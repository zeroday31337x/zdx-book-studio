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
  generatedAt?: string;
  approvedAt?: string;
}

export interface ContinuityState {
  timeline: string[];
  facts: string[];
  unresolvedThreads: string[];
  relationshipState: string[];
  knowledgeState: string[];
}

export interface BookProject {
  id: string;
  title: string;
  tagline: string;
  genre: string;
  tone: string;
  premise: string;
  overview: string;
  canon: string;
  chapterCount: number;
  movementCount: number;
  targetWords: number;
  status: "design" | "production" | "complete";
  characters: Character[];
  chapters: Chapter[];
  continuity: ContinuityState;
  createdAt: string;
  updatedAt: string;
}
