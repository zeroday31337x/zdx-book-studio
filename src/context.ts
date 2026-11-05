import type { BookProject, Chapter, Character } from "./types.js";
import { readBookDocument, readChapterDocument, readCharacterDocument, readContinuityDocument } from "./manuscript.js";

export function wordCount(text: string) { return text.trim() ? text.trim().split(/\s+/).length : 0; }

export function previousCanonRequired(book: BookProject, chapterNumber: number) {
  if (chapterNumber <= 1) return true;
  return book.chapters.slice(0, chapterNumber - 1).every(chapter => chapter.status === "canon");
}

export function chapterContext(book: BookProject, chapter: Chapter, pov: Character) {
  const prior = book.chapters.filter(item => item.number < chapter.number && item.status === "canon");
  const summaries = prior.map(item => `Ch ${item.number} (${book.characters.find(c => c.id === item.povCharacterId)?.name || item.povCharacterId}): ${item.review?.summary || "No summary"}`);
  const immediate = prior.slice(-1).map(item => ({ path: `chapters/${item.number}`, content: readChapterDocument(book, item) }));
  const ownPrevious = [...prior].reverse().find(item => item.povCharacterId === pov.id);
  const structure = chapter.structure.toLowerCase();
  const relevant = book.characters.filter(c => c.id !== pov.id && [c.name, c.id, c.guild].some(value => value && structure.includes(value.toLowerCase())));
  return {
    sourceDocuments: [
      { path: "book.md", content: readBookDocument(book) },
      { path: `characters/${pov.id}.md`, content: readCharacterDocument(book, pov, true) },
      ...relevant.map(character => ({ path: `characters/${character.id}.md`, content: readCharacterDocument(book, character, false) })),
      { path: "continuity.md", content: readContinuityDocument(book) },
      ...immediate
    ],
    chapter: { number: chapter.number, title: chapter.title, structure: chapter.structure, sourcePath: `chapters/${chapter.number}` },
    povCharacter: { id: pov.id, name: pov.name, guild: pov.guild },
    chapterSummaries: summaries,
    previousSamePovDocument: ownPrevious && !prior.slice(-1).includes(ownPrevious) ? readChapterDocument(book, ownPrevious) : ""
  };
}
