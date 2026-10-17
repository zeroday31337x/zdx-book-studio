import test from "node:test";
import assert from "node:assert/strict";
import { postgresTarget } from "../src/adapters/postgres.js";
import type { AdapterEnvironment } from "../src/env.js";

function config(connectionString: string, sslCaFile?: string): AdapterEnvironment {
  return {
    system: "data-synthesis",
    backend: "postgres",
    connectionString,
    ...(sslCaFile ? { sslCaFile } : {}),
    schema: "zdx_memory_synthesis",
    poolMax: 2,
    statementTimeoutMs: 5000,
  };
}

test("remote PostgreSQL requires verified TLS configuration", () => {
  assert.throws(
    () => postgresTarget(config("postgresql://db.example.com/zdx")),
    /requires sslmode or a platform-specific SSL CA file/i,
  );
  const target = postgresTarget(config("postgresql://db.example.com/zdx?sslmode=require&channel_binding=require", "/etc/ssl/certs/ca-certificates.crt"));
  const url = new URL(target.connectionString);
  assert.equal(url.searchParams.has("sslmode"), false);
  assert.equal(url.searchParams.get("channel_binding"), "require");
  const ssl = typeof target.ssl === "object" && target.ssl ? target.ssl : undefined;
  assert.equal(ssl?.rejectUnauthorized, true);
});

test("connection URL cannot disable TLS verification", () => {
  assert.throws(
    () => postgresTarget(config("postgresql://db.example.com/zdx?sslmode=disable", "/etc/ssl/certs/ca-certificates.crt")),
    /cannot be disabled/i,
  );
});

test("loopback PostgreSQL remains usable for local deployments without remote TLS", () => {
  const target = postgresTarget(config("postgresql://127.0.0.1:5432/zdx"));
  assert.equal(target.ssl, undefined);
});
