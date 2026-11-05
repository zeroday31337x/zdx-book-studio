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
- The running production directory is currently not a Git checkout. Do not overwrite it by blindly cloning or pulling. First reconcile production code with the canonical repository, commit reviewed differences, back up the live database, then deploy a pinned commit.

## Operating rules
1. Before a Studio operation, read this file and inspect `systemctl show zdx-book-studio-primary.service -p WorkingDirectory -p ExecStart`.
2. Read manuscript from the production SQLite DB, filtered by the CodeBound book ID; the DB contains multiple books. Approved text for chapters 1–35 is `approvedText`; chapter 36 is a reviewed draft in `draft`.
3. Humanizer and analytics may consume read-only, versioned snapshots, never overwrite or treat their own copies as manuscript truth.
4. Back up the DB with SQLite backup facilities and verify chapter counts before migrations or deployment. Never commit `.env`, `data/*.sqlite*`, manuscript contents or authentication files.
5. Do not delete legacy directories until code differences are reconciled and a verified rollback backup exists.
6. Record deployed Git commit, database migration version and deployment time in a release manifest; compare against the canonical GitHub repository before every deployment.

## Current consolidation status
Canonical repo selected and documented. Production code has NOT yet been reconciled with the repo, and legacy directories have NOT been deleted. No deployment has been performed by this decision.
