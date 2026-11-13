# Usage ledger, pipeline hardening, and scale fixes — 2026-11-12

Status: **merged to `main` 2026-11-13** via the feature branch
`usage-ledger-pipeline-scale-2026-11-12`, built and tested (28/28).
**Not deployed.** Production still runs the 2026-11-05 reconciliation
until a staged release ships this change set. Requested by Justen
2026-11-12 after the pipeline / platform review of the same day.

## What changed

### Inference usage ledger (new)
- Every model call in `BookAgentService` (design, write, continuation,
  length repair, review, continuity extraction, FrictionWrite, local
  humanizer) is metered through one wrapper: provider, model, real token
  usage from the provider response (estimated from text length only when a
  provider returns none, and flagged `tokensEstimated`), latency, and cost.
- Cost comes from a rate card: `BOOK_STUDIO_MODEL_RATES` (JSON env).
  Self-hosted inference-pool models default to $0/token — the pool is owned
  infrastructure, so tokens and latency are the honest resource measures;
  no dollar figure is invented. Paid providers get real rates via env.
- Storage: `usage_events` table in the existing `books.sqlite`
  (migration is additive, `CREATE TABLE IF NOT EXISTS`).
- Admin surfaces: `GET /api/admin/usage` (totals, by user / book / model,
  recent events), usage totals in `/api/admin/overview`, per-user inference
  totals in `/api/admin/users` and the user-review endpoint. The admin
  dashboard shows call/token/cost stat cards, by-user / by-book / by-model
  tables, and a recent-calls table. User create/edit/delete already existed
  in the dashboard and API; the users table now also shows metered tokens
  and cost per user.
- Metering starts at deployment; historical production is not backfilled.
  The inference metrics DB used by the logs page remains a separate,
  pool-wide aggregate.

### Pipeline hardening
- **Reviewer independence (opt-in):** `BOOK_REVIEWER_PROVIDER`
  (groq|gemini|openai, via a reviewer-only ProviderRouter) or
  `BOOK_REVIEWER_MODEL` (a different model on the same pool, called
  directly) routes the review gate away from the writer's model. Unset,
  behavior is unchanged.
- **Context assembly:** writer caps raised (book.md 9,000; continuity
  12,000) and truncation is no longer silent or mid-document by default:
  excerpts cut at paragraph boundaries with an explicit omission marker;
  continuity is trimmed section-aware (oldest timeline entries first;
  facts / knowledge state are never middle-cut). The writer now receives
  a bounded voice excerpt of the previous same-POV canon chapter (was
  blanked). Chapter summaries widened from last 8 to last 24.
- **Two-tier length policy** (`chapterLengthBands` in context.ts): the
  ±20% preferred band is advisory; hard bounds (floor 0.6× target, cap
  `hardChapterWordCap` or 1.3× target) are enforced deterministically.
  Compression passes now run only above the hard cap, and review only
  forces NEEDS_CHANGES outside the hard bounds — inside them, a PASS can
  be an earned exception, matching the documented behavior (CodeBound
  Ch.2, 2,444 words under a 2,500 cap). New optional book field
  `hardChapterWordCap` (create/PATCH APIs accept it).
- **Review retry feedback:** a malformed-review retry now includes the
  validation error in the prompt instead of repeating the identical ask.
- **FrictionWrite:** added a deterministic preservation check (proper
  names and figures from the draft must survive the revision, 10%
  tolerance), and the pass is now fail-soft — a rejected/failed revision
  logs `[BOOK_STUDIO_FRICTION_FALLBACK]` and the original draft proceeds
  to review, instead of failing the chapter.
- **Approval continuity gap closed:** approving a chapter without a PASS
  review now still feeds continuity — an existing review's deltas merge
  regardless of verdict; with no review on record, deltas are extracted
  from the approved text (`extractContinuity`). Extraction failure is
  logged and never blocks a human approval.
- Dead code removed: unused agent-team `writerTeam`/`reviewerTeam`
  builders (generation never used the TeamRuntime path).

### Scale fixes (the 10-user wall)
- **Incremental persistence:** `SqliteBookStore.save()` previously deleted
  and re-inserted every character/chapter row of the book and re-serialized
  the entire library to `books.json` on every save. Rows are now written
  only when their content hash changed (hash cache warmed on read, staged
  during the transaction, committed only after COMMIT).
- **Legacy mirror throttled:** `books.json` remains a recovery convenience
  (SQLite is authoritative), refreshed at most once per
  `BOOK_STUDIO_LEGACY_MIRROR_MS` (default 15 min) and flushed on
  SIGTERM/SIGINT. Recovery runbooks should treat the mirror as up to one
  interval stale; the SQLite online backup remains the recovery path.
- **Auth hot path:** `AuthStore` now caches the parsed auth file keyed by
  mtime and `authenticate()` no longer rewrites the file on every request
  (writes only when pruning actually expired a session, plus the usual
  login/logout/change writes).

## Verification
- `npm run build` clean; `npm test` 17/17 (11 pre-existing + 6 new in
  `tests/usage.test.ts`: rate card, ledger aggregation, length bands,
  incremental save integrity, mirror throttle, auth no-write-on-read).
- Smoke: server boots on a scratch port; `/` 200; `/api/admin/usage`
  correctly rejects non-admin; `/api/auth/me` correctly rejects anonymous.

## Deployment notes
- Additive SQLite migration only; no data movement. Deploy via the staged
  release process in SOURCE_OF_TRUTH.md (never pull over the live
  directory). Back up `books.sqlite` (with WAL) before deploying.
- Set `BOOK_REVIEWER_PROVIDER`/`BOOK_REVIEWER_MODEL` and
  `BOOK_STUDIO_MODEL_RATES` in the production env only when ready to use
  them; all default to prior behavior / $0 pool rates.
- Rollback: redeploy the previous pinned commit; the `usage_events` table
  is inert for older code.

## Addendum 2026-11-13 — settings moved from env to the database

At Justen's direction ("Do we have to use env file for the options and on
off or setting? Can't we use a db table or options?"), product settings no
longer require env edits:

- New `app_settings` table (key/value, updated_at, updated_by) in the same
  SQLite DB; the registry of known settings (key, env fallback name, label,
  kind, default, bounds, help) lives in `src/settings.ts` and drives both
  validation and the dashboard form, so the two cannot drift.
- Keys: reviewerProvider, reviewerModel, modelRates, legacyMirrorMs,
  writerMaxOutputTokens, writerContinuationTokens, writerRepairTokens,
  reviewerMaxOutputTokens, modelRequestTimeoutMs.
- Resolution everywhere: **DB setting > env > built-in default**. An empty
  DB value is a real value (e.g. reviewerProvider "" = reviewer explicitly
  on the writer route, beating a stale env entry). Changes apply without a
  restart — the reviewer route re-resolves on each review call, the rate
  card re-reads when its raw value changes, the mirror interval is read per
  save.
- Admin: `GET/PUT /api/admin/settings` (admin-only, origin-checked writes)
  and a Platform settings panel in the dashboard showing each field's
  current source (db / env / default).
- Env keeps only bootstrap wiring and secrets: DB file path, listen
  address, manuscript dir, Cognito client secret, admin seed, provider API
  keys (which live in the agent-core env, by design). Secrets are never
  stored in app_settings and never rendered by the settings API.
- Tests: `tests/settings.test.ts` (round-trip, patch validation, precedence
  including explicit-off, DB-driven mirror interval). Suite total 21/21.

## Correction 2026-11-13 — Studio uses the inference pool; there is no provider designation

Justen flagged the architectural error in the reviewer-independence design
above: Studio's model traffic goes to the ZDX inference pool, and **the
platform cannot designate a provider**. The pool itself is multi-provider:
12 providers are registered in it and it rotates their keys per call, so
successive calls usually land on different providers — that selection is
the pool's, never the platform's (Justen, clarified 2026-11-13; the same
fact was on record since 2026-11-09 and the first draft of this section
stated the pool's model-only interface too flatly). Verified in code: the writer router
registers exactly one provider (the Ollama-compatible client pointed at
`BOOK_OLLAMA_BASE_URL` / `ZDX_INFERENCE_POOL_URL`); the support bot and
FrictionWrite also call the pool. The agent core's OpenAI/Groq/Gemini
classes call those public APIs *directly* and were imported but never
registered in production — the `reviewerProvider` option built the day
before was the only path that would have activated them, i.e. it would
have made Studio bypass its own pool. Removed:

- `reviewerProvider` setting and env fallback deleted (the settings API
  now rejects it as unknown); the reviewer route resolves from
  `reviewerModel` alone.
- Reviewer independence is expressed the pool's way: a **different model
  served by the pool**, called through the same pool endpoint
  (`generateViaPoolModel`). Rotation alone does not create independence —
  the same model name is the same weights on whichever provider serves
  the call. Usage events record the pool endpoint and the model; which
  provider served a given call is pool-side information.
- The rate card keeps paid-provider keys available for cost accounting of
  any future pool-side routing, but Studio itself designates models only.

## Addendum 2026-11-13 — series attachment built; inconsistency fixes

At Justen's direction, the series manuscript attachment feature (spec:
`~/workspace/book-studio-series-attachment-spec.md`, rewritten the same day
to its general platform framing — it is a feature for any user's series,
not a CodeBound-specific build) is implemented:

- Model: `seriesName` on books (same name = same series) and
  `attachments` on the later book: { bookId, title, canonHash,
  canonChapters, canonWords, attachedAt }. The seal is a SHA-256 over the
  source book's canon chapters only. Verified on every packet build; a
  changed source canon makes the attachment stale and it feeds nothing
  until re-attached (fail closed). Chapters record the seals they were
  built against (`Chapter.builtAgainst`).
- API: `GET/POST/DELETE /api/books/:id/attachments` with guards — own
  books only, no self-attach, source must have canon, both books must
  carry the same series name. UI: series name field in Book design and a
  Series attachments card with live seal status, attach and detach.
- Generation: attached books contribute their book file, continuity file,
  a per-POV knowledge carry-over document (their own prior-book character
  file, continuity lines naming them, their canon chapter summaries, a
  voice-anchor excerpt; other characters public-only), under a binding
  series-canon instruction. Review: the same documents form a sixth
  source with explicit cross-book flag duties (contradiction, knowledge
  violation, silent retcon).
- Carry-over is text-level (recorded continuity + character files). The
  structured per-character knowledge store remains a future upgrade, not
  a prerequisite.

Inconsistencies fixed in the same pass:
- **Production-mode stamps:** canon chapters now record how they entered
  canon — `productionMode: "manual"` at the human approve endpoint,
  `"auto"` in the automated pipeline — matching the two-mode design.
- **Dual source of truth closed:** prompt-assembly reads
  (`readBookDocument` etc. in manuscript.ts) now render from the database
  object; the on-disk manuscript files are a write-only mirror, never an
  input that can override the DB.
- **Support copy:** the public support text no longer claims full-book
  generation is "still undergoing end-to-end testing"; it describes the
  two production modes accurately.
- Tests: `tests/series.test.ts` (seal counts canon only, guards, stale
  fail-closed, knowledge partitioning incl. planted draft/private-text
  exclusion, context inclusion, DB-first regression, persistence).
  Suite total 28/28. The live end-to-end acceptance items (generation
  against the pool + planted-contradiction review) run with this branch's
  deployment and are not claimed from unit tests.
