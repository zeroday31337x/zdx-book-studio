import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { AdapterEnvironment } from "../env.js";
import type { MemoryAdapter, MemoryQuery, MemoryRecord, MemorySystem, MemoryWrite } from "../contracts.js";
import { MemoryConfigurationError, MemoryVersionConflictError } from "../contracts.js";

export function postgresTarget(config: AdapterEnvironment): { connectionString: string; ssl?: PoolConfig["ssl"] } {
  if (!config.connectionString) throw new MemoryConfigurationError("Postgres adapter requires a connection URL");
  let parsed: URL;
  try { parsed = new URL(config.connectionString); }
  catch { throw new MemoryConfigurationError("PostgreSQL connection URL is invalid"); }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new MemoryConfigurationError("PostgreSQL adapter requires a PostgreSQL URL");
  }
  const host = (parsed.hostname || "").toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  const sslmode = (parsed.searchParams.get("sslmode") || "").toLowerCase();
  if (sslmode === "disable") throw new MemoryConfigurationError("PostgreSQL TLS cannot be disabled by connection URL");
  const secure = Boolean(config.sslCaFile || sslmode);
  if (!secure && !local) {
    throw new MemoryConfigurationError("Remote PostgreSQL requires sslmode or a platform-specific SSL CA file");
  }
  // URL TLS options can override the explicit pg SSL object. Remove them after
  // translating them into the strict, verified adapter configuration.
  for (const key of ["schema", "sslmode", "sslrootcert", "sslcert", "sslkey"]) parsed.searchParams.delete(key);
  const ssl = secure
    ? { rejectUnauthorized: true, ...(config.sslCaFile ? { ca: readFileSync(config.sslCaFile, "utf8") } : {}) }
    : undefined;
  return { connectionString: parsed.toString(), ...(ssl ? { ssl } : {}) };
}

function ident(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new MemoryConfigurationError("Unsafe SQL identifier");
  }
  return `"${value}"`;
}

export class PostgresMemoryAdapter implements MemoryAdapter {
  readonly id: string;
  readonly system: MemorySystem;
  private readonly pool: Pool;
  private readonly table: string;
  private initialized?: Promise<void>;

  constructor(config: AdapterEnvironment) {
    if (config.backend !== "postgres" || !config.connectionString) {
      throw new MemoryConfigurationError("Postgres adapter requires a PostgreSQL connection URL");
    }
    this.system = config.system;
    this.id = `${config.system}:postgres:${config.schema}`;
    this.table = `${ident(config.schema)}.${ident("memory_records")}`;
    const role = config.role ? config.role : undefined;
    if (role && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role)) {
      throw new MemoryConfigurationError("Database role must be a simple SQL identifier");
    }
    const target = postgresTarget(config);
    this.pool = new Pool({
      connectionString: target.connectionString,
      ...(target.ssl ? { ssl: target.ssl } : {}),
      max: config.poolMax,
      statement_timeout: config.statementTimeoutMs,
      application_name: `zdx-memory-pool-${config.system}`,
      options: role ? `-c role=${role}` : undefined,
    });
  }

  private async init(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.pool.query(`SELECT 1 FROM ${this.table} LIMIT 0`);
      })();
    }
    return this.initialized;
  }

  async healthCheck(): Promise<{ ok: boolean; backend: string; detail?: string }> {
    try {
      await this.pool.query("SELECT 1");
      return { ok: true, backend: "postgres" };
    } catch {
      return { ok: false, backend: "postgres", detail: "Database health check failed" };
    }
  }

  async get(query: MemoryQuery, key: string): Promise<MemoryRecord | null> {
    await this.init();
    const result = await this.pool.query(
      `SELECT record FROM ${this.table}
       WHERE system=$1 AND namespace=$2 AND owner_id=$3
         AND agent_id IS NOT DISTINCT FROM $4 AND key=$5
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY version DESC LIMIT 1`,
      [query.system, query.namespace, query.ownerId, query.agentId ?? null, key],
    );
    return (result.rows[0]?.record as MemoryRecord | undefined) ?? null;
  }

  async search(query: MemoryQuery): Promise<MemoryRecord[]> {
    await this.init();
    const clauses = ["system=$1", "namespace=$2", "owner_id=$3", "agent_id IS NOT DISTINCT FROM $4", "(expires_at IS NULL OR expires_at > now())"];
    const values: unknown[] = [query.system, query.namespace, query.ownerId, query.agentId ?? null];
    if (query.kinds?.length) {
      values.push(query.kinds);
      clauses.push(`kind = ANY($${values.length}::text[])`);
    }
    if (query.keyPrefix) {
      values.push(`${query.keyPrefix.replace(/[\\\\%_]/g, "\\\\$&")}%`);
      clauses.push(`key LIKE $${values.length} ESCAPE E'\\\\\\\\'`);
    }
    values.push(Math.min(Math.max(query.limit ?? 50, 1), 500));
    const result = await this.pool.query(
      `SELECT record FROM ${this.table} WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => row.record as MemoryRecord);
  }

  async put(input: MemoryWrite): Promise<MemoryRecord> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lockKey = JSON.stringify([input.system, input.namespace, input.ownerId, input.agentId ?? null, input.key]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      const currentResult = await client.query(
        `SELECT record FROM ${this.table}
         WHERE system=$1 AND namespace=$2 AND owner_id=$3
           AND agent_id IS NOT DISTINCT FROM $4 AND key=$5
         ORDER BY version DESC LIMIT 1`,
        [input.system, input.namespace, input.ownerId, input.agentId ?? null, input.key],
      );
      const current = (currentResult.rows[0]?.record as MemoryRecord | undefined) ?? null;
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
      const result = await client.query(
        `INSERT INTO ${this.table} (id, system, namespace, owner_id, agent_id, kind, key, version, created_at, updated_at, expires_at, record) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING record`,
        [record.id, input.system, input.namespace, input.ownerId, input.agentId ?? null, input.kind, input.key, record.version, record.createdAt, now, input.expiresAt ?? null, JSON.stringify(record)],
      );
      await client.query("COMMIT");
      return result.rows[0].record as MemoryRecord;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export async function migratePostgresMemorySchema(client: PoolClient, schema: string): Promise<void> {
  const safe = ident(schema);
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${safe}`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${safe}."memory_records" (
    id text PRIMARY KEY,
    system text NOT NULL,
    namespace text NOT NULL,
    owner_id text NOT NULL,
    agent_id text NULL,
    kind text NOT NULL,
    key text NOT NULL,
    version integer NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    expires_at timestamptz NULL,
    record jsonb NOT NULL,
    UNIQUE (system, namespace, owner_id, agent_id, key, version)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${ident(`memory_records_ns_owner_idx`)} ON ${safe}."memory_records" (system, namespace, owner_id, updated_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${ident(`memory_records_key_idx`)} ON ${safe}."memory_records" (system, namespace, owner_id, key, version DESC)`);
}
