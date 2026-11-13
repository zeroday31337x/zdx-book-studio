import path from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import type { BookProject, ChapterReview, Character } from "./types.js";
import { parseStructuredReview } from "./review-parser.js";
import { applyFrictionWrite, type FrictionConfig } from './frictionwrite.js';
import { humanizeWithLocalModel } from './humanizer.js';
import { chapterContext, chapterLengthBands, wordCount } from "./context.js";
import { costFor, estimateTokens, loadRateCard, type UsageEventInput } from "./usage.js";
import { activeAttachments, type ResolvedAttachment } from "./series.js";

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

interface ModelResponseShape {
  text: string;
  provider?: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

interface MeterContext {
  operation: string;
  bookId?: string | null;
  chapterNumber?: number | null;
  ownerEmail?: string;
  /** Route the call to the independent reviewer provider/model when configured. */
  reviewer?: boolean;
}

export class BookAgentService {
  private core?: Core;
  private models?: any;
  /** Reviewer model served by the inference pool when the reviewer model setting names a different model than the writer's. */
  private reviewPoolModel?: string;
  /** Effective reviewer route key (provider|model) the current route was built for; rebuilt when settings change. */
  private reviewerRouteKey: string | null = null;
  private rateCardCache?: { raw: string; card: ReturnType<typeof loadRateCard> };
  private usageSink?: (event: UsageEventInput & { costUsd: number }) => void;
  /** Reads platform settings from the DB (wired by the server). DB > env > default. */
  private settingsProvider?: (key: string) => string | undefined;

  /** The server wires persistence here; metering must never break generation. */
  setUsageSink(sink: (event: UsageEventInput & { costUsd: number }) => void) { this.usageSink = sink; }

  setSettingsProvider(provider: (key: string) => string | undefined) { this.settingsProvider = provider; }

  /** Resolves other books by id (wired by the server to the store) for series attachments. */
  private bookResolver?: (id: string) => BookProject | undefined;

  setBookResolver(resolver: (id: string) => BookProject | undefined) { this.bookResolver = resolver; }

  /** Seal-verified series attachments for a book. Stale or missing sources are excluded (fail closed) and logged. */
  private attachedSourcesFor(book: BookProject): ResolvedAttachment[] {
    if (!this.bookResolver || !(book.attachments || []).length) return [];
    const active = activeAttachments(book, this.bookResolver);
    if (active.length !== (book.attachments || []).length) {
      console.warn("[BOOK_STUDIO_ATTACHMENT_STALE]", JSON.stringify({ bookId: book.id, attached: (book.attachments || []).length, active: active.length, note: "attachments whose source canon changed are excluded until re-attached" }));
    }
    return active;
  }

  private settingValue(key: string, envName: string, fallback: string): string {
    const fromDb = this.settingsProvider?.(key);
    if (fromDb !== undefined) return fromDb;
    const fromEnv = process.env[envName];
    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : fallback;
  }

  private settingNumber(key: string, envName: string, fallback: number): number {
    const parsed = Number(this.settingValue(key, envName, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private currentRateCard() {
    const raw = this.settingValue("modelRates", "BOOK_STUDIO_MODEL_RATES", "");
    if (!this.rateCardCache || this.rateCardCache.raw !== raw) {
      this.rateCardCache = { raw, card: loadRateCard(process.env, raw) };
    }
    return this.rateCardCache.card;
  }

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

  /**
   * Reviewer independence, resolved from platform settings on each review
   * call (changes apply without a restart). Studio talks only to the ZDX
   * inference pool and designates a model, never a provider: the pool
   * internally rotates across its registered providers and keys, so
   * successive calls usually land on different providers — but the same
   * model name is the same weights wherever it is served, so independence
   * of judgment still means the review gate runs on a DIFFERENT MODEL
   * served by the pool (reviewerModel setting), through the same pool
   * endpoint. Unset (or the writer's own model), the reviewer uses the
   * writer's route. There is deliberately no direct-provider path from
   * Studio: the agent core's OpenAI/Groq/Gemini classes call those public
   * APIs directly and are never registered here.
   */
  private async resolveReviewerRoute() {
    const model = this.settingValue("reviewerModel", "BOOK_REVIEWER_MODEL", "").trim();
    if (this.reviewerRouteKey === model) return;
    this.reviewerRouteKey = model;
    this.reviewPoolModel = model && model !== bookOllamaModel ? model : undefined;
    if (this.reviewPoolModel) {
      console.info("[BOOK_STUDIO_REVIEWER_ROUTE]", JSON.stringify({ route: "inference-pool", model: this.reviewPoolModel }));
    }
  }

  /** Direct call to the inference pool for the reviewer-model route. */
  private async generateViaPoolModel(request: any, model: string): Promise<ModelResponseShape> {
    const response = await fetch(`${bookOllamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, stream: false, think: false, format: "json",
        messages: [{ role: "system", content: request.system }, { role: "user", content: request.prompt }],
        options: { temperature: 0.2, num_predict: Number(request.maxOutputTokens || 1600) }
      }),
      signal: AbortSignal.timeout(this.settingNumber("modelRequestTimeoutMs", "BOOK_MODEL_REQUEST_TIMEOUT_MS", 240000))
    });
    if (!response.ok) throw new Error(`Reviewer pool request failed: ${response.status}`);
    const data = await response.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    return {
      text: data.message?.content ?? "",
      provider: "ollama",
      model,
      usage: {
        inputTokens: Number(data.prompt_eval_count || 0),
        outputTokens: Number(data.eval_count || 0),
        totalTokens: Number(data.prompt_eval_count || 0) + Number(data.eval_count || 0)
      }
    };
  }

  /**
   * Every model call in the pipeline goes through here: latency, real token
   * usage from the provider response (estimated only when the provider
   * returns none), and rate-card cost are recorded to the usage sink.
   */
  private async metered(request: any, ctx: MeterContext): Promise<ModelResponseShape> {
    await this.load();
    if (ctx.reviewer) await this.resolveReviewerRoute();
    const started = Date.now();
    const agentId = String(request?.telemetry?.agentId || ctx.operation);
    try {
      const response: ModelResponseShape = ctx.reviewer && this.reviewPoolModel
        ? await this.generateViaPoolModel(request, this.reviewPoolModel)
        : await this.models.generate(request);
      const latencyMs = Date.now() - started;
      const reported = response.usage || {};
      let inputTokens = Number(reported.inputTokens || 0);
      let outputTokens = Number(reported.outputTokens || 0);
      let tokensEstimated = false;
      if (inputTokens + outputTokens <= 0) {
        inputTokens = estimateTokens(`${request?.system || ""}\n${request?.prompt || ""}`);
        outputTokens = estimateTokens(response.text || "");
        tokensEstimated = true;
      }
      const provider = response.provider || "ollama";
      const model = response.model || bookOllamaModel;
      this.recordUsage({
        ownerEmail: ctx.ownerEmail || "", bookId: ctx.bookId ?? null, chapterNumber: ctx.chapterNumber ?? null,
        operation: ctx.operation, agentId, provider, model,
        inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, tokensEstimated,
        latencyMs, status: "success"
      }, provider, model, inputTokens, outputTokens);
      return response;
    } catch (error) {
      this.recordUsage({
        ownerEmail: ctx.ownerEmail || "", bookId: ctx.bookId ?? null, chapterNumber: ctx.chapterNumber ?? null,
        operation: ctx.operation, agentId, provider: "ollama",
        model: ctx.reviewer ? (this.settingValue("reviewerModel", "BOOK_REVIEWER_MODEL", "") || bookOllamaModel) : bookOllamaModel,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, tokensEstimated: false,
        latencyMs: Date.now() - started, status: "error"
      }, "ollama", bookOllamaModel, 0, 0);
      throw error;
    }
  }

  private recordUsage(event: UsageEventInput, provider: string, model: string, inputTokens: number, outputTokens: number) {
    if (!this.usageSink) return;
    try {
      this.usageSink({ ...event, costUsd: costFor(this.currentRateCard(), provider, model, inputTokens, outputTokens) });
    } catch (error) {
      console.warn("[BOOK_STUDIO_USAGE_SINK_FAILED]", error instanceof Error ? error.message : "unknown");
    }
  }

  async designBookFromIdea(idea: string, chapterCount: number, chapterTargetWords: number, ownerEmail = "") {
    await this.load();
    const response = await this.metered({
      profile: "reasoning",
      system: `You are a professional fiction development editor. Turn the author's short idea into an original, coherent book design for exactly ${chapterCount} chapters. Preserve the user's intent. Return one JSON object with title, tagline, genre, tone, premise, overview, canon, characters and chapters. Characters must have name, role, publicProfile, worldview, wound, strength, blindSpot, voice, privateKnowledge. At least one protagonist. Each chapter has title, structure, povCharacterName. The structure must be a distinctive 2-4 sentence scene boundary with concrete events and no plot repetition. No copyrighted character imitation. Do not generate chapter prose. Chapter length requested: ${chapterTargetWords} words.`,
      prompt: JSON.stringify({ idea, chapterCount, chapterTargetWords }),
      maxOutputTokens: Math.max(3500, Math.min(14000, chapterCount * 220 + 2200)),
      telemetry: { sessionId: "book-auto-design", agentId: "book_planner" }
    }, { operation: "design", ownerEmail });
    const raw = response.text.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    if (!json || !Array.isArray(json.characters) || !Array.isArray(json.chapters) || json.chapters.length !== chapterCount) throw new Error("Incomplete generated book design");
    return json;
  }

  async providerState() {
    await this.load();
    const state = this.models.getProviderState();
    const model = this.settingValue("reviewerModel", "BOOK_REVIEWER_MODEL", "").trim();
    return {
      ...state,
      reviewerRoute: model && model !== bookOllamaModel ? `pool-model:${model}` : "writer-route",
      reviewerModel: model || null
    };
  }

  async humanizeChapter(book: BookProject, chapterNumber: number, draft: string, config: FrictionConfig) {
    // FrictionWrite / the humanizer are optional polish passes. A failed or
    // rejected revision must never destroy a valid draft: fall back to the
    // original text and log, so the chapter proceeds to review unchanged.
    try {
      if (process.env.BOOK_STUDIO_HUMANIZER_ENGINE === 'local' && config.mode === 'natural') {
        const started = Date.now();
        const result = await humanizeWithLocalModel(draft);
        const inputTokens = estimateTokens(draft);
        const outputTokens = estimateTokens(result);
        this.recordUsage({
          ownerEmail: book.ownerEmail || "", bookId: book.id, chapterNumber, operation: "humanize",
          agentId: "humanizer_local", provider: "local-humanizer", model: "local",
          inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, tokensEstimated: true,
          latencyMs: Date.now() - started, status: "success"
        }, "local-humanizer", "local", inputTokens, outputTokens);
        return result;
      }
      await this.load();
      return await applyFrictionWrite((request) => this.metered(request, { operation: "frictionwrite", bookId: book.id, chapterNumber, ownerEmail: book.ownerEmail }), book, chapterNumber, draft, config);
    } catch (error) {
      console.warn("[BOOK_STUDIO_FRICTION_FALLBACK]", JSON.stringify({ bookId: book.id, chapter: chapterNumber, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }));
      return draft;
    }
  }

  async writeChapter(book: BookProject, chapterNumber: number) {
    await this.load();
    const chapter = book.chapters.find(item => item.number === chapterNumber);
    if (!chapter) throw new Error("Chapter not found");
    const pov = book.characters.find(character => character.id === chapter.povCharacterId);
    if (!pov) throw new Error("Chapter POV character is not configured");
    if (!chapter.structure.trim()) throw new Error("Chapter structure is empty");
    const resolvedAttachments = this.attachedSourcesFor(book);
    const packet = chapterContext(book, chapter, pov, resolvedAttachments);
    chapter.builtAgainst = resolvedAttachments.map(resolved => ({ bookId: resolved.attachment.bookId, canonHash: resolved.attachment.canonHash }));
    // Prompt size discipline without silent evidence loss: documents are
    // capped at paragraph boundaries with an explicit omission marker, the
    // continuity file is trimmed section-aware (oldest timeline entries go
    // first; facts and knowledge state are constraint-bearing and are never
    // middle-cut), and the writer receives a bounded excerpt of the previous
    // same-POV canon chapter — its instructions cite that chapter for voice.
    const compactText = (value: unknown, maxChars: number) => {
      const text = String(value ?? "");
      if (text.length <= maxChars) return text;
      const head = text.slice(0, Math.floor(maxChars * 0.72));
      const tail = text.slice(-Math.floor(maxChars * 0.28));
      return `${head.slice(0, head.lastIndexOf("\n\n") > 0 ? head.lastIndexOf("\n\n") : head.length)}\n\n[Context excerpt shortened to fit model request limits; ${text.length - maxChars} characters omitted here.]\n\n${tail}`;
    };
    const compactContinuity = (value: unknown, maxChars: number) => {
      const text = String(value ?? "");
      if (text.length <= maxChars) return text;
      const sections = text.split(/(?=^## )/m);
      const trimmed = sections.map(section => {
        if (!section.startsWith("## Timeline")) return section;
        const lines = section.split("\n");
        const entries = lines.filter(line => line.startsWith("- "));
        if (entries.length <= 10) return section;
        const header = lines.filter(line => !line.startsWith("- "));
        return [...header, `- [${entries.length - 10} earliest timeline entries omitted to fit request limits.]`, ...entries.slice(-10)].join("\n");
      }).join("");
      return trimmed.length <= maxChars ? trimmed : compactText(trimmed, maxChars);
    };
    const voiceExcerpt = (value: unknown, maxChars = 7000) => {
      const text = String(value ?? "");
      if (text.length <= maxChars) return text;
      return `${text.slice(0, 2800)}\n\n[Middle of the previous same-POV chapter omitted; opening and closing kept as the voice sample.]\n\n${text.slice(-2800)}`;
    };
    const compactPacket = {
      ...packet,
      sourceDocuments: packet.sourceDocuments.map((doc: any, index: number) => ({
        ...doc,
        content: doc.path === "continuity.md" ? compactContinuity(doc.content, 12000)
          : compactText(doc.content, doc.path === "book.md" ? 9000 : doc.path.startsWith("characters/") && doc.path.includes(pov.id) ? 6000 : doc.path.startsWith("characters/") ? 2000 : 9000)
      })),
      chapterSummaries: packet.chapterSummaries.slice(-24),
      previousSamePovDocument: voiceExcerpt(packet.previousSamePovDocument)
    };
    const bands = chapterLengthBands(book);
    const chapterTarget = bands.target;
    const chapterMin = bands.preferredMin;
    const chapterMax = bands.preferredMax;
    const system = [
      `You are the dedicated POV prose writer for ${pov.name} of the ${pov.guild} guild.`,
      `Write only ${pov.name}'s limited POV. Maintain this character's distinct voice, biases, emotional defenses and knowledge limits.`,
      "Treat supplied canon and approved prior chapters as immutable facts. The chapter structure is a HARD scene boundary as well as an event contract: dramatize only the events it contains, and do not advance into later chapters.",
      `Never import private knowledge belonging to another character unless the supplied continuity says ${pov.name} learned it.`,
      ...(resolvedAttachments.length ? [`SERIES CANON: documents under series/ are the sealed canon of prior books in this series — their facts, timeline and outcomes are binding on this chapter. From them, ${pov.name} may use ONLY what the knowledge-carryover document assigns to them; what other characters knew or did in those books is not theirs to use.`] : []),
      `Write a complete, publishable chapter of ${chapterMin}-${chapterMax} words, centered near ${Math.min(chapterTarget, Math.floor(chapterMax * 0.92))}. The preferred upper bound is ${chapterMax} and the absolute hard cap is ${bands.hardCap} words: plan your scene lengths before writing, finish naturally before ${chapterMax} words, and never pad.`,
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
    const response = await this.metered({
      profile: "reasoning",
      system,
      prompt: JSON.stringify({ bookTitle: book.title, chapterNumber: chapter.number, chapterTitle: chapter.title, chapterPacket: compactPacket }),
      maxOutputTokens: Math.max(2200, this.settingNumber("writerMaxOutputTokens", "BOOK_WRITER_MAX_OUTPUT_TOKENS", 2400)),

      telemetry: { sessionId: `${book.id}:chapter:${chapter.number}`, agentId: `${pov.id}_writer` }
    }, { operation: "write", bookId: book.id, chapterNumber: chapter.number, ownerEmail: book.ownerEmail });
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
        continued = await this.metered({
          profile: "reasoning",
          system: continuationSystem,
          prompt: JSON.stringify({
            book: { title: book.title, tone: book.tone, canon: book.canon },
            chapter: { number: chapter.number, title: chapter.title, structure: chapter.structure },
            pov: { name: pov.name, guild: pov.guild, voice: pov.voice, worldview: pov.worldview, blindSpot: pov.blindSpot },
            existingDraft: output,
            currentWordCount: wordCount(output), minimumWordCount: chapterMin, maximumWordCount: chapterMax
          }),
          maxOutputTokens: Math.max(1600, this.settingNumber("writerContinuationTokens", "BOOK_WRITER_CONTINUATION_TOKENS", 2200)),

          telemetry: { sessionId: `${book.id}:chapter:${chapter.number}`, agentId: `${pov.id}_writer_continuation_${continuationPass}` }
        }, { operation: "continuation", bookId: book.id, chapterNumber: chapter.number, ownerEmail: book.ownerEmail });
      } catch (error) {
        if (wordCount(output) >= chapterMin) break;
        throw error;
      }
      const addition = this.extractWriterOutput(continued.text);
      if (!addition || addition.length < 200) break;
      output = `${output.trim()}\n\n${addition.trim()}`;
    }
    // Compression passes run only against the HARD cap, not the preferred
    // band: a draft inside the hard bounds but over the preferred max goes
    // to review, where an exception can be earned, instead of being
    // rewritten here. Preserve the original draft if compression fails;
    // the review gate remains authoritative.
    const hardMax = bands.hardCap;
    for (let pass = 1; wordCount(output) > hardMax && pass <= 3; pass++) {
      const before = wordCount(output);
      console.warn("[BOOK_STUDIO_LENGTH_REPAIR]", JSON.stringify({ chapter: chapter.number, pass, before, maximum: hardMax }));
      const revised = await this.metered({
        profile: "reasoning",
        system: [
          `You are revising chapter ${chapter.number} of ${book.title} in ${pov.name}'s limited POV.`,
          `HARD REQUIREMENT: Return a complete replacement chapter between ${chapterMin} and ${hardMax} words, targeting ${Math.round(chapterMin + (hardMax - chapterMin) * 0.35)} words. Output above the hard cap is rejected by code.`,
          "This is a compression pass, not a new generation. Preserve the plot, dialogue meaning, canon, character relationships, and all required chapter-structure events. Remove repetition and padding. Do not add new scenes or advance beyond the chapter boundary.",
          "Return only the revised chapter prose as plain text. No JSON, code fences, or metadata."
        ].join(" "),
        prompt: JSON.stringify({ chapterStructure: chapter.structure, existingDraft: output, actualWordCount: before, maximumWords: hardMax, writingStyle: book.writingStyle, writingSample: book.writingSample?.slice(0,3500) }),
        maxOutputTokens: Math.max(3600, this.settingNumber("writerRepairTokens", "BOOK_WRITER_REPAIR_TOKENS", 4400)),

        telemetry: { sessionId: `${book.id}:chapter:${chapter.number}`, agentId: `${pov.id}_writer_length_repair_${pass}` }
      }, { operation: "length_repair", bookId: book.id, chapterNumber: chapter.number, ownerEmail: book.ownerEmail });
      const candidate = this.extractWriterOutput(revised.text);
      if (candidate && candidate.length >= 500 && wordCount(candidate) >= bands.hardFloor && wordCount(candidate) < before) output = candidate;
    }
    const finalWords = wordCount(output);
    const withinPreferred = finalWords >= chapterMin && finalWords <= chapterMax;
    console.info("[BOOK_STUDIO_LENGTH_RESULT]", JSON.stringify({ chapter: chapter.number, words: finalWords, preferred: [chapterMin, chapterMax], hard: [bands.hardFloor, hardMax], withinPreferred, withinHard: finalWords >= bands.hardFloor && finalWords <= hardMax }));
    if (finalWords < bands.hardFloor || finalWords > hardMax) {
      throw new Error(`Chapter ${chapter.number} failed deterministic length validation: ${finalWords} words; hard bounds ${bands.hardFloor}-${hardMax} (preferred ${chapterMin}-${chapterMax}). No noncompliant draft submitted for review.`);
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
    const resolvedAttachments = this.attachedSourcesFor(book);
    const fullPacket = chapterContext(book, chapter, pov, resolvedAttachments);
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
    const bands = chapterLengthBands(book);
    const chapterMin = bands.preferredMin;
    const chapterMax = bands.preferredMax;
    const buildSystem = (attempt: number, lastError: unknown) => [
      `You are the independent Book Reviewer for Chapter ${chapter.number} of ${book.title}.`,
      `Preferred chapter length is ${chapterMin}-${chapterMax} words; the hard bounds are ${bands.hardFloor}-${bands.hardCap} words. Mark NEEDS_CHANGES on length only if the draft is outside the hard bounds. Inside the hard bounds but outside the preferred range, you may PASS it as an earned exception when the scene justifies the length, and you must say so in the notes.`,
      "The chapter structure is a HARD boundary. Mark NEEDS_CHANGES if the draft advances beyond it, steals events/encounters from the next chapter, resolves knowledge the POV has not earned, or adds a later scene merely to satisfy length.",
      ...(resolvedAttachments.length ? ["Attached prior-book canon (documents under series/) is a sixth review source, equal in authority to this book's own canon. Mark NEEDS_CHANGES and record the finding in notes and originalityFlags when the draft: contradicts an attached book's facts, timeline or outcomes; uses knowledge the knowledge-carryover document does not assign to the POV character; or silently retcons an attached book's events. Cite the attached book and, where identifiable, its chapter."] : []),      "Review in two independent passes: (1) hard constraints—canon, continuity, event boundary, POV knowledge, factual consistency; (2) literary craft—does this read like confident, professional human-authored fiction in this book's established voice?",
      "For literary craft, look for natural sentence variety, distinct dialogue, subtext, vivid but selective detail, believable emotional complexity, scene momentum, tonal consistency, and humor/warmth when the moment and character invite it. Check for robotic symmetry, over-explained motives, explaining a joke after it lands, repeated emotional conclusions, recap paragraphs, generic filler, stiff dialogue, obvious signposting, stock transitions, and prose that narrates the outline instead of dramatizing it.",
      "Trust readers to make ordinary inferences. A sentence that merely restates the previous action, dialogue, image, or emotion is usually expendable. Do not require humor in every scene; judge whether the prose feels alive and tonally right. Avoid imposing one rigid style across all books or characters.",
      "Use NEEDS_CHANGES for material craft problems that noticeably damage the reading experience, not for subjective taste or harmless stylistic variation. Give concise, actionable notes that identify the pattern and its effect; do not rewrite the chapter. Keep continuity deltas factual and concise.",
      "Do not claim legal infringement. Flag similarity concerns for the dedicated Copyright platform.",
      "Return exactly one JSON object with keys verdict, notes, summary, continuityDelta, knowledgeDelta, relationshipDelta, originalityFlags.",
      "verdict must be PASS or NEEDS_CHANGES. All delta/flag/note fields must be arrays of concise strings; summary must be a concise factual chapter summary.",
      ...(attempt > 1 ? [`Your previous attempt failed validation: ${lastError instanceof Error ? lastError.message : "invalid envelope"}. Return exactly one JSON object matching the schema — no prose, no markdown fences.`] : [])
    ].join(" ");
    const actualWordCount = wordCount(draft);
    let review: ChapterReview | undefined;
    let lastReviewError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await this.metered({
      profile: "review",
      system: buildSystem(attempt, lastReviewError),
      prompt: JSON.stringify({ ...packet, deterministicMetrics: { actualWordCount, preferredRange: [chapterMin, chapterMax], hardRange: [bands.hardFloor, bands.hardCap] } }),
      maxOutputTokens: Math.max(1200, this.settingNumber("reviewerMaxOutputTokens", "BOOK_REVIEWER_MAX_OUTPUT_TOKENS", 1600)),
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
    }, { operation: "review", bookId: book.id, chapterNumber: chapter.number, ownerEmail: book.ownerEmail, reviewer: true });
    try { review = parseStructuredReview(response.text); break; }
    catch (error) {
      lastReviewError = error;
      console.warn("[BOOK_STUDIO_REVIEW_FORMAT_RETRY]", JSON.stringify({ chapter: chapter.number, attempt, message: error instanceof Error ? error.message : "invalid envelope" }));
    }
    }
    if (!review) throw new Error("Reviewer returned invalid structured output after 2 attempts: " + (lastReviewError instanceof Error ? lastReviewError.message : "unknown error"));
    review.notes = review.notes.filter(note => !/chapter\s+(?:is|has)\s+[\d,]+\s+words/i.test(note));
    review.notes.unshift(`Deterministic word count: ${actualWordCount} words. Preferred range ${chapterMin}-${chapterMax}; hard bounds ${bands.hardFloor}-${bands.hardCap}.`);
    if (actualWordCount < bands.hardFloor || actualWordCount > bands.hardCap) {
      review.verdict = "NEEDS_CHANGES";
      review.notes.unshift("Deterministic hard length gate failed; revise before Canon approval.");
    } else if (actualWordCount < chapterMin || actualWordCount > chapterMax) {
      review.notes.unshift("Outside the preferred length range but inside the hard bounds; a PASS here is an earned exception, decided at review/approval.");
    }
    return review;
  }

  /**
   * Delta extraction for a chapter that is being approved as Canon without a
   * PASS review on record (human approval is sovereign, but continuity must
   * still learn what the chapter changed). Returns the review's delta fields
   * plus a factual summary. Throws on malformed output; the caller decides
   * whether approval proceeds regardless.
   */
  async extractContinuity(book: BookProject, chapterNumber: number, text: string): Promise<{ summary: string; continuityDelta: string[]; knowledgeDelta: string[]; relationshipDelta: string[] }> {
    await this.load();
    const chapter = book.chapters.find(item => item.number === chapterNumber);
    if (!chapter) throw new Error("Chapter not found");
    const response = await this.metered({
      profile: "review",
      system: [
        `You are the continuity recorder for ${book.title}.`,
        "Read the supplied canon chapter and return exactly one JSON object with keys summary, continuityDelta, knowledgeDelta, relationshipDelta.",
        "summary is one concise factual sentence about what happens in the chapter. Each delta field is an array of concise factual strings: continuityDelta = new established facts and events; knowledgeDelta = what named characters learned; relationshipDelta = how relationships changed. Record only what the chapter text establishes. Do not review, do not judge quality, do not invent."
      ].join(" "),
      prompt: JSON.stringify({ chapter: { number: chapter.number, title: chapter.title, povCharacterId: chapter.povCharacterId }, text }),
      maxOutputTokens: Math.max(1200, this.settingNumber("reviewerMaxOutputTokens", "BOOK_REVIEWER_MAX_OUTPUT_TOKENS", 1600)),
      telemetry: { sessionId: `${book.id}:chapter:${chapter.number}`, agentId: "continuity_extractor" }
    }, { operation: "continuity_extract", bookId: book.id, chapterNumber, ownerEmail: book.ownerEmail, reviewer: true });
    const clean = response.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed: any;
    try { parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)); } catch { throw new Error("Continuity extraction returned invalid JSON"); }
    const strings = (value: unknown) => Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()).map(item => String(item)) : [];
    if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim()) throw new Error("Continuity extraction missing summary");
    return {
      summary: parsed.summary.trim(),
      continuityDelta: strings(parsed.continuityDelta),
      knowledgeDelta: strings(parsed.knowledgeDelta),
      relationshipDelta: strings(parsed.relationshipDelta)
    };
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

}

