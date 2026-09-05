import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes, createHash } from 'crypto';
import { TOKEN_FILENAME, CLI_JSON_FILENAME } from '../schema/index';

// Pure HTTP core for the loopback CLI endpoint: no Joplin `api` imports so it
// is testable in plain Node. Orchestration/storage wiring lives in server.ts.

export const BODY_LIMIT = 64 * 1024;
export const MAX_QUERY_LENGTH = 500;

// Rate limiting: 5 auth failures per minute per client socket address
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const RATE_LIMIT_MAX = 5;

export const VALID_PIPELINES = new Set(['structural', 'semantic', 'embedding', 'both']);
export const VALID_RUN_STATUSES = new Set(['running', 'success', 'failed', 'cancelled']);

export interface CliCoreDeps {
	isVaultLocked: () => Promise<boolean>;
	resolveScope: (scope: any) => Promise<string[]>;
	enqueueRun: (options: any) => Promise<{ runId: string }>;
	getCurrentStatus: () => Promise<any>;
	getRunHistory: (query: any) => Promise<any[]>;
	getRunById: (id: string) => Promise<any>;
	search: (query: string, limit: number) => Promise<{ results: any[]; total: number }>;
}

export interface CliServerHandle {
	port: number;
	token: string;
	tokenFingerprint: string;
}

const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

export function tokenFingerprint(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 8);
}

export function getTokenPath(dataDir: string): string {
	return path.join(dataDir, TOKEN_FILENAME);
}

export function getCliJsonPath(dataDir: string): string {
	return path.join(dataDir, CLI_JSON_FILENAME);
}

async function chmodQuiet(filePath: string): Promise<void> {
	try {
		await fs.chmod(filePath, 0o600);
	} catch {
		// Windows / unsupported filesystems: best-effort per design
	}
}

/**
 * Generate or load the per-install token. 32 random bytes → 64 hex chars
 * (>128 bits), persisted with restrictive permissions where supported.
 */
export async function ensureToken(dataDir: string, rotate = false): Promise<string> {
	const tokenPath = getTokenPath(dataDir);
	if (!rotate) {
		try {
			const raw = await fs.readFile(tokenPath, 'utf8');
			const trimmed = raw.trim();
			if (trimmed) {
				await chmodQuiet(tokenPath);
				return trimmed;
			}
		} catch {}
	}
	const token = randomBytes(32).toString('hex');
	await fs.writeFile(tokenPath, token, { mode: 0o600 });
	await chmodQuiet(tokenPath);
	return token;
}

export async function readPersistedPort(dataDir: string): Promise<number | null> {
	try {
		const raw = await fs.readFile(getCliJsonPath(dataDir), 'utf8');
		const parsed = JSON.parse(raw);
		if (typeof parsed.port === 'number') return parsed.port;
	} catch {}
	return null;
}

export async function writeCliJson(dataDir: string, port: number, token: string): Promise<void> {
	const cliJsonPath = getCliJsonPath(dataDir);
	const payload = { port, tokenFingerprint: tokenFingerprint(token), token };
	const tmp = cliJsonPath + '.tmp';
	await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
	await chmodQuiet(tmp);
	await fs.rename(tmp, cliJsonPath);
	await chmodQuiet(cliJsonPath);
}

/** Generate a fresh token and persist it to the token file. */
export async function rotateTokenFiles(dataDir: string): Promise<string> {
	return ensureToken(dataDir, true);
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
	if (!remoteAddress) return false;
	if (remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1') return true;
	if (remoteAddress.startsWith('127.')) return true;
	// ::ffff:127.x.y mapped form
	if (/^::ffff:127\.\d+\.\d+\.\d+$/.test(remoteAddress)) return true;
	return false;
}

export function isRateLimited(ip: string, now = Date.now()): boolean {
	const entry = rateLimitMap.get(ip);
	if (!entry) return false;
	if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
		rateLimitMap.delete(ip);
		return false;
	}
	return entry.count >= RATE_LIMIT_MAX;
}

export function recordFailedAuth(ip: string, now = Date.now()): void {
	const entry = rateLimitMap.get(ip);
	if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
		rateLimitMap.set(ip, { count: 1, windowStart: now });
	} else {
		entry.count++;
	}
}

export function resetRateLimits(): void {
	rateLimitMap.clear();
}

export function sendJson(res: http.ServerResponse, status: number, body: any): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
	res.end(payload);
}

export function sendError(res: http.ServerResponse, status: number, error: string): void {
	sendJson(res, status, { error });
}

export function readBody(req: http.IncomingMessage, limit = BODY_LIMIT): Promise<string> {
	return new Promise((resolve, reject) => {
		let total = 0;
		const chunks: Buffer[] = [];
		let rejected = false;
		req.on('data', (chunk: Buffer) => {
			if (rejected) return;
			total += chunk.length;
			if (total > limit) {
				rejected = true;
				reject(new Error('BODY_TOO_LARGE'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
		});
		req.on('error', (e) => {
			if (!rejected) reject(e);
		});
	});
}

export function validatePipelineRunBody(body: any): string | null {
	if (!body || typeof body !== 'object') return 'Body must be a JSON object';
	if (typeof body.pipeline !== 'string' || !VALID_PIPELINES.has(body.pipeline)) {
		return `Invalid pipeline: must be one of ${Array.from(VALID_PIPELINES).join(', ')}`;
	}
	if (body.scope === 'all') return null;
	if (body.scope && typeof body.scope === 'object') {
		if (typeof body.scope.noteId === 'string' && body.scope.noteId.trim() !== '') return null;
		if (typeof body.scope.folderId === 'string' && body.scope.folderId.trim() !== '') return null;
	}
	return 'Invalid scope: must be "all" or { noteId } or { folderId }';
}

export interface RequestHandler {
	(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
}

interface DeferredTrigger {
	runId: string;
	pipeline: string;
	scope: any;
	force: boolean;
}

/**
 * Request handler with all side-effecting behavior injected via `deps`,
 * exported so tests can run it without the Joplin runtime.
 * Loopback guard runs BEFORE auth; 401 responses never distinguish missing
 * from wrong token (no token-existence oracle).
 */
export function createRequestHandler(
	getState: () => { token: string | null },
	deps: CliCoreDeps,
): RequestHandler & { drainDeferred(): Promise<number>; deferredCount(): number } {
	// Deferred pipeline triggers awaiting vault unlock
	const deferred: DeferredTrigger[] = [];
	let drainTimer: ReturnType<typeof setInterval> | null = null;

	async function drainDeferred(): Promise<number> {
		if (deferred.length === 0) return 0;
		if (await deps.isVaultLocked()) return 0;
		let drained = 0;
		const batch = [...deferred];
		deferred.length = 0;
		for (const item of batch) {
			try {
				await deps.resolveScope(item.scope);
				await deps.enqueueRun({
					pipeline: item.pipeline,
					scope: item.scope,
					trigger: 'manual',
					force: item.force,
				});
				drained++;
			} catch (e) {
				console.warn(`[echo cli] deferred trigger ${item.runId} failed`, e);
			}
		}
		if (drainTimer) {
			clearInterval(drainTimer);
			drainTimer = null;
		}
		return drained;
	}

	function scheduleDrain(): void {
		if (drainTimer) return;
		drainTimer = setInterval(() => {
			void drainDeferred();
		}, 2000);
		// Don't keep the event loop alive for the drain timer alone (Joplin/electron main loop keeps process)
		if (typeof (drainTimer as any).unref === 'function') (drainTimer as any).unref();
	}

	const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
		// Loopback source guard (kernel-reported socket address only)
		if (!isLoopbackAddress(req.socket.remoteAddress)) {
			sendError(res, 403, 'Forbidden: loopback only');
			return;
		}

		const ip = req.socket.remoteAddress ?? 'unknown';
		if (isRateLimited(ip)) {
			sendError(res, 429, 'Too many failed auth attempts; try again later');
			return;
		}

		let url: URL;
		try {
			url = new URL(req.url ?? '/', 'http://127.0.0.1');
		} catch {
			sendError(res, 400, 'Bad request');
			return;
		}
		const pathname = url.pathname;
		const method = req.method ?? 'GET';

		// Health probe: loopback-only, no token required, exposes only a fingerprint
		if (method === 'GET' && pathname === '/v1/health') {
			const state = getState();
			sendJson(res, 200, {
				ok: true,
				fingerprint: state.token ? tokenFingerprint(state.token) : null,
			});
			return;
		}

		// Bearer auth on every other route
		const state = getState();
		const auth = req.headers.authorization;
		if (!state.token || !auth || !auth.startsWith('Bearer ')) {
			recordFailedAuth(ip);
			sendError(res, 401, 'Unauthorized');
			return;
		}
		const presented = auth.slice('Bearer '.length).trim();
		if (presented !== state.token) {
			recordFailedAuth(ip);
			sendError(res, 401, 'Unauthorized');
			return;
		}

		try {
			if (method === 'POST' && pathname === '/v1/pipeline/run') {
				let bodyStr: string;
				try {
					bodyStr = await readBody(req);
				} catch (e: any) {
					if (String(e?.message) === 'BODY_TOO_LARGE') sendError(res, 413, 'Payload too large');
					else sendError(res, 400, 'Bad request');
					return;
				}
				let body: any;
				try {
					body = bodyStr ? JSON.parse(bodyStr) : null;
				} catch {
					sendError(res, 400, 'Invalid JSON');
					return;
				}
				const validationError = validatePipelineRunBody(body);
				if (validationError) {
					sendError(res, 400, validationError);
					return;
				}

				// Vault gate: while locked, do not resolve scope (which may read
				// decrypted content); defer the trigger and flush on unlock.
				if (await deps.isVaultLocked()) {
					const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
					deferred.push({ runId, pipeline: body.pipeline, scope: body.scope, force: !!body.force });
					scheduleDrain();
					sendJson(res, 202, {
						runId,
						pipeline: body.pipeline,
						scope: body.scope,
						trigger: 'manual',
						status: 'deferred',
					});
					return;
				}

				// Validate scope via the single-source-of-truth resolver before
				// enqueuing, so unknown note ids yield 404 rather than a failed run.
				try {
					await deps.resolveScope(body.scope);
				} catch (e: any) {
					const msg = String(e?.message ?? e);
					if (msg.toLowerCase().includes('not found')) sendError(res, 404, msg);
					else sendError(res, 400, msg);
					return;
				}

				try {
					const result = await deps.enqueueRun({
						pipeline: body.pipeline,
						scope: body.scope,
						trigger: 'manual',
						force: !!body.force,
					});
					sendJson(res, 202, {
						runId: result.runId,
						pipeline: body.pipeline,
						scope: body.scope,
						trigger: 'manual',
					});
				} catch (e: any) {
					const msg = String(e?.message ?? e);
					if (msg.toLowerCase().includes('not found')) sendError(res, 404, msg);
					else sendError(res, 500, msg);
				}
				return;
			}

			if (method === 'POST' && pathname === '/v1/search') {
				let bodyStr: string;
				try {
					bodyStr = await readBody(req);
				} catch (e: any) {
					if (String(e?.message) === 'BODY_TOO_LARGE') sendError(res, 413, 'Payload too large');
					else sendError(res, 400, 'Bad request');
					return;
				}
				let body: any;
				try {
					body = bodyStr ? JSON.parse(bodyStr) : null;
				} catch {
					sendError(res, 400, 'Invalid JSON');
					return;
				}
				const query = body?.query;
				if (typeof query !== 'string' || !query.trim()) {
					sendError(res, 400, 'Query must be a non-empty string');
					return;
				}
				if (query.length > MAX_QUERY_LENGTH) {
					sendError(res, 400, `Query exceeds max length ${MAX_QUERY_LENGTH}`);
					return;
				}
				const limitRaw = body?.limit ?? 10;
				const limit = Math.min(Math.max(parseInt(String(limitRaw), 10) || 10, 1), 100);
				try {
					const result = await deps.search(query, limit);
					sendJson(res, 200, { results: result.results, total: result.total, query });
				} catch (e: any) {
					sendError(res, 500, String(e?.message ?? e));
				}
				return;
			}

			if (method === 'GET' && pathname === '/v1/status') {
				try {
					const status = await deps.getCurrentStatus();
					sendJson(res, 200, status);
				} catch (e: any) {
					sendError(res, 500, String(e?.message ?? e));
				}
				return;
			}

			if (method === 'GET' && pathname === '/v1/runs') {
				const pipeline = url.searchParams.get('pipeline');
				const status = url.searchParams.get('status');
				const limitStr = url.searchParams.get('limit');
				const offsetStr = url.searchParams.get('offset');
				if (pipeline && !VALID_PIPELINES.has(pipeline)) {
					sendError(res, 400, `Invalid pipeline filter: ${pipeline}`);
					return;
				}
				if (status && !VALID_RUN_STATUSES.has(status)) {
					sendError(res, 400, `Invalid status filter: ${status}`);
					return;
				}
				const limit = limitStr !== null ? parseInt(limitStr, 10) : 50;
				const offset = offsetStr !== null ? parseInt(offsetStr, 10) : 0;
				if (!Number.isFinite(limit) || !Number.isFinite(offset) || limit < 0 || offset < 0 || limit > 200) {
					sendError(res, 400, 'Invalid limit/offset');
					return;
				}
				try {
					const rows = await deps.getRunHistory({
						pipeline: pipeline ?? undefined,
						status: status ?? undefined,
						limit,
						offset,
					});
					sendJson(res, 200, rows);
				} catch (e: any) {
					sendError(res, 500, String(e?.message ?? e));
				}
				return;
			}

			if (method === 'GET' && pathname.startsWith('/v1/runs/')) {
				const id = decodeURIComponent(pathname.slice('/v1/runs/'.length));
				if (!id) {
					sendError(res, 400, 'Missing run id');
					return;
				}
				try {
					const row = await deps.getRunById(id);
					sendJson(res, 200, row);
				} catch (e: any) {
					const msg = String(e?.message ?? e);
					if (msg.toLowerCase().includes('not found')) sendError(res, 404, msg);
					else sendError(res, 500, msg);
				}
				return;
			}

			sendError(res, 404, 'Not found');
		} catch (e: any) {
			console.error('[echo cli] handler error', e);
			sendError(res, 500, String(e?.message ?? e));
		}
	};

	return Object.assign(handler, {
		drainDeferred,
		deferredCount: () => deferred.length,
	});
}
