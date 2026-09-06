# indexing Specification

## Purpose

Provides the structural indexing pipeline that turns Joplin notes into chunked, searchable, and graph-linked data — the foundation for retrieval, chat context, and the layered knowledge graph.

## Requirements

### Requirement: Structural indexing pipeline pulls notes via Joplin API
The system SHALL provide a structural indexing pipeline that fetches note data through `joplin.data` (notes, folders, tags) and processes note title and body content into downstream artifacts (chunks, structural graph).

#### Scenario: Indexing fetches notes from Joplin data API
- **WHEN** the pipeline runs with any scope (single note, folder, all)
- **THEN** it fetches note records via `joplin.data` including `id`, `title`, `parent_id`, `body` (markdown), `created_time`, `updated_time`, and notebook/folder membership, and uses Joplin folder APIs to resolve folder-scoped queries

#### Scenario: Indexing works only on decrypted content
- **WHEN** the Joplin vault is locked (E2EE)
- **THEN** the pipeline defers execution and surfaces a status indicating indexing is paused until unlock, because `joplin.data` returns decrypted content only while unlocked

### Requirement: Markdown parsing and heading-aware chunking
The system SHALL parse note markdown and split it into ordered chunks using a heading-aware strategy with size limits, storing results in `chunks` and keeping `chunks_fts` synchronized via existing triggers.

#### Scenario: Chunking respects headings and size limits
- **WHEN** a note with markdown headings (`#`, `##`, etc.) and body text is indexed
- **THEN** the system produces chunks where heading boundaries are preferred split points, no chunk exceeds the configured maximum token/character limit, chunks preserve their original order via `chunk_index`, and each chunk records `content` and `token_count`

#### Scenario: Small notes produce one chunk
- **WHEN** a note whose content is below the chunk size limit is indexed
- **THEN** exactly one chunk is created with `chunk_index` 0

#### Scenario: Chunk content supports FTS retrieval
- **WHEN** chunks are inserted or replaced for a note
- **THEN** the `chunks_fts` FTS5 index is kept synchronized (via the schema triggers) so BM25 queries can find chunk content immediately

#### Scenario: Deterministic chunk IDs
- **WHEN** the same note content is chunked twice
- **THEN** the resulting chunk `id` values are deterministic per `(note_id, chunk_index)` so that re-indexing can diff and upsert without orphaning embeddings that CASCADE on chunk replacement

### Requirement: Structural graph extraction from wiki-links, tags, and backlinks
The system SHALL extract wiki-links (`[[...]]`), Joplin tags, and backlinks from notes and materialize them as `structural`-layer nodes and edges in the layered graph (`nodes`/`edges` with `layer = 'structural'`).

#### Scenario: Wiki-link edges extracted
- **WHEN** a note body contains wiki-links `[[Target Title]]` or `[[Target Title|alias]]`
- **THEN** the system resolves each link to a target note (by title match, case-insensitive, first match if ambiguous) and creates an edge with `layer='structural'`, `type='link'` from the source note's graph node to the target note's graph node; unresolved links produce no edge and are counted as unresolved

#### Scenario: Tag edges extracted
- **WHEN** a note has Joplin tags associated via `joplin.data`
- **THEN** the system creates or reuses a tag node and an edge with `layer='structural'`, `type='tag'` from the note node to the tag node, with one edge per (note, tag) pair

#### Scenario: Backlink edges derived
- **WHEN** note A links to note B via a wiki-link
- **THEN** the system materializes a complementary edge with `type='backlink'` from B to A (or ensures backlinks can be queried bidirectionally), consistent with the structural layer

#### Scenario: Structural nodes per note
- **WHEN** a note is indexed
- **THEN** a `nodes` row with `kind='note'`, `layer='structural'`, `label` derived from note title, and `note_id` pointing to the note exists (created or updated), enabling graph traversal

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

### Requirement: Content-hash delta and stale cleanup
The system SHALL compute a content hash for each note (title + body) and only reprocess notes whose hash differs from `index_state.content_hash`; on deletion or hash change, stale chunks, embeddings, and structural edges for that note are removed via CASCADE or explicit cleanup.

#### Scenario: Unchanged notes are skipped
- **WHEN** the pipeline scans notes and a note's current content hash equals `index_state.content_hash` and `structural_status` is `success`
- **THEN** no chunks, embeddings, or graph edges are rewritten for that note

#### Scenario: Changed note is reprocessed atomically
- **WHEN** a note's content hash has changed
- **THEN** the system deletes prior chunks for that note (which CASCADE deletes embeddings and `chunks_fts` entries), re-chunks, re-embeds, re-extracts structural edges, updates `notes.content_hash` and `index_state.content_hash`, and sets `structural_status` to `success` in a single logical transaction per note

#### Scenario: Deleted note is purged
- **WHEN** a note that exists in `notes`/`index_state` no longer exists in Joplin (deleted)
- **THEN** the system removes its rows from `notes`, `chunks`, `embeddings`, `nodes`, `edges` (via FK CASCADE), and `index_state` so the index contains no orphan data

#### Scenario: Force reindex bypasses delta
- **WHEN** a caller requests reindex with `force = true`
- **THEN** the system reprocesses matching notes regardless of content hash equality

### Requirement: Scoped indexing runs
The system SHALL support scoped runs — single note, folder, and all notes — callable programmatically (and later by orchestration/CLI/UI) with progress and result counts.

#### Scenario: Single-note scope
- **WHEN** the pipeline is invoked with scope `noteId = "<id>"`
- **THEN** only that note is processed (or reported as not found if the id does not exist)

#### Scenario: Folder scope
- **WHEN** the pipeline is invoked with scope `folderId = "<id>"`
- **THEN** only notes whose `parent_id` equals that folder (and, if the plugin resolves nested folders, all descendant folder notes) are processed

#### Scenario: All-notes scope
- **WHEN** the pipeline is invoked with scope `all`
- **THEN** every non-deleted Joplin note is considered for delta processing (skipping unchanged notes per content hash)

#### Scenario: Scoped run returns counts
- **WHEN** a scoped run completes
- **THEN** the caller receives counts of `notesProcessed`, `chunksCreated`, `skipped` (hash-equal), and any `errors` with per-note messages

### Requirement: Event-driven watching with debounce and unlock gate
The system SHALL watch Joplin note events (`note added`, `note changed`, `note deleted`) and trigger debounced incremental indexing, gated by vault-unlock state, updating `index_state` and `notes.indexed_at`.

#### Scenario: Note change triggers debounced reindex
- **WHEN** a note is created or edited in Joplin
- **THEN** the system debounces the event (coalescing rapid edits, default window 1-2 seconds) and enqueues a single-note reindex for that `noteId`

#### Scenario: Note deletion triggers purge
- **WHEN** Joplin emits a delete event for a note
- **THEN** the system purges that note's stale index data as described in the delta requirement and removes its `index_state` row

#### Scenario: Vault unlock resumes indexing
- **WHEN** the vault transitions from locked to unlocked
- **THEN** the system runs a delta scan over all notes (respecting content hash) to catch changes that occurred while locked, without requiring user action

#### Scenario: Index state updated per note
- **WHEN** a note finishes structural indexing (success or failure)
- **THEN** `index_state` for that `note_id` reflects the current `content_hash`, `structural_status` (`pending` | `success` | `failed`), `last_indexed_at`, `error`, and `updated_at`

#### Scenario: No indexing while locked
- **WHEN** the vault is locked and an event or manual trigger requests indexing
- **THEN** the request is queued/deferred until unlock and no decrypted content is read while locked

### Requirement: Notes table snapshot is kept current
The system SHALL maintain the `notes` table as a snapshot of Joplin note metadata, upserting `title`, `notebook_id`, `notebook_name`, `content_hash`, `parent_id`, `created_at`, `updated_at`, `indexed_at`, and `status` on each processed note.

#### Scenario: Notes row upserted on indexing
- **WHEN** a note is processed
- **THEN** its row in `notes` is inserted or updated with current Joplin metadata and `indexed_at` set to the current time, with `status` set to `success` or `failed` matching `index_state`

#### Scenario: Notes snapshot is readable for downstream pipelines
- **WHEN** a downstream consumer (semantic extraction, retrieval) queries `notes`
- **THEN** it can read `content_hash` and `indexed_at` to decide further work without re-reading Joplin data

### Requirement: Plaintext index security posture
The system SHALL store all derived index data (chunks, embeddings, graph, hashes) as plaintext in the plugin data dir SQLite file, SHALL NOT sync the index, and SHALL obtain note content only via `joplin.data` decrypted at runtime while unlocked.

#### Scenario: Index is local and unsynced
- **WHEN** the index database is created
- **THEN** it resides only in the plugin data directory (per storage spec) and is never placed in a Joplin sync folder

#### Scenario: No network exfiltration during structural indexing
- **WHEN** structural indexing (chunking, link/tag extraction) runs
- **THEN** no note content is sent to any network endpoint; only the embedding step calls the configured provider and that step is the sole network-touching operation in this capability
