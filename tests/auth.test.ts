import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthStore } from '../src/auth.js';

const dirs: string[] = [];
function store() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zdx-studio-auth-'));
  dirs.push(dir);
  return new AuthStore(path.join(dir, 'auth.json'));
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

test('new verified Cognito identity receives basic user access by default', () => {
  const auth = store();
  const session = auth.loginCognito('member-sub', 'member@example.com');
  assert.ok(session);
  assert.equal(session.user.role, 'user');
  assert.equal(session.user.tier, 'basic');
  assert.equal(auth.authenticate(session.token)?.role, 'user');
});

test('Cognito sub cannot bind to an account already linked to a different sub', () => {
  const auth = store();
  assert.ok(auth.loginCognito('sub-one', 'member@example.com'));
  assert.equal(auth.loginCognito('sub-two', 'member@example.com'), null);
});

test('disabled accounts cannot log in or authenticate', () => {
  const auth = store();
  const session = auth.loginCognito('sub-one', 'member@example.com');
  assert.ok(session);
  auth.upsertUser('member@example.com', { disabled: true });
  assert.equal(auth.authenticate(session.token), null);
  assert.equal(auth.loginCognito('sub-one', 'member@example.com'), null);
});

test('bootstrap flag is required to create a new admin from Cognito', () => {
  const auth = store();
  const member = auth.loginCognito('member-sub', 'member@example.com');
  assert.ok(member);
  assert.equal(member.user.role, 'user');
  const admin = auth.loginCognito('admin-sub', 'admin@example.com', true);
  assert.ok(admin);
  assert.equal(admin.user.role, 'admin');
});
