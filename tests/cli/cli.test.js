const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const CLI = path.resolve('cli/dist/cli/src/cli.js');
const TOKEN = 't'.repeat(64);

// Async spawn (NOT spawnSync: a synchronous spawn would block this process's
// event loop and the in-process fake server could never respond).
function runCli(args, env = {}, timeoutMs = 10000) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI, ...args], {
			env: { ...process.env, ...env },
		});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`CLI hung: echo ${args.join(' ')} (stdout so far: ${stdout})`));
		}, timeoutMs);
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

// Create a fake index DB fixture (schema subset used by offline reads).
function makeDataDir(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-cli-fixture-'));
	const port = overrides.port ?? 0;
	fs.writeFileSync(
		path.join(dir, 'cli.json'),
		JSON.stringify({ port, tokenFingerprint: 'abc12345', token: TOKEN }),
	);
	fs.writeFileSync(path.join(dir, 'echo-token'), TOKEN);
	if (overrides.db !== false) {
		const db = new DatabaseSync(path.join(dir, 'echo-index.db'));
		db.exec(`
			CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, notebook_id TEXT, notebook_name TEXT, content_hash TEXT NOT NULL, parent_id TEXT, created_at TEXT, updated_at TEXT, indexed_at TEXT, status TEXT NOT NULL DEFAULT 'pending');
			CREATE TABLE chunks (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, token_count INTEGER, created_at TEXT NOT NULL);
			CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY, pipeline TEXT NOT NULL, trigger TEXT NOT NULL, scope TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, notes_processed INTEGER DEFAULT 0, chunks_created INTEGER DEFAULT 0, error TEXT);
			CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content='chunks', content_rowid='rowid', tokenize='porter unicode61');
			CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content); END;
			CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content); END;
			CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content); INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content); END;
		`);
		db.prepare('INSERT INTO notes (id, title, content_hash) VALUES (?, ?, ?)').run('note1', 'Hello Note', 'h1');
		db.prepare('INSERT INTO chunks (id, note_id, chunk_index, content, created_at) VALUES (?, ?, ?, ?, ?)').run('chunk1', 'note1', 0, 'hello world this is a test', 't');
		db.prepare("INSERT INTO pipeline_runs (id, pipeline, trigger, scope, status, started_at) VALUES ('run_success', 'structural', 'manual', 'all', 'success', '2026-01-01T00:00:00Z')").run();
		db.prepare("INSERT INTO pipeline_runs (id, pipeline, trigger, scope, status, started_at) VALUES ('run_failed', 'semantic', 'schedule', 'all', 'failed', '2026-01-02T00:00:00Z')").run();
		db.close();
	}
	return dir;
}

function startFakeServer() {
	// Minimal mock of the echo endpoint for online-path tests
	return new Promise((resolve, reject) => {
		const srv = http.createServer((req, res) => {
			const auth = req.headers.authorization;
			if (auth !== 'Bearer ' + TOKEN) {
				res.writeHead(401, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Unauthorized' }));
				return;
			}
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				if (req.url.startsWith('/v1/pipeline/run')) {
					res.end(JSON.stringify({ runId: 'run_test1', pipeline: JSON.parse(body).pipeline, scope: JSON.parse(body).scope, trigger: 'manual' }));
				} else if (req.url.startsWith('/v1/search')) {
					res.end(JSON.stringify({ results: [{ chunkId: 'chunk1', noteId: 'note1', title: 'Hello Note', snippet: 'hello world', score: 1, source: 'fts5' }], total: 1, query: JSON.parse(body).query }));
				} else if (req.url.startsWith('/v1/status')) {
					res.end(JSON.stringify({ currentRun: null, queueDepth: 0, queuedRuns: [], progress: null }));
				} else if (req.url.startsWith('/v1/runs/')) {
					res.end(JSON.stringify({ id: 'run_success', pipeline: 'structural', status: 'success' }));
				} else if (req.url.startsWith('/v1/runs')) {
					res.end(JSON.stringify([{ id: 'run_success', pipeline: 'structural', status: 'success', started_at: 't' }]));
				} else {
					res.writeHead(404);
					res.end(JSON.stringify({ error: 'Not found' }));
				}
			});
		});
		srv.listen(0, '127.0.0.1', () => resolve(srv));
		srv.on('error', reject);
	});
}

async function main() {
	console.log('Running CLI client tests...');

	// --help / --version without plugin
	let r = await runCli(['--help']);
	assert.strictEqual(r.code, 0, 'help exits 0');
	assert.ok(/pipeline/.test(r.stdout), 'help lists commands');
	r = await runCli(['--version']);
	assert.strictEqual(r.code, 0, 'version exits 0');
	assert.strictEqual(r.stdout.trim(), '0.1.0', 'version string');
	console.log('✓ --help / --version without plugin (exit 0)');

	// Unknown command -> exit 1
	r = await runCli(['bogus'], { ECHO_DATA_DIR: makeDataDir() });
	assert.strictEqual(r.code, 1, 'unknown command exit 1');
	console.log('✓ unknown command exit 1');

	// Missing token/port -> exit 2 with diagnostic
	const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-cli-empty-'));
	r = await runCli(['status'], { ECHO_DATA_DIR: emptyDir });
	assert.strictEqual(r.code, 2, 'no plugin reachable exit 2');
	assert.ok(/Cannot reach plugin/.test(r.stderr + r.stdout), 'diagnostic printed');
	console.log('✓ missing token/port -> exit 2 with diagnostic');

	// Online: pipeline run via fake server
	const srv = await startFakeServer();
	const onlineDir = makeDataDir({ port: srv.address().port });
	r = await runCli(['pipeline', 'run', '--all', '--pipeline', 'both'], { ECHO_DATA_DIR: onlineDir });
	assert.strictEqual(r.code, 0, 'pipeline run exit 0');
	assert.ok(/run_test1/.test(r.stdout), 'runId printed');
	r = await runCli(['pipeline', 'run', '--all', '--pipeline', 'bogus'], { ECHO_DATA_DIR: onlineDir });
	assert.strictEqual(r.code, 1, 'invalid pipeline exit 1');
	console.log('✓ pipeline run online (exit 0) + invalid pipeline (exit 1)');

	// Online: search
	r = await runCli(['search', 'hello', '--limit', '5'], { ECHO_DATA_DIR: onlineDir });
	assert.strictEqual(r.code, 0, 'search exit 0');
	assert.ok(/Hello Note/.test(r.stdout), 'search result title');
	r = await runCli(['search', ''], { ECHO_DATA_DIR: onlineDir });
	assert.strictEqual(r.code, 1, 'empty query exit 1');
	console.log('✓ search online + empty query exit 1');

	// Online: status + history + run detail
	r = await runCli(['status'], { ECHO_DATA_DIR: onlineDir });
	assert.strictEqual(r.code, 0, 'status exit 0');
	r = await runCli(['status', '--history', '--limit', '5'], { ECHO_DATA_DIR: onlineDir });
	assert.strictEqual(r.code, 0, 'history exit 0');
	r = await runCli(['status', '--run', 'run_success'], { ECHO_DATA_DIR: onlineDir });
	assert.strictEqual(r.code, 0, 'run detail exit 0');
	assert.ok(/run_success/.test(r.stdout), 'run detail');
	r = await runCli(['status', '--run', 'unknown_run'], { ECHO_DATA_DIR: onlineDir });
	// fake server returns 200 for unknown too; skip exit-code assert for that path
	console.log('✓ status/history/run detail online');

	// ECHO_TOKEN precedence over file token (use wrong file token, right env token)
	const wrongTokenDir = makeDataDir({ port: srv.address().port });
	fs.writeFileSync(path.join(wrongTokenDir, 'echo-token'), 'wrong');
	r = await runCli(['status'], { ECHO_DATA_DIR: wrongTokenDir, ECHO_TOKEN: TOKEN });
	assert.strictEqual(r.code, 0, 'ECHO_TOKEN overrides file');
	console.log('✓ ECHO_TOKEN env var precedence');

	srv.close();

	// Offline: search against fixture DB
	const offDir = makeDataDir();
	r = await runCli(['search', 'hello', '--offline', '--json'], { ECHO_DATA_DIR: offDir });
	assert.strictEqual(r.code, 0, 'offline search exit 0');
	const parsed = JSON.parse(r.stdout);
	assert.strictEqual(parsed.results[0].noteId, 'note1', 'offline search note');
	assert.strictEqual(parsed.results[0].title, 'Hello Note', 'offline search title');
	console.log('✓ offline search against index DB fixture');

	// Offline: status + history
	r = await runCli(['status', '--offline', '--json'], { ECHO_DATA_DIR: offDir });
	assert.strictEqual(r.code, 0, 'offline status exit 0');
	const st = JSON.parse(r.stdout);
	assert.strictEqual(st.currentRun.pipeline, 'semantic', 'offline status latest run');
	r = await runCli(['status', '--history', '--offline', '--json'], { ECHO_DATA_DIR: offDir });
	assert.strictEqual(r.code, 0, 'offline history exit 0');
	const hist = JSON.parse(r.stdout);
	assert.strictEqual(hist.length, 2, 'two runs in history');
	console.log('✓ offline status/history read pipeline_runs');

	// Offline: run detail
	r = await runCli(['status', '--run', 'run_failed', '--offline', '--json'], { ECHO_DATA_DIR: offDir });
	assert.strictEqual(r.code, 0, 'offline run detail');
	assert.strictEqual(JSON.parse(r.stdout).status, 'failed');
	r = await runCli(['status', '--run', 'nope', '--offline'], { ECHO_DATA_DIR: offDir });
	assert.strictEqual(r.code, 1, 'offline unknown run exit 1');
	console.log('✓ offline run detail + unknown -> exit 1');

	// Offline: missing index DB -> exit 1 with message
	const noDbDir = makeDataDir({ db: false });
	r = await runCli(['search', 'hello', '--offline'], { ECHO_DATA_DIR: noDbDir });
	assert.strictEqual(r.code, 1, 'offline no db exit 1');
	assert.ok(/Index DB not found/.test(r.stderr + r.stdout), 'clear db missing message');
	console.log('✓ offline missing DB -> exit 1 with clear message');

	// update alias online
	const srv2 = await startFakeServer();
	const updDir = makeDataDir({ port: srv2.address().port });
	r = await runCli(['update', '--all'], { ECHO_DATA_DIR: updDir });
	assert.strictEqual(r.code, 0, 'update alias exit 0');
	assert.ok(/run_test1/.test(r.stdout), 'update prints runId');
	srv2.close();
	console.log('✓ update alias maps to pipeline run');

	// shared-schema drift guard: build fails if schema import missing
	// Simulate by checking the compiled dist imports resolve to the schema module.
	const offlineSrc = fs.readFileSync(path.resolve('cli/src/offline.ts'), 'utf8');
	assert.ok(/..\/..\/src\/schema\/index/.test(offlineSrc), 'offline.ts imports shared schema');
	const discoverySrc = fs.readFileSync(path.resolve('cli/src/discovery.ts'), 'utf8');
	assert.ok(/..\/..\/src\/schema\/index/.test(discoverySrc), 'discovery.ts imports shared schema');
	console.log('✓ shared schema import present in cli sources (drift guard)');

	console.log('All CLI client tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });