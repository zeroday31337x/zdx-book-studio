import { createHash } from "node:crypto";
import type { BookProject, Chapter, Character, SeriesAttachment } from "./types.js";
import { renderBookFile, renderCharacterFile, renderContinuityFile, slug } from "./manuscript.js";
import { wordCount } from "./context.js";

/**
 * Series manuscript attachment — a platform feature for any user's series,
 * not tied to any one book. A later book attaches an earlier book from the
 * SAME series (both carry the same seriesName). The attachment source is the
 * earlier book's approved canon only: drafts and rejected chapters are never
 * visible to generation or review.
 *
 * The attachment is sealed by a hash of the canon at attach time. Packet
 * assembly verifies the seal on every use: if the source canon has changed
 * since the attach, the attachment is stale and contributes NOTHING (fail
 * closed) until it is re-attached. A chapter records the seals it was built
 * against (Chapter.builtAgainst). Nothing in the later book can modify the
 * earlier book: attachments are read-only references.
 *
 * Knowledge carry-over is assembled from the source book's recorded
 * continuity and character files — what the POV character's own file holds,
 * plus the continuity lines that name them, plus their canon chapter
 * summaries. (A fully structured per-character knowledge store remains a
 * separate future upgrade; this is the text-level carry-over the current
 * continuity model supports.)
 */

export interface CanonSeal { hash: string; chapters: number; words: number }

export function canonChapters(book: BookProject): Chapter[] {
  return book.chapters.filter(chapter => chapter.status === "canon" && chapter.approvedText.trim()).sort((a, b) => a.number - b.number);
}

export function canonSeal(book: BookProject): CanonSeal {
  const canon = canonChapters(book);
  const hash = createHash("sha256");
  for (const chapter of canon) hash.update(`${chapter.number}\n${chapter.title}\n${chapter.approvedText}\n===\n`);
  return { hash: hash.digest("hex"), chapters: canon.length, words: canon.reduce((sum, chapter) => sum + wordCount(chapter.approvedText), 0) };
}

export function makeAttachment(source: BookProject): SeriesAttachment {
  const seal = canonSeal(source);
  return { bookId: source.id, title: source.title, canonHash: seal.hash, canonChapters: seal.chapters, canonWords: seal.words, attachedAt: new Date().toISOString() };
}

export type AttachmentStatus = "active" | "stale" | "missing";

export function attachmentStatus(attachment: SeriesAttachment, source: BookProject | undefined): AttachmentStatus {
  if (!source) return "missing";
  return canonSeal(source).hash === attachment.canonHash ? "active" : "stale";
}

/** Returns an error code when the attach must be refused, else null. */
export function validateAttachment(target: BookProject, source: BookProject): string | null {
  if (source.id === target.id) return "cannot_attach_own_book";
  if ((target.attachments || []).some(item => item.bookId === source.id)) return "already_attached";
  if (canonSeal(source).chapters === 0) return "source_has_no_canon";
  const targetSeries = (target.seriesName || "").trim().toLowerCase();
  const sourceSeries = (source.seriesName || "").trim().toLowerCase();
  if (!targetSeries || !sourceSeries || targetSeries !== sourceSeries) return "different_series";
  return null;
}

export interface ResolvedAttachment { attachment: SeriesAttachment; source: BookProject }

/** Attachments whose seal still matches the source canon — the only ones allowed to feed a packet. */
export function activeAttachments(book: BookProject, resolve: (id: string) => BookProject | undefined): ResolvedAttachment[] {
  const resolved: ResolvedAttachment[] = [];
  for (const attachment of book.attachments || []) {
    const source = resolve(attachment.bookId);
    if (source && attachmentStatus(attachment, source) === "active") resolved.push({ attachment, source });
  }
  return resolved;
}

function mentions(lines: string[], name: string) {
  const needle = name.trim().toLowerCase();
  return lines.filter(line => line.toLowerCase().includes(needle));
}

function knowledgeCarryover(source: BookProject, pov: Character): string {
  const header = `# Knowledge carry-over from ${source.title}\n\nSealed canon reference. This is what ${pov.name} legitimately carries into the next book — no more. Knowledge held by other characters, or events ${pov.name} did not experience or learn of, are NOT theirs to use.`;
  const match = source.characters.find(character => character.name.trim().toLowerCase() === pov.name.trim().toLowerCase());
  if (!match) {
    return `${header}\n\nNo character named ${pov.name} appears in ${source.title}. ${pov.name} enters with no carried knowledge from this book.`;
  }
  const ownChapters = canonChapters(source).filter(chapter => chapter.povCharacterId === match.id);
  const summaries = ownChapters.map(chapter => `- Ch ${chapter.number} (${chapter.title}): ${chapter.review?.summary || "No summary recorded"}`);
  const learned = [
    ...mentions(source.continuity.knowledgeState, match.name).map(line => `- Knowledge: ${line}`),
    ...mentions(source.continuity.facts, match.name).map(line => `- Fact involving them: ${line}`),
    ...mentions(source.continuity.relationshipState, match.name).map(line => `- Relationship: ${line}`),
  ];
  const voiceAnchor = ownChapters.length
    ? `\n\n## Voice anchor — ${pov.name}'s most recent canon chapter in ${source.title} (Ch ${ownChapters[ownChapters.length - 1].number})\n\n${ownChapters[ownChapters.length - 1].approvedText.slice(0, 2400)}`
    : "";
  return [
    header,
    `\n## ${pov.name} as established in ${source.title} (their own full character file from that book)\n\n${renderCharacterFile(match, true)}`,
    `\n## What ${pov.name} experienced and learned, per the recorded continuity\n\n${learned.length ? learned.join("\n") : "- Nothing recorded under their name."}`,
    `\n## Their canon chapters in ${source.title}\n\n${summaries.length ? summaries.join("\n") : "- None."}`,
    voiceAnchor,
  ].join("\n");
}

/** Source documents for one attached book, appended to a chapter packet. Canon only — never drafts. */
export function seriesContextDocuments(resolved: ResolvedAttachment, pov: Character): Array<{ path: string; content: string }> {
  const { attachment, source } = resolved;
  const base = `series/${slug(source.title)}`;
  const others = source.characters.filter(character => character.name.trim().toLowerCase() !== pov.name.trim().toLowerCase());
  return [
    { path: `${base}/attachment.md`, content: `# Attached prior book: ${source.title}\n\nSealed canon attached ${attachment.attachedAt}. Canon hash ${attachment.canonHash}. ${attachment.canonChapters} canon chapters, ${attachment.canonWords} words. This manuscript is read-only reference: its facts, timeline and outcomes are binding on the new book.` },
    { path: `${base}/book.md`, content: renderBookFile(source) },
    { path: `${base}/continuity.md`, content: renderContinuityFile(source) },
    { path: `${base}/knowledge-carryover.md`, content: knowledgeCarryover(source, pov) },
    ...(others.length ? [{ path: `${base}/characters-public.md`, content: `# Other characters in ${source.title} — public profiles only\n\n${others.map(character => renderCharacterFile(character, false)).join("\n\n")}` }] : []),
  ];
}
