import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeBookMemoryPool, readBookContinuity, recordCanonChapter } from "../src/memory-pool.js";
import type { BookProject, Chapter } from "../src/types.js";

test("Book Studio writes approved canon continuity to its scoped Memory Pool adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zdx-book-memory-"));
  const oldBackend = process.env.ZDX_MEMORY_BOOK_STUDIO_BACKEND;
  const oldPath = process.env.ZDX_MEMORY_BOOK_STUDIO_SQLITE_PATH;
  process.env.ZDX_MEMORY_BOOK_STUDIO_BACKEND = "sqlite";
  process.env.ZDX_MEMORY_BOOK_STUDIO_SQLITE_PATH = join(directory, "memory.sqlite");
  const book = {
    id: "book-1",
    continuity: {
      timeline: ["Chapter 1: the signal appears"],
      facts: ["The signal is real"],
      unresolvedThreads: ["Who sent it?"],
      relationshipState: ["The protagonists distrust one another"],
      knowledgeState: ["Only the Phreaker has heard the signal"],
    },
  } as BookProject;
  const chapter = {
    number: 1,
    title: "The Signal",
    approvedText: "The signal came through the receiver.",
    approvedAt: new Date().toISOString(),
    review: {
      summary: "The Phreaker hears an impossible signal.",
      continuityDelta: ["The signal is real"],
      knowledgeDelta: ["The Phreaker heard the signal"],
      relationshipDelta: ["The protagonists distrust one another"],
    },
  } as Chapter;
  try {
    await recordCanonChapter(book, chapter);
    const memory = await readBookContinuity(book.id) as { latestCanonChapter?: number; timeline?: string[] } | null;
    assert.equal(memory?.latestCanonChapter, 1);
    assert.deepEqual(memory?.timeline, book.continuity.timeline);
  } finally {
    await closeBookMemoryPool();
    if (oldBackend === undefined) delete process.env.ZDX_MEMORY_BOOK_STUDIO_BACKEND;
    else process.env.ZDX_MEMORY_BOOK_STUDIO_BACKEND = oldBackend;
    if (oldPath === undefined) delete process.env.ZDX_MEMORY_BOOK_STUDIO_SQLITE_PATH;
    else process.env.ZDX_MEMORY_BOOK_STUDIO_SQLITE_PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
});
