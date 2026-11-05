import { readFileSync } from "node:fs";
import { BookStore } from "../src/store.js";
import { wordCount } from "../src/context.js";

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
chapter.status = "draft";
chapter.review = undefined;
store.save(book);
console.log(JSON.stringify({ chapter: 9, title: chapter.title, status: chapter.status, words: chapter.wordCount }));
