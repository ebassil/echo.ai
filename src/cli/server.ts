import * as http from 'http';
import { all } from '../storage/db';
import { getCurrentStatus, getRunHistory, getRunById } from '../orchestration/status';
import { enqueueRun } from '../orchestration/runner';
import { resolveScope } from '../orchestration/scope';
import { isVaultLocked } from '../indexing/vault';
import {
	CliServerHandle,
	CliCoreDeps,
	createRequestHandler,
	ensureToken,
	writeCliJson,
	readPersistedPort,
	rotateTokenFiles,
	resetRateLimits,
	tokenFingerprint,
} from './core';

export {
	CliServerHandle,
	ensureToken,
	writeCliJson,
	readPersistedPort,
	getTokenPath,
	getCliJsonPath,
	tokenFingerprint,
	resetRateLimits,
	createRequestHandler,
} from './core';

let server: http.Server | null = null;
let handle: CliServerHandle | null = null;

/**
 * Default search: FTS5/BM25 over the index only — no `joplin.data.get` of note
 * bodies. When `echo-retrieval` lands, inject the full RRF pipeline via deps.
 */
async function defaultSearch(query: string, limit: number): Promise<{ results: any[]; total: number }> {
	const { getDatabase } = await import('../storage/db');
	const db = getDatabase();
	const rows = await all<any>(
		db,
		`SELECT c.id AS chunkId, c.note_id AS noteId, n.title AS title,
		        snippet(chunks_fts, -1, '[', ']', ' … ', 20) AS snippet, rank
		 FROM chunks_fts
		 JOIN chunks c ON c.rowid = chunks_fts.rowid
		 LEFT JOIN notes n ON n.id = c.note_id
		 WHERE chunks_fts MATCH ?
		 ORDER BY rank
		 LIMIT ?`,
		[query, limit],
	);
	const results = rows.map((r: any, idx: number) => ({
		chunkId: r.chunkId,
		noteId: r.noteId,
		title: r.title ?? null,
		snippet: r.snippet ?? '',
		score: typeof r.rank === 'number' ? r.rank : idx,
		source: 'fts5',
	}));
	return { results, total: results.length };
}

export interface CliServerDeps extends Partial<CliCoreDeps> {
	// Fixed port override (tests / echo.cliPort setting); undefined = persisted/ephemeral
	port?: number;
}

function listen(srv: http.Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (err: any) => reject(err);
		srv.once('error', onError);
		srv.listen(port, '127.0.0.1', () => {
			srv.removeListener('error', onError);
			const addr = srv.address();
			resolve(typeof addr === 'object' && addr ? addr.port : port);
		});
	});
}

/**
 * Start the loopback CLI server. Binds 127.0.0.1 only. Persists
 * `<dataDir>/echo-token` (per-install token) and `<dataDir>/cli.json`
 * ({ port, tokenFingerprint, token }) for CLI discovery. On EADDRINUSE for a
 * persisted/configured port, falls back to an ephemeral port and rewrites
 * cli.json.
 */
export async function startCliServer(dataDir: string, deps: CliServerDeps = {}): Promise<CliServerHandle> {
	if (server && handle) return handle;

	const token = await ensureToken(dataDir);
	// Port precedence: explicit dep override > persisted port > ephemeral (0)
	const desiredPort = deps.port ?? (await readPersistedPort(dataDir)) ?? 0;

	const coreDeps: CliCoreDeps = {
		isVaultLocked: deps.isVaultLocked ?? isVaultLocked,
		resolveScope: deps.resolveScope ?? ((scope: any) => resolveScope(scope)),
		enqueueRun: deps.enqueueRun ?? ((options: any) => enqueueRun(options)),
		getCurrentStatus: deps.getCurrentStatus ?? getCurrentStatus,
		getRunHistory: deps.getRunHistory ?? getRunHistory,
		getRunById: deps.getRunById ?? getRunById,
		search: deps.search ?? defaultSearch,
	};

	const state = { token };
	const handler = createRequestHandler(() => state, coreDeps);
	const srv = http.createServer((req, res) => {
		void handler(req, res);
	});

	let actualPort: number;
	try {
		actualPort = await listen(srv, desiredPort);
	} catch (e: any) {
		if (e?.code === 'EADDRINUSE' && desiredPort !== 0) {
			// Configured/persisted port taken: fall back to ephemeral and rewrite discovery file
			actualPort = await listen(srv, 0);
		} else {
			throw e;
		}
	}

	server = srv;
	handle = { port: actualPort, token, tokenFingerprint: tokenFingerprint(token) };
	await writeCliJson(dataDir, actualPort, token);
	// Log only host:port and fingerprint — never the raw token
	console.info(`[echo] cli endpoint listening on 127.0.0.1:${actualPort} (token fp=${handle.tokenFingerprint})`);
	return handle;
}

export async function stopCliServer(): Promise<void> {
	if (!server) {
		handle = null;
		return;
	}
	const srv = server;
	server = null;
	handle = null;
	await new Promise<void>((resolve) => {
		srv.close(() => resolve());
		// Force-close idle keep-alive sockets so shutdown does not hang
		if (typeof (srv as any).closeAllConnections === 'function') (srv as any).closeAllConnections();
	});
	resetRateLimits();
}

export function getCliServerHandle(): CliServerHandle | null {
	return handle ? { ...handle } : null;
}

/** Rotate the per-install token and rewrite the discovery file. */
export async function rotateCliToken(dataDir: string): Promise<CliServerHandle | null> {
	const token = await rotateTokenFiles(dataDir);
	if (handle) {
		handle = { ...handle, token, tokenFingerprint: tokenFingerprint(token) };
	}
	const port = handle?.port ?? (await readPersistedPort(dataDir)) ?? 0;
	await writeCliJson(dataDir, port, token);
	return handle ? { ...handle } : null;
}
