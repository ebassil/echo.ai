import { all, run } from '../storage/db';

export interface SemanticDeltaDecision {
	noteId: string;
	contentHash: string;
	shouldReprocess: boolean;
	reason: 'no_state' | 'hash_changed' | 'hash_equal' | 'force' | 'model_changed' | 'status_not_success';
}

async function ensureExtractionModelColumn(db: any): Promise<void> {
	try {
		const cols: { name: string }[] = await all(db, `SELECT name FROM pragma_table_info('index_state')`, []);
		const hasModel = cols.some((c) => c.name === 'extraction_model');
		if (!hasModel) {
			await run(db, `ALTER TABLE index_state ADD COLUMN extraction_model TEXT`);
		}
	} catch {
		// ignore
	}
}

export async function getSemanticIndexState(
	db: any,
	noteId: string,
): Promise<{ content_hash: string; semantic_status: string; extraction_model: string | null } | null> {
	await ensureExtractionModelColumn(db);
	const rows = await all<{ content_hash: string; semantic_status: string; extraction_model: string | null }>(
		db,
		`SELECT content_hash, semantic_status, extraction_model FROM index_state WHERE note_id = ?`,
		[noteId],
	);
	return rows[0] ?? null;
}

export async function shouldReprocessSemantic(
	db: any,
	noteId: string,
	currentHash: string,
	options: { force?: boolean; expectedExtractionModel?: string } = {},
): Promise<SemanticDeltaDecision> {
	if (options.force) {
		return { noteId, contentHash: currentHash, shouldReprocess: true, reason: 'force' };
	}

	const state = await getSemanticIndexState(db, noteId);
	if (!state) {
		return { noteId, contentHash: currentHash, shouldReprocess: true, reason: 'no_state' };
	}

	if (state.content_hash !== currentHash) {
		return { noteId, contentHash: currentHash, shouldReprocess: true, reason: 'hash_changed' };
	}

	if (state.semantic_status !== 'success') {
		return { noteId, contentHash: currentHash, shouldReprocess: true, reason: 'status_not_success' };
	}

	if (options.expectedExtractionModel) {
		// If recorded model differs, reprocess
		if (state.extraction_model && state.extraction_model !== options.expectedExtractionModel) {
			return { noteId, contentHash: currentHash, shouldReprocess: true, reason: 'model_changed' };
		}
		if (!state.extraction_model && options.expectedExtractionModel) {
			// No model recorded yet, treat as model changed to ensure first run with model is recorded
			// But if previous success had no model column value, we should reprocess to record it?
			// Only if we have a model expectation, trigger reprocess once.
			return { noteId, contentHash: currentHash, shouldReprocess: true, reason: 'model_changed' };
		}
	}

	return { noteId, contentHash: currentHash, shouldReprocess: false, reason: 'hash_equal' };
}

export function resolveExpectedExtractionModel(settings: any): string {
	if (settings.extractionModel && typeof settings.extractionModel === 'string' && settings.extractionModel.trim().length > 0) {
		return settings.extractionModel.trim();
	}
	return settings.model ?? 'unknown';
}
