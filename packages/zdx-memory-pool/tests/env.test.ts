import test from "node:test";
import assert from "node:assert/strict";
import { readAdapterEnvironment, readAgentEnvironment } from "../src/env.js";
import { MemoryConfigurationError } from "../src/contracts.js";

test("system adapters use independent database credentials and schema settings", () => {
  const config = readAdapterEnvironment("book-studio", {
    ZDX_MEMORY_BOOK_STUDIO_BACKEND: "postgres",
    ZDX_MEMORY_BOOK_STUDIO_DATABASE_URL: "postgresql://book_role:secret@localhost:5432/zdx",
    ZDX_MEMORY_BOOK_STUDIO_ROLE: "book_role",
    ZDX_MEMORY_BOOK_STUDIO_SCHEMA: "book_memory",
  });
  assert.equal(config.system, "book-studio");
  assert.equal(config.backend, "postgres");
  assert.equal(config.role, "book_role");
  assert.equal(config.schema, "book_memory");
});

test("individual agents can override generic agent database configuration", () => {
  const config = readAgentEnvironment("RESEARCHER", {
    ZDX_MEMORY_AGENT_BACKEND: "sqlite",
    ZDX_MEMORY_AGENT_SQLITE_PATH: "/var/lib/zdx/default.sqlite",
    ZDX_MEMORY_AGENT_RESEARCHER_BACKEND: "postgres",
    ZDX_MEMORY_AGENT_RESEARCHER_DATABASE_URL: "postgresql://researcher:secret@localhost:5432/zdx",
    ZDX_MEMORY_AGENT_RESEARCHER_SCHEMA: "researcher_memory",
  });
  assert.equal(config.backend, "postgres");
  assert.equal(config.schema, "researcher_memory");
  assert.match(config.connectionString ?? "", /researcher/);
});

test("missing database configuration fails closed", () => {
  assert.throws(
    () => readAdapterEnvironment("agentcore", {}),
    (error: unknown) => error instanceof MemoryConfigurationError,
  );
});

test("SQL schema names are validated", () => {
  assert.throws(
    () => readAdapterEnvironment("agentcore", {
      ZDX_MEMORY_AGENTCORE_BACKEND: "sqlite",
      ZDX_MEMORY_AGENTCORE_SQLITE_PATH: "/tmp/memory.sqlite",
      ZDX_MEMORY_AGENTCORE_SCHEMA: "x; DROP TABLE users",
    }),
    (error: unknown) => error instanceof MemoryConfigurationError,
  );
});
