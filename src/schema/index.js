"use strict";
// Shared schema package — row types, constants, and DDL helpers imported by
// both the Joplin plugin (src/) and the standalone CLI (cli/).
// A build of either side fails if this module is missing, enforcing drift guard.
Object.defineProperty(exports, "__esModule", { value: true });
exports.VALID_STATUSES = exports.VALID_PIPELINES = exports.tokenFingerprint = exports.TABLES = exports.CLI_JSON_FILENAME = exports.TOKEN_FILENAME = exports.INDEX_DB_FILENAME = void 0;
exports.INDEX_DB_FILENAME = 'echo-index.db';
exports.TOKEN_FILENAME = 'echo-token';
exports.CLI_JSON_FILENAME = 'cli.json';
// Table names (shared constants)
exports.TABLES = {
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
};
// Helper: fingerprint logic is also exported for reuse
function tokenFingerprint(token) {
    const { createHash } = require('crypto');
    return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 8);
}
exports.tokenFingerprint = tokenFingerprint;
exports.VALID_PIPELINES = ['structural', 'semantic', 'embedding', 'both'];
exports.VALID_STATUSES = ['running', 'success', 'failed', 'cancelled'];
//# sourceMappingURL=index.js.map