import { writeFileSync } from "node:fs";
import { BookStore } from "../src/store.js";
import { OllamaProvider, ProviderRouter } from "../../zdx-agent-team/src/providers/providers.js";
import { wordCount } from "../src/context.js";

async function main() {
  const book = new BookStore("/home/zdxadmin/zdx-book-studio/data/books.sqlite").list().find(b => b.title === "CodeBound");
  if (!book) throw new Error("CodeBound not found");
  const chapter = book.chapters.find(c => c.number === 10);
  const sable = book.characters.find(c => c.id === "phreaker");
  if (!chapter || !sable) throw new Error("Chapter 10 context missing");
  const system = `Write polished techno-fantasy in intimate third-person limited Sable Rynn POV. Her perception is sensory, kinetic, dryly funny, and exact about sound. Target 1200-1500 words. Use dialogue, tension, disciplined technical wonder, and subtle unresolved attraction. Stay inside the supplied scene. No headings, explanations, modern computing, prophecy, or events beyond it. Return JSON exactly as {"output":"complete prose"}.`;
  const prompt = JSON.stringify({
    canon: "Spoken language transmits executable meaning through crystals and the Deep Current. Every act needs independent Carrier, Form, and Warrant. Sable masters Carrier, Tarin Form, Nera Warrant. Guild crystals secretly supply drifting defaults; no guild has the whole truth.",
    continuity: "Sable, Tarin, and Nera recently chose cooperation despite guild distrust. The fourth harmonic appears across guild work. Sable and Tarin respect each other but remain guarded.",
    scene: chapter.structure
  });
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11437";
  process.env.OLLAMA_MODEL = "llama3.1:70b";
  process.env.OLLAMA_MODELS = "llama3.1:70b";
  process.env.MODEL_OLLAMA_TIMEOUT_MS = "7200000";
  const models = new ProviderRouter([new OllamaProvider()]);
  const started = Date.now();
  const response = await models.generate({ profile: "reasoning", system, prompt, maxOutputTokens: 2600, responseFormat: { type: "object", properties: { output: { type: "string" } }, required: ["output"] } });
  const parsed = JSON.parse(response.text);
  const draft = String(parsed.output || "").trim();
  if (wordCount(draft) < 1000) throw new Error(`Llama candidate too short: ${wordCount(draft)} words`);
  const output = "/home/zdxadmin/ch10.llama3.1-70b.candidate.md";
  writeFileSync(output, `# Chapter 10 — ${chapter.title}\n\n${draft}\n`, "utf8");
  console.log(JSON.stringify({ event: "complete", words: wordCount(draft), elapsedSeconds: Math.round((Date.now()-started)/1000), output }));
}
main().catch(error => { console.error(error); process.exit(1); });
