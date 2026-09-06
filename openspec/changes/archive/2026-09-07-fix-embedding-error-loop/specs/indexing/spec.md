## MODIFIED Requirements

### Requirement: Embedding pipeline for chunks
The system SHALL embed each chunk through the configured LLM provider (`provider.embeddings`) and store vectors in `embeddings` with model and dimension metadata, distinguishing provider-unavailability from per-note embedding failures so an unreachable provider defers work instead of entering a permanent retry loop.

#### Scenario: Chunks are embedded after creation
- **WHEN** chunks for a note are created or replaced
- **THEN** the system calls `provider.embeddings` with chunk texts (batched, respecting provider limits) and inserts one `embeddings` row per chunk with `model`, `dims`, and `vector` (serialized Float32 BLOB)

#### Scenario: Embedding failure is isolated
- **WHEN** embedding a batch fails for a note while the provider is reachable (rate limit, model error, malformed response)
- **THEN** the system records the error in `index_state.error`, leaves the affected note's `structural_status` as `failed`, does not delete already-stored embeddings for other notes, and allows retry on the next run subject to the retry cooldown

#### Scenario: Provider unreachable defers without destroying index data
- **WHEN** embedding fails and the provider health gate reports the provider `down`
- **THEN** the system does not call `provider.embeddings` again within the down window, keeps the note's existing chunks and embeddings intact, leaves `structural_status` as `pending`, and records a consolidated "provider unreachable — indexing deferred" status rather than marking any note `failed`

#### Scenario: Genuine embedding failures retry with cooldown
- **WHEN** a note has `structural_status='failed'` and its last attempt occurred within the retry cooldown window
- **THEN** the delta scan skips that note's re-embedding until the cooldown has elapsed, unless the run is a manual/forced reindex

#### Scenario: Embedding model change invalidates vectors
- **WHEN** the configured embedding model differs from the `model` stored in `embeddings`
- **THEN** the next indexing run treats all embeddings as stale and re-embeds affected chunks with the new model