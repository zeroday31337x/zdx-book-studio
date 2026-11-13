import type { BookProject, Chapter, Character } from "./types.js";
import { readBookDocument, readChapterDocument, readCharacterDocument, readContinuityDocument } from "./manuscript.js";
import { seriesContextDocuments, type ResolvedAttachment } from "./series.js";

export function wordCount(text: string) { return text.trim() ? text.trim().split(/\s+/).length : 0; }

export interface ChapterLengthBands {
  target: number;
  /** Advisory range the writer aims for and the reviewer judges exceptions against. */
  preferredMin: number;
  preferredMax: number;
  /** Deterministic bounds: outside these, a draft cannot pass review or generation validation. */
  hardFloor: number;
  hardCap: number;
}

/**
 * Two-tier length policy. The preferred band (+/-20% of target) is advisory:
 * a draft inside the hard bounds but outside the preferred band can earn an
 * exception at review/approval. The hard bounds are enforced in code.
 * hardCap comes from the book's explicit cap when set (CodeBound ran with a
 * 2,500-word hard cap), otherwise 1.3x target.
 */
export function chapterLengthBands(book: BookProject, chapterTarget?: number): ChapterLengthBands {
  const target = Math.max(600, chapterTarget ?? book.chapterTargetWords ?? Math.round(book.targetWords / book.chapterCount));
  return {
    target,
    preferredMin: Math.round(target * 0.8),
    preferredMax: Math.round(target * 1.2),
    hardFloor: Math.floor(target * 0.6),
    hardCap: book.hardChapterWordCap && book.hardChapterWordCap > 0 ? book.hardChapterWordCap : Math.ceil(target * 1.3),
  };
}

export function previousCanonRequired(book: BookProject, chapterNumber: number) {
  if (chapterNumber <= 1) return true;
  return book.chapters.slice(0, chapterNumber - 1).every(chapter => chapter.status === "canon");
}

export function chapterContext(book: BookProject, chapter: Chapter, pov: Character, resolvedAttachments: ResolvedAttachment[] = []) {
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
      ...immediate,
      ...resolvedAttachments.flatMap(resolved => seriesContextDocuments(resolved, pov))
    ],
    chapter: { number: chapter.number, title: chapter.title, structure: chapter.structure, sourcePath: `chapters/${chapter.number}` },
    povCharacter: { id: pov.id, name: pov.name, guild: pov.guild },
    chapterSummaries: summaries,
    previousSamePovDocument: ownPrevious && !prior.slice(-1).includes(ownPrevious) ? readChapterDocument(book, ownPrevious) : ""
  };
}
