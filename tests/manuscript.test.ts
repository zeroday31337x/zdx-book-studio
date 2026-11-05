import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BookStore, seedCodebound } from "../src/store.js";
import { canonChapterPath, writeCanonChapter } from "../src/manuscript.js";

test("approved canon chapter is mirrored to markdown", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zdx-book-manuscript-"));
  const oldRoot = process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
  try {
    process.env.BOOK_STUDIO_MANUSCRIPT_DIR = path.join(dir, "manuscript");
    const store = new BookStore(path.join(dir, "books.json"));
    const book = seedCodebound(store);
    const chapter = book.chapters[0];
    chapter.status = "canon";
    chapter.approvedText = "The first canon paragraph.";
    chapter.title = "The Wrong Note";
    const target = writeCanonChapter(book, chapter);
    assert.equal(target, canonChapterPath(book, chapter));
    assert.equal(existsSync(target), true);
    assert.match(readFileSync(target, "utf8"), /^# Chapter 1 — The Wrong Note\n\nThe first canon paragraph\.\n$/);
  } finally {
    if (oldRoot === undefined) delete process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
    else process.env.BOOK_STUDIO_MANUSCRIPT_DIR = oldRoot;
    rmSync(dir, { recursive: true, force: true });
  }
});
