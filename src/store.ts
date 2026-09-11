import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { BookProject, Character } from "./types.js";

export class BookStore {
  constructor(private filePath = process.env.BOOK_STUDIO_DATA || path.resolve("data/books.json")) {}

  list(): BookProject[] { return this.read(); }
  get(id: string): BookProject | undefined { return this.read().find(book => book.id === id); }

  save(book: BookProject): BookProject {
    const books = this.read();
    const index = books.findIndex(item => item.id === book.id);
    book.updatedAt = new Date().toISOString();
    if (index >= 0) books[index] = book; else books.push(book);
    this.write(books);
    return book;
  }

  create(input: Partial<BookProject> & Pick<BookProject, "title">): BookProject {
    const now = new Date().toISOString();
    const chapterCount = input.chapterCount || 42;
    const book: BookProject = {
      id: crypto.randomUUID(), title: input.title, tagline: input.tagline || "", genre: input.genre || "",
      tone: input.tone || "", premise: input.premise || "", overview: input.overview || "", canon: input.canon || "",
      chapterCount, movementCount: input.movementCount || 6, targetWords: input.targetWords || 80000,
      status: input.status || "design", characters: input.characters || [], continuity: input.continuity || emptyContinuity(),
      chapters: Array.from({ length: chapterCount }, (_, i) => ({ number: i + 1, title: `Chapter ${i + 1}`, povCharacterId: "", structure: "", status: "planned", draft: "", approvedText: "", wordCount: 0 })),
      createdAt: now, updatedAt: now
    };
    return this.save(book);
  }

  private read(): BookProject[] {
    if (!existsSync(this.filePath)) return [];
    try { const parsed = JSON.parse(readFileSync(this.filePath, "utf8")); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }

  private write(books: BookProject[]) {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(books, null, 2)}\n`, "utf8");
    renameSync(temp, this.filePath);
  }
}

export function emptyContinuity() { return { timeline: [], facts: [], unresolvedThreads: [], relationshipState: [], knowledgeState: [] }; }

export function seedCodebound(store: BookStore) {
  const existing = store.list().find(book => book.title.toLowerCase() === "codebound");
  if (existing) return existing;
  const characters: Character[] = [
    { id: "phreaker", name: "Phreaker protagonist", guild: "Phreakers", role: "protagonist", povOrder: 1, publicProfile: "One of three equal central protagonists.", worldview: "Signal, resonance and transmission explain power.", wound: "To be designed.", strength: "Reads carrier, interference and propagation instinctively.", blindSpot: "Mistakes signal mastery for understanding the whole system.", voice: "To be designed.", privateKnowledge: "To be designed." },
    { id: "hacker", name: "Hacker protagonist", guild: "Hackers", role: "protagonist", povOrder: 2, publicProfile: "One of three equal central protagonists.", worldview: "Structure, state and transformation explain power.", wound: "To be designed.", strength: "Understands sequencing, state and executable structure.", blindSpot: "Mistakes structural mastery for understanding the whole system.", voice: "To be designed.", privateKnowledge: "To be designed." },
    { id: "crypto", name: "Crypto protagonist", guild: "Crypto", role: "protagonist", povOrder: 3, publicProfile: "One of three equal central protagonists.", worldview: "Identity, integrity and authorization explain power.", wound: "To be designed.", strength: "Understands binding, authentication, secrecy and permission.", blindSpot: "Mistakes authority mastery for understanding the whole system.", voice: "To be designed.", privateKnowledge: "To be designed." }
  ];
  const book = store.create({
    title: "CodeBound",
    tagline: "In a world where spoken code alters reality, three rival guilds discover that none of them understands the language completely.",
    genre: "Techno-fantasy", tone: "Character-driven, fast, mysterious, emotionally grounded",
    premise: "Language is transmission. Energy is the substrate. Crystal is the focusing medium. Meaning becomes executable only when those layers align. Three enemy guilds each understand one layer and mistake partial knowledge for the whole.",
    overview: "Three equal protagonists—one Phreaker, one Hacker, one Crypto—begin as enemies. Their separate knowledge systems are all valid and all incomplete. Forced interaction turns rivalry into dependence, trust and potentially romance. Outer-ring antagonists benefit from division or seek completion through domination. The romantic end-state is deliberately unresolved until the characters earn it.",
    canon: "No one possesses the whole truth. The danger begins when a fragment is mistaken for the whole. No prophecy-selected trio. Completion comes through cooperation without erasing difference. The number 42 is structural pattern completion and remains an unadvertised Easter egg.",
    chapterCount: 42, movementCount: 6, targetWords: 80000, characters
  });
  book.chapters.forEach((chapter, index) => { chapter.povCharacterId = characters[index % 3].id; });
  return store.save(book);
}
