import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { BookProject, Character, Chapter, ContinuityState } from "./types.js";
import { syncBookFiles } from "./manuscript.js";

type BookRow = {
  id: string; metadata: string; continuity: string;
  created_at: string; updated_at: string;
};

export class SqliteBookStore {
  private db: DatabaseSync;
  private legacyPath: string;

  constructor(
    filePath = process.env.BOOK_STUDIO_DB || path.resolve("data/books.sqlite"),
    legacyPath = process.env.BOOK_STUDIO_DATA || path.resolve("data/books.json")
  ) {
    this.legacyPath = legacyPath;
    mkdirSync(path.dirname(filePath), { recursive: true });
    const fresh = !existsSync(filePath);
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.migrateSchema();
    if (fresh) this.importLegacy(legacyPath);
  }

  private migrateSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY, metadata TEXT NOT NULL, continuity TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS characters (
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (book_id, id)
      );
      CREATE TABLE IF NOT EXISTS chapters (
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        number INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (book_id, number)
      );
      CREATE INDEX IF NOT EXISTS idx_chapters_book_status
        ON chapters(book_id, json_extract(data, '$.status'));
    `);
  }

  private importLegacy(legacyPath: string) {
    if (!existsSync(legacyPath)) return;
    const parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Legacy books.json is not an array");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const book of parsed as BookProject[]) this.persist(book);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const imported = this.list();
    if (imported.length !== parsed.length) throw new Error("SQLite import verification failed");
  }

  list(): BookProject[] {
    const rows = this.db.prepare("SELECT * FROM books ORDER BY created_at").all() as unknown as BookRow[];
    return rows.map(row => this.hydrate(row));
  }
  get(id: string): BookProject | undefined {
    const row = this.db.prepare("SELECT * FROM books WHERE id = ?").get(id) as unknown as BookRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  save(book: BookProject): BookProject {
    book.updatedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.persist(book);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    syncBookFiles(book);
    // SQLite is authoritative; mirror all saved books to the legacy backup for recovery.
    const mirror = `${this.legacyPath}.${process.pid}.tmp`;
    writeFileSync(mirror, `${JSON.stringify(this.list(), null, 2)}\n`, "utf8");
    renameSync(mirror, this.legacyPath);
    return book;
  }

  create(input: Partial<BookProject> & Pick<BookProject, "title">): BookProject {
    const now = new Date().toISOString();
    const chapterCount = input.chapterCount ?? 12;
    const book: BookProject = {
      id: crypto.randomUUID(), title: input.title, ownerEmail: input.ownerEmail, tagline: input.tagline || "",
      genre: input.genre || "", tone: input.tone || "", premise: input.premise || "",
      overview: input.overview || "", canon: input.canon || "", chapterCount,
      movementCount: input.movementCount ?? 3, targetWords: input.targetWords ?? 80000,
      chapterTargetWords: input.chapterTargetWords,
      writingStyle: input.writingStyle || "", writingSample: input.writingSample || "",
      status: input.status || "design", characters: input.characters || [],
      continuity: input.continuity || emptyContinuity(),
      chapters: Array.from({ length: chapterCount }, (_, i) => ({
        number: i + 1, title: `Chapter ${i + 1}`, povCharacterId: "",
        structure: "", status: "planned", draft: "", approvedText: "", wordCount: 0
      })),
      createdAt: now, updatedAt: now
    };
    return this.save(book);
  }
  private persist(book: BookProject) {
    const { characters, chapters, continuity, ...metadata } = book;
    this.db.prepare(`
      INSERT INTO books(id, metadata, continuity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,
        continuity=excluded.continuity, updated_at=excluded.updated_at
    `).run(book.id, JSON.stringify(metadata), JSON.stringify(continuity), book.createdAt, book.updatedAt);

    this.db.prepare("DELETE FROM characters WHERE book_id = ?").run(book.id);
    const putCharacter = this.db.prepare("INSERT INTO characters(book_id,id,position,data) VALUES(?,?,?,?)");
    characters.forEach((character, index) => putCharacter.run(book.id, character.id, index, JSON.stringify(character)));

    this.db.prepare("DELETE FROM chapters WHERE book_id = ?").run(book.id);
    const putChapter = this.db.prepare("INSERT INTO chapters(book_id,number,data) VALUES(?,?,?)");
    chapters.forEach(chapter => putChapter.run(book.id, chapter.number, JSON.stringify(chapter)));
  }

  private hydrate(row: BookRow): BookProject {
    const metadata = JSON.parse(row.metadata);
    const characters = this.db.prepare(
      "SELECT data FROM characters WHERE book_id = ? ORDER BY position"
    ).all(row.id).map(item => JSON.parse(String((item as any).data))) as Character[];
    const chapters = this.db.prepare(
      "SELECT data FROM chapters WHERE book_id = ? ORDER BY number"
    ).all(row.id).map(item => JSON.parse(String((item as any).data))) as Chapter[];
    return {
      ...metadata,
      continuity: JSON.parse(row.continuity) as ContinuityState,
      characters, chapters, createdAt: row.created_at, updatedAt: row.updated_at
    } as BookProject;
  }
}

export function emptyContinuity(): ContinuityState {
  return { timeline: [], facts: [], unresolvedThreads: [], relationshipState: [], knowledgeState: [] };
}
