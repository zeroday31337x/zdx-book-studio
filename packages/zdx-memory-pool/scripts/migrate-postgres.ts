import { Pool } from "pg";
import { migratePostgresMemorySchema } from "../src/adapters/postgres.js";

const databaseUrl = process.env.ZDX_MEMORY_MIGRATION_DATABASE_URL;
const schemas = (process.env.ZDX_MEMORY_MIGRATION_SCHEMAS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!databaseUrl) {
  console.error("ZDX_MEMORY_MIGRATION_DATABASE_URL is required");
  process.exit(2);
}
if (!schemas.length || schemas.some((schema) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))) {
  console.error("Set ZDX_MEMORY_MIGRATION_SCHEMAS to a comma-separated list of safe schema identifiers");
  process.exit(2);
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  application_name: "zdx-memory-pool-migration",
  statement_timeout: 15000,
});

try {
  for (const schema of schemas) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await migratePostgresMemorySchema(client, schema);
      await client.query(`CREATE TABLE IF NOT EXISTS "${schema}"."memory_schema_migrations" (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query(
        `INSERT INTO "${schema}"."memory_schema_migrations" (version)
         VALUES ($1) ON CONFLICT (version) DO NOTHING`,
        ["001_initial"],
      );
      await client.query("COMMIT");
      console.log(JSON.stringify({ event: "memory_schema_migrated", schema, version: "001_initial" }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error(JSON.stringify({
        event: "memory_schema_migration_failed",
        schema,
        error: error instanceof Error ? error.message : "unknown_error",
      }));
      process.exitCode = 1;
      break;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
