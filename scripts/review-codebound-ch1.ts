import { readFileSync, writeFileSync } from "node:fs";
import { BookStore } from "../src/store.js";
import { BookAgentService } from "../src/agent-service.js";
import { wordCount } from "../src/context.js";

async function main() {
  const store = new BookStore("/home/zdxadmin/zdx-book-studio/data/books.json");
  const book = store.list().find(b => b.title === "CodeBound");
  if (!book) throw new Error("CodeBound not found");
  const chapter = book.chapters[0];
  const draft = readFileSync("/tmp/codebound-chapter1-revised.txt", "utf8").trim();
  console.log("reviewing_words", wordCount(draft));
  const agents = new BookAgentService();
  const review = await agents.reviewChapter(book, 1, draft);
  writeFileSync("/tmp/codebound-chapter1-revised-review.json", JSON.stringify(review, null, 2) + "\n");
  console.log("review_verdict", review.verdict);
  console.log("review_notes", review.notes.join(" | "));
}
main().catch(err => { console.error(err); process.exit(1); });
