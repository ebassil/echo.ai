## Context

`echo.ai` performs all LLM work (embedded chunks, semantic extraction, chat) against a local Ollama OpenAI-compatible `/v1` endpoint configured via `echo.baseUrl`. Today the plugin makes no distinction between "the provider is down" and "this note failed to embed". Consequences observed:

- Every trigger (startup catch-up, `onNoteChange`, `onSyncComplete`, schedule) fires `provider.embeddings` against a dead endpoint. Each failed `fetch` logs `net::ERR_CONNECTION_REFUSED` in the Joplin console even though the rejection is handled downstream.
- Every embedding failure records `index_state.structural_status='failed'`. `shouldReprocess` (`src/indexing/delta.ts:41-44`) treats *any* non-`success` state as "reprocess", so failed notes are retried on every subsequent pass and fail again — a permanent retry treadmill until Ollama returns.
- Two trigger systems run at once: orchestration `createTriggers` (`src/plugin/runtime.ts:173`) *and* the legacy `startWatching` (`runtime.ts:221`). Both register their own `onNoteChange`/`onSyncComplete` handlers and both run a full `scope:'all'` catch-up at startup, doubling every event and every scan, and writing to the same SQLite connection without mutual exclusion.

This design introduces a provider health gate with cached status and backoff, a single trigger path, and a bounded retry policy so that an unreachable provider produces one clear status instead of an error storm.

## Goals / Non-Goals

**Goals:**
- Detect provider-unavailable once per short window and gate embedding/extraction behind it.
- Leave notes `pending` (not `failed`) when the provider is down, and preserve their existing chunks/embeddings.
- Distinguish genuine per-note embedding failures (still retried, with cooldown) from connectivity failures (deferred, not recorded as note errors).
- Execute exactly one indexing run per Joplin event / catch-up by coalescing to the orchestration trigger path.
- Reduce console noise from expected connection-refused errors.

**Non-Goals:**
- No new storage schema, no setting-driven tuning surface (constants are fine for now, may be promoted to settings later).
- No change to chat streaming behavior (chat already surfaces its own per-send error; the health gate only informs it if trivially available).
- No changes to the semantic cascade depth/fanout logic.
- Not a full circuit-breaker with half-open states/probes — a cached binary reachability gate with lazy re-probe is sufficient.

## Decisions

### D1: Cached provider health gate as a standalone module
**Decision:** New `src/llm/health.ts` exporting a singleton `providerHealth` with:
- `peek(): 'up' | 'down' | 'unknown'` — returns cached state without any network I/O.
- `check(provider): Promise<'up' | 'down'>` — returns cached state if fresh, otherwise probes the provider and caches the result with TTL (default 30s).
- `invalidate(): void` — drop cache (e.g., after settings change or a manual connection test).

Probe is `GET {baseUrl}/v1/models` with `AbortSignal.timeout(2000)` (reusing the existing `provider.listModels()`/`testConnection` call path). Status TTL: down-state cache is short (e.g., 15s) so recovery is noticed quickly; up-state TTL can be longer (e.g., 60s) to avoid per-run probes.

**Rationale:** Consumers (`embedder`, `canonicalize`, semantic extraction, optionally chat retrieval) can all consult one cached truth. A binadic gate with lazy re-probe is simpler than a full circuit breaker and matches the "local dev tool" usage pattern.
**Alternative considered:** Per-provider `ping()` method on the interface. Rejected to avoid a breaking interface change for one capability; the gate falls back to `listModels()` which already exists on every provider.

### D2: Distinguish connectivity failure from note failure at the embed site
**Decision:** In `processSingleNote` (`src/indexing/pipeline.ts:77-117`), when `embedChunks` throws:
1. Consult `providerHealth` (probe once, not per note): if the provider is `'down'` (or becomes down), treat as *deferred*: do **not** delete existing chunks/embeddings, do **not** write `structural_status='failed'`; write/keep `structural_status='pending'` and a single run-level status "provider unreachable". Existing indexed content for the note remains queryable.
2. Otherwise the failure is genuine (provider up, model/dims/parse error): keep current behavior — persist chunks, mark `failed` — subject to the cooldown in D3.

The same classification applies in semantic extraction (`src/semantic/index.ts` `processSingleSemanticNote`), which currently marks `semantic_status='failed'` on any extraction/embedding error.

**Rationale:** This is the core fix for the "endless loop": a dead provider no longer poisons per-note state, and previously stored data is never destroyed by a connectivity failure.
**Alternative considered:** Adding a dedicated `'deferred'` status column. Rejected — reuse existing `'pending'` and run-level status; no migration needed.

### D3: Early-exit for automatic runs when provider is down
**Decision:** `runStructuralFromNoteIds` and `runSemanticFromNoteIds` (and the equivalent legacy runner path if retained) check `providerHealth.check(provider)` once at run start. If `'down'`:
- For automatic triggers (`event`, `schedule`, `startup`): abort the run with a single consolidated status "provider unreachable — indexing deferred" rather than iterating notes.
- For manual/force runs: still execute, but per-note handling from D2 applies (skip embedding when down, leave pending).

**Rationale:** Prevent the whole vault from being churned by connection-refused requests; manual runs stay functional for when a user insists.
**Alternative considered:** Always abort regardless of trigger. Rejected — manual runs may be used to index structural-only content, and per-note guarded embedding means no destructive writes.

### D4: Retry cooldown for genuinely failed notes
**Decision:** `shouldReprocess` (`src/indexing/delta.ts`) treats `structural_status='failed'` as "retry" **only if** the note's last attempt is older than a cooldown (default constant, e.g., 10 minutes, using `index_state.updated_at`). For `pending` (provider-down) notes, retry is governed by the health gate TTL, not per-note state — they are skipped until the gate flips `up`.

`force=true` bypasses both cooldowns.

**Rationale:** A burst of genuine failures (e.g., wrong model configured) retries on every flush today. A small cooldown bounds that without user configuration.
**Alternative considered:** Exponential backoff stored per note. Rejected for now — the health gate already bounds the common connectivity case; a single cooldown is enough.

### D5: Single trigger path — remove the legacy watcher overlap
**Decision:** `src/plugin/runtime.ts` stops calling `startWatching(...)` at startup. Orchestration triggers (`createTriggers`) become the only Joplin event listener and catch-up source. The legacy `indexing/watch.ts` + `indexing/events.ts` code paths are either deleted or reduced to thin shims delegating to `getOrchestrationTriggers()` / `runner` so nothing else regresses:
- `getIndexingService().flushQueue` / `getPauseStatus` delegate to orchestration triggers.
- Startup catch-up remains the single `enqueueRun({ pipeline:'structural', scope:'all', trigger:'startup' })` already issued in `runtime.ts`; the legacy watcher's own `indexAll` start-up scan is removed.

**Rationale:** The orchestration trigger framework was built to supersede `indexing/watch.ts` (see `openspec/specs/orchestration/spec.md` — "delegating watch behavior previously owned by indexing/watch.ts"). Running both is the multiplier behind the error storm.
**Alternative considered:** Stop orchestration triggers and keep the legacy watcher. Rejected — the spec and all newer features (runner queue, trigger metadata, CLI) are built on orchestration; legacy exists for back-compat only.

### D6: Console noise reduction
**Decision:** Because the gate (D1/D3) prevents most connection-refused requests from ever being issued, the dominant source of noise disappears. For leftover per-note failures, `console.warn`/`error` calls in `pipeline.ts` and `semantic/index.ts` are de-duplicated per run (one log per distinct error message per run) instead of per note.

## Risks / Trade-offs

- **Provider flaps** (Ollama restarting) → TTL for down-state is short (15s); a restart is noticed within one probe window. Mild probe traffic is negligible against a local endpoint.
- **Provider down masks genuine errors** → classification probes the gate once; if the gate says `up` but embeddings still fail, the failure is recorded as genuine (`failed`) and retried per cooldown. Edge case: provider accepts `/models` but rejects embeddings — caught by treating `up`+embed-failure as genuine.
- **Removing the legacy watcher could change event semantics** → orchestration triggers and legacy watcher already share debounce/defaults (1.2s); orchestration trigger coverage includes note change, sync complete, vault transitions, startup. Existing tests assert the trigger framework's behavior as canonical.
- **`pending` notes never recover visually** → run-level status and a single consolidated message surface "provider unreachable"; when the gate flips `up`, the next automatic run resumes and flips notes to `success`. No user action required.
- **Cooldown delays a quick re-index of a genuinely failed note** → acceptable (10 min); manual reindex/force bypasses.

## Migration Plan

1. Land D1 (health module) and D5 (single trigger path) first — no behavioral change for a healthy provider.
2. Land D2/D3/D4 — the classification and gating behavior.
3. Rollback: revert the change; prior behavior has no new schema/state to clean up (notes return to being marked `failed`/reprocessed as before). No data migration required.

## Open Questions

- Should the health-gate TTL and retry cooldown be exposed as `echo.*` settings now, or promoted later? (Default: keep constants, add settings only if users report tuning needs.)
- Should chat context retrieval consult the health gate to skip the dense retriever's failed embed attempt? (Default: no — retrieval already fails soft per retriever; revisit if noise persists.)