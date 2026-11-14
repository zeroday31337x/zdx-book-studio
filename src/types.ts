export type ChapterStatus = "planned" | "draft" | "reviewed" | "canon";

export interface Character {
  id: string;
  name: string;
  guild: string;
  role: "protagonist" | "antagonist" | "supporting";
  povOrder?: number;
  publicProfile: string;
  worldview: string;
  wound: string;
  strength: string;
  blindSpot: string;
  voice: string;
  privateKnowledge: string;
}

export interface ChapterReview {
  verdict: "PASS" | "NEEDS_CHANGES";
  notes: string[];
  summary: string;
  continuityDelta: string[];
  knowledgeDelta: string[];
  relationshipDelta: string[];
  originalityFlags: string[];
  reviewedAt: string;
}

export interface Chapter {
  number: number;
  title: string;
  povCharacterId: string;
  structure: string;
  status: ChapterStatus;
  draft: string;
  approvedText: string;
  wordCount: number;
  review?: ChapterReview;
  reviewStatus?: "idle" | "reviewing" | "complete" | "failed";
  reviewStartedAt?: string;
  reviewError?: string;
  generationStatus?: "idle" | "generating" | "complete" | "failed";
  generationStartedAt?: string;
  generationError?: string;
  generatedAt?: string;
  approvedAt?: string;
  /** How this chapter entered canon: the manual human gate, or the automated pipeline's review PASS. */
  productionMode?: "manual" | "auto";
  /** Sealed series attachments (book + canon hash) this chapter's generation was built against. */
  builtAgainst?: Array<{ bookId: string; canonHash: string }>;
}

export interface ContinuityState {
  timeline: string[];
  facts: string[];
  unresolvedThreads: string[];
  relationshipState: string[];
  knowledgeState: string[];
}

export interface SeriesAttachment {
  bookId: string;
  title: string;
  /** SHA-256 over the source book's canon chapters at attach time. The seal pins the version this book builds against. */
  canonHash: string;
  canonChapters: number;
  canonWords: number;
  attachedAt: string;
}

export interface AuthorProfile {
  id: string;
  ownerEmail: string;
  label: string;
  byline: string;
  bio: string;
  website: string;
  contactEmail: string;
  createdAt: string;
  updatedAt: string;
}

export type PageMode = "off" | "default" | "custom";

export interface FrontMatterConfig {
  authorProfileId: string | null;
  copyrightPage: { mode: PageMode; year: number; holder: string; customText: string };
  dedicationPage: { mode: PageMode; dedicatee: string; customText: string };
  preface: string;
  acknowledgments: string;
}

export interface BookProject {
  frictionWrite?: import('./frictionwrite.js').FrictionConfig;
  id: string;
  title: string;
  /** Books sharing a series name (case-insensitive) form a series; only same-series books can be attached. */
  seriesName?: string;
  /** Sealed prior-book canon attached for series building. Read-only reference; see series.ts. */
  attachments?: SeriesAttachment[];
  ownerEmail?: string;
  /** Front and back matter, optional for legacy books. */
  frontMatter?: FrontMatterConfig;
  autoRun?: { status: "running" | "paused" | "complete"; nextChapter: number; lastError?: string; updatedAt: string };
  tagline: string;
  genre: string;
  tone: string;
  premise: string;
  overview: string;
  canon: string;
  chapterCount: number;
  movementCount: number;
  targetWords: number;
  chapterTargetWords?: number;
  /** Absolute per-chapter hard word cap. Null/undefined = derive from the chapter target (see chapterLengthBands). */
  hardChapterWordCap?: number;
  writingStyle?: string;
  writingSample?: string;
  status: "design" | "production" | "complete";
  characters: Character[];
  chapters: Chapter[];
  continuity: ContinuityState;
  createdAt: string;
  updatedAt: string;
}
