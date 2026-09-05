import joplin from 'api';
import { join } from 'path';
import { applyMigrations } from './migrations';

export const INDEX_DB_FILENAME = 'echo-index.db';

let db: any = null;

export function getDatabase(): any {
	if (!db) throw new Error('Index database is not open');
	return db;
}

export async function openDatabase(dataDir: string): Promise<void> {
	if (db) return;

	const sqlite3 = joplin.require('sqlite3');
	const dbPath = join(dataDir, INDEX_DB_FILENAME);

	db = await open(sqlite3, dbPath);
	await run(db, 'PRAGMA foreign_keys = ON');
	await applyMigrations(db);
}

export async function closeDatabase(): Promise<void> {
	if (!db) return;
	await close(db);
	db = null;
}

function open(sqlite3: any, dbPath: string): Promise<any> {
	return new Promise((resolve, reject) => {
		const database = new sqlite3.Database(dbPath, (error: Error | null) => {
			if (error) reject(error);
			else resolve(database);
		});
	});
}

function close(database: any): Promise<void> {
	return new Promise((resolve, reject) => {
		database.close((error: Error | null) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

export function run(dbConnection: any, sql: string, params: any[] = []): Promise<void> {
	return new Promise((resolve, reject) => {
		dbConnection.run(sql, params, (error: Error | null) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

export function all<T>(dbConnection: any, sql: string, params: any[] = []): Promise<T[]> {
	return new Promise((resolve, reject) => {
		dbConnection.all(sql, params, (error: Error | null, rows: T[]) => {
			if (error) reject(error);
			else resolve(rows);
		});
	});
}