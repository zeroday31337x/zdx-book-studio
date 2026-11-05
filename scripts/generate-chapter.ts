import { BookStore } from "../src/store.js";
import { BookAgentService } from "../src/agent-service.js";
import { previousCanonRequired, wordCount } from "../src/context.js";

async function main() {
  const chapterNumber = Number(process.argv[2]);
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) throw new Error("Usage: tsx scripts/generate-chapter.ts <chapterNumber>");
  const store = new BookStore("/home/zdxadmin/zdx-book-studio/data/books.json");
  const book = store.list().find(item => item.title === "CodeBound");
  if (!book) throw new Error("CodeBound not found");
  if (!previousCanonRequired(book, chapterNumber)) throw new Error("All previous chapters must be Canon first");
  const chapter = book.chapters.find(item => item.number === chapterNumber);
  if (!chapter) throw new Error("Chapter not found");
  const pov = book.characters.find(c => c.id === chapter.povCharacterId);
  const agents = new BookAgentService();
  console.log("writing", chapter.number, chapter.title, "POV", pov?.name);
  const draft = await agents.writeChapter(book, chapterNumber);
  chapter.draft = draft;
  chapter.wordCount = wordCount(draft);
  chapter.generatedAt = new Date().toISOString();
  chapter.status = "draft";
  store.save(book);
  console.log("draft_words", chapter.wordCount);
  console.log("draft_saved", chapter.number);
  console.log("reviewing");
  chapter.review = await agents.reviewChapter(book, chapterNumber, draft);
  chapter.status = chapter.review.verdict === "PASS" ? "reviewed" : "draft";
  store.save(book);
  console.log("review_verdict", chapter.review.verdict);
  console.log("review_notes", chapter.review.notes.join(" | "));
}

main().catch(error => { console.error(error); process.exit(1); });
