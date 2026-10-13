import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStore } from "../src/auth.js";

const directories: string[] = [];
function makeStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zdx-book-auth-"));
  directories.push(dir);
  return new AuthStore(path.join(dir, "auth.json"));
}
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

test("Cognito Book Studio members receive writer role, not admin", () => {
  const store = makeStore();
  const session = store.loginCognito("cognito-writer-sub", "writer@example.com", "writer");
  assert.ok(session);
  assert.equal(session.user.role, "writer");
  assert.equal(store.authenticate(session.token)?.role, "writer");
});

test("only the exact configured administrator can bind a legacy admin record", () => {
  const store = makeStore();
  store.seedAdmin("admin@example.com", "temporary-password-for-test");
  assert.equal(store.loginCognito("admin-sub", "admin@example.com", "admin", false), null);
  const session = store.loginCognito("admin-sub", "admin@example.com", "admin", true);
  assert.ok(session);
  assert.equal(session.user.role, "admin");
});

test("a Cognito group change updates the stored Studio role on next login", () => {
  const store = makeStore();
  const first = store.loginCognito("same-sub", "member@example.com", "writer");
  assert.ok(first);
  const elevatedByGroup = store.loginCognito("same-sub", "member@example.com", "admin");
  assert.ok(elevatedByGroup);
  assert.equal(elevatedByGroup.user.role, "admin");
  const downgradedByGroup = store.loginCognito("same-sub", "member@example.com", "writer");
  assert.ok(downgradedByGroup);
  assert.equal(downgradedByGroup.user.role, "writer");
});

test("a legacy account is not linked by matching email alone", () => {
  const store = makeStore();
  store.seedAdmin("legacy@example.com", "temporary-password-for-test");
  assert.equal(store.loginCognito("unverified-link-sub", "legacy@example.com", "writer"), null);
});
