import Database from "better-sqlite3";
import type { AdapterEnvironment } from "../env.js";
import type { MemoryAdapter, MemoryQuery, MemoryRecord, MemorySystem, MemoryWrite } from "../contracts.js";
import { MemoryConfigurationError, MemoryVersionConflictError } from "../contracts.js";

export class SqliteMemoryAdapter implements MemoryAdapter {
  readonly id: string;
  readonly system: MemorySystem;
  private readonly db: Database.Database;

  constructor(config: AdapterEnvironment) {
    if (config.backend !== "sqlite" || !config.sqlitePath) {
      throw new MemoryConfigurationError("SQLite adapter requires a database file path");
    }
    this.system = config.system;
    this.id = `${config.system}:sqlite`;
    this.db = new Database(config.sqlitePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_records (
      id TEXT PRIMARY KEY,
      system TEXT NOT NULL,
      namespace TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      agent_id TEXT,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_records_scope_idx
      ON memory_records(system, namespace, owner_id, agent_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS memory_records_expiry_idx ON memory_records(expires_at);`);
  }

  async healthCheck(): Promise<{ ok: boolean; backend: string; detail?: string }> {
    try {
      this.db.prepare("SELECT 1").get();
      return { ok: true, backend: "sqlite" };
    } catch {
      return { ok: false, backend: "sqlite", detail: "Database health check failed" };
    }
  }

  async get(query: MemoryQuery, key: string): Promise<MemoryRecord | null> {
    const row = this.db.prepare(`SELECT record_json FROM memory_records
      WHERE system=? AND namespace=? AND owner_id=? AND agent_id IS ?
      AND key=? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY version DESC LIMIT 1`)
      .get(query.system, query.namespace, query.ownerId, query.agentId ?? null, key, new Date().toISOString()) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as MemoryRecord : null;
  }

  async search(query: MemoryQuery): Promise<MemoryRecord[]> {
    // Exact agent scope is intentional: omitted agentId means shared/null scope, not all agents.
    const clauses = ["system=?", "namespace=?", "owner_id=?", "agent_id IS ?", "(expires_at IS NULL OR expires_at > ?)"];
    const values: unknown[] = [query.system, query.namespace, query.ownerId, query.agentId ?? null, new Date().toISOString()];
    if (query.kinds?.length) {
      clauses.push(`kind IN (${query.kinds.map(() => "?").join(",")})`);
      values.push(...query.kinds);
    }
    if (query.keyPrefix) {
      clauses.push("key LIKE ? ESCAPE '\\'");
      values.push(`${query.keyPrefix.replace(/[\\%_]/g, "\\$&")}%`);
    }
    values.push(Math.min(Math.max(query.limit ?? 50, 1), 500));
    const rows = this.db.prepare(`SELECT record_json FROM memory_records WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`).all(...values) as { record_json: string }[];
    return rows.map((row) => JSON.parse(row.record_json) as MemoryRecord);
  }

  async put(input: MemoryWrite): Promise<MemoryRecord> {
    const write = this.db.transaction(() => {
      const scope = [input.system, input.namespace, input.ownerId, input.agentId ?? null, input.key];
      const currentRow = this.db.prepare(`SELECT record_json FROM memory_records
        WHERE system=? AND namespace=? AND owner_id=? AND agent_id IS ? AND key=?
        ORDER BY version DESC LIMIT 1`).get(...scope) as { record_json: string } | undefined;
      const current = currentRow ? JSON.parse(currentRow.record_json) as MemoryRecord : null;
      if (input.expectedVersion !== undefined && input.expectedVersion !== (current?.version ?? 0)) {
        throw new MemoryVersionConflictError("Expected memory version does not match current version");
      }
      const now = new Date().toISOString();
      const { expectedVersion: _expectedVersion, ...payload } = input;
      const record: MemoryRecord = {
        ...payload,
        id: crypto.randomUUID(),
        version: (current?.version ?? 0) + 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      this.db.prepare(`INSERT INTO memory_records
        (id,system,namespace,owner_id,agent_id,kind,key,version,created_at,updated_at,expires_at,record_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.id, input.system, input.namespace, input.ownerId, input.agentId ?? null,
        input.kind, input.key, record.version, record.createdAt, now, input.expiresAt ?? null, JSON.stringify(record),
      );
      return record;
    });
    return write();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
