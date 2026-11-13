# Book Studio — Source of Truth

Decision: 2026-11-02. Canonical GitHub repository: https://github.com/zeroday31337x/zdx-book-studio (verified HEAD 9f22c6113e0a8ea8fb6c9e0749b075558b618e8b at decision time).

## Production authority
- Running service: `zdx-book-studio-primary.service`.
- Production application: `/srv/zdx-data/apps/book-studio` (Nginx studio.zerodrivex.com -> 127.0.0.1:3210).
- **Only authoritative live manuscript database:** `/srv/zdx-data/apps/book-studio/data/books.sqlite` (include SQLite WAL when backing up; use SQLite online backup API).
- GitHub `zdx-book-studio` is the **only canonical source-code repository** for Studio. Source code, tests, migrations and deployment manifests belong there; manuscript content, runtime databases, secrets and auth records do not.

## Do not confuse with these copies
- `/home/ubuntu/zdx-books-work` and `/home/ubuntu/book-studio-sync` are stale development copies, NOT manuscript authorities.
- GitHub `zeroday31337x/zdx-books` is legacy, NOT the canonical Book Studio repo. Do not deploy from or push Studio changes to it.
- The running production directory is currently not a Git checkout. Do not overwrite it by blindly cloning or pulling. Production source was reconciled into the canonical repository on 2026-11-05. Back up the live database and verify deployment dependencies before deploying a pinned commit.

## Operating rules
1. Before a Studio operation, read this file and inspect `systemctl show zdx-book-studio-primary.service -p WorkingDirectory -p ExecStart`.
2. Read manuscript from the production SQLite DB, filtered by the CodeBound book ID; the DB contains multiple books. Approved text for chapters 1–35 is `approvedText`; chapter 36 is a reviewed draft in `draft`.
3. Humanizer and analytics may consume read-only, versioned snapshots, never overwrite or treat their own copies as manuscript truth.
4. Back up the DB with SQLite backup facilities and verify chapter counts before migrations or deployment. Never commit `.env`, `data/*.sqlite*`, manuscript contents or authentication files.
5. Do not delete legacy directories until code differences are reconciled and a verified rollback backup exists.
6. Record deployed Git commit, database migration version and deployment time in a release manifest; compare against the canonical GitHub repository before every deployment.

## Current consolidation status
Canonical source was reconciled from verified live production on 2026-11-05 and pushed to `main` as commit `1354899`. Prior main is preserved at `backup/pre-live-source-sync-20261105`. TypeScript build and all 11 current tests passed. Legacy directories remain intact; the running production Studio has not been redeployed or containerized. See `docs/architecture/SOURCE-RECONCILIATION-2026-11-05.md`.

## 2026-11-12 change set (merged to main 2026-11-13, NOT deployed)
Usage ledger (`usage_events` in the same SQLite DB), admin cost/token dashboards, pipeline hardening (opt-in independent reviewer route, section-aware context assembly, two-tier length policy, FrictionWrite preservation check + fail-soft fallback, approval continuity extraction), and scale fixes (incremental row persistence, throttled legacy mirror, auth read cache). Persistence boundary unchanged: SQLite remains authoritative; the `books.json` mirror is now refreshed at most every `BOOK_STUDIO_LEGACY_MIRROR_MS` (default 15 min) plus on shutdown, so treat it as up to one interval stale. Details and deployment notes: `docs/architecture/USAGE-LEDGER-AND-SCALE-2026-11-12.md`. Build clean, 17/17 tests at the change-set commit.

2026-11-13 addendum (same branch, still NOT deployed): product settings moved from env vars to an `app_settings` DB table managed in the admin dashboard (Platform settings panel; DB > env > default; secrets and bootstrap wiring stay in env). Suite now 21/21. See the addendum in the same decision record. Correction the same day: the reviewer route is pool-model only — Studio uses the ZDX inference pool exclusively (the platform designates the model only; the pool rotates its 12 registered providers and keys internally); the short-lived reviewerProvider option was removed before ever being deployed.

Second 2026-11-13 addendum (same branch, still NOT deployed): the series manuscript attachment feature is built (general platform feature: same-series books attach sealed canon — hash-pinned, fail-closed when stale — feeding generation and the review gate, with per-character knowledge carry-over), and three inconsistencies are fixed: production-mode stamps on canon chapters, DB-first prompt reads (manuscript files are a write-only mirror now), and the support copy's stale "end-to-end testing" claim. Suite 28/28. See the decision record addendum.
