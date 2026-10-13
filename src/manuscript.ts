import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BookProject, Chapter } from "./types.js";

function manuscriptRoot() {
  return path.resolve(process.env.BOOK_STUDIO_MANUSCRIPT_DIR || "data/manuscripts");
}

function slug(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "book";
}

function bookDirectory(book: BookProject) {
  const root = manuscriptRoot();
  const directory = path.resolve(root, `${slug(book.title)}-${book.id.slice(0, 8)}`);
  if (directory !== root && !directory.startsWith(root + path.sep)) {
    throw new Error("Invalid manuscript output path");
  }
  return directory;
}

function atomicWrite(filePath: string, contents: string) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, filePath);
}

function chapterMarkdown(chapter: Chapter) {
  if (chapter.status !== "canon" || !chapter.approvedText.trim()) {
    throw new Error("Only human-approved canon chapters can be exported");
  }
  return `# Chapter ${chapter.number}: ${chapter.title.trim() || `Chapter ${chapter.number}`}\n\n${chapter.approvedText.trim()}\n`;
}

export function writeCanonChapter(book: BookProject, chapter: Chapter) {
  const directory = bookDirectory(book);
  const markdown = chapterMarkdown(chapter);
  atomicWrite(path.join(directory, `chapter-${String(chapter.number).padStart(3, "0")}.md`), markdown);
  syncBookManuscript(book, directory);
}

export function syncCanonChapters(books: BookProject[]) {
  for (const book of books) {
    const directory = bookDirectory(book);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const chapter of book.chapters) {
      if (chapter.status === "canon" && chapter.approvedText.trim()) {
        atomicWrite(path.join(directory, `chapter-${String(chapter.number).padStart(3, "0")}.md`), chapterMarkdown(chapter));
      }
    }
    syncBookManuscript(book, directory);
  }
}

function syncBookManuscript(book: BookProject, directory: string) {
  const chapters = [...book.chapters]
    .filter(chapter => chapter.status === "canon" && chapter.approvedText.trim())
    .sort((a, b) => a.number - b.number);
  const body = chapters.map(chapter => chapterMarkdown(chapter).trim()).join("\n\n---\n\n");
  const title = book.title.trim() || "Untitled manuscript";
  atomicWrite(path.join(directory, "manuscript.md"), `# ${title}\n\n${body}\n`);
}
