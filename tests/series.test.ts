import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BookStore } from "../src/store.js";
import { chapterContext } from "../src/context.js";
import { readChapterDocument, bookDirectory } from "../src/manuscript.js";
import {
  activeAttachments, attachmentStatus, canonSeal, makeAttachment,
  seriesContextDocuments, validateAttachment,
} from "../src/series.js";
import type { BookProject, Chapter, Character } from "../src/types.js";

function character(id: string, name: string, privateKnowledge = ""): Character {
  return {
    id, name, guild: "Guild", role: "protagonist",
    publicProfile: `${name} public profile`, worldview: "", wound: "", strength: "",
    blindSpot: "", voice: `${name} voice`, privateKnowledge,
  };
}
function chapter(number: number, status: Chapter["status"], approvedText = "", povCharacterId = "mara"): Chapter {
  return { number, title: `Chapter ${number}`, povCharacterId, structure: "contract", status, draft: "", approvedText, wordCount: 0 };
}
function book(id: string, title: string, overrides: Partial<BookProject> = {}): BookProject {
  return {
    id, title, tagline: "", genre: "", tone: "", premise: "", overview: "", canon: "",
    chapterCount: 2, movementCount: 1, targetWords: 4000, status: "production",
    characters: [character("mara", "Mara", "Mara secretly knows the cipher.")],
    chapters: [], continuity: { timeline: [], facts: [], unresolvedThreads: [], relationshipState: [], knowledgeState: [] },
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
function sourceBook(): BookProject {
  return book("book-1", "First Light", {
    seriesName: "Ember Saga",
    chapters: [
      chapter(1, "canon", "Mara crossed the ash sea and learned the harbor cipher from the keeper.", "mara"),
      chapter(2, "draft", "", "mara"),
    ],
    continuity: {
      timeline: ["Mara crossed the ash sea"],
      facts: ["The harbor cipher opens the lower gate"],
      unresolvedThreads: [], relationshipState: [],
      knowledgeState: ["Mara learned the harbor cipher"],
    },
  });
}

test("canon seal counts canon only — drafts are invisible to it", () => {
  const source = sourceBook();
  source.chapters[1].draft = "DRAFTSECRET planted text";
  const seal = canonSeal(source);
  assert.equal(seal.chapters, 1);
  assert.ok(seal.words > 0);
  const changed = sourceBook();
  changed.chapters[0].approvedText += " One more canon sentence.";
  assert.notEqual(canonSeal(changed).hash, seal.hash);
});

test("attachment guards: self, duplicate, no canon, series mismatch", () => {
  const source = sourceBook();
  const target = book("book-2", "Second Light", { seriesName: "ember saga" });
  assert.equal(validateAttachment(target, source), null); // case-insensitive series match
  assert.equal(validateAttachment(source, source), "cannot_attach_own_book");
  assert.equal(validateAttachment(book("book-3", "Other", { seriesName: "Other Saga" }), source), "different_series");
  assert.equal(validateAttachment(book("book-4", "No Series"), source), "different_series");
  const draftOnly = book("book-5", "Drafts", { seriesName: "Ember Saga", chapters: [chapter(1, "draft")] });
  assert.equal(validateAttachment(target, draftOnly), "source_has_no_canon");
  const attached = book("book-6", "Second Light", { seriesName: "Ember Saga", attachments: [makeAttachment(source)] });
  assert.equal(validateAttachment(attached, source), "already_attached");
});

test("seal verification: active, then stale when the source canon changes, missing when gone", () => {
  const source = sourceBook();
  const attachment = makeAttachment(source);
  assert.equal(attachmentStatus(attachment, source), "active");
  const evolved = sourceBook();
  evolved.chapters.push(chapter(2, "canon", "A new canon chapter appears."));
  assert.equal(attachmentStatus(attachment, evolved), "stale");
  assert.equal(attachmentStatus(attachment, undefined), "missing");

  const target = book("book-2", "Second Light", { seriesName: "Ember Saga", attachments: [attachment] });
  assert.equal(activeAttachments(target, id => (id === "book-1" ? source : undefined)).length, 1);
  assert.equal(activeAttachments(target, id => (id === "book-1" ? evolved : undefined)).length, 0); // stale feeds nothing
});

test("series context: canon only, knowledge partitioned per character", () => {
  const source = sourceBook();
  source.chapters[1].draft = "DRAFTSECRET planted text";
  source.characters.push(character("orin", "Orin", "ORINPRIVATE planted secret"));
  const docs = seriesContextDocuments({ attachment: makeAttachment(source), source }, source.characters[0]);
  const all = docs.map(doc => doc.content).join("\n");
  assert.ok(all.includes("harbor cipher")); // canon fact present
  assert.ok(!all.includes("DRAFTSECRET")); // drafts never leak
  assert.ok(!all.includes("ORINPRIVATE")); // another character's private knowledge never leaks
  assert.ok(all.includes("Mara secretly knows the cipher.")); // the POV character's own Book 1 file carries over
  const carryover = docs.find(doc => doc.path.endsWith("knowledge-carryover.md"));
  assert.ok(carryover && carryover.content.includes("Mara learned the harbor cipher"));
  const stranger = character("zed", "Zed");
  const docsForStranger = seriesContextDocuments({ attachment: makeAttachment(source), source }, stranger);
  assert.ok(docsForStranger.find(doc => doc.path.endsWith("knowledge-carryover.md"))!.content.includes("no carried knowledge"));
});

test("chapter context includes series documents only when attachments are resolved", () => {
  const source = sourceBook();
  const target = book("book-2", "Second Light", {
    seriesName: "Ember Saga",
    chapters: [chapter(1, "planned", "", "mara")],
    attachments: [makeAttachment(source)],
  });
  const pov = target.characters[0];
  const withSeries = chapterContext(target, target.chapters[0], pov, activeAttachments(target, () => source));
  assert.ok(withSeries.sourceDocuments.some(doc => doc.path.startsWith("series/")));
  const without = chapterContext(target, target.chapters[0], pov);
  assert.ok(!without.sourceDocuments.some(doc => doc.path.startsWith("series/")));
});

test("prompt reads are DB-first: a stale on-disk chapter file cannot override the database", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zdx-book-studio-dbfirst-"));
  const previous = process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
  process.env.BOOK_STUDIO_MANUSCRIPT_DIR = dir;
  try {
    const b = book("book-9", "Db First", { chapters: [chapter(1, "canon", "DATABASE truth text")] });
    const root = bookDirectory(b);
    mkdirSync(path.join(root, "chapters"), { recursive: true });
    writeFileSync(path.join(root, "chapters", "01-chapter-1.md"), "STALE FILE text", "utf8");
    assert.ok(readChapterDocument(b, b.chapters[0]).includes("DATABASE truth text"));
    assert.ok(!readChapterDocument(b, b.chapters[0]).includes("STALE FILE"));
  } finally {
    if (previous === undefined) delete process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
    else process.env.BOOK_STUDIO_MANUSCRIPT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("series fields persist through the store (book metadata)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zdx-book-studio-series-"));
  const previous = process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
  process.env.BOOK_STUDIO_MANUSCRIPT_DIR = path.join(dir, "manuscript");
  try {
    const store = new BookStore(path.join(dir, "books.json"));
    const created = store.create({ title: "Persisted", chapterCount: 1, seriesName: "Ember Saga" });
    created.attachments = [makeAttachment(sourceBook())];
    store.save(created);
    const loaded = store.get(created.id)!;
    assert.equal(loaded.seriesName, "Ember Saga");
    assert.equal(loaded.attachments?.length, 1);
    assert.equal(loaded.attachments?.[0].title, "First Light");
  } finally {
    if (previous === undefined) delete process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
    else process.env.BOOK_STUDIO_MANUSCRIPT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
