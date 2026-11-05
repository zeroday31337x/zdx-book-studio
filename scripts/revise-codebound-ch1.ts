import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { BookStore } from "/home/zdxadmin/zdx-book-studio/src/store.ts";
import { chapterContext, wordCount } from "/home/zdxadmin/zdx-book-studio/src/context.ts";

async function main() {
  loadEnv({ path: "/home/zdxadmin/zdx-book-studio/.env" });
  loadEnv({ path: "/home/zdxadmin/zdx-agent-team/.env", override: false });
  process.env.OLLAMA_BASE_URL = process.env.BOOK_OLLAMA_BASE_URL || "http://127.0.0.1:11436";
  process.env.OLLAMA_MODEL = process.env.BOOK_OLLAMA_MODEL || "qwen3:30b-a3b-instruct-2507-q4_K_M";
  process.env.OLLAMA_MODELS = process.env.OLLAMA_MODEL;
  const providers = await import(pathToFileURL("/home/zdxadmin/zdx-agent-team/src/providers/providers.ts").href);
  const models = new providers.ProviderRouter([new providers.OllamaProvider()]);
  models.setPreferredModel("ollama", "qwen3:30b-a3b-instruct-2507-q4_K_M");
  models.setPreferredProvider("ollama");
  const store = new BookStore("/home/zdxadmin/zdx-book-studio/data/books.json");
  const book = store.list().find(b => b.title === "CodeBound");
  if (!book) throw new Error("CodeBound not found");
  const chapter = book.chapters[0];
  const pov = book.characters.find(c => c.id === chapter.povCharacterId)!;
  const baseDraft = readFileSync("/tmp/codebound-chapter1-base.txt", "utf8").trim();
  const packet = chapterContext(book, chapter, pov);
  const system = [
    `You are the dedicated POV prose writer for ${pov.name}. Revise Chapter 1, not any later chapter.`,
    "The authoritative Chapter 1 structure is a hard boundary: Sable tunes the Phreaker carrier tower, hears the impossible fourth harmonic, connects it to her brother's corridor death, handles the fractured shard, is confronted by Halden Rusk, and ends by deciding to attend the Confluence to investigate. The Confluence itself does NOT occur in Chapter 1.",
    "Do not introduce Tarin Kest, Nera Voss, Aurel Senn, the Confluence hall, or any later-chapter encounter. Do not let Sable already conclude that all three guilds are incomplete; at this point she only knows something is wrong and Halden is hiding information.",
    "Correct the timeline phrase implying only months have passed since her brother died; the loss happened years ago. Keep the shard and fourth harmonic mysterious without making the lattice sentient.",
    "Preserve the strongest imagery and emotional beats from the supplied draft, but rewrite as needed for coherence. Expand within the existing tower/Halden scenes through sensory detail, dialogue, interiority, and technical tension rather than advancing the plot.",
    "Target 1550-1900 words. Third-person limited through Sable only. No headings, summaries, explanations, or commentary.",
    "Return exactly one JSON object with a single key output containing the complete revised chapter prose."
  ].join(" ");
  const response = await models.generate({
    profile: "reasoning",
    system,
    prompt: JSON.stringify({ chapterPacket: packet, baseDraft, authoritativeStructure: chapter.structure }),
    maxOutputTokens: 4096,
    responseFormat: { type: "object", properties: { output: { type: "string" } }, required: ["output"], additionalProperties: false },
    telemetry: { sessionId: `${book.id}:chapter:1:revision`, agentId: "phreaker_writer_revision" }
  });
  const clean = response.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(clean);
  if (!parsed?.output || typeof parsed.output !== "string") throw new Error("revision output missing");
  const revised = parsed.output.trim();
  writeFileSync("/tmp/codebound-chapter1-revised.txt", revised + "\n");
  console.log("revision_words", wordCount(revised));
}

main().catch(err => { console.error(err); process.exit(1); });
