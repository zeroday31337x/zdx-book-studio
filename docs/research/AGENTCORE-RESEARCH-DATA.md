# Book Studio → ZDX AgentCore research evidence

Status 2026-11-05: production Book Studio uses AgentCore `TeamRuntime` and `ProviderRouter` for writing and review. This document describes the research capture contract; it does not claim full prompt/response logging is enabled.

## Architecture

- Studio is the manuscript/workflow authority. AgentCore orchestrates agents and logs provider attempts. The ZDX Inference Pool is the shared model routing/operational metrics service, not the same component as AgentCore.
- AgentCore telemetry session IDs use `${book.id}:chapter:${chapter.number}` and phase-specific agent IDs for writer, continuation, length repair, and reviewer; planning uses `book-auto-design`.
- Studio has direct inference-pool and optional local humanizer paths that bypass AgentCore. A shared research collector must include those paths and mark their origin.
- The standalone Axiomatic Runtime product is not required for the text-generation pipeline. Ordinary application auth, access control, validation, and sandboxing still apply.

## Research retention and data policy

Record metadata for authorized workflows: event/request ID, book/chapter/version, workflow phase, agent/role, source commit, prompt-template version, provider/model, generation settings, latency, tokens, retries, error/status, output length/hash, review score/decision, and parent artifact ID. Persist provenance for comparison of revisions and experiments.

Treat manuscript text, prompts, and responses as private user content. Store full text only in restricted research storage where data ownership and training/research authorization permit it. Do not train on other users' manuscripts by default. Separate operational logs, research candidates, reviewed examples, and approved training sets. Enforce deletion, retention, encryption, tenant isolation, and auditable approvals.

AgentCore currently has opt-in `TRAINING_CAPTURE_MODEL_CALLS` JSONL capture for router calls with session IDs, but effective Book Studio enablement has not been verified. Its heuristic redaction and 16,000-character truncation do not provide complete privacy or full-fidelity corpus capture. The inference pool's request metrics do not include prompt/response text.

## Implementation gates

1. Implement a versioned inference-event schema and nonblocking collector at the common pool boundary with Studio context propagation.
2. Link each request to AgentCore execution and manuscript version; cover direct Studio and humanizer calls.
3. Configure secure metadata storage, review/approval workflow and explicit content retention policy; test redaction and consent.
4. Verify a test-book end-to-end research trace before enabling production content capture.
5. Update AgentCore research docs and the central ZeroDriveX architecture inventory with measured results and deployment status in the same changeset.

Canonical AgentCore implementation record: https://github.com/zeroday31337x/zdx-agent-team/blob/main/docs/research/BOOK-STUDIO-IMPLEMENTATION.md


## Engineering-only research policy (supersedes prior capture proposals, 2026-11-05)

Book Studio is an ongoing AgentCore **engineering evaluation** environment. Collect **only non-content operational telemetry by default**: opaque event/trace IDs, component and workflow phase, agent role, provider/model, routing/fallback, token counts, latency, retries, failure categories, output length, schema/format validity, aggregate quality/evaluation scores, software versions and resource utilization. Research must assess agent orchestration and model-system performance, **not** the contents of books.

**Do not retain** manuscripts, chapters, prompts, completions, writing samples, character descriptions, personal data, account IDs, book titles, source documents, or user-authored text in the engineering research store. Avoid stable book/chapter IDs in exported research data; use ephemeral pseudonymous correlation IDs with bounded retention. Never log request/response bodies, error messages containing user content, or payload hashes that could reveal or link private text.

The existing AgentCore `TRAINING_CAPTURE_MODEL_CALLS` mechanism captures prompt and response content and **must remain disabled for Book Studio**. Its historical mention in this document describes an existing capability, **not an approved Book Studio data source**. No research use or training approval for user content is implied. Engineering telemetry may be analyzed for reliability and optimization, but it must not be exported as a text-model training corpus.

Implementation status: this is the approved documentation policy, not proof that a content-free telemetry collector is already deployed. Audit all emitters (AgentCore, pool, direct Studio calls and humanizer), sanitize structured errors, enforce allowlisted fields and retention limits, and validate with synthetic test requests before enabling default engineering research collection.
