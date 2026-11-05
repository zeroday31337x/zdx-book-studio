import path from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import type { BookProject, ChapterReview, Character } from "./types.js";
import { parseStructuredReview } from "./review-parser.js";
import { applyFrictionWrite, type FrictionConfig } from './frictionwrite.js';
import { humanizeWithLocalModel } from './humanizer.js';
import { chapterContext, wordCount } from "./context.js";

loadEnv();
const coreEnv = process.env.ZDX_AGENT_ENV || path.resolve(process.cwd(), "../zdx-agent-team/.env");
loadEnv({ path: coreEnv, override: false });

const bookOllamaBaseUrl = process.env.BOOK_OLLAMA_BASE_URL || process.env.ZDX_INFERENCE_POOL_URL || "http://127.0.0.1:11438";
const bookOllamaModel = process.env.BOOK_OLLAMA_MODEL || "qwen3:32b";
process.env.OLLAMA_BASE_URL = bookOllamaBaseUrl;
process.env.OLLAMA_MODEL = bookOllamaModel;
process.env.OLLAMA_MODELS = bookOllamaModel;
process.env.OLLAMA_STREAM = "0";
process.env.OLLAMA_THINK = "0";
// Bound a single pool request so provider fallback cannot hold a chapter indefinitely.
process.env.MODEL_OLLAMA_TIMEOUT_MS = process.env.BOOK_MODEL_REQUEST_TIMEOUT_MS || "240000";

type Core = { TeamRuntime: any; ProviderRouter: any; OpenAIProvider: any; GroqProvider: any; GeminiProvider: any; OllamaProvider: any };

export class BookAgentService {
  private core?: Core;
  private models?: any;

  private async load() {
    if (this.core && this.models) return;
    const root = process.env.ZDX_AGENT_CORE_PATH || path.resolve(process.cwd(), "../zdx-agent-team");
    const runtimeUrl = pathToFileURL(path.join(root, "src/core/runtime.ts")).href;
    const providersUrl = pathToFileURL(path.join(root, "src/providers/providers.ts")).href;
    const runtime = await import(runtimeUrl);
    const providers = await import(providersUrl);
    this.core = { TeamRuntime: runtime.TeamRuntime, ProviderRouter: providers.ProviderRouter, OpenAIProvider: providers.OpenAIProvider, GroqProvider: providers.GroqProvider, GeminiProvider: providers.GeminiProvider, OllamaProvider: providers.OllamaProvider };
    this.models = new providers.ProviderRouter([new providers.OllamaProvider()]);
    this.models.setPreferredModel("ollama", bookOllamaModel);
    this.models.setPreferredProvider("ollama");
  }

  async designBookFromIdea(idea: string, chapterCount: number, chapterTargetWords: number) {
    await this.load();
    const response = await this.models.generate({
      profile: "reasoning",
      system: `You are a professional fiction development editor. Turn the author's short idea into an original, coherent book design for exactly ${chapterCount} chapters. Preserve the user's intent. Return one JSON object with title, tagline, genre, tone, premise, overview, canon, characters and chapters. Characters must have name, role, publicProfile, worldview, wound, strength, blindSpot, voice, privateKnowledge. At least one protagonist. Each chapter has title, structure, povCharacterName. The structure must be a distinctive 2-4 sentence scene boundary with concrete events and no plot repetition. No copyrighted character imitation. Do not generate chapter prose. Chapter length requested: ${chapterTargetWords} words.`,
      prompt: JSON.stringify({ idea, chapterCount, chapterTargetWords }),
      maxOutputTokens: Math.max(3500, Math.min(14000, chapterCount * 220 + 2200)),
      telemetry: { sessionId: "book-auto-design", agentId: "book_planner" }
    });
    const raw = response.text.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    if (!json || !Array.isArray(json.characters) || !Array.isArray(json.chapters) || json.chapters.length !== chapterCount) throw new Error("Incomplete generated book design");
    return json;
  }

  async providerState() { await this.load(); return this.models.getProviderState(); }

  async humanizeChapter(book: BookProject, chapterNumber: number, draft: string, config: FrictionConfig) {
    if (process.env.BOOK_STUDIO_HUMANIZER_ENGINE === 'local' && config.mode === 'natural') {
      return humanizeWithLocalModel(draft);
    }
    await this.load();
    return applyFrictionWrite((request) => this.models.generate(request), book, chapterNumber, draft, config);
  }

  async writeChapter(book: BookProject, chapterNumber: number) {
    await this.load();
    const chapter = book.chapters.find(item => item.number === chapterNumber);
    if (!chapter) throw new Error("Chapter not found");
    const pov = book.characters.find(character => character.id === chapter.povCharacterId);
    if (!pov) throw new Error("Chapter POV character is not configured");
    if (!chapter.structure.trim()) throw new Error("Chapter structure is empty");
    const packet = chapterContext(book, chapter, pov);
    // Keep prompts below shared-provider TPM/context ceilings. Full canon chapter files can
    // otherwise make a single POV request exceed 8k TPM before generation even starts.
    const compactText = (value: unknown, maxChars: number) => {
      const text = String(value ?? "");
      if (text.length <= maxChars) return text;
      return `${text.slice(0, Math.floor(maxChars * 0.72))}\n\n[Context excerpt shortened to fit model request limits.]\n\n${text.slice(-Math.floor(maxChars * 0.28))}`;
    };
    const compactPacket = {
      ...packet,
      sourceDocuments: packet.sourceDocuments.map((doc: any, index: number) => ({
        ...doc,
        content: compactText(doc.content, doc.path === "book.md" ? 4200 : doc.path === "continuity.md" ? 4200 : doc.path.startsWith("characters/") && doc.path.includes(pov.id) ? 3200 : doc.path.startsWith("characters/") ? 1200 : 6500)
      })),
      chapterSummaries: packet.chapterSummaries.slice(-8),
      previousSamePovDocument: ""
    };
    const chapterTarget = Math.max(600, book.chapterTargetWords || Math.round(book.targetWords / book.chapterCount));
    const chapterMin = Math.round(chapterTarget * 0.8);
    const chapterMax = Math.round(chapterTarget * 1.2);
    const system = [
      `You are the dedicated POV prose writer for ${pov.name} of the ${pov.guild} guild.`,
      `Write only ${pov.name}'s limited POV. Maintain this character's distinct voice, biases, emotional defenses and knowledge limits.`,
      "Treat supplied canon and approved prior chapters as immutable facts. The chapter structure is a HARD scene boundary as well as an event contract: dramatize only the events it contains, and do not advance into later chapters.",
      `Never import private knowledge belonging to another character unless the supplied continuity says ${pov.name} learned it.`,
      `Write a complete, publishable chapter of ${chapterMin}-${chapterMax} words, centered near ${Math.min(chapterTarget, Math.floor(chapterMax * 0.92))}. The upper bound is strict: plan your scene lengths before writing, finish naturally before ${chapterMax} words, and never pad.`,
      "PROSE STANDARD: Write like a skilled human novelist, not an assistant explaining a story. Favor specific lived-in details, varied natural sentence rhythms, sharp dialogue, subtext, selective interiority, and scenes that move. Trust the reader to infer meaning. Do not explain a feeling after dialogue, action, or an image has already conveyed it. Avoid repetitive emotional beats, redundant summaries, tidy moral lessons, generic transitions, over-signposting, and exposition that characters would not naturally think or say.",
      ...(book.writingStyle ? [`AUTHOR WRITING STYLE (highest prose-style priority): ${book.writingStyle.slice(0,4000)}`] : []),
      ...(book.writingSample ? [`AUTHOR WRITING SAMPLE (match rhythm, voice, narrative distance, dialogue and diction without copying passages): ${book.writingSample.slice(0,9000)}`] : []),
      "VOICE: Use the book's stated tone and the POV character's voice as authority. Treat approved Canon chapters—especially the same-POV chapter—as the author's own house-style sample. Match cadence, humor, vocabulary, formality, and narrative distance without copying sentences. Preserve the author's voice instead of replacing it with generic polished AI prose.",
      "HUMOR AND HUMANITY: Allow wit, irony, awkwardness, warmth, playfulness, and ordinary human contradiction wherever they fit the character and moment. Humor should arise from personality, timing, dialogue, or circumstance; never force jokes into serious scenes or flatten the whole book into solemn exposition.",
      "SCENE CRAFT: Enter scenes close to the moment something changes. Give characters distinct voices and friction. Let them evade, misunderstand, interrupt, notice odd things, make mistakes, and leave things unsaid. Vary paragraph length and pacing. Prefer concrete action and sensory particulars over abstract explanation. End scenes on a resonant beat, turn, image, or unanswered question—not a recap.",
      "Keep canon, limited POV, and the chapter's event boundary intact, but treat the structure as a dramatic brief, not a checklist to narrate point by point. Do not mention these instructions or describe the prose.",
      "Do not summarize, explain, outline, or add commentary. Do not write markdown headings.",
      "Return only the complete chapter prose as plain text. No JSON, code fences, or metadata."
    ].join(" ");
    const writerFormat = {
      type: "object",
      properties: { output: { type: "string" } },
      required: ["output"],
      additionalProperties: false
    };
    const response = await this.models.generate({
      profile: "reasoning",
      system,
      prompt: JSON.stringify({ bookTitle: book.title, chapterNumber: chapter.number, chapterTitle: chapter.title, chapterPacket: compactPacket }),
      maxOutputTokens: Math.max(2200, Number(process.env.BOOK_WRITER_MAX_OUTPUT_TOKENS || 2400)),

      telemetry: { sessionId: `${book.id}:chapter:${chapter.number}`, agentId: `${pov.id}_writer` }
    });
    let output = this.extractWriterOutput(response.text);
    if (!output || output.length < 500) throw new Error("POV writer did not return a substantive chapter");

    for (let continuationPass = 1; wordCount(output) < chapterMin && continuationPass <= 2; continuationPass++) {
      const remaining = Math.max(400, chapterMin - wordCount(output));
      const continuationSystem = [
        `You are continuing Chapter ${chapter.number} of ${book.title} in ${pov.name}'s limited POV.`,
        `The existing draft is valid and must not be rewritten or repeated. Add approximately ${remaining}-${Math.min(remaining + 500, 1200)} words that continue seamlessly from its final sentence.`,
        "Stay inside the authoritative chapter structure. Continue naturally from the final sentence; do not recap, restart, or repeat existing information. Expand, deepen, or complete only its existing scenes; NEVER advance time into the next chapter, introduce later-chapter encounters, or append a new scene merely to reach word count.",
        "Maintain the same human authorial voice, narrative distance, sentence rhythm, humor level, and character-specific diction as the draft. Add only material the scene genuinely needs. Prefer fresh action, revealing dialogue, subtext, friction, and concrete detail over explaining what the reader already understands. Do not pad with repetitive thoughts, generic atmosphere, or a second explanation of the same emotion.",
        "Return only continuation prose as plain text. No JSON, code fences, or metadata."
      ].join(" ");
      let continued;
      try {
        continued = await this.models.generate({
          profile: "reasoning",
          system: continuationSystem,
          prompt: JSON.stringify({
            book: { title: book.title, tone: book.tone, canon: book.canon },
            chapter: { number: chapter.number, title: chapter.title, structure: chapter.structure },
            pov: { name: pov.name, guild: pov.guild, voice: pov.voice, worldview: pov.worldview, blindSpot: pov.blindSpot },
            existingDraft: output,
            currentWordCount: wordCount(output), minimumWordCount: chapterMin, maximumWordCount: chapterMax
          }),
          maxOutputTokens: Math.max(1600, Number(process.env.BOOK_WRITER_CONTINUATION_TOKENS || 2200)),

          telemetry: { sessionId: `${book.id}:chapter:${chapter.number}`, agentId: `${pov.id}_writer_continuation_${continuationPass}` }
        });
      } catch (error) {
        if (wordCount(output) >= chapterMin) break;
        throw error;
      }
      const addition = this.extractWriterOutput(continued.text);
      if (!addition || addition.length < 200) break;
      output = `${output.trim()}\n\n${addition.trim()}`;
    }
    // Do not send over-length drafts to review: retry against a deterministic word budget.
    // Preserve the original draft if compression fails; the review gate remains authoritative.
    const hardMax = chapterMax;
    for (let pass = 1; wordCount(output) > hardMax && pass <= 3; pass++) {
      const before = wordCount(output);
      console.warn("[BOOK_STUDIO_LENGTH_REPAIR]", JSON.stringify({ chapter: chapter.number, pass, before, maximum: hardMax }));
      const revised = await this.models.generate({
        profile: "reasoning",
        system: [
          `You are revising chapter ${chapter.number} of ${book.title} in ${pov.name}'s limited POV.`,
          `HARD REQUIREMENT: Return a complete replacement chapter between ${chapterMin} and ${hardMax} words, targeting ${Math.round(chapterMin + (hardMax - chapterMin) * 0.35)} words. Output outside these bounds is rejected by code.`,
          "This is a compression pass, not a new generation. Preserve the plot, dialogue meaning, canon, character relationships, and all required chapter-structure events. Remove repetition and padding. Do not add new scenes or advance beyond the chapter boundary.",
          "Return only the revised chapter prose as plain text. No JSON, code fences, or metadata."
        ].join(" "),
        prompt: JSON.stringify({ chapterStructure: chapter.structure, existingDraft: output, actualWordCount: before, maximumWords: hardMax, writingStyle: book.writingStyle, writingSample: book.writingSample?.slice(0,3500) }),
        maxOutputTokens: Math.max(3600, Number(process.env.BOOK_WRITER_REPAIR_TOKENS || 4400)),

        telemetry: { sessionId: `${book.id}:chapter:${chapter.number}`, agentId: `${pov.id}_writer_length_repair_${pass}` }
      });
      const candidate = this.extractWriterOutput(revised.text);
      if (candidate && candidate.length >= 500 && wordCount(candidate) >= chapterMin && wordCount(candidate) < before) output = candidate;
    }
    const finalWords = wordCount(output);
    console.info("[BOOK_STUDIO_LENGTH_RESULT]", JSON.stringify({ chapter: chapter.number, words: finalWords, minimum: chapterMin, maximum: hardMax, withinLimit: finalWords >= chapterMin && finalWords <= hardMax }));
    if (finalWords < chapterMin || finalWords > hardMax) {
      throw new Error(`Chapter ${chapter.number} failed deterministic length validation: ${finalWords} words; required ${chapterMin}-${hardMax}. No noncompliant draft submitted for review.`);
    }
    return output.trim();
  }

  async reviewChapter(book: BookProject, chapterNumber: number, draft: string): Promise<ChapterReview> {
    await this.load();
    const chapter = book.chapters.find(item => item.number === chapterNumber);
    if (!chapter) throw new Error("Chapter not found");
    const pov = book.characters.find(character => character.id === chapter.povCharacterId);
    if (!pov) throw new Error("Chapter POV character is not configured");
    const nextChapter = book.chapters.find(item => item.number === chapter.number + 1);
    const fullPacket = chapterContext(book, chapter, pov);
    const immediatePath = `chapters/${chapter.number - 1}`;
    const packet = {
      ...fullPacket,
      sourceDocuments: fullPacket.sourceDocuments.filter(document =>
        !document.path.startsWith("chapters/") || document.path === immediatePath
      ),
      previousSamePovDocument: fullPacket.previousSamePovDocument,
      candidateChapterDocument: { path: `chapters/${chapter.number}-candidate.md`, content: draft },
      nextChapterBoundary: nextChapter ? { number: nextChapter.number, title: nextChapter.title, structure: nextChapter.structure } : null
    };
    const chapterTarget = Math.max(600, book.chapterTargetWords || Math.round(book.targetWords / book.chapterCount));
    const chapterMin = Math.round(chapterTarget * 0.8);
    const chapterMax = Math.round(chapterTarget * 1.2);
    const system = [
      `You are the independent Book Reviewer for Chapter ${chapter.number} of ${book.title}.`,
      `Expected chapter length is ${chapterMin}-${chapterMax} words; mark NEEDS_CHANGES if materially outside that range unless the scene clearly earns an exception.`,
      "The chapter structure is a HARD boundary. Mark NEEDS_CHANGES if the draft advances beyond it, steals events/encounters from the next chapter, resolves knowledge the POV has not earned, or adds a later scene merely to satisfy length.",      "Review in two independent passes: (1) hard constraints—canon, continuity, event boundary, POV knowledge, factual consistency; (2) literary craft—does this read like confident, professional human-authored fiction in this book's established voice?",
      "For literary craft, look for natural sentence variety, distinct dialogue, subtext, vivid but selective detail, believable emotional complexity, scene momentum, tonal consistency, and humor/warmth when the moment and character invite it. Check for robotic symmetry, over-explained motives, explaining a joke after it lands, repeated emotional conclusions, recap paragraphs, generic filler, stiff dialogue, obvious signposting, stock transitions, and prose that narrates the outline instead of dramatizing it.",
      "Trust readers to make ordinary inferences. A sentence that merely restates the previous action, dialogue, image, or emotion is usually expendable. Do not require humor in every scene; judge whether the prose feels alive and tonally right. Avoid imposing one rigid style across all books or characters.",
      "Use NEEDS_CHANGES for material craft problems that noticeably damage the reading experience, not for subjective taste or harmless stylistic variation. Give concise, actionable notes that identify the pattern and its effect; do not rewrite the chapter. Keep continuity deltas factual and concise.",
      "Do not claim legal infringement. Flag similarity concerns for the dedicated Copyright platform.",
      "Return exactly one JSON object with keys verdict, notes, summary, continuityDelta, knowledgeDelta, relationshipDelta, originalityFlags.",
      "verdict must be PASS or NEEDS_CHANGES. All delta/flag/note fields must be arrays of concise strings; summary must be a concise factual chapter summary."
    ].join(" ");
    const actualWordCount = wordCount(draft);
    let review: ChapterReview | undefined;
    let lastReviewError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await this.models.generate({
      profile: "review",
      system,
      prompt: JSON.stringify({ ...packet, deterministicMetrics: { actualWordCount, preferredRange: [chapterMin, chapterMax], hardRange: [chapterMin, chapterMax] } }),
      maxOutputTokens: Math.max(1200, Number(process.env.BOOK_REVIEWER_MAX_OUTPUT_TOKENS || 1600)),
      responseFormat: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["PASS", "NEEDS_CHANGES"] },
          notes: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          continuityDelta: { type: "array", items: { type: "string" } },
          knowledgeDelta: { type: "array", items: { type: "string" } },
          relationshipDelta: { type: "array", items: { type: "string" } },
          originalityFlags: { type: "array", items: { type: "string" } }
        },
        required: ["verdict", "notes", "summary", "continuityDelta", "knowledgeDelta", "relationshipDelta", "originalityFlags"],
        additionalProperties: false
      },
      telemetry: { sessionId: `${book.id}:chapter:${chapter.number}`, agentId: "book_reviewer" }
    });
    try { review = parseStructuredReview(response.text); break; }
    catch (error) {
      lastReviewError = error;
      console.warn("[BOOK_STUDIO_REVIEW_FORMAT_RETRY]", JSON.stringify({ chapter: chapter.number, attempt, message: error instanceof Error ? error.message : "invalid envelope" }));
    }
    }
    if (!review) throw new Error("Reviewer returned invalid structured output after 2 attempts: " + (lastReviewError instanceof Error ? lastReviewError.message : "unknown error"));
    review.notes = review.notes.filter(note => !/chapter\s+(?:is|has)\s+[\d,]+\s+words/i.test(note));
    review.notes.unshift(`Deterministic word count: ${actualWordCount} words. Preferred range ${chapterMin}-${chapterMax}; hard range ${chapterMin}-${chapterMax}.`);
    if (actualWordCount < chapterMin || actualWordCount > chapterMax) {
      review.verdict = "NEEDS_CHANGES";
      review.notes.unshift("Deterministic length gate failed; revise before Canon approval.");
    }
    return review;
  }

  private extractWriterOutput(text: string): string {
    const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      const parsed = JSON.parse(clean);
      if (parsed && typeof parsed.output === "string") return parsed.output.trim();
    } catch {}
    const first = clean.indexOf("{"); const last = clean.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        const parsed = JSON.parse(clean.slice(first, last + 1));
        if (parsed && typeof parsed.output === "string") return parsed.output.trim();
      } catch {}
    }
    if (clean.startsWith("{") || clean.startsWith("[")) return "";
    return clean;
  }

  private writerTeam(writerId: string, pov: Character) {
    const budget = { maxTurns: 4, maxToolCalls: 0, maxRuntimeSeconds: 1200 };
    return {
      id: `book-${pov.id}`, name: `${pov.name} Writing Team`, description: "Sequential POV manuscript generation", manager: "manager",
      policy: { maxChainExecutions: 4, requireApprovalFor: [], denyTools: [] }, workflow: { orderedAgents: [writerId], requireSubstantiveOutput: true },
      agents: [
        { id: "manager", name: "Book Orchestrator", role: "Protect the authoritative chapter contract", instructions: "Do not write the chapter yourself. Preserve the supplied canon, outline, continuity and POV boundary. Hand the exact bounded chapter objective to the configured writer through the runtime-controlled workflow.", modelProfile: "reasoning", tools: [], canDelegateTo: [writerId], budget },
        { id: writerId, name: `${pov.name} POV Writer`, role: `Write only ${pov.name}'s chapters`, instructions: `You are the dedicated POV prose writer for ${pov.name} of the ${pov.guild} guild. Write publishable, natural human-authored fiction, not generic AI prose. Match the book tone and use approved Canon chapters as the author's house-style sample: cadence, narrative distance, diction, humor, and formality. Maintain this character's distinct voice, biases, emotional defenses and knowledge limits. Use dialogue, subtext, selective sensory detail, and varied rhythm. Trust the reader; do not over-explain, repeat emotional beats, recap scenes, pad, or narrate the outline as a checklist. Let humor and warmth arise naturally where they fit; do not force them. Treat supplied canon and approved prior chapters as immutable facts. The chapter structure defines required events but not exact prose. Never import private knowledge belonging to another character unless the supplied continuity says ${pov.name} learned it.`, modelProfile: "reasoning", tools: [], canDelegateTo: [], budget }
      ]
    };
  }

  private reviewerTeam(reviewerId: string) {
    const budget = { maxTurns: 4, maxToolCalls: 0, maxRuntimeSeconds: 1200 };
    return {
      id: "book-review", name: "Book Review Team", description: "Independent manuscript gate", manager: "manager",
      policy: { maxChainExecutions: 4, requireApprovalFor: [], denyTools: [] }, workflow: { orderedAgents: [reviewerId], requireSubstantiveOutput: true },
      agents: [
        { id: "manager", name: "Book Orchestrator", role: "Route the candidate chapter to independent review", instructions: "Do not review the chapter yourself. Preserve the supplied evidence and send the exact review objective through the runtime-controlled workflow.", modelProfile: "reasoning", tools: [], canDelegateTo: [reviewerId], budget },
        { id: reviewerId, name: "Book Reviewer", role: "Independently gate chapter quality and continuity", instructions: "Review the candidate against the authoritative book packet in two passes: hard canon/continuity/POV constraints, then literary craft. Judge whether it reads like professional human-authored prose in the book's established voice. Flag over-explanation, redundant emotional beats, stiff dialogue, generic filler, outline-like narration, unnatural sentence rhythm, and missed opportunities for natural wit or warmth when appropriate. Do not demand humor in every scene or impose one generic style. Give concise actionable notes; do not rewrite. Flag similarity concerns for the dedicated Copyright platform rather than claiming legal infringement. Return the requested structured review.", modelProfile: "review", tools: [], canDelegateTo: [], budget }
      ]
    };
  }

}
