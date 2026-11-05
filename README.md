# ZDX Book Studio

Private manuscript-production console built on the ZDX 5-agent core.

The Studio owns book-specific state: canon, characters, POV assignments, chapter structures, continuity, review state, and manuscript assembly. It imports the existing ZDX Agent Team runtime at execution time rather than duplicating the model/provider layer.

## Production model

Each chapter is sequential and human-gated:

1. Manager receives the authoritative chapter packet.
2. The assigned POV writer produces the chapter.
3. The independent book reviewer checks canon, continuity, POV knowledge, voice, pacing, and originality risk notes.
4. A human approves the reviewed draft as Canon.
5. Only then can the next chapter be generated.

For CodeBound the intended rotation is Phreaker -> Hacker -> Crypto, repeated 14 times across 42 chapters.

## Run

```bash
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3210` for local-only development. For network exposure, put the service behind HTTPS and configure a seeded admin account with `BOOK_STUDIO_ADMIN_EMAIL` and `BOOK_STUDIO_ADMIN_PASSWORD`. The first login forces the temporary password to be changed.

The default core path points to the existing sibling `/home/zdxadmin/zdx-agent-team` installation. Provider credentials are loaded from the agent core `.env`; no keys are copied into this repository. Runtime manuscript data, authentication records, sessions, and `.env` files are excluded from Git.

## Production review envelope validation (October 2026)

The independent reviewer must return a complete JSON object containing `verdict`,
`notes`, `summary`, `continuityDelta`, `knowledgeDelta`,
`relationshipDelta`, and `originalityFlags`. The response is validated
against a strict schema. A malformed, truncated, or incomplete review is
retried once and must **not** be recorded as PASS. When both attempts fail,
the review task is marked failed and the draft is preserved for re-review.

The reviewer reserves at least 1,200 output tokens (default 1,600); the
`BOOK_REVIEWER_MAX_OUTPUT_TOKENS` setting may increase this allowance.
Review output budget changes do not alter the writer's chapter budget.

Previously saved malformed reviews are not silently rewritten or upgraded.
Chapters should be reviewed again before relying on their historical PASS
verdict or structured continuity metadata.

Validation: `npm run build && npm test`; test coverage is in
`tests/review-parser.test.ts`.

## Canonical source and deployment

This repository is the sole authoritative Book Studio source repository. The 2026-11-05 production reconciliation is documented in [docs/architecture/SOURCE-RECONCILIATION-2026-11-05.md](docs/architecture/SOURCE-RECONCILIATION-2026-11-05.md). Runtime manuscript data, SQLite databases, credentials, and user auth state remain external to Git. Do not deploy by pulling this repo over the live application directory; use a staged release with persistent-data mounts and rollback.

### Architecture change documentation rule

Every architecture, runtime, authentication, storage, integration or deployment change must update `SOURCE_OF_TRUTH.md`, relevant `docs/architecture/` decision records and deployment runbooks **in the same pull request/commit as the code**. Record source commit and deployment status (planned, in Git, built, staged or live), dependencies, env-key names (never values), persistence boundaries, verification, and rollback. Cross-platform changes must also update the central ZeroDriveX architecture inventory in `zeroday31337x/zerodrivex`.

### AgentCore research and evidence

Book Studio is a production AgentCore integration. The [research-data contract](docs/research/AGENTCORE-RESEARCH-DATA.md) defines provenance, inference telemetry, authorized research retention, and missing capture coverage. The shared inference pool remains separate from AgentCore; standalone Axiomatic Runtime is not required for book generation.
