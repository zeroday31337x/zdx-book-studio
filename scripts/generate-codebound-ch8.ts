import "dotenv/config";
import { BookStore } from "../src/store.js";
import { BookAgentService } from "../src/agent-service.js";
import { previousCanonRequired, wordCount } from "../src/context.js";

async function main() {
  const store = new BookStore("/home/zdxadmin/zdx-book-studio/data/books.sqlite");
  const book = store.list().find(item => item.title === "CodeBound");
  if (!book) throw new Error("CodeBound not found");
  const chapter = book.chapters.find(item => item.number === 8);
  if (!chapter) throw new Error("Chapter 8 not found");
  if (!previousCanonRequired(book, 8)) throw new Error("All previous chapters must be Canon");
  console.log(JSON.stringify({ event: "writing", chapter: 8, title: chapter.title, pov: chapter.povCharacterId }));
  const draft = await new BookAgentService().writeChapter(book, 8);
  chapter.draft = draft;
  chapter.wordCount = wordCount(draft);
  chapter.generatedAt = new Date().toISOString();
  chapter.status = "draft";
  chapter.review = undefined;
  store.save(book);
  console.log(JSON.stringify({ event: "saved", status: chapter.status, words: chapter.wordCount }));
}
main().catch(error => { console.error(error); process.exit(1); });
