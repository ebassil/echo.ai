const { DatabaseSync } = require('node:sqlite');

const MIGRATION_V4 = `
	CREATE TABLE conversations (
		id TEXT PRIMARY KEY,
		title TEXT,
		model TEXT NOT NULL,
		system_prompt TEXT NOT NULL,
		notes_on INTEGER NOT NULL DEFAULT 1,
		retrieval_toggles TEXT NOT NULL DEFAULT '{}',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE conversation_messages (
		id TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
		role TEXT NOT NULL,
		content TEXT NOT NULL,
		citations TEXT NOT NULL DEFAULT '[]',
		created_at TEXT NOT NULL,
		seq INTEGER NOT NULL,
		error TEXT,
		UNIQUE(conversation_id, seq)
	);
	CREATE INDEX idx_conversation_messages_conv ON conversation_messages(conversation_id, seq);
	CREATE INDEX idx_conversations_updated ON conversations(updated_at);
`;

function makeMemoryDb() {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec(MIGRATION_V4);
	const adapter = {
		run: (sql, params = []) => {
			db.prepare(sql).run(...params);
			return Promise.resolve();
		},
		all: (sql, params = []) => {
			const rows = db.prepare(sql).all(...params);
			return Promise.resolve(rows);
		},
	};
	return { db, adapter };
}

const delay = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { makeMemoryDb, delay };