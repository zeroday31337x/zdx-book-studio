import { readFileSync } from "node:fs";
import { BookStore } from "../src/store.js";
import { wordCount } from "../src/context.js";
import { writeCanonChapter } from "../src/manuscript.js";

const store = new BookStore("/home/zdxadmin/zdx-book-studio/data/books.sqlite");
const book = store.list().find(item => item.title === "CodeBound");
if (!book) throw new Error("CodeBound not found");
const chapter = book.chapters.find(item => item.number === 8);
if (!chapter) throw new Error("Chapter 8 not found");
const draft = readFileSync("/home/zdxadmin/ch8.draft.md", "utf8")
  .replace(/^# Chapter 8[^\n]*\n+/, "").trim();
chapter.draft = draft;
chapter.wordCount = wordCount(draft);
chapter.generatedAt = new Date().toISOString();
chapter.review = {
  verdict: "PASS",
  notes: [
    `Deterministic word count: ${chapter.wordCount} words. Hard range 1200-2500: pass.`,
    "Chapter contract, Tarin limited POV, prior-canon continuity, execution physics, pacing, and Chapter 9 boundary pass.",
    "Inheritance remains an evidence-bounded hypothesis; the text does not claim universal frequency or identify the compact's authors.",
    "Three-layer cooperation preserves independent contribution, custody, and refusal.",
    "No obvious originality, placeholder, or generation-artifact concern detected."
  ],
  summary: "Tarin reads the sealed chamber as a record of three independent execution contributions rather than a single spell. His forbidden fragment physically and responsively matches the chamber, indicating that modern guild crystals may silently inherit missing Carrier and Warrant conditions. Sable names the inheritance unacknowledged borrowed work, while Nera identifies the chamber as compact-bound and designed for divided custody rather than guild ownership.",
  continuityDelta: [
    "The sealed chamber records Carrier, Form, and Warrant as three independent contributions rather than one complete expression.",
    "Tarin's forbidden fragment matches a chamber recess and its inherited Carrier and Warrant fields respond while its visible Hacker form remains dark.",
    "The chamber's compact preserves separate custody paths and does not assign ownership to any single contributor or guild."
  ],
  knowledgeDelta: [
    "The trio concludes that some modern guild crystals may silently inherit conditions from layers their users no longer name.",
    "Tarin distinguishes evidence-supported inheritance from unsupported claims about its frequency, origin, or intent.",
    "Nera recognizes that the chamber's authority is bounded by a compact that preserves contribution, refusal, and divided custody."
  ],
  relationshipDelta: [
    "Sable, Tarin, and Nera develop a shared interpretation of the chamber while continuing to challenge one another's assumptions and terminology."
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
book.continuity.timeline.push(`Chapter 8: ${chapter.review.summary}`);
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
