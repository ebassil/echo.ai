## Why

When the configured LLM provider (Ollama on `localhost:11434`) is unreachable, the plugin enters what looks like an endless loop: every indexing trigger re-attempts embeddings against the dead endpoint, each attempt logs `net::ERR_CONNECTION_REFUSED`, every note is marked `failed`, and `shouldReprocess` treats any non-`success` state as "must reprocess" forever. Two overlapping trigger systems (orchestration triggers + the legacy watcher) double every event and run two full catch-up scans at startup, amplifying the flood.

## What Changes

- Add a **provider health gate with backoff**: cache provider reachability (short timeout, ~30–60s TTL). When unreachable, skip embedding/extraction for automatic triggers, leave notes in a `pending`/`deferred` state, and surface **one** clear "provider unreachable" status instead of one error per note.
- **Distinguish provider-unavailable from note-level failure**: an unreachable provider must not poison per-note `structural_status`/`semantic_status` into a permanent retry state, and `shouldReprocess` must not treat provider-down as a per-note retry.
- **Coalesce to a single trigger path**: remove the legacy `startWatching` duplicate path so each Joplin event (note change / sync complete) and each startup catch-up triggers exactly one indexing run.
- Add a **retry cooldown** so genuinely failed notes are retried with backoff rather than on every flush.
- Reduce console noise: failed network requests to the provider log once per provider-down window, not per note/attempt.

## Capabilities

### New Capabilities
- `provider-health`: provider reachability gate with cached status and backoff used by indexing, semantic extraction, and (optionally) chat — a single source of truth for "is the provider up" decisions.

### Modified Capabilities
- `indexing`: the "Embedding failure is isolated" scenario changes so an unreachable provider defers embeddings and leaves the note `pending`, while a genuine embedding error still marks the note `failed` for bounded retry.
- `orchestration`: event triggers must de-duplicate to a single indexing path (remove the legacy watcher overlap), and failed/deferred notes must be subject to a retry cooldown rather than reprocessed on every flush.
- `llm/providers`: the provider interface gains a lightweight reachability check (e.g., cached `listModels`-style ping) that never blocks startup and is used by the health gate.

## Impact

- `src/indexing/pipeline.ts` — embed-failure handling and per-note status transition.
- `src/indexing/delta.ts` — `shouldReprocess` behavior for provider-unavailable vs. genuine failure.
- `src/indexing/watch.ts`, `src/indexing/events.ts`, `src/orchestration/triggers.ts` — de-dup / single trigger path.
- `src/plugin/runtime.ts` — stop starting the legacy watcher alongside orchestration triggers.
- `src/llm/providers/ollama.ts`, `src/llm/provider.ts` — reachability check with cache.
- New `src/llm/health.ts` (or `src/providers/health.ts`) module for the cached health gate.
- `src/orchestration/settings.ts` (optional) — cooldown/backoff tuning settings.
- No storage schema changes. Security posture unchanged: all network traffic remains to the configured local Ollama `/v1` endpoint; no note content is sent anywhere new.