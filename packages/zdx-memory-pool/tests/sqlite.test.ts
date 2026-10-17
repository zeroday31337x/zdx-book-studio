import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryAdapter } from "../src/adapters/sqlite.js";
import type { AdapterEnvironment } from "../src/env.js";
import type { MemoryQuery, MemoryWrite } from "../src/contracts.js";

test("SQLite search without agentId only returns shared/null-agent records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zdx-memory-pool-"));
  const adapter = new SqliteMemoryAdapter({
    system: "agentcore",
    backend: "sqlite",
    sqlitePath: join(directory, "memory.sqlite"),
    schema: "zdx_memory",
    poolMax: 1,
    statementTimeoutMs: 5000,
  } satisfies AdapterEnvironment);

  const base: Omit<MemoryWrite, "key" | "agentId"> = {
    system: "agentcore",
    namespace: "team",
    ownerId: "owner-1",
    kind: "semantic",
    value: "value",
    provenance: { source: "test", createdBy: "test" },
  };

  try {
    await adapter.put({ ...base, key: "shared" });
    await adapter.put({ ...base, key: "agent-private", agentId: "agent-a" });

    const query: MemoryQuery = {
      system: "agentcore",
      namespace: "team",
      ownerId: "owner-1",
      limit: 50,
    };
    const sharedResults = await adapter.search(query);
    assert.deepEqual(sharedResults.map((record) => record.key), ["shared"]);

    const agentResults = await adapter.search({ ...query, agentId: "agent-a" });
    assert.deepEqual(agentResults.map((record) => record.key), ["agent-private"]);
  } finally {
    await adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("SQLite versioned writes increment versions and reject stale expectedVersion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zdx-memory-pool-version-"));
  const adapter = new SqliteMemoryAdapter({
    system: "agentcore",
    backend: "sqlite",
    sqlitePath: join(directory, "memory.sqlite"),
    schema: "zdx_memory",
    poolMax: 1,
    statementTimeoutMs: 5000,
  });
  const base: MemoryWrite = {
    system: "agentcore",
    namespace: "continuity",
    ownerId: "principal-1",
    agentId: "agent-1",
    kind: "episodic",
    key: "last-task",
    value: { status: "started" },
    provenance: { source: "test", createdBy: "test-suite" },
  };
  try {
    const first = await adapter.put({ ...base, expectedVersion: 0 });
    assert.equal(first.version, 1);
    const second = await adapter.put({ ...base, value: { status: "done" }, expectedVersion: 1 });
    assert.equal(second.version, 2);
    assert.equal(second.createdAt, first.createdAt);
    assert.deepEqual((await adapter.get({
      system: "agentcore", namespace: "continuity", ownerId: "principal-1", agentId: "agent-1"
    }, "last-task"))?.value, { status: "done" });
    await assert.rejects(
      () => adapter.put({ ...base, expectedVersion: 1 }),
      /version does not match/i,
    );
  } finally {
    await adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
});
