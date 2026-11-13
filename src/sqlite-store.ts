import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { BookProject, Character, Chapter, ContinuityState } from "./types.js";
import type { UsageEvent, UsageEventInput } from "./usage.js";
import { syncBookFiles } from "./manuscript.js";

export interface UsageTotals {
  calls: number; errors: number;
  inputTokens: number; outputTokens: number; totalTokens: number;
  costUsd: number; latencyMs: number;
}

type BookRow = {
  id: string; metadata: string; continuity: string;
  created_at: string; updated_at: string;
};

export class SqliteBookStore {
  private db: DatabaseSync;
  private legacyPath: string;
  /** Hashes of rows as last written/read, so save() only rewrites changed rows. */
  private rowHashes = new Map<string, string>();
  private lastMirrorAt = 0;
  private mirrorIntervalMs = Math.max(0, Number(process.env.BOOK_STUDIO_LEGACY_MIRROR_MS ?? 900_000) || 0);

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
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, owner_email TEXT NOT NULL DEFAULT '',
        book_id TEXT, chapter_number INTEGER, operation TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
        tokens_estimated INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0, status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_owner ON usage_events(owner_email);
      CREATE INDEX IF NOT EXISTS idx_usage_book ON usage_events(book_id);
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL,
        updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  // ---- Platform settings (DB-first, env is only a fallback default) ----

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as unknown as { value: string } | undefined;
    return row?.value;
  }

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM app_settings").all() as unknown as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map(row => [row.key, row.value]));
  }

  setSettings(values: Record<string, string>, updatedBy: string): void {
    const now = new Date().toISOString();
    const put = this.db.prepare(`
      INSERT INTO app_settings(key, value, updated_at, updated_by) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of Object.entries(values)) put.run(key, value, now, updatedBy);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private importLegacy(legacyPath: string) {
    if (!existsSync(legacyPath)) return;
    const parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Legacy books.json is not an array");
    this.db.exec("BEGIN IMMEDIATE");
    const commitFns: Array<() => void> = [];
    try {
      for (const book of parsed as BookProject[]) commitFns.push(this.persist(book));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const commit of commitFns) commit();
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
    let commitCache: () => void;
    try {
      commitCache = this.persist(book);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    commitCache();
    syncBookFiles(book);
    this.mirrorLegacyThrottled();
    return book;
  }

  /**
   * The legacy books.json mirror is a recovery convenience, not the store of
   * record (SQLite is). Rewriting the whole library on every save was the
   * scaling wall; the mirror is now refreshed at most once per interval
   * (DB setting legacyMirrorMs > env BOOK_STUDIO_LEGACY_MIRROR_MS > 15 min)
   * and on flush.
   */
  private mirrorInterval(): number {
    const fromDb = this.getSetting("legacyMirrorMs");
    if (fromDb !== undefined && fromDb !== "") {
      const parsed = Number(fromDb);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return this.mirrorIntervalMs;
  }

  private mirrorLegacyThrottled(force = false) {
    const now = Date.now();
    if (!force && now - this.lastMirrorAt < this.mirrorInterval()) return;
    this.lastMirrorAt = now;
    const mirror = `${this.legacyPath}.${process.pid}.tmp`;
    writeFileSync(mirror, `${JSON.stringify(this.list(), null, 2)}\n`, "utf8");
    renameSync(mirror, this.legacyPath);
  }

  flushLegacyMirror() { this.mirrorLegacyThrottled(true); }

  create(input: Partial<BookProject> & Pick<BookProject, "title">): BookProject {
    const now = new Date().toISOString();
    const chapterCount = input.chapterCount ?? 12;
    const book: BookProject = {
      id: crypto.randomUUID(), title: input.title, ownerEmail: input.ownerEmail, tagline: input.tagline || "",
      genre: input.genre || "", tone: input.tone || "", premise: input.premise || "",
      overview: input.overview || "", canon: input.canon || "", chapterCount,
      movementCount: input.movementCount ?? 3, targetWords: input.targetWords ?? 80000,
      chapterTargetWords: input.chapterTargetWords,
      hardChapterWordCap: input.hardChapterWordCap,
      seriesName: input.seriesName,
      attachments: input.attachments,
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
  private hashOf(value: string) { return crypto.createHash("sha256").update(value).digest("hex"); }

  /**
   * Writes only the rows whose content changed since this process last wrote
   * or read them (hash cache), instead of deleting and re-inserting every
   * character and chapter of the book on each save. Returns a function that
   * commits the staged hash changes; call it only after the surrounding
   * transaction commits, so a rollback never poisons the cache.
   */
  private persist(book: BookProject): () => void {
    const staged = new Map<string, string>();
    const removed: string[] = [];
    const { characters, chapters, continuity, ...metadata } = book;
    const metaKey = `${book.id}|meta`;
    const metaHash = this.hashOf(`${JSON.stringify(metadata)}\n${JSON.stringify(continuity)}`);
    if (this.rowHashes.get(metaKey) !== metaHash) {
      this.db.prepare(`
        INSERT INTO books(id, metadata, continuity, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,
          continuity=excluded.continuity, updated_at=excluded.updated_at
      `).run(book.id, JSON.stringify(metadata), JSON.stringify(continuity), book.createdAt, book.updatedAt);
      staged.set(metaKey, metaHash);
    }

    const seen = new Set<string>([metaKey]);
    const putCharacter = this.db.prepare(`
      INSERT INTO characters(book_id,id,position,data) VALUES(?,?,?,?)
      ON CONFLICT(book_id,id) DO UPDATE SET position=excluded.position, data=excluded.data
    `);
    characters.forEach((character, index) => {
      const key = `${book.id}|c|${character.id}`;
      seen.add(key);
      const data = JSON.stringify(character);
      const hash = this.hashOf(`${index}\n${data}`);
      if (this.rowHashes.get(key) !== hash) { putCharacter.run(book.id, character.id, index, data); staged.set(key, hash); }
    });

    const putChapter = this.db.prepare(`
      INSERT INTO chapters(book_id,number,data) VALUES(?,?,?)
      ON CONFLICT(book_id,number) DO UPDATE SET data=excluded.data
    `);
    chapters.forEach(chapter => {
      const key = `${book.id}|h|${chapter.number}`;
      seen.add(key);
      const data = JSON.stringify(chapter);
      const hash = this.hashOf(data);
      if (this.rowHashes.get(key) !== hash) { putChapter.run(book.id, chapter.number, data); staged.set(key, hash); }
    });

    for (const key of [...this.rowHashes.keys()]) {
      if (!key.startsWith(`${book.id}|`) || seen.has(key)) continue;
      if (key.startsWith(`${book.id}|c|`)) this.db.prepare("DELETE FROM characters WHERE book_id = ? AND id = ?").run(book.id, key.slice(book.id.length + 3));
      else if (key.startsWith(`${book.id}|h|`)) this.db.prepare("DELETE FROM chapters WHERE book_id = ? AND number = ?").run(book.id, Number(key.slice(book.id.length + 3)));
      removed.push(key);
    }

    return () => {
      for (const [key, hash] of staged) this.rowHashes.set(key, hash);
      for (const key of removed) this.rowHashes.delete(key);
    };
  }

  private hydrate(row: BookRow): BookProject {
    this.rowHashes.set(`${row.id}|meta`, this.hashOf(`${row.metadata}\n${row.continuity}`));
    const characterRows = this.db.prepare(
      "SELECT id, position, data FROM characters WHERE book_id = ? ORDER BY position"
    ).all(row.id) as unknown as Array<{ id: string; position: number; data: string }>;
    const characters = characterRows.map(item => {
      this.rowHashes.set(`${row.id}|c|${item.id}`, this.hashOf(`${item.position}\n${item.data}`));
      return JSON.parse(item.data) as Character;
    });
    const chapterRows = this.db.prepare(
      "SELECT number, data FROM chapters WHERE book_id = ? ORDER BY number"
    ).all(row.id) as unknown as Array<{ number: number; data: string }>;
    const chapters = chapterRows.map(item => {
      this.rowHashes.set(`${row.id}|h|${item.number}`, this.hashOf(item.data));
      return JSON.parse(item.data) as Chapter;
    });
    return {
      ...JSON.parse(row.metadata),
      continuity: JSON.parse(row.continuity) as ContinuityState,
      characters, chapters, createdAt: row.created_at, updatedAt: row.updated_at
    } as BookProject;
  }

  // ---- Inference usage ledger ----

  recordUsage(event: UsageEventInput & { costUsd: number }): UsageEvent {
    const full: UsageEvent = {
      ...event,
      id: crypto.randomUUID(),
      ts: event.ts || new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO usage_events(id, ts, owner_email, book_id, chapter_number, operation, agent_id,
        provider, model, input_tokens, output_tokens, total_tokens, tokens_estimated, latency_ms, cost_usd, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(full.id, full.ts, full.ownerEmail, full.bookId, full.chapterNumber, full.operation, full.agentId,
      full.provider, full.model, full.inputTokens, full.outputTokens, full.totalTokens,
      full.tokensEstimated ? 1 : 0, full.latencyMs, full.costUsd, full.status);
    return full;
  }

  private usageTotalsWhere(where: string, params: unknown[]): UsageTotals {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS calls, COALESCE(SUM(status = 'error'), 0) AS errors,
        COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(total_tokens), 0) AS totalTokens, COALESCE(SUM(cost_usd), 0) AS costUsd,
        COALESCE(SUM(latency_ms), 0) AS latencyMs
      FROM usage_events ${where}
    `).get(...(params as never[])) as unknown as UsageTotals;
    return { ...row, costUsd: Number(Number(row.costUsd).toFixed(6)) };
  }

  usageTotals(): UsageTotals { return this.usageTotalsWhere("", []); }
  usageForUser(ownerEmail: string): UsageTotals { return this.usageTotalsWhere("WHERE owner_email = ?", [ownerEmail]); }
  usageForBook(bookId: string): UsageTotals { return this.usageTotalsWhere("WHERE book_id = ?", [bookId]); }

  private usageGrouped(dimension: string): Array<Record<string, unknown> & UsageTotals> {
    const rows = this.db.prepare(`
      SELECT ${dimension} AS dimension, COUNT(*) AS calls, COALESCE(SUM(status = 'error'), 0) AS errors,
        COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(total_tokens), 0) AS totalTokens, COALESCE(SUM(cost_usd), 0) AS costUsd,
        COALESCE(SUM(latency_ms), 0) AS latencyMs
      FROM usage_events GROUP BY ${dimension} ORDER BY totalTokens DESC
    `).all() as unknown as Array<Record<string, unknown> & UsageTotals>;
    return rows.map(row => ({ ...row, costUsd: Number(Number(row.costUsd).toFixed(6)) }));
  }

  usageByUser() { return this.usageGrouped("owner_email"); }
  usageByBook() { return this.usageGrouped("book_id"); }
  usageByModel() { return this.usageGrouped("provider || ' / ' || model"); }

  usageRecent(limit = 50): UsageEvent[] {
    const rows = this.db.prepare("SELECT * FROM usage_events ORDER BY ts DESC LIMIT ?").all(Math.max(1, Math.min(500, limit))) as unknown as Array<Record<string, unknown>>;
    return rows.map(row => ({
      id: String(row.id), ts: String(row.ts), ownerEmail: String(row.owner_email),
      bookId: row.book_id === null ? null : String(row.book_id),
      chapterNumber: row.chapter_number === null ? null : Number(row.chapter_number),
      operation: String(row.operation), agentId: String(row.agent_id),
      provider: String(row.provider), model: String(row.model),
      inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
      totalTokens: Number(row.total_tokens), tokensEstimated: Number(row.tokens_estimated) === 1,
      latencyMs: Number(row.latency_ms), costUsd: Number(row.cost_usd),
      status: row.status === "error" ? "error" : "success",
    }));
  }
}

export function emptyContinuity(): ContinuityState {
  return { timeline: [], facts: [], unresolvedThreads: [], relationshipState: [], knowledgeState: [] };
}
