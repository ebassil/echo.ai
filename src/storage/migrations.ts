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