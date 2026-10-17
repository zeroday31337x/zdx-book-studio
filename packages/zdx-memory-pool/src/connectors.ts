import type { MemoryAccessContext, MemoryQuery, MemoryRecord, MemorySystem, MemoryWrite } from "./contracts.js";
import { ZdxMemoryPool, type MemoryPoolOptions } from "./pool.js";

export type ScopedMemoryQuery = Omit<MemoryQuery, "system">;
export type ScopedMemoryWrite = Omit<MemoryWrite, "system">;

/**
 * A system-bound connector. It injects the target system instead of accepting it
 * from callers, preventing an integration from accidentally crossing systems.
 * Authorization is still checked by ZdxMemoryPool and the database role.
 */
export class ZdxMemoryConnector {
  private readonly pool: ZdxMemoryPool;

  constructor(
    readonly system: MemorySystem,
    private readonly context: MemoryAccessContext,
    options: MemoryPoolOptions = {},
  ) {
    if (!context.allowedSystems.includes(system)) {
      throw new Error("Connector context does not grant access to its configured memory system");
    }
    this.pool = new ZdxMemoryPool(options);
  }

  get(query: ScopedMemoryQuery, key: string): Promise<MemoryRecord | null> {
    return this.pool.get(this.context, { ...query, system: this.system }, key);
  }

  search(query: ScopedMemoryQuery): Promise<MemoryRecord[]> {
    return this.pool.search(this.context, { ...query, system: this.system });
  }

  put(input: ScopedMemoryWrite): Promise<MemoryRecord> {
    return this.pool.put(this.context, { ...input, system: this.system });
  }

  async healthCheck() {
    // Force creation of the adapter for this connector's system so health checks
    // are useful before the first read/write.
    await this.pool.ensureAdapter(this.system);
    return this.pool.healthCheck();
  }

  close(): Promise<void> {
    return this.pool.close();
  }
}

export const createAgentCoreMemoryConnector = (context: MemoryAccessContext, options?: MemoryPoolOptions) =>
  new ZdxMemoryConnector("agentcore", context, options);

export const createDataSynthesisMemoryConnector = (context: MemoryAccessContext, options?: MemoryPoolOptions) =>
  new ZdxMemoryConnector("data-synthesis", context, options);

export const createBookStudioMemoryConnector = (context: MemoryAccessContext, options?: MemoryPoolOptions) =>
  new ZdxMemoryConnector("book-studio", context, options);

export const createAgentMemoryConnector = (context: MemoryAccessContext, options?: MemoryPoolOptions) =>
  new ZdxMemoryConnector("agent", context, options);
