# ZDX Memory Pool

A provider-independent memory routing package for ZeroDriveX systems. This package is being introduced inside the Agent Team repository as the first implementation location; it is designed to be extractable into a standalone `zdxMemoryPool` repository.

## Systems and adapters

- `agentcore`: shared AgentCore continuity memory.
- `data-synthesis`: isolated dataset research, synthesis, and evaluation memory.
- `book-studio`: isolated manuscript, canon, chapter, and review memory.
- `agent`: individual future-agent memory with per-agent environment overrides.
- Backends: PostgreSQL and SQLite.

Each system uses its own environment-prefixed database URL or SQLite path. PostgreSQL credentials should be separate database roles with least-privilege grants. The optional `*_ROLE` setting requests `SET ROLE` after connecting; the connecting user must be permitted to assume that role. Prefer separate login roles and URLs in production.

## Configuration

Copy `.env.example` values into the deployment environment or secret manager. Do not commit actual credentials.

PostgreSQL environment variables per system:

- `ZDX_MEMORY_<SYSTEM>_BACKEND=postgres`
- `ZDX_MEMORY_<SYSTEM>_DATABASE_URL`
- `ZDX_MEMORY_<SYSTEM>_ROLE` (optional)
- `ZDX_MEMORY_<SYSTEM>_SCHEMA`
- `ZDX_MEMORY_<SYSTEM>_POOL_MAX`
- `ZDX_MEMORY_<SYSTEM>_STATEMENT_TIMEOUT_MS`
- `ZDX_MEMORY_<SYSTEM>_SSL_CA_FILE` (optional PEM CA bundle; remote PostgreSQL requires verified TLS via `sslmode` or this CA setting)

SQLite uses `ZDX_MEMORY_<SYSTEM>_SQLITE_PATH`. SQLite relies on OS filesystem permissions rather than database roles; use separate files and service identities for isolation.

Individual agents can override the defaults with `ZDX_MEMORY_AGENT_<AGENT_KEY>_BACKEND`, `_DATABASE_URL`, `_SQLITE_PATH`, `_ROLE`, and `_SCHEMA`. The generic `ZDX_MEMORY_AGENT_*` settings are fallbacks.

## Security model

The pool checks the caller's memory access context before every operation. This is an application-layer defense, not a substitute for database authorization. Production deployments must also use database roles, schema/table grants, network restrictions, secret management, and backups. Do not share a privileged database login across systems. Schema migrations must run using a separate administrative identity; runtime roles should not have DDL permissions.

The memory record is data, not authority. Stored approvals, instructions, or previous actions never grant new execution permission. Agent runtime policy remains the authority for tool and action execution.

## Current scope

The SDK is now wired into AgentCore session memory, Data Synthesis workflow continuity, and Book Studio approved-canon continuity. AgentCore preserves the existing file store unless `ZDX_MEMORY_AGENTCORE_BACKEND` is configured. Data Synthesis and Book Studio treat memory as supplemental: existing durable workflow state remains authoritative, and memory failures are logged without replaying or failing already-committed work. Each integration uses a system-specific environment prefix and scoped namespaces. The app repositories currently vendor the same package source until it is extracted to a standalone repository.

## PostgreSQL migration and least-privilege grants

Migrations are an explicit operator action; the runtime adapter never creates tables. Set `ZDX_MEMORY_MIGRATION_DATABASE_URL` to a short-lived administrative/migration connection and `ZDX_MEMORY_MIGRATION_SCHEMAS` to the exact comma-separated schemas to initialize, then run:

```sh
npm run migrate:postgres --prefix packages/zdx-memory-pool
```

The command validates schema identifiers, runs each schema migration transactionally, records `001_initial`, and does not print connection strings. Keep the migration credential out of application runtime environments.

After migration, grant each application's distinct runtime role only what it needs. Example for the AgentCore schema (repeat with the correct schema and role for each system):

```sql
GRANT USAGE ON SCHEMA zdx_memory_agentcore TO zdx_agentcore_memory;
GRANT SELECT, INSERT ON TABLE zdx_memory_agentcore.memory_records TO zdx_agentcore_memory;
```

Do not grant runtime roles `CREATE`, `UPDATE`, `DELETE`, or ownership. Memory writes are append-only versions; the adapter serializes writes to each logical key and supports `expectedVersion: 0` for create-only and positive expected versions for optimistic concurrency. PostgreSQL uses transaction-scoped advisory locks for keys, including first writes with no existing row.

## System connectors

Use the system-bound factories rather than passing arbitrary system names throughout application code. They inject the system identifier and reject a caller context that lacks a grant for that system:

```ts
import {
  createAgentCoreMemoryConnector,
  createDataSynthesisMemoryConnector,
  createBookStudioMemoryConnector,
} from "@zerodrivex/memory-pool";

const memory = createDataSynthesisMemoryConnector({
  principalId: workerId,
  roles: [],
  allowedSystems: ["data-synthesis"],
  allowedNamespaces: ["dataset:" + datasetId],
  canWrite: true,
});

const previous = await memory.get(
  { namespace: "dataset:" + datasetId, ownerId: workerId },
  "last-successful-stage",
);
await memory.close();
```

The same contract is available for AgentCore, Book Studio, and per-agent stores. The application must derive `principalId`, roles, and namespace grants from its authenticated server-side identity; never accept them from an untrusted request body. AgentCore session connectors and Book Studio book connectors are namespace-scoped and closed per operation. Data Synthesis uses a dataset-scoped connector and stores only bounded job-state summaries, not raw prompts or customer source content.
