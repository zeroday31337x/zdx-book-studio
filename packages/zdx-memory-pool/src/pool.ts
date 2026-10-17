import { readAdapterEnvironment, readAgentEnvironment } from "./env.js";
import { MemoryAccessError, type MemoryAccessContext, type MemoryAdapter, type MemoryQuery, type MemoryRecord, type MemorySystem, type MemoryWrite } from "./contracts.js";
import { PostgresMemoryAdapter } from "./adapters/postgres.js";
import { SqliteMemoryAdapter } from "./adapters/sqlite.js";

export interface MemoryPoolOptions {
  env?: NodeJS.ProcessEnv;
  adapters?: Partial<Record<MemorySystem, MemoryAdapter>>;
}

export class ZdxMemoryPool {
  private readonly adapters = new Map<string, MemoryAdapter>();
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: MemoryPoolOptions = {}) {
    this.env = options.env ?? process.env;
    for (const [system, adapter] of Object.entries(options.adapters ?? {}) as [MemorySystem, MemoryAdapter][]) {
      this.adapters.set(system, adapter);
    }
  }

  private key(system: MemorySystem, agentKey?: string): string {
    return system === "agent" && agentKey ? `agent:${agentKey}` : system;
  }

  register(adapter: MemoryAdapter, agentKey?: string): void {
    const key = this.key(adapter.system, agentKey);
    if (this.adapters.has(key)) throw new Error(`Memory adapter already registered for ${key}`);
    this.adapters.set(key, adapter);
  }

  adapterFor(system: MemorySystem, agentKey?: string): MemoryAdapter {
    const key = this.key(system, agentKey);
    const registered = this.adapters.get(key) ?? (system === "agent" ? this.adapters.get("agent") : undefined);
    if (registered) return registered;

    const config = system === "agent" && agentKey
      ? readAgentEnvironment(agentKey, this.env)
      : readAdapterEnvironment(system, this.env);
    const adapter = config.backend === "postgres"
      ? new PostgresMemoryAdapter(config)
      : new SqliteMemoryAdapter(config);
    this.adapters.set(key, adapter);
    return adapter;
  }

  async get(context: MemoryAccessContext, query: MemoryQuery, key: string): Promise<MemoryRecord | null> {
    this.authorize(context, query, false);
    const record = await this.adapterFor(query.system, query.agentId).get(query, key);
    // Enforce kind grants after retrieval as the adapter's get() API is key-based
    // and cannot otherwise express the caller's allowedKinds policy.
    if (record && context.allowedKinds && !context.allowedKinds.includes(record.kind)) {
      throw new MemoryAccessError("Principal cannot access this memory kind");
    }
    return record;
  }

  async search(context: MemoryAccessContext, query: MemoryQuery): Promise<MemoryRecord[]> {
    this.authorize(context, query, false);
    const records = await this.adapterFor(query.system, query.agentId).search(query);
    return records.filter((record) =>
      (!context.allowedKinds || context.allowedKinds.includes(record.kind)) &&
      (!query.tags?.length || query.tags.every((tag) => record.tags?.includes(tag)))
    );
  }

  async put(context: MemoryAccessContext, input: MemoryWrite): Promise<MemoryRecord> {
    this.authorize(context, input, true);
    if (context.allowedKinds && !context.allowedKinds.includes(input.kind)) {
      throw new MemoryAccessError("Principal cannot write this memory kind");
    }
    if (!input.provenance?.source || !input.provenance?.createdBy) {
      throw new Error("Memory provenance source and createdBy are required");
    }
    return this.adapterFor(input.system, input.agentId).put(input);
  }

  async healthCheck(): Promise<Array<{ system: MemorySystem; ok: boolean; backend: string; detail?: string }>> {
    return Promise.all([...this.adapters.entries()].map(async ([key, adapter]) => ({
      system: adapter.system, ...(await adapter.healthCheck()), detail: key,
    })));
  }

  async close(): Promise<void> {
    await Promise.all([...new Set(this.adapters.values())].map((adapter) => adapter.close?.()));
    this.adapters.clear();
  }

  private authorize(context: MemoryAccessContext, request: Pick<MemoryQuery, "system" | "namespace" | "ownerId" | "agentId">, write: boolean): void {
    if (!context.allowedSystems.includes(request.system)) throw new MemoryAccessError("Principal cannot access this memory system");
    if (context.allowedNamespaces && !context.allowedNamespaces.includes(request.namespace)) throw new MemoryAccessError("Principal cannot access this namespace");
    if (request.ownerId !== context.principalId && !context.roles.includes("memory:cross-owner")) throw new MemoryAccessError("Cross-owner memory access denied");
    if (request.agentId && request.agentId !== context.principalId && !context.roles.includes("memory:cross-agent")) throw new MemoryAccessError("Cross-agent memory access denied");
    if (write && !context.canWrite) throw new MemoryAccessError("Principal is read-only");
  }
}
