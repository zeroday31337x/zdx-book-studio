import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeCanonChapter, syncCanonChapters } from "../src/manuscript.js";
import type { BookProject, Chapter } from "../src/types.js";

function sampleBook(chapterStatus: Chapter["status"] = "canon"): BookProject {
  const chapter: Chapter = {
    number: 1, title: "First Signal", povCharacterId: "writer", structure: "The signal arrives.",
    status: chapterStatus, draft: "The signal arrives.", approvedText: "The signal arrives.",
    wordCount: 3
  };
  return {
    id: "12345678-1234-1234-1234-123456789012", title: "../Safe Book",
    tagline: "", genre: "", tone: "", premise: "", overview: "", canon: "",
    chapterCount: 1, movementCount: 1, targetWords: 1000, status: "production",
    characters: [], chapters: [chapter],
    continuity: { timeline: [], facts: [], unresolvedThreads: [], relationshipState: [], knowledgeState: [] },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
}

test("exports only approved canon to safe, atomic manuscript paths", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "zdx-manuscript-test-"));
  const previous = process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
  process.env.BOOK_STUDIO_MANUSCRIPT_DIR = directory;
  try {
    const book = sampleBook();
    writeCanonChapter(book, book.chapters[0]!);
    const bookDir = path.join(directory, "safe-book-12345678");
    const chapterPath = path.join(bookDir, "chapter-001.md");
    assert.ok(existsSync(chapterPath));
    assert.match(readFileSync(chapterPath, "utf8"), /# Chapter 1: First Signal/);
    assert.match(readFileSync(path.join(bookDir, "manuscript.md"), "utf8"), /The signal arrives\./);
    assert.equal(existsSync(path.join(directory, "Safe Book")), false);
  } finally {
    if (previous === undefined) delete process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
    else process.env.BOOK_STUDIO_MANUSCRIPT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup sync ignores unapproved drafts", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "zdx-manuscript-test-"));
  const previous = process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
  process.env.BOOK_STUDIO_MANUSCRIPT_DIR = directory;
  try {
    const book = sampleBook("draft");
    syncCanonChapters([book]);
    const bookDir = path.join(directory, "safe-book-12345678");
    assert.equal(existsSync(path.join(bookDir, "chapter-001.md")), false);
    assert.doesNotMatch(readFileSync(path.join(bookDir, "manuscript.md"), "utf8"), /The signal arrives\./);
  } finally {
    if (previous === undefined) delete process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
    else process.env.BOOK_STUDIO_MANUSCRIPT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
