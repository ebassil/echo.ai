# schema Specification

## Purpose

Defines the echo.ai index data model — the SQLite tables, columns, constraints, indexes, and migration DDL that every pipeline and UI reads and writes.

## Requirements

### Requirement: Notes table
The system SHALL provide a `notes` table that stores a snapshot of each Joplin note needed for indexing and graph construction.

#### Scenario: Notes table exists with required columns
- **WHEN** the schema migration has been applied
- **THEN** a `notes` table exists with columns `id` (primary key, Joplin note id), `title` TEXT NOT NULL, `notebook_id` TEXT, `notebook_name` TEXT, `content_hash` TEXT NOT NULL, `parent_id` TEXT, `created_at` TEXT, `updated_at` TEXT, `indexed_at` TEXT, `status` TEXT NOT NULL DEFAULT 'pending'

#### Scenario: Notes id is unique
- **WHEN** two rows with the same `id` are inserted into `notes`
- **THEN** the second insert fails due to the primary key constraint

### Requirement: Chunks table and FTS5 index
The system SHALL provide a `chunks` table that stores ordered chunked note text and a `chunks_fts` FTS5 virtual table for BM25 retrieval.

#### Scenario: Chunks table exists with ordering
- **WHEN** the schema migration has been applied
- **THEN** a `chunks` table exists with columns `id` TEXT PRIMARY KEY, `note_id` TEXT NOT NULL REFERENCES `notes(id)` ON DELETE CASCADE, `chunk_index` INTEGER NOT NULL, `content` TEXT NOT NULL, `token_count` INTEGER, `created_at` TEXT NOT NULL, and a unique constraint on (`note_id`, `chunk_index`)

#### Scenario: FTS5 table exists for BM25
- **WHEN** the schema migration has been applied
- **THEN** a `chunks_fts` FTS5 virtual table exists indexing `content` with external content mode pointing at `chunks`, and triggers keep `chunks_fts` synchronized on INSERT, UPDATE, and DELETE of `chunks`

#### Scenario: Chunk lookup by note
- **WHEN** chunks for a given `note_id` are queried
- **THEN** they are returned ordered by `chunk_index` via an index on `chunks(note_id, chunk_index)`

### Requirement: Embeddings table
The system SHALL provide an `embeddings` table that stores dense vectors per chunk for kNN retrieval.

#### Scenario: Embeddings table exists
- **WHEN** the schema migration has been applied
- **THEN** an `embeddings` table exists with columns `chunk_id` TEXT PRIMARY KEY REFERENCES `chunks(id)` ON DELETE CASCADE, `model` TEXT NOT NULL, `dims` INTEGER NOT NULL, `vector` BLOB NOT NULL, `created_at` TEXT NOT NULL

#### Scenario: Embedding references valid chunk
- **WHEN** an embedding is inserted with a `chunk_id` that does not exist in `chunks`
- **THEN** the insert fails due to the foreign key constraint

### Requirement: Layered graph nodes and edges
The system SHALL provide `nodes` and `edges` tables implementing a layered knowledge graph where every node and edge carries a `layer` column with values `structural` or `semantic`.

#### Scenario: Nodes table exists with layer and kind
- **WHEN** the schema migration has been applied
- **THEN** a `nodes` table exists with columns `id` TEXT PRIMARY KEY, `layer` TEXT NOT NULL CHECK (`layer` IN ('structural','semantic')), `kind` TEXT NOT NULL CHECK (`kind` IN ('note','entity','chunk')), `label` TEXT NOT NULL, `note_id` TEXT REFERENCES `notes(id)` ON DELETE CASCADE, `entity_id` TEXT REFERENCES `entities(id)` ON DELETE SET NULL, `weight` REAL DEFAULT 1.0, `created_at` TEXT NOT NULL, `updated_at` TEXT NOT NULL

#### Scenario: Edges table exists with layer and type
- **WHEN** the schema migration has been applied
- **THEN** an `edges` table exists with columns `id` TEXT PRIMARY KEY, `layer` TEXT NOT NULL CHECK (`layer` IN ('structural','semantic')), `source_id` TEXT NOT NULL REFERENCES `nodes(id)` ON DELETE CASCADE, `target_id` TEXT NOT NULL REFERENCES `nodes(id)` ON DELETE CASCADE, `type` TEXT NOT NULL CHECK (`type` IN ('link','tag','backlink','relation','mention')), `weight` REAL NOT NULL DEFAULT 1.0, `created_at` TEXT NOT NULL

#### Scenario: Layer filtering is indexed
- **WHEN** nodes or edges are filtered by `layer`
- **THEN** an index on `nodes(layer)` and `edges(layer, type)` supports the query efficiently

#### Scenario: Invalid layer rejected
- **WHEN** a node or edge is inserted with a `layer` value other than `structural` or `semantic`
- **THEN** the insert fails due to the CHECK constraint

### Requirement: Semantic entities and relations
The system SHALL provide `entities` and `relations` tables for canonicalized semantic extraction output.

#### Scenario: Entities table exists
- **WHEN** the schema migration has been applied
- **THEN** an `entities` table exists with columns `id` TEXT PRIMARY KEY, `canonical_name` TEXT NOT NULL UNIQUE, `type` TEXT, `aliases` TEXT (JSON array), `confidence` REAL, `created_at` TEXT NOT NULL, `updated_at` TEXT NOT NULL

#### Scenario: Relations table exists
- **WHEN** the schema migration has been applied
- **THEN** a `relations` table exists with columns `id` TEXT PRIMARY KEY, `source_entity_id` TEXT NOT NULL REFERENCES `entities(id)` ON DELETE CASCADE, `target_entity_id` TEXT NOT NULL REFERENCES `entities(id)` ON DELETE CASCADE, `relation_type` TEXT NOT NULL, `confidence` REAL, `evidence_chunk_id` TEXT REFERENCES `chunks(id)` ON DELETE SET NULL, `created_at` TEXT NOT NULL, `updated_at` TEXT NOT NULL

#### Scenario: Entity canonical name uniqueness
- **WHEN** two entities with the same `canonical_name` are inserted
- **THEN** the second insert fails due to the UNIQUE constraint

### Requirement: Index state for delta tracking
The system SHALL provide an `index_state` table that tracks per-note content hash and pipeline status to enable content-hash delta processing.

#### Scenario: Index state table exists
- **WHEN** the schema migration has been applied
- **THEN** an `index_state` table exists with columns `note_id` TEXT PRIMARY KEY REFERENCES `notes(id)` ON DELETE CASCADE, `content_hash` TEXT NOT NULL, `structural_status` TEXT NOT NULL DEFAULT 'pending', `semantic_status` TEXT NOT NULL DEFAULT 'pending', `last_indexed_at` TEXT, `error` TEXT, `updated_at` TEXT NOT NULL

#### Scenario: Delta detection via hash lookup
- **WHEN** the pipeline checks whether a note needs reprocessing
- **THEN** it can compare the current content hash against `index_state.content_hash` via the primary key lookup on `note_id`

### Requirement: Pipeline runs log
The system SHALL provide a `pipeline_runs` table that logs every pipeline execution for status queries and run history.

#### Scenario: Pipeline runs table exists
- **WHEN** the schema migration has been applied
- **THEN** a `pipeline_runs` table exists with columns `id` TEXT PRIMARY KEY, `pipeline` TEXT NOT NULL CHECK (`pipeline` IN ('structural','semantic','embedding')), `trigger` TEXT NOT NULL, `scope` TEXT, `status` TEXT NOT NULL CHECK (`status` IN ('running','success','failed','cancelled')) DEFAULT 'running', `started_at` TEXT NOT NULL, `finished_at` TEXT, `notes_processed` INTEGER DEFAULT 0, `chunks_created` INTEGER DEFAULT 0, `error` TEXT

#### Scenario: Pipeline runs are ordered by start time
- **WHEN** run history is queried
- **THEN** an index on `pipeline_runs(pipeline, started_at)` supports ordering and filtering by pipeline

### Requirement: Schema applied as versioned migration
The system SHALL apply the full domain DDL as a versioned migration on top of the storage bootstrap, tracked in `schema_migrations`, and SHALL be idempotent on re-apply.

#### Scenario: Migration version recorded
- **WHEN** the plugin starts and the schema migration has been applied
- **THEN** the `schema_migrations` table contains a row for the schema version and re-running migrations does not recreate tables

#### Scenario: Fresh database gets full schema
- **WHEN** the plugin starts with an empty database at version 1 (baseline)
- **THEN** the schema migration creates all domain tables in a single transaction

### Requirement: Indexes and constraints for graph traversal and filtering
The system SHALL create indexes and foreign keys supporting efficient graph traversal, layer/type filtering, and delta tracking.

#### Scenario: Graph traversal indexes exist
- **WHEN** the schema migration has been applied
- **THEN** indexes exist on `edges(source_id)`, `edges(target_id)`, and `edges(layer, type)` to support neighborhood expansion and view switching (structural/semantic/overlap)

#### Scenario: Foreign keys are enforced
- **WHEN** the database is opened
- **THEN** `PRAGMA foreign_keys = ON` is in effect so that invalid references are rejected and cascades apply

#### Scenario: Content hash index supports delta scan
- **WHEN** the schema migration has been applied
- **THEN** an index on `notes(content_hash)` and `index_state(updated_at)` exists to support delta scans
