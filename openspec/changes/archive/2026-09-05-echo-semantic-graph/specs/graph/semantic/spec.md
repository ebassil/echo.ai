## Purpose

Provides the semantic layer of the layered knowledge graph: local-LLM entity and relation extraction, entity canonicalization, delta re-extraction with lazy-or-eager cascade, and optional structural enrichment — all stored as `semantic`-layer graph data for retrieval and visualization.

## ADDED Requirements

### Requirement: Semantic extraction pipeline with configurable granularity
The system SHALL provide a semantic extraction pipeline that runs a local LLM (`provider.extract`) over note content to produce entities and typed relations, writing entity nodes, relation edges, and note→entity mention edges into the `semantic` layer. The pipeline SHALL default to per-note extraction and SHALL support opt-in per-chunk modes, with chunk size configurable via settings.

#### Scenario: Per-note default extraction
- **WHEN** semantic extraction runs for a note whose combined title+body length is within `echo.extractionMaxChars`
- **THEN** the system makes exactly one `provider.extract` call with the full note content (title prepended as `# title` when present) and writes the returned entities and relations into the semantic layer

#### Scenario: Large note windowed extraction
- **WHEN** a note exceeds `echo.extractionMaxChars` in per-note mode
- **THEN** the system splits the note using the same heading-aware chunker as structural indexing (respecting `echo.chunkSize`/`echo.chunkOverlap`), extracts each windowed chunk, and merges entity/relation results with cross-window deduplication before writing

#### Scenario: Per-chunk parallel add-on
- **WHEN** `echo.extractionGranularity` is set to `per-note+per-chunk` (add-on mode)
- **THEN** the system runs per-note extraction plus additional per-chunk extraction in parallel (bounded by `echo.extractionConcurrency`), merges all results, and deduplicates entities/relations before write

#### Scenario: Per-chunk replace mode
- **WHEN** `echo.extractionGranularity` is set to `per-chunk`
- **THEN** the system skips per-note extraction and runs only per-chunk extraction (sequentially or bounded parallel per `echo.extractionConcurrency`), one `provider.extract` call per chunk

#### Scenario: Chunk size configurability
- **WHEN** the user changes `echo.chunkSize` or `echo.chunkOverlap`
- **THEN** subsequent semantic extractions use the updated values for per-chunk and windowed extraction, without requiring a database migration

#### Scenario: Extraction output validation and retry
- **WHEN** `provider.extract` returns malformed or schema-invalid JSON (missing `entities[].name` or `relations[].from/to/type`)
- **THEN** the system retries once with a corrective prompt that asks the provider to return valid JSON in the required schema; if still invalid, it marks `index_state.semantic_status='failed'` with the parse error (truncated to 1k chars) and does not abort processing of other notes

#### Scenario: Bounded concurrency and isolated failure
- **WHEN** per-chunk extraction runs with `echo.extractionConcurrency = N`
- **THEN** at most N `provider.extract` calls are in flight concurrently; a failure (timeout, provider unreachable, invalid response after retry) for one chunk marks that note's `semantic_status='failed'` and records the error, without deleting already-stored semantic data for other notes

#### Scenario: Extraction uses local provider only
- **WHEN** semantic extraction runs
- **THEN** it calls only the configured local Ollama provider (`echo.provider`/`echo.baseUrl`/`echo.extractionModel` if set, otherwise `echo.model`); note content is never sent to any remote endpoint

### Requirement: Entity canonicalization with exact+fold and embedding-clustered modes
The system SHALL canonicalize extracted entity strings into `entities` rows with `canonical_name`, `aliases` (JSON array of distinct original spellings), `type`, and `confidence`. The system SHALL support two canonicalization modes selectable via `echo.canonicalizationMode`: `exact` (case-fold) and `embedding` (embedding similarity clustering).

#### Scenario: Exact+fold deduplication
- **WHEN** canonicalization runs in `exact` mode and extractions produce spellings like "Alice", "alice ", "ALICE"
- **THEN** the system normalizes via NFC, trim, `toLocaleLowerCase()`, and whitespace collapse; all variants map to a single `entities` row with `canonical_name` equal to the normalized form of the first-seen original, `aliases` containing each distinct original spelling, and `type`/`confidence` taken from the first occurrence (or the highest confidence if multiple)

#### Scenario: Embedding-clustered merging
- **WHEN** canonicalization runs in `embedding` mode
- **THEN** the system normalizes names as above, embeds each normalized name via `provider.embeddings`, and merges an incoming entity into an existing entity when cosine similarity to that entity's canonical name exceeds `echo.canonicalSimilarity` (default 0.85); on merge, `aliases` is the union of both alias sets and `canonical_name` remains the earliest-seen canonical form

#### Scenario: Below-threshold alias stays separate
- **WHEN** embedding mode compares "NYC" and "New York" and similarity is below `echo.canonicalSimilarity`
- **THEN** two separate `entities` rows are created, each with its own `canonical_name` and `aliases`

#### Scenario: Canonical name uniqueness enforced
- **WHEN** two canonicalization attempts would create the same `canonical_name`
- **THEN** the second attempt merges into the existing row (aliases union) rather than failing with a UNIQUE constraint error; the operation is idempotent within a per-note transaction

#### Scenario: Nodes bridge to entities
- **WHEN** a canonicalized entity exists
- **THEN** a `nodes` row exists with `layer='semantic'`, `kind='entity'`, `label` equal to the entity `canonical_name`, and `entity_id` referencing `entities(id)`, and any `nodes` rows previously pointing to an absorbed `entity_id` are rewritten to the surviving entity's id (not left NULL)

#### Scenario: Pure-JS, no LLM for canonicalization
- **WHEN** canonicalization runs in either mode
- **THEN** no LLM generation call is made for merging; only string normalization (exact) or embedding cosine (embedding mode) is used

### Requirement: Relation extraction and evidence-counted storage
The system SHALL store typed relations between canonicalized entities in `relations` with supporting evidence, and SHALL materialize semantic graph edges. Relation evidence SHALL be counted (multiple chunks can evidence the same relation) using a `relation_evidence` join table, and relation `confidence` SHALL be derived deterministically from evidence count and LLM-reported confidence.

#### Scenario: Relations stored with evidence join table
- **WHEN** extraction returns a relation `A -[knows]-> B` evidenced by chunk X
- **THEN** a `relations` row exists with `source_entity_id` and `target_entity_id` referencing canonical entities, `relation_type='knows'`, and a `relation_evidence` row exists linking that `relation_id` to `evidence_chunk_id = X`

#### Scenario: Multiple evidence for same relation increments count
- **WHEN** two different chunks (from the same or different notes) evidence the same logical relation `A -[knows]-> B`
- **THEN** a single `relations` row exists with two `relation_evidence` rows; `relations.confidence` is recomputed as a deterministic function of evidence count and the individual extraction confidences (e.g., `1 - product(1 - c_i)` or `evidence_count`-weighted average as documented), and is updated whenever evidence is added or removed

#### Scenario: Relation edges materialized
- **WHEN** a relation exists between two entities
- **THEN** an `edges` row exists with `layer='semantic'`, `type='relation'`, `source_id` and `target_id` equal to the corresponding entity `nodes.id` values, and `weight` derived from `relations.confidence`

#### Scenario: Mention edges materialized
- **WHEN** a note's extraction mentions an entity E
- **THEN** an `edges` row exists with `layer='semantic'`, `type='mention'`, `source_id` equal to the note's `nodes(id)` (`note:<noteId>`) and `target_id` equal to E's entity node id, with one mention edge per (note, entity) pair evidenced by at least one of the note's chunks

### Requirement: Content-hash delta and stale semantic cleanup
The system SHALL re-extract a note only when its content hash differs from `index_state.content_hash`, when the extraction model changes, or when `force=true` is requested. On hash change or deletion, stale semantic data for that note SHALL be removed via scoped deletes or FK CASCADE.

#### Scenario: Unchanged note skipped
- **WHEN** the semantic pipeline scans a note and `currentHash == index_state.content_hash`, `index_state.semantic_status='success'`, and the configured extraction model matches the model recorded for that note's last run
- **THEN** no extraction or graph writes occur for that note

#### Scenario: Changed note re-extracted atomically
- **WHEN** a note's content hash has changed
- **THEN** the system deletes prior `relation_evidence` and `edges(type='mention')` for that note's chunks, re-extracts per the configured granularity, inserts new entities/relations/evidence/edges, and updates `index_state.content_hash`, `index_state.semantic_status='success'`, and `notes.indexed_at` in a single per-note transaction

#### Scenario: Deleted note purged
- **WHEN** a note that exists in `notes`/`index_state` no longer exists in Joplin
- **THEN** the system removes its rows from `relation_evidence` (via chunk CASCADE), `edges(layer='semantic')` where source is its note node, and `index_state`/`notes`; entity nodes and relations that lose all evidence as a result have their evidence count decremented per the evidence-counting rule and are deleted when count reaches zero

#### Scenario: Extraction model change invalidates
- **WHEN** `echo.extractionModel` (or `echo.model` if extraction model is not separately configured) differs from the model recorded for a note's last successful semantic run
- **THEN** that note is treated as stale and is re-extracted on the next semantic scan regardless of content hash equality

#### Scenario: Force re-extract bypasses delta
- **WHEN** a caller requests semantic re-extraction with `force=true`
- **THEN** matching notes are re-extracted regardless of content hash or model equality

### Requirement: Lazy evidence-counted cascade and eager opt-in cascade
The system SHALL default to lazy evidence-counted cascade (no neighbor re-extraction on edit) and SHALL offer an opt-in eager cascade that re-extracts neighbor notes whose graph neighborhood changed, with configurable depth and fanout cap. Both modes SHALL keep relation confidence coherent; only eager SHALL re-extract neighbor text.

#### Scenario: Lazy default updates evidence and confidence without neighbor re-extraction
- **WHEN** `echo.semanticCascade='lazy'` (default) and note B is edited to remove mention of entity Alice
- **THEN** the system re-extracts B only, deletes B's `relation_evidence` and `mention` edges, decrements evidence counts for affected relations (e.g., Alice→Bob), recomputes their confidence deterministically, deletes any relation whose evidence count reaches zero (and its `relation` edge), and does NOT enqueue any neighbor notes for re-extraction

#### Scenario: Eager cascade re-extracts neighbors
- **WHEN** `echo.semanticCascade='eager'` and note B is edited
- **THEN** the system re-extracts B, identifies affected entities (added/removed/changed), finds neighbor note ids that have `relation_evidence` or `mention` edges to those entities (up to `echo.semanticCascadeFanoutCap` distinct notes), and re-extracts each neighbor in the frontier; this repeats for `echo.semanticCascadeDepth` iterations with a visited set to prevent revisiting

#### Scenario: Eager cascade respects bounds and visited set
- **WHEN** eager cascade would affect more than `echo.semanticCascadeFanoutCap` neighbors or would revisit a note already processed in the current cascade run
- **THEN** the system caps the frontier to the fanout limit (deterministic order, e.g., earliest `updated_at` first) and skips already-visited notes, ensuring the cascade terminates within `depth * fanoutCap` re-extractions

#### Scenario: Cascade mode selectable via settings and via trigger
- **WHEN** the user changes `echo.semanticCascade` between `lazy` and `eager`, or changes `echo.semanticCascadeDepth`/`echo.semanticCascadeFanoutCap`
- **THEN** subsequent semantic runs use the new mode and bounds; additionally, a caller (orchestration or CLI) can override the cascade for a single run via a `cascade` parameter (`{mode:'eager', depth:N}` or `false` to force lazy for that run)

#### Scenario: Vault lock gates cascade
- **WHEN** a cascade run is in progress and the Joplin vault becomes locked (or the run starts while locked)
- **THEN** remaining frontier notes are deferred/quened and no decrypted content is read while locked; the queue is flushed on vault unlock or next startup delta scan, consistent with structural indexing's vault gating

#### Scenario: Single pipeline_runs row for cascade
- **WHEN** a cascade run (lazy or eager) completes
- **THEN** a single `pipeline_runs` row exists with `pipeline='semantic'`, `trigger` reflecting the initiating event (edit, manual, schedule), `scope` encoding the cascade mode and depth, `status` `success`/`failed`/`cancelled`, `notes_processed` equal to `1 + number of cascaded neighbors actually re-extracted`, and `error` truncated to 1k on failure

### Requirement: Optional structural enrichment as distinct source
The system SHALL provide optional structural enrichment that writes suggested tags and wiki-links back into Joplin notes. The feature SHALL be opt-in (default off), SHALL mark enriched edges as a distinct source, SHALL be idempotent via a marker, and SHALL suppress the indexing event loop from re-triggering on its own writes.

#### Scenario: Enrichment off by default
- **WHEN** `echo.enrichmentEnabled` is `false` (default)
- **THEN** no Joplin notes are modified by enrichment regardless of extraction output; enrichment is not scheduled automatically

#### Scenario: Enrichment writes with distinct source
- **WHEN** `echo.enrichmentEnabled` is `true` and extraction suggests a tag or wiki-link for note N
- **THEN** the system writes the tag (via `joplin.data.post(['tags', ...])` or body hashtag, as implemented) or wiki-link (`[[Target]]` in body) into note N, and creates or updates `nodes`/`edges` rows with `layer='structural'`, `source='enrichment'` (or equivalent discriminator), distinguishing them from user-authored `source='joplin'` edges; readers can filter by `source`

#### Scenario: Idempotent enrichment via marker
- **WHEN** enrichment writes to a note
- **THEN** it appends or updates an idempotency marker (HTML comment `<!-- echo:enrichment v{version} ... -->` at the end of the body, not included in chunking/extraction input) containing the version and the exact set of tags/links written; on subsequent runs, the system parses the marker and performs a diff — writing only added/removed enrichment and updating the marker — and performs no write when the suggestion is unchanged

#### Scenario: Marker removal forces re-enrichment
- **WHEN** a user manually removes the `<!-- echo:enrichment ... -->` marker from a note body
- **THEN** the next enrichment run treats the note as not yet enriched and re-evaluates enrichment from scratch

#### Scenario: Loop suppression via watch gate
- **WHEN** enrichment modifies a note via `joplin.data.put`
- **THEN** the system registers the note id in an in-flight suppression set before the write and the `watch` debounce handler (`watch.ts` event pipeline) skips enqueuing a structural or semantic reindex for that note id within the suppression window (e.g., 5 seconds or until the debounce fires once), preventing an enrichment→reindex→re-enrichment loop; the structural graph for the enriched edges is still updated via the direct `source='enrichment'` write without an extra reindex

#### Scenario: Enrichment independent of semantic re-extraction cadence
- **WHEN** enrichment is enabled and a note's semantic extraction is up to date
- **THEN** enrichment can run without re-extracting the note; and when enrichment is disabled, previously enriched `source='enrichment'` edges can be deleted independently (`DELETE FROM edges WHERE source='enrichment'` filtered by note) without affecting user-authored structural edges

### Requirement: Scoped semantic runs with progress and result counts
The system SHALL support scoped semantic extraction — single note, folder (with descendants), and all notes — with progress reporting and result counts, reusing the scope resolution semantics defined for structural indexing.

#### Scenario: Single-note scope
- **WHEN** semantic extraction is invoked with scope `noteId = "<id>"`
- **THEN** only that note is considered for delta processing (or reported as not found if the id does not exist), with lazy or eager cascade applied per the current mode if that single note changed

#### Scenario: Folder scope
- **WHEN** extraction is invoked with scope `folderId = "<id>"`
- **THEN** only notes whose `parent_id` equals that folder or its descendant folders are considered, and each note is delta-checked individually

#### Scenario: All-notes scope
- **WHEN** extraction is invoked with scope `all`
- **THEN** every non-deleted Joplin note is considered for delta processing (skipping unchanged notes per content hash and model)

#### Scenario: Scoped run returns counts
- **WHEN** a scoped run completes
- **THEN** the caller receives counts of `notesProcessed`, `entitiesCreated`, `relationsCreated`, `skipped` (hash-equal), and any `errors` with per-note messages; and a `pipeline_runs` row is written

### Requirement: Semantic index state and pipeline run logging
The system SHALL maintain per-note semantic status in `index_state.semantic_status` (`pending` | `success` | `failed`) and SHALL log every semantic pipeline execution in `pipeline_runs` with `pipeline='semantic'`.

#### Scenario: Index state updated per note
- **WHEN** a note finishes semantic extraction (success or failure)
- **THEN** `index_state` for that `note_id` reflects the current `content_hash`, `semantic_status`, `last_indexed_at` (set on success, preserved on failure), `error` (truncated to 1k, null on success), and `updated_at`; `structural_status` is left unchanged

#### Scenario: Pipeline run logged
- **WHEN** a semantic extraction run starts and finishes
- **THEN** a `pipeline_runs` row is created with `pipeline='semantic'`, `trigger` (`manual`, `event`, `schedule`, `startup`), `scope` (note/folder/all/cascade), `status` (`running` → `success`/`failed`/`cancelled`), `started_at`/`finished_at`, `notes_processed`, and `error` if failed

### Requirement: Plaintext index security posture for semantic data
The system SHALL store all derived semantic index data (entities, relations, relation evidence, semantic graph nodes/edges, hashes) as plaintext in the plugin data dir SQLite file, SHALL NOT sync the index, and SHALL obtain note content only via `joplin.data` decrypted at runtime while the vault is unlocked. Semantic extraction SHALL NOT send note content to any remote endpoint.

#### Scenario: Semantic index is local and unsynced
- **WHEN** semantic data is written
- **THEN** it resides only in the plugin data directory SQLite file (per storage spec) and is never placed in a Joplin sync folder

#### Scenario: No network exfiltration during enrichment
- **WHEN** structural enrichment writes tags or wiki-links via Joplin data APIs
- **THEN** no note content is sent to any network endpoint as part of the write; only the local extraction step's Ollama call is network-touching, and only to the configured local `baseUrl`

#### Scenario: No extraction while vault is locked
- **WHEN** the vault is locked and a semantic extraction or cascade is triggered
- **THEN** the request is queued/deferred until unlock and no decrypted content is read while locked
