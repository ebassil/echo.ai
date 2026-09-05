import { chunkNote, DEFAULT_CHUNKER_OPTIONS } from '../indexing/chunker';
import type { LLMProvider, ExtractionResult, Entity, Relation } from '../llm/provider';
import { validatedExtract } from './validate';

export type ExtractionGranularity = 'per-note' | 'per-chunk' | 'per-note+per-chunk';

export interface ExtractorOptions {
	granularity: ExtractionGranularity;
	extractionMaxChars: number;
	extractionConcurrency: number;
	chunkSize: number;
	chunkOverlap: number;
}

export const DEFAULT_EXTRACTION_MAX_CHARS = 8000;
export const DEFAULT_EXTRACTION_CONCURRENCY = 1;
export const DEFAULT_GRANULARITY: ExtractionGranularity = 'per-note';

const ENRICHMENT_MARKER_RE = /<!--\s*echo:enrichment[\s\S]*?-->\s*$/;

export function stripEnrichmentMarker(text: string): string {
	if (!text) return text;
	return text.replace(ENRICHMENT_MARKER_RE, '').trimEnd();
}

export function buildFullContent(title: string, body: string): string {
	const safeBody = stripEnrichmentMarker(body ?? '');
	const trimmedTitle = (title ?? '').trim();
	if (trimmedTitle.length > 0) {
		return `# ${trimmedTitle}\n\n${safeBody}`;
	}
	return safeBody;
}

function normalizeForDedup(name: string): string {
	return name
		.normalize('NFC')
		.trim()
		.toLocaleLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
		.trim();
}

function dedupeEntities(entities: Entity[]): Entity[] {
	const map = new Map<string, Entity>();
	for (const e of entities) {
		const key = normalizeForDedup(e.name);
		if (!key) continue;
		const existing = map.get(key);
		if (!existing) {
			map.set(key, { ...e });
		} else {
			// Merge confidence: keep max
			if (e.confidence != null && (existing.confidence == null || e.confidence > existing.confidence)) {
				existing.confidence = e.confidence;
			}
			// Keep first name/type, but could update type if missing
		}
	}
	return Array.from(map.values());
}

function dedupeRelations(relations: Relation[]): Relation[] {
	const map = new Map<string, Relation>();
	for (const r of relations) {
		const fromNorm = normalizeForDedup(r.from);
		const toNorm = normalizeForDedup(r.to);
		const typeNorm = r.type.trim().toLocaleLowerCase();
		if (!fromNorm || !toNorm || !typeNorm) continue;
		const key = `${fromNorm}|${toNorm}|${typeNorm}`;
		const existing = map.get(key);
		if (!existing) {
			map.set(key, { ...r });
		} else {
			if (r.confidence != null && (existing.confidence == null || r.confidence > existing.confidence)) {
				existing.confidence = r.confidence;
			}
		}
	}
	return Array.from(map.values());
}

function mergeResults(results: ExtractionResult[]): ExtractionResult {
	const allEntities: Entity[] = [];
	const allRelations: Relation[] = [];
	for (const r of results) {
		allEntities.push(...r.entities);
		allRelations.push(...r.relations);
	}
	return {
		entities: dedupeEntities(allEntities),
		relations: dedupeRelations(allRelations),
	};
}

async function pMapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const clamped = Math.min(Math.max(Math.floor(concurrency), 1), 4);
	if (clamped === 1) {
		const results: R[] = [];
		for (let i = 0; i < items.length; i++) {
			results.push(await fn(items[i], i));
		}
		return results;
	}
	// Bounded parallel via semaphore
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (true) {
			const idx = nextIndex++;
			if (idx >= items.length) break;
			results[idx] = await fn(items[idx], idx);
		}
	}
	const workers = Array(Math.min(clamped, items.length))
		.fill(0)
		.map(() => worker());
	await Promise.all(workers);
	return results;
}

export async function extractPerNote(
	provider: LLMProvider,
	fullContent: string,
	options: ExtractorOptions,
): Promise<ExtractionResult> {
	if (fullContent.trim().length === 0) {
		return { entities: [], relations: [] };
	}
	if (fullContent.length <= options.extractionMaxChars) {
		return await validatedExtract(provider, fullContent);
	}
	// Windowed fallback: split using chunker
	// Use a synthetic note id for chunking; chunk content is the window
	const syntheticId = '__window__';
	const chunks = chunkNote(syntheticId, '', fullContent, {
		maxChars: options.chunkSize ?? DEFAULT_CHUNKER_OPTIONS.maxChars,
		overlapChars: options.chunkOverlap ?? DEFAULT_CHUNKER_OPTIONS.overlapChars,
	});
	if (chunks.length === 0) {
		return await validatedExtract(provider, fullContent.slice(0, options.extractionMaxChars));
	}
	const windowResults = await pMapWithConcurrency(
		chunks,
		options.extractionConcurrency,
		async (chunk) => {
			try {
				return await validatedExtract(provider, chunk.content);
			} catch (e) {
				// Log and return empty for this window, caller will handle error surfacing
				console.warn('[echo] window extraction failed', e);
				return { entities: [], relations: [] } as ExtractionResult;
			}
		},
	);
	return mergeResults(windowResults);
}

export async function extractPerChunk(
	provider: LLMProvider,
	noteId: string,
	title: string,
	body: string,
	options: ExtractorOptions,
): Promise<ExtractionResult> {
	const safeBody = stripEnrichmentMarker(body ?? '');
	const fullContent = buildFullContent(title, safeBody);
	if (fullContent.trim().length === 0) {
		return { entities: [], relations: [] };
	}
	const chunks = chunkNote(noteId, title ?? '', safeBody, {
		maxChars: options.chunkSize ?? DEFAULT_CHUNKER_OPTIONS.maxChars,
		overlapChars: options.chunkOverlap ?? DEFAULT_CHUNKER_OPTIONS.overlapChars,
	});
	if (chunks.length === 0) {
		return { entities: [], relations: [] };
	}
	const chunkResults = await pMapWithConcurrency(
		chunks,
		options.extractionConcurrency,
		async (chunk) => {
			try {
				return await validatedExtract(provider, chunk.content);
			} catch (e) {
				console.warn(`[echo] per-chunk extraction failed for ${chunk.id}`, e);
				return { entities: [], relations: [] } as ExtractionResult;
			}
		},
	);
	return mergeResults(chunkResults);
}

export async function extractNote(
	provider: LLMProvider,
	note: { id: string; title: string; body: string },
	options: ExtractorOptions,
): Promise<ExtractionResult> {
	const granularity = options.granularity ?? DEFAULT_GRANULARITY;
	const fullContent = buildFullContent(note.title ?? '', note.body ?? '');

	if (granularity === 'per-chunk') {
		return await extractPerChunk(provider, note.id, note.title ?? '', note.body ?? '', options);
	}

	if (granularity === 'per-note+per-chunk') {
		const perNotePromise = extractPerNote(provider, fullContent, options);
		const perChunkPromise = extractPerChunk(provider, note.id, note.title ?? '', note.body ?? '', options);
		const [perNoteResult, perChunkResult] = await Promise.all([perNotePromise, perChunkPromise]);
		return mergeResults([perNoteResult, perChunkResult]);
	}

	// per-note default with windowed fallback
	return await extractPerNote(provider, fullContent, options);
}

export function resolveExtractorOptions(settings: any): ExtractorOptions {
	return {
		granularity: isValidGranularity(settings.extractionGranularity)
			? settings.extractionGranularity
			: DEFAULT_GRANULARITY,
		extractionMaxChars: isValidMaxChars(settings.extractionMaxChars)
			? settings.extractionMaxChars
			: DEFAULT_EXTRACTION_MAX_CHARS,
		extractionConcurrency: isValidConcurrency(settings.extractionConcurrency)
			? settings.extractionConcurrency
			: DEFAULT_EXTRACTION_CONCURRENCY,
		chunkSize: typeof settings.chunkSize === 'number' ? settings.chunkSize : DEFAULT_CHUNKER_OPTIONS.maxChars,
		chunkOverlap: typeof settings.chunkOverlap === 'number' ? settings.chunkOverlap : DEFAULT_CHUNKER_OPTIONS.overlapChars,
	};
}

function isValidGranularity(v: any): boolean {
	return v === 'per-note' || v === 'per-chunk' || v === 'per-note+per-chunk';
}
function isValidMaxChars(v: any): boolean {
	return typeof v === 'number' && isFinite(v) && v >= 1000 && v <= 20000;
}
function isValidConcurrency(v: any): boolean {
	return typeof v === 'number' && isFinite(v) && v >= 1 && v <= 4;
}
