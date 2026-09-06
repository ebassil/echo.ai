## 1. Provider health gate

- [x] 1.1 Implement `src/llm/health.ts` exporting a singleton `providerHealth` with `peek()`, `check(provider)`, and `invalidate()`, probing reachability via the provider's `listModels` under `AbortSignal.timeout(2000)`.
- [x] 1.2 Cache status with distinct TTLs (down ~15s for fast recovery; up ~60s) so repeated checks within TTL perform no network I/O.
- [x] 1.3 Invalidate the cache when `baseUrl`/model settings change and after a manual connection-test command runs, so the next check re-probes.
- [x] 1.4 Add unit tests for the health gate: cached-up within TTL, expiry triggers one probe, down-state recovery within a short window, and `invalidate()` forces a re-probe.

## 2. Single trigger path

- [x] 2.1 Remove the `startWatching(...)` call in `src/plugin/runtime.ts` so orchestration triggers (`createTriggers`) are the only Joplin event-listener registration.
- [x] 2.2 Remove the legacy watcher's own full-`all` catch-up scan at startup (keep the single orchestration `enqueueRun({ scope:'all', trigger:'startup' })`).
- [x] 2.3 Reduce `indexing/watch.ts` + `indexing/events.ts` to thin shims: `getIndexingService` `flushQueue`/`getPauseStatus` delegate to `getOrchestrationTriggers()`/runner instead of running duplicate handlers.
- [x] 2.4 Verify (manual/test) that one Joplin note event enqueues at most one scoped run and no duplicate processing occurs.

## 3. Embedding/extraction failure classification

- [x] 3.1 In `processSingleNote` (`src/indexing/pipeline.ts`): on `embedChunks` failure, consult the health gate — if provider is `down`, keep existing chunks/embeddings, leave `structural_status='pending'`, skip per-note `failed`/error writes; otherwise keep current failure behavior.
- [x] 3.2 Apply the same classification in `src/semantic/index.ts` (`processSingleSemanticNote`) so extraction/embedding failures while the provider is down leave `semantic_status='pending'` instead of `failed`.
- [x] 3.3 Add run-level early-exit in `runStructuralFromNoteIds` and `runSemanticFromNoteIds`: automatic triggers (`event`/`schedule`/`startup`) abort up front with a consolidated "provider unreachable — indexing deferred" status when the gate reports `down`; manual/force runs still execute with per-note guarded embedding.
- [x] 3.4 Ensure the early-exit writes one `pipeline_runs` row with the deferred status and performs no per-note index mutations.

## 4. Retry cooldown for genuine failures

- [x] 4.1 Update `shouldReprocess` (`src/indexing/delta.ts`): `structural_status='failed'` is retried only when the last attempt (via `index_state.updated_at`) is older than the cooldown (default ~10 min); `force=true` bypasses.
- [x] 4.2 Confirm `pending` notes left by provider-down are still reprocessed once the gate flips `up` (hash changed OR status not `success`), so recovery needs no manual action.
- [x] 4.3 Add/extend tests for `shouldReprocess` covering failed-within-cooldown (skip), failed-past-cooldown (retry), and force bypass.

## 5. Noise reduction and verification

- [x] 5.1 Deduplicate per-run `console.warn`/`error` logging for embedding/extraction failures (one log per distinct error message per run) in `pipeline.ts` and `semantic/index.ts`.
- [x] 5.2 Update tests that assert the old "embedding failure ⇒ `failed`" semantics to match the provider-down deferral behavior. (No existing test asserts the old semantics; verified by search. `tests/llm/health.test.js` + `tests/delta.test.js` cover the new behavior.)
- [x] 5.3 Run lint, typecheck, and the plugin test suite; confirm `net::ERR_CONNECTION_REFUSED` console storm is gone when Ollama is stopped (backed by a health-gate unit test simulating an unreachable endpoint).