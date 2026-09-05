// Shared schema package — row types, constants, and DDL helpers imported by
// both the Joplin plugin (src/) and the standalone CLI (cli/).
// A build of either side fails if this module is missing, enforcing drift guard.

export const INDEX_DB_FILENAME = 'echo-index.db';
export const TOKEN_FILENAME = 'echo-token';
export const CLI_JSON_FILENAME = 'cli.json';

// Table names (shared constants)
export const TABLES = {
  notes: 'notes',
  chunks: 'chunks',
  chunksFts: 'chunks_fts',
  embeddings: 'embeddings',
  nodes: 'nodes',
  edges: 'edges',
  entities: 'entities',
  relations: 'relations',
  relationEvidence: 'relation_evidence',
  indexState: 'index_state',
  pipelineRuns: 'pipeline_runs',
  schemaMigrations: 'schema_migrations',
} as const;

// Row types

export interface NoteRow {
  id: string;
  title: string;
  notebook_id: string | null;
  notebook_name: string | null;
  content_hash: string;
  parent_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  indexed_at: string | null;
  status: string;
}

export interface ChunkRow {
  id: string;
  note_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  created_at: string;
}

export interface PipelineRunRow {
  id: string;
  pipeline: string;
  trigger: string;
  scope: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  notes_processed: number | null;
  chunks_created: number | null;
  error: string | null;
}

export interface IndexStateRow {
  note_id: string;
  content_hash: string;
  structural_status: string;
  semantic_status: string;
  last_indexed_at: string | null;
  error: string | null;
  updated_at: string;
}

// Search result shape (used by HTTP endpoint and CLI)
export interface SearchResult {
  chunkId: string;
  noteId: string;
  title: string | null;
  snippet: string;
  score: number;
  source: string;
}

// CLI discovery file shape
export interface CliJson {
  port: number;
  tokenFingerprint: string;
  // raw token is stored separately in echo-token, but cli.json may hold it for compat
  token?: string;
}

// Helper: fingerprint logic is also exported for reuse
export function tokenFingerprint(token: string): string {
  const { createHash } = require('crypto');
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 8);
}

export const VALID_PIPELINES = ['structural', 'semantic', 'embedding', 'both'] as const;
export type ValidPipeline = typeof VALID_PIPELINES[number];

export const VALID_STATUSES = ['running', 'success', 'failed', 'cancelled'] as const;
