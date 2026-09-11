import type { BookProject, Chapter, Character } from "./types.js";

export function wordCount(text: string) { return text.trim() ? text.trim().split(/\s+/).length : 0; }

export function previousCanonRequired(book: BookProject, chapterNumber: number) {
  if (chapterNumber <= 1) return true;
  return book.chapters.slice(0, chapterNumber - 1).every(chapter => chapter.status === "canon");
}

export function chapterContext(book: BookProject, chapter: Chapter, pov: Character) {
  const prior = book.chapters.filter(item => item.number < chapter.number && item.status === "canon");
  const summaries = prior.map(item => `Ch ${item.number} (${book.characters.find(c => c.id === item.povCharacterId)?.name || item.povCharacterId}): ${item.review?.summary || "No summary"}`);
  const immediate = prior.slice(-2).map(item => `\n--- Chapter ${item.number} approved text ---\n${item.approvedText}`);
  const ownPrevious = [...prior].reverse().find(item => item.povCharacterId === pov.id);
  const others = book.characters.filter(c => c.id !== pov.id).map(c => ({ name: c.name, guild: c.guild, role: c.role, publicProfile: c.publicProfile }));
  return {
    book: { title: book.title, tagline: book.tagline, genre: book.genre, tone: book.tone, premise: book.premise, overview: book.overview, canon: book.canon, targetWords: book.targetWords },
    chapter: { number: chapter.number, title: chapter.title, structure: chapter.structure },
    povCharacter: pov,
    otherCharactersPublic: others,
    continuity: book.continuity,
    chapterSummaries: summaries,
    immediatePriorText: immediate,
    previousSamePovText: ownPrevious ? ownPrevious.approvedText : ""
  };
}
