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

## Standing research collection policy (decision 2026-11-05)

Book Studio is an ongoing AgentCore research and evaluation environment. Default collection should cover operational **metadata** (agent/workflow/model, timestamps, performance, error/retry, revision and evaluation outcomes) with privacy controls, minimization and tenant separation. Full manuscript/prompt/response retention for research or training requires informed, affirmative authorization; do not infer consent from a preselected checkbox or normal use. Research retention permission is distinct from approval to include examples in model training. The default-on metadata collection is a **target policy**, not evidence that the collector has been deployed. Existing `TRAINING_CAPTURE_MODEL_CALLS` is opt-in by environment flag and not verified enabled for Book Studio. Provide clear user-facing disclosure and an appropriate control for content research participation before activating content capture.
