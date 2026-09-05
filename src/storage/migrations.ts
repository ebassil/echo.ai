import { run, all } from './db';
import { errorMessage } from '../util/errors';

export interface Migration {
	version: number;
	apply(dbConnection: any): Promise<void>;
}

const migrations: Migration[] = [
	{
		version: 1,
		apply: async () => {
			// Baseline migration: establishes the migration mechanism only.
			// Real schema is introduced by later changes (echo-schema).
		},
	},
	{
		version: 2,
		apply: async (dbConnection: any) => {
			// Enable foreign keys for this connection
			await run(dbConnection, 'PRAGMA foreign_keys = ON');

			// Notes — snapshot of each Joplin note
			await run(
				dbConnection,
				`CREATE TABLE IF NOT EXISTS notes (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					notebook_id TEXT,
					notebook_name TEXT,
					content_hash TEXT NOT NULL,
					parent_id TEXT,
					created_at TEXT,
					updated_at TEXT,
					indexed_at TEXT,
					status TEXT NOT NULL DEFAULT 'pending'
				)`,
			);

			// Chunks — ordered chunked note text
			await run(
				dbConnection,
				`CREATE TABLE IF NOT EXISTS chunks (
					id TEXT PRIMARY KEY,
					note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
					chunk_index INTEGER NOT NULL,
					content TEXT NOT NULL,
					token_count INTEGER,
					created_at TEXT NOT NULL,
					UNIQUE(note_id, chunk_index)
				)`,
			);

			// Entities — canonicalized semantic entities (must exist before nodes)
			await run(
				dbConnection,
				`CREATE TABLE IF NOT EXISTS entities (
					id TEXT PRIMARY KEY,
					canonical_name TEXT NOT NULL UNIQUE,
					type TEXT,
					aliases TEXT,
					confidence REAL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)`,
			);

			// Embeddings — dense vectors per chunk
			await run(
				dbConnection,
				`CREATE TABLE IF NOT EXISTS embeddings (
					chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
					model TEXT NOT NULL,
					dims INTEGER NOT NULL,
					vector BLOB NOT NULL,
					created_at TEXT NOT NULL
				)`,
			);

			// Nodes — layered graph nodes
			await run(
				dbConnection,
				`CREATE TABLE IF NOT EXISTS nodes (
					id TEXT PRIMARY KEY,
					layer TEXT NOT NULL CHECK (layer IN ('structural','semantic')),
					kind TEXT NOT NULL CHECK (kind IN ('note','entity','chunk')),
					label TEXT NOT NULL,
					note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
					entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
					weight REAL DEFAULT 1.0,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)`,
			);

			// Edges — layered graph edges
			await run(
				dbConnection,
				`CREATE TABLE IF NOT EXISTS edges (
					id TEXT PRIMARY KEY,
					layer TEXT NOT NULL CHECK (layer IN ('structural','semantic')),
					source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
					target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
					type TEXT NOT NULL CHECK (type IN ('link','tag','backlink','relation','mention')),
					weight REAL NOT NULL DEFAULT 1.0,
					created_at TEXT NOT NULL
				)`,
			);

			// Relations — typed relations between entities
			await run(
				dbConnection,
				`CREATE TABLE IF NOT EXISTS relations (
					id TEXT PRIMARY KEY,
					source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
					target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
					relation_type TEXT NOT NULL,
					confidence REAL,
					evidence_chunk_id TEXT REFERENCES chunks(id) ON DELETE SET NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)`,
			);

			// Index state — per-note content hash and pipeline status for delta tracking
			await run(
				dbConnection,
				`CREATE TABLE IF NOT EXISTS index_state (
					note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
					content_hash TEXT NOT NULL,
					structural_status TEXT NOT NULL DEFAULT 'pending',
					semantic_status TEXT NOT NULL DEFAULT 'pending',
					last_indexed_at TEXT,
					error TEXT,
					updated_at TEXT NOT NULL
				)`,
			);

			// Pipeline runs — run log
			await run(
				dbConnection,
				`CREATE TABLE IF NOT EXISTS pipeline_runs (
					id TEXT PRIMARY KEY,
					pipeline TEXT NOT NULL CHECK (pipeline IN ('structural','semantic','embedding')),
					trigger TEXT NOT NULL,
					scope TEXT,
					status TEXT NOT NULL CHECK (status IN ('running','success','failed','cancelled')) DEFAULT 'running',
					started_at TEXT NOT NULL,
					finished_at TEXT,
					notes_processed INTEGER DEFAULT 0,
					chunks_created INTEGER DEFAULT 0,
					error TEXT
				)`,
			);

			// FTS5 virtual table for BM25 (external content mode)
			await run(
				dbConnection,
				`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
					content,
					content='chunks',
					content_rowid='rowid',
					tokenize='porter unicode61'
				)`,
			);

			// Triggers to keep FTS5 synchronized with chunks
			await run(
				dbConnection,
				`CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
					INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
				END`,
			);
			await run(
				dbConnection,
				`CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
					INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
				END`,
			);
			await run(
				dbConnection,
				`CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
					INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
					INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
				END`,
			);

			// Indexes for query patterns
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_notes_content_hash ON notes(content_hash)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_chunks_note_index ON chunks(note_id, chunk_index)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_nodes_layer ON nodes(layer)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_nodes_note_id ON nodes(note_id)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_nodes_entity_id ON nodes(entity_id)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_edges_layer_type ON edges(layer, type)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline_started ON pipeline_runs(pipeline, started_at)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_index_state_updated_at ON index_state(updated_at)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model)`);
		},
	},
	{
		version: 3,
		apply: async (dbConnection: any) => {
			await run(dbConnection, 'PRAGMA foreign_keys = ON');

			// Relation evidence join table for lazy evidence counting
			await run(
				dbConnection,
				`CREATE TABLE IF NOT EXISTS relation_evidence (
					relation_id TEXT NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
					chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
					note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
					created_at TEXT NOT NULL,
					PRIMARY KEY (relation_id, chunk_id)
				)`,
			);

			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_relation_evidence_relation ON relation_evidence(relation_id)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_relation_evidence_chunk ON relation_evidence(chunk_id)`);
			await run(dbConnection, `CREATE INDEX IF NOT EXISTS idx_relation_evidence_note ON relation_evidence(note_id)`);

			// Add source discriminator to nodes and edges for enrichment
			// Use helper to avoid duplicate column error on re-apply
			async function addSourceColumn(table: string): Promise<void> {
				const columns: { name: string }[] = await all(dbConnection, `SELECT name FROM pragma_table_info('${table}')`, []);
				const hasSource = columns.some((c) => c.name === 'source');
				if (hasSource) return;
				await run(
					dbConnection,
					`ALTER TABLE ${table} ADD COLUMN source TEXT CHECK (source IN ('joplin','enrichment')) DEFAULT 'joplin'`,
				);
			}

			await addSourceColumn('nodes');
			await addSourceColumn('edges');

			// Ensure existing rows default correctly (ALTER TABLE DEFAULT does not backfill NULLs if column existed with different default)
			await run(dbConnection, `UPDATE nodes SET source = 'joplin' WHERE source IS NULL`);
			await run(dbConnection, `UPDATE edges SET source = 'joplin' WHERE source IS NULL`);
		},
	},
];

export const LATEST_SCHEMA_VERSION: number = migrations[migrations.length - 1].version;

export async function applyMigrations(dbConnection: any): Promise<void> {
	await run(
		dbConnection,
		'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL)',
	);

	const rows = await all<{ version: number }>(dbConnection, 'SELECT version FROM schema_migrations');
	const appliedVersions = new Set(rows.map((row) => row.version));

	const pending = migrations
		.filter((migration) => !appliedVersions.has(migration.version))
		.sort((a, b) => a.version - b.version);

	for (const migration of pending) {
		await run(dbConnection, 'BEGIN');
		try {
			await migration.apply(dbConnection);
			await run(
				dbConnection,
				'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
				[migration.version, new Date().toISOString()],
			);
			await run(dbConnection, 'COMMIT');
		} catch (error) {
			await run(dbConnection, 'ROLLBACK');
			throw new Error(`Migration ${migration.version} failed: ${errorMessage(error)}`);
		}
	}
}