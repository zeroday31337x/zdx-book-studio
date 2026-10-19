import path from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import type { BookProject, ChapterReview, Character } from "./types.js";
import { chapterContext } from "./context.js";

loadEnv();
const coreEnv = process.env.ZDX_AGENT_ENV || path.resolve(process.cwd(), "../zdx-agent-team/.env");
loadEnv({ path: coreEnv, override: false });

const bookOllamaBaseUrl = process.env.BOOK_OLLAMA_BASE_URL || "http://127.0.0.1:11436";
const bookOllamaModel = process.env.BOOK_OLLAMA_MODEL || "qwen3:30b-a3b-instruct-2507-q4_K_M";
process.env.OLLAMA_BASE_URL = bookOllamaBaseUrl;
process.env.OLLAMA_MODEL = bookOllamaModel;
process.env.OLLAMA_MODELS = bookOllamaModel;

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
    this.models = new providers.ProviderRouter([new providers.OpenAIProvider(), new providers.GroqProvider(), new providers.GeminiProvider(), new providers.OllamaProvider()]);
    this.models.setPreferredModel("ollama", bookOllamaModel);
    this.models.setPreferredProvider("ollama");
  }

  async providerState() { await this.load(); return this.models.getProviderState(); }

  async writeChapter(book: BookProject, chapterNumber: number) {
    await this.load();
    const chapter = book.chapters.find(item => item.number === chapterNumber);
    if (!chapter) throw new Error("Chapter not found");
    const pov = book.characters.find(character => character.id === chapter.povCharacterId);
    if (!pov) throw new Error("Chapter POV character is not configured");
    if (!chapter.structure.trim()) throw new Error("Chapter structure is empty");
    const packet = { ...chapterContext(book, chapter, pov) };
    const writerId = `${pov.id}_writer`;
    const team = this.writerTeam(writerId, pov);
    const runtime = new this.core!.TeamRuntime(team, this.models);
    const objective = [
      `Write Chapter ${chapter.number} of ${book.title} from ${pov.name}'s limited POV.`,
      "The chapter structure is authoritative. Preserve established canon and continuity.",
      "Do not reveal information this POV character does not know. Do not summarize the chapter or explain your choices.",
      "Return polished novel prose only in the output field. End at the natural state required by the chapter structure."
    ].join(" ");
    const results = await runtime.run({ id: `${book.id}:chapter:${chapter.number}:writer`, objective, context: packet });
    const result = results.find((item: any) => item.agentId === writerId && item.status === "completed");
    if (!result || typeof result.output !== "string" || !result.output.trim()) throw new Error("POV writer did not return a substantive chapter");
    return result.output.trim();
  }

  async reviewChapter(book: BookProject, chapterNumber: number, draft: string): Promise<ChapterReview> {
    await this.load();
    const chapter = book.chapters.find(item => item.number === chapterNumber);
    if (!chapter) throw new Error("Chapter not found");
    const pov = book.characters.find(character => character.id === chapter.povCharacterId);
    if (!pov) throw new Error("Chapter POV character is not configured");
    const packet = { ...chapterContext(book, chapter, pov), candidateDraft: draft };
    const reviewerId = "book_reviewer";
    const runtime = new this.core!.TeamRuntime(this.reviewerTeam(reviewerId), this.models);
    const objective = [
      `Review the candidate Chapter ${chapter.number} of ${book.title}.`,
      "Check canon, continuity, chapter-structure compliance, limited-POV knowledge, character voice, pacing, repetition and obvious similarity/originality risks.",
      "Do not rewrite the chapter. Return a JSON object as your output string with keys verdict, notes, summary, continuityDelta, knowledgeDelta, relationshipDelta, originalityFlags.",
      "verdict must be PASS or NEEDS_CHANGES. Arrays must contain concise strings. summary must be a concise factual chapter summary for downstream context."
    ].join(" ");
    const results = await runtime.run({ id: `${book.id}:chapter:${chapter.number}:review`, objective, context: packet });
    const result = results.find((item: any) => item.agentId === reviewerId && item.status === "completed");
    if (!result || typeof result.output !== "string") throw new Error("Reviewer did not return output");
    return this.parseReview(result.output);
  }

  private writerTeam(writerId: string, pov: Character) {
    const budget = { maxTurns: 4, maxToolCalls: 0, maxRuntimeSeconds: 600 };
    return {
      id: `book-${pov.id}`, name: `${pov.name} Writing Team`, description: "Sequential POV manuscript generation", manager: "manager",
      policy: { maxChainExecutions: 4, requireApprovalFor: [], denyTools: [] }, workflow: { orderedAgents: [writerId], requireSubstantiveOutput: true },
      agents: [
        { id: "manager", name: "Book Orchestrator", role: "Protect the authoritative chapter contract", instructions: "Do not write the chapter yourself. Preserve the supplied canon, outline, continuity and POV boundary. Hand the exact bounded chapter objective to the configured writer through the runtime-controlled workflow.", modelProfile: "reasoning", tools: [], canDelegateTo: [writerId], budget },
        { id: writerId, name: `${pov.name} POV Writer`, role: `Write only ${pov.name}'s chapters`, instructions: `You are the dedicated POV prose writer for ${pov.name} of the ${pov.guild} guild. Maintain this character's distinct voice, biases, emotional defenses and knowledge limits. Treat supplied canon and approved prior chapters as immutable facts. The chapter structure defines required events but not exact prose. Never import private knowledge belonging to another character unless the supplied continuity says ${pov.name} learned it.`, modelProfile: "reasoning", tools: [], canDelegateTo: [], budget }
      ]
    };
  }

  private reviewerTeam(reviewerId: string) {
    const budget = { maxTurns: 4, maxToolCalls: 0, maxRuntimeSeconds: 600 };
    return {
      id: "book-review", name: "Book Review Team", description: "Independent manuscript gate", manager: "manager",
      policy: { maxChainExecutions: 4, requireApprovalFor: [], denyTools: [] }, workflow: { orderedAgents: [reviewerId], requireSubstantiveOutput: true },
      agents: [
        { id: "manager", name: "Book Orchestrator", role: "Route the candidate chapter to independent review", instructions: "Do not review the chapter yourself. Preserve the supplied evidence and send the exact review objective through the runtime-controlled workflow.", modelProfile: "reasoning", tools: [], canDelegateTo: [reviewerId], budget },
        { id: reviewerId, name: "Book Reviewer", role: "Independently gate chapter quality and continuity", instructions: "Review only the supplied candidate chapter against the authoritative book packet. Be conservative about canon contradictions and POV knowledge leaks. Flag similarity concerns for the dedicated Copyright platform rather than claiming legal infringement. Return the requested structured review and do not rewrite the prose.", modelProfile: "review", tools: [], canDelegateTo: [], budget }
      ]
    };
  }

  private parseReview(text: string): ChapterReview {
    const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed: any;
    try { parsed = JSON.parse(clean); }
    catch {
      const first = clean.indexOf("{"); const last = clean.lastIndexOf("}");
      if (first >= 0 && last > first) { try { parsed = JSON.parse(clean.slice(first, last + 1)); } catch {} }
    }
    const arr = (value: unknown) => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
    if (!parsed || (parsed.verdict !== "PASS" && parsed.verdict !== "NEEDS_CHANGES")) {
      return { verdict: "NEEDS_CHANGES", notes: [text.trim() || "Reviewer returned an invalid review envelope."], summary: "", continuityDelta: [], knowledgeDelta: [], relationshipDelta: [], originalityFlags: [], reviewedAt: new Date().toISOString() };
    }
    return { verdict: parsed.verdict, notes: arr(parsed.notes), summary: String(parsed.summary || ""), continuityDelta: arr(parsed.continuityDelta), knowledgeDelta: arr(parsed.knowledgeDelta), relationshipDelta: arr(parsed.relationshipDelta), originalityFlags: arr(parsed.originalityFlags), reviewedAt: new Date().toISOString() };
  }
}
