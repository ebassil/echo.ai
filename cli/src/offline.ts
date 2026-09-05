// Offline direct-index reads — read-only SQLite over the plaintext index DB.
// Uses shared schema constants for SQL so drift is caught at build time.
import * as path from 'path';
import * as fs from 'fs/promises';
import { TABLES } from '../../src/schema/index';

const INDEX_DB_FILENAME = 'echo-index.db';

export interface OfflineSearchResult {
  chunkId: string;
  noteId: string;
  title: string | null;
  snippet: string;
  score: number;
  source: string;
}

function getDbPath(dataDir: string): string {
  return path.join(dataDir, INDEX_DB_FILENAME);
}

// Lazy-load node:sqlite (Node >= 22.5, stable in Node 24) — a pure builtin, no
// native npm dep, so `cli/` stays dependency-light. Opens strictly read-only.
async function openReadOnly(dataDir: string): Promise<any> {
  const dbPath = getDbPath(dataDir);
  try {
    await fs.access(dbPath);
  } catch {
    throw new Error(`Index DB not found at ${dbPath} — is the plugin installed and has it indexed notes?`);
  }

  let DatabaseSync: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch {
    throw new Error(
      'node:sqlite is unavailable in this Node version (>= 22.5 required). Install sqlite3 with "npm --prefix cli install sqlite3" for offline reads.',
    );
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  // Short busy timeout so a locked writer surfaces quickly and we can retry
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
  } catch {}
  return db;
}

function allRows(db: any, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

function closeDb(db: any): void {
  try {
    db.close();
  } catch {}
}

async function withRetryOnBusy<T>(fn: () => T, label: string): Promise<T> {
  try {
    return fn();
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        return fn();
      } catch (e2: any) {
        throw new Error(`Index DB is locked (plugin may be writing). Retry after a moment: ${String(e2?.message ?? e2)}`);
      }
    }
    throw e;
  }
}

export async function offlineSearch(dataDir: string, query: string, limit: number): Promise<{ results: OfflineSearchResult[]; total: number }> {
  let db: any;
  try {
    db = await openReadOnly(dataDir);
  } catch (e) {
    throw e;
  }

  try {
    return await withRetryOnBusy(() => {
      const rows = allRows(
        db,
        `SELECT c.id as chunkId, c.note_id as noteId, n.title as title,
                snippet(${TABLES.chunksFts}, -1, '[', ']', ' … ', 20) as snippet,
                rank
         FROM ${TABLES.chunksFts}
         JOIN ${TABLES.chunks} c ON c.rowid = ${TABLES.chunksFts}.rowid
         LEFT JOIN ${TABLES.notes} n ON n.id = c.note_id
         WHERE ${TABLES.chunksFts} MATCH ?
         ORDER BY rank
         LIMIT ?`,
        [query, limit],
      );
      const results: OfflineSearchResult[] = rows.map((r: any, idx: number) => ({
        chunkId: r.chunkId,
        noteId: r.noteId,
        title: r.title ?? null,
        snippet: r.snippet ?? '',
        score: typeof r.rank === 'number' ? r.rank : idx,
        source: 'fts5',
      }));
      return { results, total: results.length };
    }, 'offline search');
  } finally {
    if (db) closeDb(db);
  }
}

export async function offlineStatus(dataDir: string): Promise<{ currentRun: any | null; queueDepth: number; queuedRuns: any[]; progress: any | null }> {
  let db: any = null;
  try {
    db = await openReadOnly(dataDir);
    const runs = await withRetryOnBusy(
      () => allRows(db, `SELECT * FROM ${TABLES.pipelineRuns} ORDER BY started_at DESC LIMIT 1`, []),
      'offline status',
    );
    const currentRun = runs[0] ?? null;
    return { currentRun, queueDepth: 0, queuedRuns: [], progress: null };
  } finally {
    if (db) closeDb(db);
  }
}

export async function offlineHistory(dataDir: string, query: { pipeline?: string; status?: string; limit?: number; offset?: number }): Promise<any[]> {
  let db: any = null;
  try {
    db = await openReadOnly(dataDir);
    const conditions: string[] = [];
    const params: any[] = [];
    if (query.pipeline) {
      conditions.push('pipeline = ?');
      params.push(query.pipeline);
    }
    if (query.status) {
      conditions.push('status = ?');
      params.push(query.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const sql = `SELECT * FROM ${TABLES.pipelineRuns} ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return await withRetryOnBusy(() => allRows(db, sql, params), 'offline history');
  } finally {
    if (db) closeDb(db);
  }
}

export async function offlineRunById(dataDir: string, id: string): Promise<any> {
  let db: any = null;
  try {
    db = await openReadOnly(dataDir);
    const rows = await withRetryOnBusy(
      () => allRows(db, `SELECT * FROM ${TABLES.pipelineRuns} WHERE id = ?`, [id]),
      'offline run detail',
    );
    if (rows.length === 0) throw new Error(`Run not found: ${id}`);
    return rows[0];
  } finally {
    if (db) closeDb(db);
  }
}