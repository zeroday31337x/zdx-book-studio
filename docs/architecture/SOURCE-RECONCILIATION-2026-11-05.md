# Book Studio source reconciliation — 2026-11-05

## Authority

Canonical source repository: `zeroday31337x/zdx-book-studio`, branch `main`. Legacy `zeroday31337x/zdx-books` is **not** an alternate source of truth. The live application is `/srv/zdx-data/apps/book-studio` on AWS, managed by `zdx-book-studio-primary.service` and exposed via Nginx at `studio.zerodrivex.com` to port 3210.

## Compared versions

- Canonical `zdx-book-studio` before synchronization: `9f22c61`, 2026-10-19.
- Legacy `zdx-books` latest observed working branch `fix/live-book-inference-status`: `9bdb4e8`, 2026-10-28.
- Legacy production sync worktree: `sync/production-book-studio-20261102`, `48c5507`, 2026-11-02.
- Live AWS source has updates through 2026-11-03 (notably `public/app.js`); it is not a Git checkout.

## Findings and resolution

The live source is the most complete implementation. It contains additional production routes, SQLite storage, humanizer, FrictionWrite, review parser, manuscript and administrative UI, and site icons not present in the older canonical repository. The 2026-11-02 legacy production sync was close to live, but live includes later edits to `src/agent-service.ts`, `src/frictionwrite.ts`, `src/server.ts`, `src/humanizer.ts`, and scripts. Therefore, active source and public assets were copied from live into a new canonical Git branch, excluding backup artifacts and runtime data.

Canonical-only `tests/auth.test.ts` was preserved as `tests/auth.legacy-cognito.test.ts.disabled` because it tests an older role model (`writer`) and a different `loginCognito` signature; those four tests failed against production code. New tests reflect current `admin`/`user` roles and verify the current Cognito auth-store contract. All 11 active tests pass; TypeScript compilation succeeds. Preserve the old tests for reference, not as executable current-contract assertions.

## Security review follow-up (must resolve before changing production authentication)

Live `src/auth.ts` uses `find(item => item.cognitoSub === sub || item.email === normalized)` during Cognito linking. Although it rejects accounts already linked to another sub, it may bind an **unlinked** legacy local record by matching email alone. This is weaker than the old canonical test's explicit-migration expectation. The OIDC callback checks token issuer, audience, nonce, verified email and Cognito groups before invoking this function, but that does not eliminate the need for a deliberate account-linking policy. Do not silently change production identity behavior during a source synchronization. Review existing account records and migration rules, implement a verified linking policy, and add regression tests before deployment.

## Data separation and deployment safety

- Only authoritative manuscript DB: `/srv/zdx-data/apps/book-studio/data/books.sqlite`; never put it, WAL files, auth JSON, `.env`, or manuscript files into Git or Docker images.
- Verified SQLite online backup: `/srv/zdx-data/apps/book-studio/data/backups/books-before-container-20261105T173450Z.sqlite`; integrity check returned `ok`. The running service was not stopped.
- Runtime configuration is external: `/etc/zerodrivex/zdx-book-studio-aws.env` (values never committed).
- This synchronization **does not deploy or restart** the live Book Studio. Docker migration must use a separately verified container, persistent mounts, isolated port, health checks, and rollback plan.
- Do not delete legacy repos or directories until historical features, backup coverage, and migration readiness are fully verified.
