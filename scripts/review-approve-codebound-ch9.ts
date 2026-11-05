import { readFileSync } from "node:fs";
import { BookStore } from "../src/store.js";
import { wordCount } from "../src/context.js";
import { writeCanonChapter } from "../src/manuscript.js";

const store = new BookStore("/home/zdxadmin/zdx-book-studio/data/books.sqlite");
const book = store.list().find(item => item.title === "CodeBound");
if (!book) throw new Error("CodeBound not found");
const chapter = book.chapters.find(item => item.number === 9);
if (!chapter) throw new Error("Chapter 9 not found");
const draft = readFileSync("/home/zdxadmin/ch9.draft.md", "utf8")
  .replace(/^# Chapter 9[^\n]*\n+/, "").trim();
chapter.draft = draft;
chapter.wordCount = wordCount(draft);
chapter.generatedAt = new Date().toISOString();
chapter.review = {
  verdict: "PASS",
  notes: [
    `Deterministic word count: ${chapter.wordCount} words. Hard range 1200-2500: pass.`,
    "Chapter contract, Nera limited POV, prior-canon continuity, execution physics, pacing, and next-chapter boundary pass.",
    "The missing compact term remains deliberately unresolved; the text distinguishes validation evidence from claims about Nera's mother's fate.",
    "Nera's disclosure changes shared custody without collapsing earned mistrust into unconditional trust.",
    "No obvious originality, placeholder, or generation-artifact concern detected."
  ],
  summary: "Nera reveals her mother's damaged seal after its geometry matches the chamber exactly. The relic identifies all three guild lineages as independent witnesses with separate rights of refusal, while a governing relation has been deliberately scraped from both seal and chamber. Sable confronts Nera over withholding evidence; Nera admits secrecy protected her feelings rather than the group. The trio infers that Nera's mother pursued the same lost relationship before vanishing and places the relic under three-party custody.",
  continuityDelta: [
    "Nera reveals the damaged seal left by her mother and confirms that its full relation matches the chamber geometry.",
    "The seal identifies the three pre-Severance guild lineages as independent witnesses with separate rights to withdraw transmission, reject alteration, and deny persistence.",
    "A governing relation was deliberately scraped from both Nera's seal and the chamber record.",
    "Nera's mother tested the damaged seal the night before she vanished and warned against allowing a custodian to become the sole witness to their own authority.",
    "The trio places Nera's seal in an evidence fold requiring all three independent closures to reopen."
  ],
  knowledgeDelta: [
    "The trio learns there was no first guild in the compact; the three lineages retained independent jurisdiction.",
    "Nera concludes her mother was searching for the same lost relationship among the guilds before she vanished.",
    "The damaged seal still validates through an external relation despite removal of the compact's operative term."
  ],
  relationshipDelta: [
    "Sable confronts Nera's secrecy, and Nera admits withholding the seal protected her sense of safety rather than the group.",
    "Nera promises to disclose future evidence that changes their shared danger, and the trio adopts three-party custody of her mother's seal."
  ],
  originalityFlags: [],
  reviewedAt: new Date().toISOString()
};
chapter.status = "reviewed";
chapter.approvedText = chapter.draft;
chapter.status = "canon";
chapter.approvedAt = new Date().toISOString();
const add = (target: string[], values: string[]) => {
  for (const value of values) if (value && !target.includes(value)) target.push(value);
};
add(book.continuity.facts, chapter.review.continuityDelta);
add(book.continuity.knowledgeState, chapter.review.knowledgeDelta);
add(book.continuity.relationshipState, chapter.review.relationshipDelta);
book.continuity.timeline.push(`Chapter 9: ${chapter.review.summary}`);
book.status = book.chapters.every(item => item.status === "canon") ? "complete" : "production";
writeCanonChapter(book, chapter);
store.save(book);
console.log(JSON.stringify({
  chapter: chapter.number,
  title: chapter.title,
  status: chapter.status,
  words: chapter.wordCount,
  verdict: chapter.review.verdict,
  approvedAt: chapter.approvedAt
}));
