import { readFileSync } from "node:fs";
import { BookStore } from "../src/store.js";
import { wordCount } from "../src/context.js";

const store = new BookStore("/home/zdxadmin/zdx-book-studio/data/books.sqlite");
const book = store.list().find(item => item.title === "CodeBound");
if (!book) throw new Error("CodeBound not found");
const chapter = book.chapters.find(item => item.number === 8);
if (!chapter) throw new Error("Chapter 8 not found");
const raw = readFileSync("/home/zdxadmin/ch8.draft.md", "utf8");
const draft = raw.replace(/^# Chapter 8[^\n]*\n+/, "").trim();
chapter.draft = draft;
chapter.wordCount = wordCount(draft);
chapter.generatedAt = new Date().toISOString();
chapter.status = "draft";
chapter.review = undefined;
store.save(book);
console.log(JSON.stringify({ chapter: chapter.number, title: chapter.title, status: chapter.status, words: chapter.wordCount }));
