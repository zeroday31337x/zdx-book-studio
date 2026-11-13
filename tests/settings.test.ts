import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BookStore } from "../src/store.js";
import { effectiveSettings, validateSettingsPatch } from "../src/settings.js";

function withStore(run: (store: BookStore, dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "zdx-book-studio-settings-"));
  const previousManuscriptDir = process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
  process.env.BOOK_STUDIO_MANUSCRIPT_DIR = path.join(dir, "manuscript");
  try {
    run(new BookStore(path.join(dir, "books.json")), dir);
  } finally {
    if (previousManuscriptDir === undefined) delete process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
    else process.env.BOOK_STUDIO_MANUSCRIPT_DIR = previousManuscriptDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("app settings round-trip in the store", () => {
  withStore((store) => {
    assert.equal(store.getSetting("reviewerModel"), undefined);
    store.setSettings({ reviewerModel: "qwen3:32b" }, "admin@example.com");
    assert.equal(store.getSetting("reviewerModel"), "qwen3:32b");
    store.setSettings({ reviewerModel: "" }, "admin@example.com");
    assert.equal(store.getSetting("reviewerModel"), ""); // explicit empty beats env
    assert.equal(store.getAllSettings().reviewerModel, "");
  });
});

test("settings patch validation normalizes and rejects bad values", () => {
  const good = validateSettingsPatch({ reviewerModel: "qwen3:32b", reviewerMaxOutputTokens: 2000, legacyMirrorMs: "0" });
  assert.ok("values" in good);
  if ("values" in good) {
    assert.equal(good.values.reviewerModel, "qwen3:32b");
    assert.equal(good.values.reviewerMaxOutputTokens, "2000");
  }
  assert.ok("error" in validateSettingsPatch({ reviewerProvider: "groq" })); // the platform cannot designate a provider; the pool rotates its own
  assert.ok("error" in validateSettingsPatch({ modelRates: "{not json" }));
  assert.ok("error" in validateSettingsPatch({ modelRates: JSON.stringify({ x: { inputPer1M: "free" } }) }));
  assert.ok("error" in validateSettingsPatch({ reviewerMaxOutputTokens: 10 })); // below the 1200 floor
  assert.ok("error" in validateSettingsPatch({ unknownKey: "x" }));
});

test("effective settings resolve db > env > default", () => {
  const env = { BOOK_REVIEWER_MODEL: "qwen3:32b" } as NodeJS.ProcessEnv;
  const fromDefault = effectiveSettings({}, env);
  assert.equal(fromDefault.find(s => s.key === "reviewerModel")?.source, "env");
  assert.equal(fromDefault.find(s => s.key === "legacyMirrorMs")?.value, "900000");
  const fromDb = effectiveSettings({ reviewerModel: "" }, env);
  assert.deepEqual(fromDb.find(s => s.key === "reviewerModel"), { key: "reviewerModel", value: "", source: "db" });
});

test("legacy mirror interval can be driven by the DB setting", () => {
  withStore((store, dir) => {
    const mirror = path.join(dir, "books.json");
    const book = store.create({ title: "Settings Mirror", chapterCount: 1 });
    store.setSettings({ legacyMirrorMs: "0" }, "admin@example.com");
    writeFileSync(mirror, "SENTINEL", "utf8");
    book.title = "Settings Mirror Renamed";
    store.save(book);
    assert.notEqual(readFileSync(mirror, "utf8"), "SENTINEL"); // interval 0 from DB: rewritten
    store.setSettings({ legacyMirrorMs: "900000" }, "admin@example.com");
    writeFileSync(mirror, "SENTINEL2", "utf8");
    book.title = "Settings Mirror Renamed Again";
    store.save(book);
    assert.equal(readFileSync(mirror, "utf8"), "SENTINEL2"); // long interval from DB: throttled
  });
});
