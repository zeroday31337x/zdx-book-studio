import test from "node:test";
import assert from "node:assert/strict";
import { ZdxMemoryPool } from "../src/pool.js";
import { createAgentCoreMemoryConnector } from "../src/connectors.js";
import { MemoryAccessError, type MemoryAdapter, type MemoryQuery, type MemoryRecord, type MemorySystem, type MemoryWrite } from "../src/contracts.js";

class FakeAdapter implements MemoryAdapter {
  readonly id: string;
  constructor(readonly system: MemorySystem, private readonly record: MemoryRecord | null = null) { this.id = `fake:${system}`; }
  async healthCheck() { return { ok: true, backend: "fake" }; }
  async get(_query: MemoryQuery, _key: string): Promise<MemoryRecord | null> { return this.record; }
  async search(_query: MemoryQuery): Promise<MemoryRecord[]> { return []; }
  async put(input: MemoryWrite): Promise<MemoryRecord> {
    return { ...input, id: "test-id", version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  }
}

const context = {
  principalId: "agent-a",
  roles: [],
  allowedSystems: ["agentcore"] as MemorySystem[],
  allowedNamespaces: ["team"],
  canWrite: true,
};

test("pool denies access to a system outside the caller grant", async () => {
  const pool = new ZdxMemoryPool({ adapters: { agentcore: new FakeAdapter("agentcore") } });
  await assert.rejects(
    pool.search(context, { system: "book-studio", namespace: "team", ownerId: "agent-a" }),
    (error: unknown) => error instanceof MemoryAccessError,
  );
});

test("pool denies namespace escalation", async () => {
  const pool = new ZdxMemoryPool({ adapters: { agentcore: new FakeAdapter("agentcore") } });
  await assert.rejects(
    pool.search(context, { system: "agentcore", namespace: "private", ownerId: "agent-a" }),
    (error: unknown) => error instanceof MemoryAccessError,
  );
});

test("pool rejects writes without provenance", async () => {
  const pool = new ZdxMemoryPool({ adapters: { agentcore: new FakeAdapter("agentcore") } });
  await assert.rejects(pool.put(context, {
    system: "agentcore", namespace: "team", ownerId: "agent-a", kind: "working",
    key: "task", value: {}, provenance: { source: "", createdBy: "agent-a" },
  }));
});


test("pool denies get when the returned record kind is outside the caller grant", async () => {
  const record: MemoryRecord = {
    id: "record-1", system: "agentcore", namespace: "team", ownerId: "agent-a",
    kind: "semantic", key: "secret", value: "x",
    provenance: { source: "test", createdBy: "agent-a" }, version: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const pool = new ZdxMemoryPool({ adapters: { agentcore: new FakeAdapter("agentcore", record) } });
  await assert.rejects(
    pool.get({ ...context, allowedKinds: ["working"] }, { system: "agentcore", namespace: "team", ownerId: "agent-a" }, "secret"),
    (error: unknown) => error instanceof MemoryAccessError,
  );
});

test("pool denies writes when the memory kind is outside the caller grant", async () => {
  const pool = new ZdxMemoryPool({ adapters: { agentcore: new FakeAdapter("agentcore") } });
  await assert.rejects(
    pool.put({ ...context, allowedKinds: ["working"] }, {
      system: "agentcore", namespace: "team", ownerId: "agent-a", kind: "semantic",
      key: "fact", value: "x", provenance: { source: "test", createdBy: "agent-a" },
    }),
    (error: unknown) => error instanceof MemoryAccessError,
  );
});


test("system-scoped connector injects its system and rejects unauthorized connector contexts", async () => {
  const connector = createAgentCoreMemoryConnector(context, {
    adapters: { agentcore: new FakeAdapter("agentcore") },
  });
  const record = await connector.put({
    namespace: "team",
    ownerId: "agent-a",
    kind: "working",
    key: "task",
    value: { status: "done" },
    provenance: { source: "test", createdBy: "agent-a" },
  });
  assert.equal(record.system, "agentcore");
  await connector.close();

  assert.throws(
    () => createAgentCoreMemoryConnector({ ...context, allowedSystems: ["book-studio"] }),
    /does not grant access/i,
  );
});
