const assert = require('assert');

const Module = require('module');
const path = require('path');
const mockApi = path.join(__dirname, 'helpers', 'mock-api.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'api') return mockApi;
	return origResolve.call(this, request, ...args);
};

const { load } = require('./helpers/load-ts');

const { shouldReprocess, RETRY_COOLDOWN_MS } = load('indexing/delta.ts');

console.log('Running shouldReprocess cooldown unit tests...');

// Callback-style in-memory db matching the sqlite3 driver interface used by
// storage/db.ts helpers (run/all take (sql, params, callback)).
function makeCallbackDb() {
	const { DatabaseSync } = require('node:sqlite');
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec('BEGIN');
	try {
		db.exec(STATUS_SCHEMA);
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
	return {
		run(sql, params = [], cb) {
			try {
				db.prepare(sql).run(...params);
				if (cb) cb(null);
			} catch (e) {
				if (cb) cb(e);
				else throw e;
			}
		},
		all(sql, params = [], cb) {
			try {
				const rows = db.prepare(sql).all(...params);
				if (cb) cb(null, rows);
			} catch (e) {
				if (cb) cb(e);
				else throw e;
			}
		},
	};
}

const STATUS_SCHEMA = `
CREATE TABLE index_state (
  note_id TEXT PRIMARY KEY,
  content_hash TEXT,
  structural_status TEXT,
  semantic_status TEXT,
  last_indexed_at TEXT,
  error TEXT,
  updated_at TEXT
);
`;

function iso(offsetMs = 0) {
	return new Date(Date.now() - offsetMs).toISOString();
}

async function setup(status, updatedAt) {
	const db = makeCallbackDb();
	await new Promise((resolve, reject) =>
		db.run(
			`INSERT INTO index_state (note_id, content_hash, structural_status, semantic_status, last_indexed_at, error, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
			['n1', 'hash-abc', status, status === 'success' ? iso() : null, status === 'failed' ? 'embedding failed' : null, updatedAt],
			(e) => (e ? reject(e) : resolve()),
		),
	);
	return db;
}

async function testFailedWithinCooldownSkips() {
	const db = await setup('failed', iso(0));
	const decision = await shouldReprocess(db, 'n1', 'hash-abc', {});
	assert.strictEqual(decision.shouldReprocess, false, 'failed note within cooldown is skipped');
	assert.strictEqual(decision.reason, 'cooldown');
	console.log('✓ failed within cooldown -> skip');
}

async function testFailedPastCooldownRetries() {
	const db = await setup('failed', iso(RETRY_COOLDOWN_MS + 1000));
	const decision = await shouldReprocess(db, 'n1', 'hash-abc', {});
	assert.strictEqual(decision.shouldReprocess, true, 'failed note past cooldown is retried');
	console.log('✓ failed past cooldown -> retry');
}

async function testForceBypassesCooldown() {
	const db = await setup('failed', iso(0));
	const decision = await shouldReprocess(db, 'n1', 'hash-abc', { force: true });
	assert.strictEqual(decision.shouldReprocess, true, 'force bypasses cooldown');
	assert.strictEqual(decision.reason, 'force');
	console.log('✓ force bypasses the cooldown');
}

async function testPendingReprocessedWhenProviderUp() {
	const db = await setup('pending', iso(0));
	const decision = await shouldReprocess(db, 'n1', 'hash-abc', {});
	assert.strictEqual(decision.shouldReprocess, true, 'pending (provider-down) note resumes once gate flips up');
	console.log('✓ pending note is reprocessed (recovery needs no manual action)');
}

(async () => {
	await testFailedWithinCooldownSkips();
	await testFailedPastCooldownRetries();
	await testForceBypassesCooldown();
	await testPendingReprocessedWhenProviderUp();
	console.log('All shouldReprocess cooldown tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});