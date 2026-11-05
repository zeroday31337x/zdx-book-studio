import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BookProject, Chapter, Character } from "./types.js";

const manuscriptRoot = () => path.resolve(process.env.BOOK_STUDIO_MANUSCRIPT_DIR || "manuscript");

export function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "book";
}

export function bookDirectory(book: BookProject) { return path.join(manuscriptRoot(), slug(book.title)); }

export function chapterFileName(chapter: Chapter) {
  return `${String(chapter.number).padStart(2, "0")}-${slug(chapter.title)}.md`;
}

export function canonChapterPath(book: BookProject, chapter: Chapter) {
  return path.join(bookDirectory(book), chapterFileName(chapter));
}

function atomicWrite(filePath: string, content: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  renameSync(temp, filePath);
}

export function renderBookFile(book: BookProject) {
  return `# ${book.title}\n\n## Tagline\n\n${book.tagline}\n\n## Genre\n\n${book.genre}\n\n## Tone\n\n${book.tone}\n\n## Premise\n\n${book.premise}\n\n## Overview\n\n${book.overview}\n\n## Canon\n\n${book.canon}\n`;
}

export function renderCharacterFile(character: Character, includePrivate = true) {
  const privateSection = includePrivate ? `\n## Private Knowledge\n\n${character.privateKnowledge}\n` : "";
  return `# ${character.name}\n\n- ID: ${character.id}\n- Guild: ${character.guild}\n- Role: ${character.role}\n${character.povOrder ? `- POV order: ${character.povOrder}\n` : ""}\n## Public Profile\n\n${character.publicProfile}\n\n## Worldview\n\n${character.worldview}\n\n## Wound\n\n${character.wound}\n\n## Strength\n\n${character.strength}\n\n## Blind Spot\n\n${character.blindSpot}\n\n## Voice\n\n${character.voice}\n${privateSection}`;
}

export function renderContinuityFile(book: BookProject) {
  const section = (title: string, values: string[]) => `## ${title}\n\n${values.length ? values.map(value => `- ${value}`).join("\n") : "- None recorded."}\n`;
  return `# ${book.title} Continuity\n\n${section("Timeline", book.continuity.timeline)}\n${section("Facts", book.continuity.facts)}\n${section("Unresolved Threads", book.continuity.unresolvedThreads)}\n${section("Relationships", book.continuity.relationshipState)}\n${section("Knowledge State", book.continuity.knowledgeState)}`;
}

export function renderChapterFile(chapter: Chapter) {
  const prose = chapter.status === "canon" ? chapter.approvedText : chapter.draft;
  return `# Chapter ${chapter.number} — ${chapter.title}\n\n- POV: ${chapter.povCharacterId}\n- Status: ${chapter.status}\n- Words: ${chapter.wordCount}\n\n## Chapter Contract\n\n${chapter.structure}\n\n## Prose\n\n${prose}\n`;
}

export function syncBookFiles(book: BookProject) {
  const root = bookDirectory(book);
  const chaptersDir = path.join(root, "chapters");
  atomicWrite(path.join(root, "book.md"), renderBookFile(book));
  atomicWrite(path.join(root, "continuity.md"), renderContinuityFile(book));
  for (const character of book.characters) atomicWrite(path.join(root, "characters", `${slug(character.id)}.md`), renderCharacterFile(character));
  for (const chapter of book.chapters) atomicWrite(path.join(chaptersDir, chapterFileName(chapter)), renderChapterFile(chapter));
  const expected = new Set(book.chapters.map(chapterFileName));
  for (const file of readdirSync(chaptersDir)) if (/^\d+-.*\.md$/.test(file) && !expected.has(file)) unlinkSync(path.join(chaptersDir, file));
}

export function syncCanonChapters(books: BookProject[]) { for (const book of books) syncBookFiles(book); }
export function writeCanonChapter(book: BookProject, chapter: Chapter) {
  const target = canonChapterPath(book, chapter);
  atomicWrite(target, `# Chapter ${chapter.number} — ${chapter.title}\n\n${chapter.approvedText}\n`);
  syncBookFiles(book);
  return target;
}

export function readBookDocument(book: BookProject) {
  const filePath = path.join(bookDirectory(book), "book.md");
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : renderBookFile(book);
}

export function readContinuityDocument(book: BookProject) {
  const filePath = path.join(bookDirectory(book), "continuity.md");
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : renderContinuityFile(book);
}

export function readCharacterDocument(book: BookProject, character: Character, includePrivate = true) {
  const filePath = path.join(bookDirectory(book), "characters", `${slug(character.id)}.md`);
  if (includePrivate && existsSync(filePath)) return readFileSync(filePath, "utf8");
  return renderCharacterFile(character, includePrivate);
}

export function readChapterDocument(book: BookProject, chapter: Chapter) {
  const filePath = path.join(bookDirectory(book), "chapters", chapterFileName(chapter));
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : renderChapterFile(chapter);
}
