import { getDatabase, all } from '../storage/db';
import { getCurrentRun, getQueueSnapshot, getQueueDepth, getProgress } from './runner';

export interface PipelineRunRow {
  id: string;
  pipeline: string;
  trigger: string;
  scope: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  notes_processed: number | null;
  chunks_created: number | null;
  error: string | null;
}

export interface CurrentStatus {
  currentRun: PipelineRunRow | null;
  queueDepth: number;
  queuedRuns: Array<{
    id: string;
    pipeline: string;
    trigger: string;
    scope: any;
    priority: number;
    enqueuedAt: string;
  }>;
  progress: { processed: number; total: number; currentNoteId: string } | null;
}

export async function getCurrentStatus(): Promise<CurrentStatus> {
  const db = getDatabase();
  const current = getCurrentRun();
  let currentRow: PipelineRunRow | null = null;
  if (current) {
    const rows = await all<PipelineRunRow>(db, `SELECT * FROM pipeline_runs WHERE id = ?`, [current.id]);
    currentRow = rows[0] ?? null;
  }
  const queue = getQueueSnapshot();
  return {
    currentRun: currentRow,
    queueDepth: getQueueDepth(),
    queuedRuns: queue.map((q) => ({
      id: q.id,
      pipeline: q.pipeline,
      trigger: q.trigger,
      scope: q.scope,
      priority: q.priority,
      enqueuedAt: q.enqueuedAt,
    })),
    progress: getProgress(),
  };
}

export interface HistoryQuery {
  pipeline?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function getRunHistory(query: HistoryQuery = {}): Promise<PipelineRunRow[]> {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: any[] = [];

  if (query.pipeline) {
    conditions.push(`pipeline = ?`);
    params.push(query.pipeline);
  }
  if (query.status) {
    conditions.push(`status = ?`);
    params.push(query.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const sql = `SELECT * FROM pipeline_runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await all<PipelineRunRow>(db, sql, params);
  return rows;
}

export async function getRunById(id: string): Promise<PipelineRunRow> {
  const db = getDatabase();
  const rows = await all<PipelineRunRow>(db, `SELECT * FROM pipeline_runs WHERE id = ?`, [id]);
  if (rows.length === 0) throw new Error(`Run not found: ${id}`);
  return rows[0];
}
