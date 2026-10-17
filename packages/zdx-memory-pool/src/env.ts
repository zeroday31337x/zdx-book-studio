import { z } from "zod";
import type { MemorySystem } from "./contracts.js";
import { MemoryConfigurationError } from "./contracts.js";

const systemSchema = z.enum(["agentcore", "data-synthesis", "book-studio", "agent"]);

export interface AdapterEnvironment {
  system: MemorySystem;
  backend: "postgres" | "sqlite";
  connectionString?: string | undefined;
  sqlitePath?: string | undefined;
  role?: string | undefined;
  sslCaFile?: string | undefined;
  schema: string;
  poolMax: number;
  statementTimeoutMs: number;
}

const envPrefix: Record<MemorySystem, string> = {
  agentcore: "ZDX_MEMORY_AGENTCORE",
  "data-synthesis": "ZDX_MEMORY_DATA_SYNTHESIS",
  "book-studio": "ZDX_MEMORY_BOOK_STUDIO",
  agent: "ZDX_MEMORY_AGENT",
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new MemoryConfigurationError(`Expected a positive integer, received "${value}"`);
  }
  return parsed;
}

/**
 * Each system has independent connection settings and can authenticate as a
 * distinct database role. The pool never logs connection strings or secrets.
 */
export function readAdapterEnvironment(
  systemInput: string,
  env: NodeJS.ProcessEnv = process.env,
): AdapterEnvironment {
  const parsedSystem = systemSchema.safeParse(systemInput);
  if (!parsedSystem.success) {
    throw new MemoryConfigurationError(`Unsupported memory system: ${systemInput}`);
  }

  const system = parsedSystem.data;
  const prefix = envPrefix[system];
  const backend = (env[`${prefix}_BACKEND`] ?? "postgres").toLowerCase();
  if (backend !== "postgres" && backend !== "sqlite") {
    throw new MemoryConfigurationError(`${prefix}_BACKEND must be postgres or sqlite`);
  }

  const connectionString = env[`${prefix}_DATABASE_URL`];
  const sqlitePath = env[`${prefix}_SQLITE_PATH`];
  if (backend === "postgres" && !connectionString) {
    throw new MemoryConfigurationError(`${prefix}_DATABASE_URL is required for postgres`);
  }
  if (backend === "sqlite" && !sqlitePath) {
    throw new MemoryConfigurationError(`${prefix}_SQLITE_PATH is required for sqlite`);
  }

  const schema = env[`${prefix}_SCHEMA`] ?? "zdx_memory";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new MemoryConfigurationError(`${prefix}_SCHEMA must be a simple SQL identifier`);
  }

  return {
    system,
    backend,
    connectionString,
    sqlitePath,
    role: env[`${prefix}_ROLE`],
    sslCaFile: env[`${prefix}_SSL_CA_FILE`],
    schema,
    poolMax: positiveInteger(env[`${prefix}_POOL_MAX`], 5),
    statementTimeoutMs: positiveInteger(env[`${prefix}_STATEMENT_TIMEOUT_MS`], 5000),
  };
}

export function readAgentEnvironment(
  agentKey: string,
  env: NodeJS.ProcessEnv = process.env,
): AdapterEnvironment {
  if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(agentKey)) {
    throw new MemoryConfigurationError("Agent key must be an uppercase environment-safe identifier");
  }
  const prefix = `ZDX_MEMORY_AGENT_${agentKey}`;
  const backend = (env[`${prefix}_BACKEND`] ?? env.ZDX_MEMORY_AGENT_BACKEND ?? "sqlite").toLowerCase();
  if (backend !== "postgres" && backend !== "sqlite") {
    throw new MemoryConfigurationError(`${prefix}_BACKEND must be postgres or sqlite`);
  }
  const connectionString = env[`${prefix}_DATABASE_URL`] ?? env.ZDX_MEMORY_AGENT_DATABASE_URL;
  const sqlitePath = env[`${prefix}_SQLITE_PATH`] ?? env.ZDX_MEMORY_AGENT_SQLITE_PATH;
  if (backend === "postgres" && !connectionString) {
    throw new MemoryConfigurationError(`${prefix}_DATABASE_URL or ZDX_MEMORY_AGENT_DATABASE_URL is required`);
  }
  if (backend === "sqlite" && !sqlitePath) {
    throw new MemoryConfigurationError(`${prefix}_SQLITE_PATH or ZDX_MEMORY_AGENT_SQLITE_PATH is required`);
  }
  const schema = env[`${prefix}_SCHEMA`] ?? env.ZDX_MEMORY_AGENT_SCHEMA ?? "zdx_memory";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new MemoryConfigurationError("Agent memory schema must be a simple SQL identifier");
  }
  return {
    system: "agent",
    backend,
    connectionString,
    sqlitePath,
    role: env[`${prefix}_ROLE`] ?? env.ZDX_MEMORY_AGENT_ROLE,
    sslCaFile: env[`${prefix}_SSL_CA_FILE`] ?? env.ZDX_MEMORY_AGENT_SSL_CA_FILE,
    schema,
    poolMax: positiveInteger(env[`${prefix}_POOL_MAX`] ?? env.ZDX_MEMORY_AGENT_POOL_MAX, 3),
    statementTimeoutMs: positiveInteger(env[`${prefix}_STATEMENT_TIMEOUT_MS`] ?? env.ZDX_MEMORY_AGENT_STATEMENT_TIMEOUT_MS, 5000),
  };
}
