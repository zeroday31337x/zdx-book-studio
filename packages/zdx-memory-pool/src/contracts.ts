export type MemorySystem =
  | "agentcore"
  | "data-synthesis"
  | "book-studio"
  | "agent";

export type MemoryKind =
  | "working"
  | "episodic"
  | "semantic"
  | "procedural"
  | "task-state"
  | "evaluation";

export interface MemoryRecord {
  id: string;
  system: MemorySystem;
  namespace: string;
  ownerId: string;
  agentId?: string;
  kind: MemoryKind;
  key: string;
  value: unknown;
  provenance: {
    source: string;
    createdBy: string;
    confidence?: number;
    verified?: boolean;
    references?: string[];
  };
  version: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  tags?: string[];
}

export interface MemoryQuery {
  system: MemorySystem;
  namespace: string;
  ownerId: string;
  agentId?: string;
  kinds?: MemoryKind[];
  keyPrefix?: string;
  tags?: string[];
  limit?: number;
}

export interface MemoryWrite {
  /** Optional optimistic concurrency guard. 0 means create-only; otherwise the current version must match. */
  expectedVersion?: number;
  system: MemorySystem;
  namespace: string;
  ownerId: string;
  agentId?: string;
  kind: MemoryKind;
  key: string;
  value: unknown;
  provenance: MemoryRecord["provenance"];
  expiresAt?: string;
  tags?: string[];
}

export interface MemoryAdapter {
  readonly id: string;
  readonly system: MemorySystem;
  healthCheck(): Promise<{ ok: boolean; backend: string; detail?: string }>;
  get(query: MemoryQuery, key: string): Promise<MemoryRecord | null>;
  search(query: MemoryQuery): Promise<MemoryRecord[]>;
  put(input: MemoryWrite): Promise<MemoryRecord>;
  close?(): Promise<void>;
}

export interface MemoryAccessContext {
  principalId: string;
  roles: string[];
  allowedSystems: MemorySystem[];
  allowedNamespaces?: string[];
  allowedKinds?: MemoryKind[];
  canWrite: boolean;
}

export class MemoryAccessError extends Error {
  constructor(message = "Memory access denied") {
    super(message);
    this.name = "MemoryAccessError";
  }
}

export class MemoryVersionConflictError extends Error {
  constructor(message = "Memory version conflict") {
    super(message);
    this.name = "MemoryVersionConflictError";
  }
}

export class MemoryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryConfigurationError";
  }
}
