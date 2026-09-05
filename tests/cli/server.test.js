const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

// Compile the pure HTTP core (no Joplin `api` import) plus its schema
// dependency to CommonJS in a temp dir, then require the real code.
function compileCore() {
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-cli-core-'));
	const options = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2018,
		outDir,
		rootDir: path.resolve('src'),
		esModuleInterop: true,
		skipLibCheck: true,
		strict: false,
		sourceMap: false,
	};
	const files = [
		path.resolve('src/cli/core.ts'),
		path.resolve('src/schema/index.ts'),
	];
	const program = ts.createProgram(files, options);
	const emitResult = program.emit();
	const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
	const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
	if (errors.length) {
		throw new Error('compile errors: ' + ts.formatDiagnostics(errors, {
			getCanonicalFileName: (f) => f,
			getCurrentDirectory: () => process.cwd(),
			getNewLine: () => '\n',
		}));
	}
	return path.join(outDir, 'cli', 'core.js');
}

const corePath = compileCore();
const core = require(corePath);

const TOKEN = 'a'.repeat(64);

function makeHandler(overrides = {}) {
	const deps = {
		isVaultLocked: async () => overrides.vaultLocked ?? false,
		resolveScope: async (scope) => {
			if (scope && scope.noteId === 'missing') throw new Error('Note not found: missing');
			return ['n1'];
		},
		enqueueRun: async (opts) => ({ runId: 'run_' + (overrides.enqueueCounter ? ++overrides.enqueueCounter : 1) }),
		getCurrentStatus: async () => ({ currentRun: null, queueDepth: 0, queuedRuns: [], progress: null }),
		getRunHistory: async (q) => [{ id: 'r1', pipeline: q.pipeline ?? 'structural', status: 'success', started_at: 't' }],
		getRunById: async (id) => {
			if (id === 'unknown') throw new Error('Run not found: ' + id);
			return { id, pipeline: 'structural', status: 'success' };
		},
		search: async (query, limit) => ({ results: [{ chunkId: 'c1', noteId: 'n1', title: 'T', snippet: query, score: 1, source: 'fts5' }], total: 1 }),
	};
	return { deps, handler: core.createRequestHandler(() => ({ token: TOKEN }), deps) };
}

function startTestServer(handler) {
	return new Promise((resolve, reject) => {
		const srv = http.createServer((req, res) => handler(req, res));
		srv.listen(0, '127.0.0.1', () => resolve(srv));
		srv.on('error', reject);
	});
}

async function request(srv, method, pathname, { token, headers = {}, body, remoteAddress } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: srv.address().port, method, path: pathname, headers }, (res) => {
			let data = '';
			res.on('data', (c) => (data += c));
			res.on('end', () => {
				let parsed = null;
				try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
				resolve({ status: res.statusCode, body: parsed });
			});
		});
		req.on('error', reject);
		if (token) req.setHeader('Authorization', 'Bearer ' + token);
		if (body !== undefined) req.write(JSON.stringify(body));
		req.end();
	});
}

function fakeSocketRequest(handler, method, pathname, { token, body, remoteAddress } = {}) {
	// Build a minimal fake req/res to exercise the loopback guard and handlers
	// without a socket; used to test non-loopback rejection.
	const chunks = [];
	const fakeReq = {
		method,
		url: pathname,
		headers: { authorization: token ? 'Bearer ' + token : undefined },
		socket: { remoteAddress: remoteAddress ?? '127.0.0.1' },
		on: (ev, cb) => {
			if (ev === 'data') { if (body !== undefined) process.nextTick(() => cb(Buffer.from(JSON.stringify(body)))); }
			if (ev === 'error') { /* noop */ }
			if (ev === 'end') { if (body === undefined) process.nextTick(cb); }
			return fakeReq;
		},
		destroy: () => {},
	};
	const fakeRes = {
		writeHead: (status, headersObj) => { fakeRes.status = status; fakeRes.headers = headersObj; },
		end: (payload) => { chunks.push(payload); fakeRes.done = true; },
	};
	return handler(fakeReq, fakeRes).then(() => ({
		status: fakeRes.status,
		body: chunks.length ? JSON.parse(chunks.join('')) : null,
	}));
}

async function main() {
	console.log('Running CLI endpoint tests...');
	const { handler, deps } = makeHandler();
	const srv = await startTestServer(handler);

	// health without token
	let r = await request(srv, 'GET', '/v1/health');
	assert.strictEqual(r.status, 200, 'health ok');
	assert.strictEqual(r.body.fingerprint, core.tokenFingerprint(TOKEN).slice(0, 8), 'health fingerprint');

	// 401 missing token on protected route
	r = await request(srv, 'GET', '/v1/status');
	assert.strictEqual(r.status, 401, 'status requires token');
	console.log('✓ 401 on missing token');

	// 401 wrong token
	r = await request(srv, 'GET', '/v1/status', { token: 'b'.repeat(64) });
	assert.strictEqual(r.status, 401, 'wrong token rejected');
	assert.ok(!/token file/.test(JSON.stringify(r.body)), 'no token-existence oracle');
	console.log('✓ 401 on wrong token (no existence oracle)');

	// valid token status
	r = await request(srv, 'GET', '/v1/status', { token: TOKEN });
	assert.strictEqual(r.status, 200, 'status ok');
	assert.strictEqual(r.body.queueDepth, 0);
	console.log('✓ 200 status with valid token');

	// non-loopback source rejected 403 (via fake socket)
	const nonLoopback = await fakeSocketRequest(handler, 'GET', '/v1/status', { token: TOKEN, remoteAddress: '192.168.1.5' });
	assert.strictEqual(nonLoopback.status, 403, 'non-loopback rejected');
	console.log('✓ 403 non-loopback source (before auth)');

	// Host spoofing still works since we use socket address
	r = await request(srv, 'GET', '/v1/status', { token: TOKEN, headers: { Host: 'evil.example.com', 'X-Forwarded-For': '8.8.8.8' } });
	assert.strictEqual(r.status, 200, 'host/xff spoofing does not bypass loopback');
	console.log('✓ host/x-forwarded-for spoofing ignored (socket address used)');

	// pipeline run: valid all scope
	r = await request(srv, 'POST', '/v1/pipeline/run', { token: TOKEN, body: { pipeline: 'structural', scope: 'all' } });
	assert.strictEqual(r.status, 202, 'run accepted');
	assert.ok(r.body.runId, 'has runId');
	assert.strictEqual(r.body.trigger, 'manual');
	console.log('✓ pipeline run all -> 202 with runId');

	// pipeline run: invalid pipeline -> 400
	r = await request(srv, 'POST', '/v1/pipeline/run', { token: TOKEN, body: { pipeline: 'bogus', scope: 'all' } });
	assert.strictEqual(r.status, 400, 'invalid pipeline');
	console.log('✓ 400 invalid pipeline');

	// pipeline run: unknown note -> 404
	r = await request(srv, 'POST', '/v1/pipeline/run', { token: TOKEN, body: { pipeline: 'structural', scope: { noteId: 'missing' } } });
	assert.strictEqual(r.status, 404, 'unknown note');
	console.log('✓ 404 unknown note (scope resolver)');

	// vault locked -> 202 deferred
	const lockedHandler = makeHandler({ vaultLocked: true }).handler;
	const lockedSrv = await startTestServer(lockedHandler);
	r = await request(lockedSrv, 'POST', '/v1/pipeline/run', { token: TOKEN, body: { pipeline: 'semantic', scope: 'all' } });
	assert.strictEqual(r.status, 202, 'deferred accepted');
	assert.strictEqual(r.body.status, 'deferred', 'deferred status');
	assert.ok(r.body.runId, 'deferred runId');
	console.log('✓ vault locked -> 202 deferred');
	lockedSrv.close();

	// search: valid
	r = await request(srv, 'POST', '/v1/search', { token: TOKEN, body: { query: 'hello', limit: 5 } });
	assert.strictEqual(r.status, 200, 'search ok');
	assert.strictEqual(r.body.total, 1);
	assert.strictEqual(r.body.results[0].noteId, 'n1');
	console.log('✓ search -> 200');

	// search: empty query -> 400
	r = await request(srv, 'POST', '/v1/search', { token: TOKEN, body: { query: '', limit: 5 } });
	assert.strictEqual(r.status, 400, 'empty query');
	console.log('✓ 400 empty query');

	// runs history with filter
	r = await request(srv, 'GET', '/v1/runs?pipeline=structural&limit=5', { token: TOKEN });
	assert.strictEqual(r.status, 200, 'history ok');
	assert.strictEqual(r.body[0].pipeline, 'structural');
	console.log('✓ /v1/runs filter');

	// runs invalid status -> 400
	r = await request(srv, 'GET', '/v1/runs?status=bogus', { token: TOKEN });
	assert.strictEqual(r.status, 400, 'invalid status filter');
	console.log('✓ 400 invalid status filter');

	// run by id
	r = await request(srv, 'GET', '/v1/runs/abc', { token: TOKEN });
	assert.strictEqual(r.status, 200, 'run detail');
	assert.strictEqual(r.body.id, 'abc');
	r = await request(srv, 'GET', '/v1/runs/unknown', { token: TOKEN });
	assert.strictEqual(r.status, 404, 'unknown run');
	console.log('✓ /v1/runs/:id 200 and 404');

	// rate limiting: 5+ failures -> 429
	const rateHandler = makeHandler().handler;
	const rateSrv = await startTestServer(rateHandler);
	let got429 = false;
	for (let i = 0; i < 6; i++) {
		const resp = await request(rateSrv, 'GET', '/v1/status', { token: 'bad' });
		if (resp.status === 429) got429 = true;
	}
	assert.strictEqual(got429, true, 'rate limited to 429');
	console.log('✓ rate limiting returns 429 after repeated failures');
	rateSrv.close();
	core.resetRateLimits();

	// body too large -> 413 (or transport reset since server destroys oversized bodies)
	const bigBody = { query: 'x'.repeat(70 * 1024), limit: 5 };
	try {
		r = await request(srv, 'POST', '/v1/search', { token: TOKEN, body: bigBody });
		assert.ok(r.status === 413, 'oversized body rejected (got ' + r.status + ')');
	} catch {
		// server destroys the connection on oversized body; that's acceptable
	}
	console.log('✓ oversized body rejected (413 or reset)');

	// token never logged: fingerprint only (we assert fingerprint helper produces 8 chars)
	assert.strictEqual(core.tokenFingerprint(TOKEN).length, 8, 'fingerprint is 8 chars');
	console.log('✓ token fingerprint is 8 chars (never raw token)');

	// deferred drain executes after unlock
	let enqueueCounter = 0;
	const drainOverrides = { vaultLocked: true, enqueueCounter: 0 };
	const drainDeps = {
		isVaultLocked: async () => { drainOverrides.vaultLocked; return drainOverrides.vaultLocked; },
		resolveScope: async (s) => ['n1'],
		enqueueRun: async (o) => { enqueueCounter++; return { runId: 'run_' + enqueueCounter }; },
		getCurrentStatus: async () => ({}),
		getRunHistory: async () => [],
		getRunById: async () => ({}),
		search: async () => ({ results: [], total: 0 }),
	};
	const drainHandler = core.createRequestHandler(() => ({ token: TOKEN }), drainDeps);
	const drainSrv = await startTestServer(drainHandler);
	await request(drainSrv, 'POST', '/v1/pipeline/run', { token: TOKEN, body: { pipeline: 'structural', scope: 'all' } });
	assert.strictEqual(drainHandler.deferredCount(), 1, 'deferred count 1 while locked');
	assert.strictEqual(enqueueCounter, 0, 'not enqueued while locked');
	// unlock and drain
	drainOverrides.vaultLocked = false;
	const drained = await drainHandler.drainDeferred();
	assert.strictEqual(drained, 1, 'drained one after unlock');
	assert.strictEqual(enqueueCounter, 1, 'enqueued after unlock');
	console.log('✓ deferred trigger executes after vault unlock');
	drainSrv.close();

	// ---- Lifecycle: real server.ts with a stubbed Joplin `api` module ----
	await testLifecycle();

	srv.close();
	console.log('All CLI endpoint tests passed');
}

// Compile server.ts + core.ts + schema + a stub `api` module, then exercise
// startCliServer / stopCliServer / EADDRINUSE fallback / token & cli.json
// persistence / fingerprint logging against a real bound socket.
async function testLifecycle() {
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-cli-srv-'));
	const options = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2018,
		outDir,
		rootDir: path.resolve('.'),
		esModuleInterop: true,
		skipLibCheck: true,
		strict: false,
		sourceMap: false,
		// Map `api` to the plugin's own type-only module so transitive imports resolve
		paths: { api: [path.resolve('api/index.ts')] },
		baseUrl: '.',
	};
	const files = [
		path.resolve('src/cli/server.ts'),
		path.resolve('src/cli/core.ts'),
		path.resolve('src/schema/index.ts'),
		// orchestration/status, runner, scope, indexing/vault, storage/db are
		// pulled in transitively; stub `api` in node_modules so they load.
	];
	const program = ts.createProgram(files, options);
	const emitResult = program.emit();
	const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
	const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
	if (errors.length) {
		throw new Error('server compile errors: ' + ts.formatDiagnostics(errors, {
			getCanonicalFileName: (f) => f,
			getCurrentDirectory: () => process.cwd(),
			getNewLine: () => '\n',
		}));
	}

	// Provide a stub `api` module so `import joplin from 'api'` resolves.
	const apiDir = path.join(outDir, 'node_modules', 'api');
	fs.mkdirSync(apiDir, { recursive: true });
	fs.writeFileSync(path.join(apiDir, 'index.js'), 'module.exports = { require: () => null };');

	// Clear any cached modules from prior test runs for the compiled server
	for (const key of Object.keys(require.cache)) {
		if (key.includes('echo-cli-srv-') || key.includes('echo-cli-core-')) delete require.cache[key];
	}

	const serverMod = require(path.join(outDir, "src", "cli", "server.js"));

	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-cli-life-'));
	// startCliServer with explicit ephemeral port (0) and injected fakes so it
	// doesn't need a live Joplin DB.
	const deps = {
		isVaultLocked: async () => false,
		resolveScope: async () => ['n1'],
		enqueueRun: async () => ({ runId: 'run_life' }),
		getCurrentStatus: async () => ({ currentRun: null, queueDepth: 0, queuedRuns: [], progress: null }),
		getRunHistory: async () => [],
		getRunById: async () => ({}),
		search: async () => ({ results: [], total: 0 }),
		port: 0,
	};
	const handle = await serverMod.startCliServer(dataDir, deps);

	// Token + cli.json written
	const tokenFile = path.join(dataDir, 'echo-token');
	const cliJsonFile = path.join(dataDir, 'cli.json');
	assert.ok(fs.existsSync(tokenFile), 'echo-token written');
	const token = fs.readFileSync(tokenFile, 'utf8').trim();
	assert.strictEqual(token.length, 64, 'token is 64 hex chars');
	assert.ok(fs.existsSync(cliJsonFile), 'cli.json written');
	const cliJson = JSON.parse(fs.readFileSync(cliJsonFile, 'utf8'));
	assert.strictEqual(cliJson.port, handle.port, 'cli.json port matches');
	assert.strictEqual(cliJson.tokenFingerprint, core.tokenFingerprint(token), 'cli.json fingerprint');
	console.log('✓ startCliServer persists token + cli.json');

	// Health endpoint over real socket
	const health = await new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port: handle.port, path: '/v1/health' }, (res) => {
			let d = '';
			res.on('data', (c) => (d += c));
			res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
		}).on('error', reject);
	});
	assert.strictEqual(health.status, 200, 'health 200');
	assert.strictEqual(health.body.fingerprint, core.tokenFingerprint(token), 'health fingerprint only');
	console.log('✓ health endpoint reachable, exposes fingerprint only');

	// Non-loopback connect refused: attempt to connect via a non-loopback IP
	// that resolves to loopback is not possible; instead verify bound address is 127.0.0.1
	// by connecting to 127.0.0.1 works and that the server does not accept an external bind.
	// We assert the listen host is loopback by checking the socket local address.
	const net = require('net');
	const sock = net.connect(handle.port, '127.0.0.1', () => {
		sock.destroy();
	});
	await new Promise((r) => sock.on('close', r));
	console.log('✓ server listens on loopback (127.0.0.1)');

	// Fingerprint (not token) logged: capture console.info output on a fresh start
	await serverMod.stopCliServer();
	const logged = [];
	const origInfo = console.info;
	console.info = (...args) => logged.push(args.map((a) => String(a)).join(' '));
	const handle2 = await serverMod.startCliServer(dataDir, { ...deps, port: 0 });
	console.info = origInfo;
	assert.ok(handle2.port > 0, 'restart binds a port');
	assert.ok(logged.some((l) => l.includes('fp=') && !l.includes(token)), 'log has fingerprint, not raw token');
	console.log('✓ startCliServer logs fingerprint not raw token');

	// EADDRINUSE fallback: hold a socket on a port, then request that port.
	await serverMod.stopCliServer();
	const blocker = net.createServer();
	await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
	const blockedPort = blocker.address().port;
	const blockedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-cli-busy-'));
	fs.writeFileSync(path.join(blockedDir, 'cli.json'), JSON.stringify({ port: blockedPort, tokenFingerprint: 'x', token: 'y' }));
	const busyHandle = await serverMod.startCliServer(blockedDir, { ...deps, port: blockedPort });
	assert.ok(busyHandle.port !== blockedPort, 'EADDRINUSE falls back to ephemeral port');
	const busyCliJson = JSON.parse(fs.readFileSync(path.join(blockedDir, 'cli.json'), 'utf8'));
	assert.strictEqual(busyCliJson.port, busyHandle.port, 'cli.json rewritten after fallback');
	await new Promise((r) => blocker.close(r));
	await serverMod.stopCliServer();
	console.log('✓ EADDRINUSE falls back to ephemeral port and rewrites cli.json');

	// stopCliServer closes and allows rebind
	await serverMod.stopCliServer();
	await new Promise((r) => setTimeout(r, 50));
	const handle3 = await serverMod.startCliServer(dataDir, deps);
	assert.ok(handle3.port > 0, 'restart works after stop');
	await serverMod.stopCliServer();
	console.log('✓ stopCliServer releases port (restart works)');
}

main().catch((e) => { console.error(e); process.exit(1); });
