import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BookStore } from "../src/store.js";
import { AuthStore } from "../src/auth.js";
import { chapterLengthBands } from "../src/context.js";
import { costFor, estimateTokens, loadRateCard } from "../src/usage.js";
import type { BookProject } from "../src/types.js";

function withStore(run: (store: BookStore, dir: string) => void, mirrorMs?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "zdx-book-studio-usage-"));
  const previousManuscriptDir = process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
  const previousMirror = process.env.BOOK_STUDIO_LEGACY_MIRROR_MS;
  process.env.BOOK_STUDIO_MANUSCRIPT_DIR = path.join(dir, "manuscript");
  if (mirrorMs === undefined) delete process.env.BOOK_STUDIO_LEGACY_MIRROR_MS;
  else process.env.BOOK_STUDIO_LEGACY_MIRROR_MS = mirrorMs;
  try {
    run(new BookStore(path.join(dir, "books.json")), dir);
  } finally {
    if (previousManuscriptDir === undefined) delete process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
    else process.env.BOOK_STUDIO_MANUSCRIPT_DIR = previousManuscriptDir;
    if (previousMirror === undefined) delete process.env.BOOK_STUDIO_LEGACY_MIRROR_MS;
    else process.env.BOOK_STUDIO_LEGACY_MIRROR_MS = previousMirror;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rate card: self-hosted pool defaults to $0, env rates price paid models", () => {
  const card = loadRateCard({});
  assert.equal(costFor(card, "ollama", "qwen3:32b", 1_000_000, 1_000_000), 0);
  const paid = loadRateCard({ BOOK_STUDIO_MODEL_RATES: JSON.stringify({ "groq:llama": { inputPer1M: 0.5, outputPer1M: 1 } }) });
  assert.equal(costFor(paid, "groq", "llama", 1_000_000, 500_000), 1);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
});

test("usage ledger records and aggregates per user, book and model", () => {
  withStore((store) => {
    const base = { chapterNumber: 1, agentId: "sable_writer", tokensEstimated: false, latencyMs: 1000, costUsd: 0, status: "success" as const };
    store.recordUsage({ ...base, ownerEmail: "a@example.com", bookId: "book-1", operation: "write", provider: "ollama", model: "m1", inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    store.recordUsage({ ...base, ownerEmail: "a@example.com", bookId: "book-1", operation: "review", provider: "ollama", model: "m1", inputTokens: 200, outputTokens: 20, totalTokens: 220, status: "error" });
    store.recordUsage({ ...base, ownerEmail: "b@example.com", bookId: "book-2", operation: "write", provider: "groq", model: "m2", inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.25 });

    const totals = store.usageTotals();
    assert.equal(totals.calls, 3);
    assert.equal(totals.errors, 1);
    assert.equal(totals.totalTokens, 385);
    assert.equal(totals.costUsd, 0.25);

    const forA = store.usageForUser("a@example.com");
    assert.equal(forA.calls, 2);
    assert.equal(forA.totalTokens, 370);
    assert.equal(store.usageForBook("book-2").calls, 1);
    assert.equal(store.usageByUser().length, 2);
    assert.equal(store.usageByModel().length, 2);
    const recent = store.usageRecent(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].ownerEmail, "b@example.com");
  });
});

test("length bands: preferred is advisory, hard bounds are separate and configurable", () => {
  const book = { targetWords: 81900, chapterCount: 42, chapterTargetWords: 1950 } as BookProject;
  const bands = chapterLengthBands(book);
  assert.equal(bands.preferredMin, 1560);
  assert.equal(bands.preferredMax, 2340);
  assert.equal(bands.hardFloor, 1170);
  assert.equal(bands.hardCap, 2535); // ceil(1950 * 1.3)
  const capped = chapterLengthBands({ ...book, hardChapterWordCap: 2500 });
  assert.equal(capped.hardCap, 2500);
});

test("incremental save keeps untouched data intact across repeated saves", () => {
  withStore((store) => {
    const book = store.create({ title: "Ledger Book", chapterCount: 3, ownerEmail: "a@example.com" });
    book.chapters[0].draft = "first draft";
    book.chapters[0].status = "draft";
    store.save(book);
    const again = store.get(book.id)!;
    again.chapters[1].draft = "second draft";
    again.chapters[1].status = "draft";
    store.save(again);
    const final = store.get(book.id)!;
    assert.equal(final.chapters[0].draft, "first draft");
    assert.equal(final.chapters[1].draft, "second draft");
    assert.equal(final.chapters.length, 3);
  });
});

test("legacy mirror is throttled between saves and forced at interval 0", () => {
  withStore((store, dir) => {
    const mirror = path.join(dir, "books.json");
    const book = store.create({ title: "Mirror Book", chapterCount: 1 });
    assert.equal(existsSync(mirror), true);
    writeFileSync(mirror, "SENTINEL", "utf8");
    book.title = "Mirror Book Renamed";
    store.save(book);
    assert.equal(readFileSync(mirror, "utf8"), "SENTINEL"); // throttled: not rewritten
    store.flushLegacyMirror();
    assert.notEqual(readFileSync(mirror, "utf8"), "SENTINEL"); // flush forces a rewrite
  });
  withStore((store, dir) => {
    const mirror = path.join(dir, "books.json");
    const book = store.create({ title: "Mirror Zero", chapterCount: 1 });
    writeFileSync(mirror, "SENTINEL", "utf8");
    book.title = "Mirror Zero Renamed";
    store.save(book);
    assert.notEqual(readFileSync(mirror, "utf8"), "SENTINEL"); // interval 0: always rewritten
  }, "0");
});

test("auth authenticate does not rewrite the auth file on a plain read", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zdx-book-studio-auth-"));
  try {
    const file = path.join(dir, "auth.json");
    const auth = new AuthStore(file);
    auth.seedAdmin("admin@example.com", "temporary-password-123");
    const session = auth.login("admin@example.com", "temporary-password-123");
    assert.ok(session);
    const before = readFileSync(file, "utf8");
    assert.equal(auth.authenticate(session!.token)?.email, "admin@example.com");
    assert.equal(auth.authenticate(session!.token)?.email, "admin@example.com");
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(auth.authenticate("bogus-token"), null);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
