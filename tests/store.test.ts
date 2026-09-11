import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BookStore, seedCodebound } from "../src/store.js";
import { previousCanonRequired, wordCount } from "../src/context.js";

test("CodeBound seed creates 42 chapters with 14 POV chapters each", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zdx-book-studio-"));
  try {
    const store = new BookStore(path.join(dir, "books.json"));
    const book = seedCodebound(store);
    assert.equal(book.chapterCount, 42);
    assert.equal(book.characters.length, 3);
    for (const id of ["phreaker", "hacker", "crypto"]) assert.equal(book.chapters.filter(ch => ch.povCharacterId === id).length, 14);
    assert.equal(seedCodebound(store).id, book.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sequential gate requires all prior chapters to be canon", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zdx-book-studio-"));
  try {
    const store = new BookStore(path.join(dir, "books.json"));
    const book = seedCodebound(store);
    assert.equal(previousCanonRequired(book, 1), true);
    assert.equal(previousCanonRequired(book, 2), false);
    book.chapters[0].status = "canon";
    assert.equal(previousCanonRequired(book, 2), true);
    assert.equal(previousCanonRequired(book, 3), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("wordCount handles draft prose", () => {
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount("one two\nthree"), 3);
});
