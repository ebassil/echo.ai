import joplin from 'api';
import { initDataDirectory } from './dataDir';
import { getDatabase, openDatabase, closeDatabase, run } from '../storage/db';
import { registerSettings, resolveSettings, watchSettings } from '../settings/registry';
import { registerCommands } from '../commands/registry';
import { createProvider } from '../llm/factory';
import type { EchoSettings } from '../settings/registry';
import type { LLMProvider } from '../llm/provider';
import { errorMessage } from '../util/errors';
import { startWatching, stopWatching, getWatchHandle, flushWatchQueue } from '../indexing/watch';
import { indexNote as indexNoteFn, indexFolder as indexFolderFn, indexAll as indexAllFn, purgeDeletedNote, isIndexingRunning } from '../indexing/pipeline';
import { isVaultLocked } from '../indexing/vault';

export interface PluginContext {
	dataDir: string;
	settings: EchoSettings;
	provider: LLMProvider;
}

export interface IndexingService {
	indexNote(noteId: string, options?: { force?: boolean }): Promise<import('../indexing/pipeline').IndexResult>;
	indexFolder(folderId: string, options?: { force?: boolean }): Promise<import('../indexing/pipeline').IndexResult>;
	indexAll(options?: { force?: boolean }): Promise<import('../indexing/pipeline').IndexResult>;
	purgeNote(noteId: string): Promise<void>;
	isVaultLocked(): Promise<boolean>;
	isIndexingRunning(): boolean;
	getWatchHandle(): ReturnType<typeof getWatchHandle>;
	flushQueue(): Promise<void>;
	getPauseStatus(): { isPaused: boolean; queueSize: number };
}

let context: PluginContext | null = null;

export function getContext(): PluginContext {
	if (!context) throw new Error('echo.ai plugin has not been started');
	return context;
}

export function getProvider(): LLMProvider {
	return getContext().provider;
}

export function getIndexingService(): IndexingService {
	const provider = getProvider();
	const settings = getContext().settings;
	const opts = {
		maxChars: settings.chunkSize,
		overlapChars: settings.chunkOverlap,
		embeddingBatchSize: settings.embeddingBatchSize,
	};
	return {
		indexNote: (noteId, options) => indexNoteFn(noteId, provider, { ...opts, ...options }),
		indexFolder: (folderId, options) => indexFolderFn(folderId, provider, { ...opts, ...options }),
		indexAll: (options) => indexAllFn(provider, { ...opts, ...options }),
		purgeNote: (noteId) => purgeDeletedNote(noteId),
		isVaultLocked: () => isVaultLocked(),
		isIndexingRunning: () => isIndexingRunning(),
		getWatchHandle: () => getWatchHandle(),
		flushQueue: () => flushWatchQueue(),
		getPauseStatus: () => {
			const handle = getWatchHandle();
			return { isPaused: handle?.isPaused() ?? false, queueSize: handle?.getQueueSize() ?? 0 };
		},
	};
}

export async function start(): Promise<void> {
	try {
		const dataDir = await initDataDirectory();

		await registerSettings();

		const resolution = await resolveSettings();
		if (resolution.errors.length > 0) {
			await surfaceErrors(resolution.errors);
		}

		await openDatabase(dataDir);
		// Ensure FK enforcement for this connection (already set in db.ts, but reaffirm for indexing writes)
		try {
			await run(getDatabase(), 'PRAGMA foreign_keys = ON');
		} catch {}

		const provider = createProvider(resolution.settings);
		await registerCommands(provider);

		await watchSettings();

		context = { dataDir, settings: resolution.settings, provider };

		// Start structural indexing watcher (debounced events + vault unlock catch-up)
		try {
			await startWatching({ provider });
			console.info('[echo] indexing watcher started');
		} catch (error) {
			console.warn('[echo] indexing watcher failed to start', error);
		}

		console.info('[echo] plugin started', { dataDir });
	} catch (error) {
		console.error('[echo] startup failed', error);
		await surfaceErrors([`echo.ai failed to start: ${errorMessage(error)}`]);
		throw error;
	}
}

export async function stop(): Promise<void> {
	try {
		await stopWatching();
		await closeDatabase();
		context = null;
		console.info('[echo] plugin stopped');
	} catch (error) {
		console.error('[echo] shutdown failed', error);
	}
}

async function surfaceErrors(errors: string[]): Promise<void> {
	if (errors.length === 0) return;
	const message = errors.map((error) => `- ${error}`).join('\n');
	await joplin.views.dialogs.showMessageBox(`echo.ai\n\n${message}`);
}