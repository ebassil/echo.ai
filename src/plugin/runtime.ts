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
import { createStructuralPipeline } from '../indexing/pipeline';
import { createSemanticPipeline } from '../semantic/index';
import { isVaultLocked } from '../indexing/vault';
import { registerOrchestrationSettings, resolveOrchestrationSchedule } from '../orchestration/settings';
import { setPipelineExecutor, getCurrentRun, getQueueDepth } from '../orchestration/runner';
import { createTriggers, stopGlobalTriggers } from '../orchestration/triggers';
import { registerOrchestrationCommands } from '../orchestration/commands';
import { createOrchestrationScheduler } from '../orchestration/scheduler';
import { enqueueRun } from '../orchestration/runner';

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
let orchestrationTriggers: ReturnType<typeof createTriggers> | null = null;
let orchestrationScheduler: ReturnType<typeof createOrchestrationScheduler> | null = null;

export function getContext(): PluginContext {
	if (!context) throw new Error('echo.ai plugin has not been started');
	return context;
}

export function getOrchestrationTriggers(): ReturnType<typeof createTriggers> | null {
	return orchestrationTriggers;
}

export function getOrchestrationScheduler(): ReturnType<typeof createOrchestrationScheduler> | null {
	return orchestrationScheduler;
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
		try {
			await registerOrchestrationSettings();
		} catch (e) {
			console.warn('[echo] orchestration settings registration failed', e);
		}

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

		// Configure orchestration pipeline executor (serial runner owns SQLite writes)
		try {
			const structuralPipeline = createStructuralPipeline(provider, {
				maxChars: resolution.settings.chunkSize,
				overlapChars: resolution.settings.chunkOverlap,
				embeddingBatchSize: resolution.settings.embeddingBatchSize,
			});
			const semanticPipeline = createSemanticPipeline(provider, resolution.settings);
			setPipelineExecutor(async (pipeline, noteIds, opts) => {
				if (pipeline === 'structural') return structuralPipeline.run(noteIds, opts);
				if (pipeline === 'semantic') return semanticPipeline.run(noteIds, opts);
				if (pipeline === 'both') {
					const s = await structuralPipeline.run(noteIds, opts);
					if (opts.signal?.aborted) return s;
					const sem = await semanticPipeline.run(noteIds, opts);
					return {
						notesProcessed: s.notesProcessed + sem.notesProcessed,
						chunksCreated: s.chunksCreated + sem.chunksCreated,
						entitiesCreated: sem.entitiesCreated,
						relationsCreated: sem.relationsCreated,
						skipped: s.skipped + sem.skipped,
						errors: [...s.errors, ...sem.errors],
					};
				}
				// embedding same as structural
				return structuralPipeline.run(noteIds, opts);
			});
		} catch (e) {
			console.warn('[echo] orchestration executor setup failed', e);
		}

		// Register orchestration commands (menu/toolbar/manual trigger)
		try {
			await registerOrchestrationCommands();
		} catch (e) {
			console.warn('[echo] orchestration commands failed', e);
		}

		// Start orchestration triggers (debounced events + vault gating + enrichment suppression)
		try {
			orchestrationTriggers = createTriggers({});
			console.info('[echo] orchestration triggers started');
		} catch (error) {
			console.warn('[echo] orchestration triggers failed to start', error);
		}

		// Start scheduler
		try {
			const schedule = await resolveOrchestrationSchedule();
			orchestrationScheduler = createOrchestrationScheduler(schedule, async () => {
				if (await isVaultLocked()) {
					console.info('[echo] scheduler tick deferred: vault locked');
					return;
				}
				await enqueueRun({ pipeline: 'structural', scope: 'all', trigger: 'schedule' });
			});
			// Watch settings changes for schedule hot-reload
			const joplinAny: any = joplin as any;
			if (typeof joplinAny.settings?.onChange === 'function') {
				await joplinAny.settings.onChange(async (event: any) => {
					if (!event.keys?.includes('echo.orchestrationSchedule')) return;
					try {
						const newSchedule = await resolveOrchestrationSchedule();
						orchestrationScheduler?.reschedule(newSchedule);
						console.info('[echo] scheduler rescheduled to', newSchedule);
					} catch {}
				});
			}
			console.info('[echo] scheduler started with', schedule);
		} catch (e) {
			console.warn('[echo] scheduler failed', e);
		}

		// Startup catch-up: delta scan if vault unlocked, else deferred
		try {
			if (await isVaultLocked()) {
				console.info('[echo] startup: vault locked, deferring catch-up');
			} else {
				console.info('[echo] startup: enqueue catch-up scan');
				await enqueueRun({ pipeline: 'structural', scope: 'all', trigger: 'startup' });
			}
		} catch (e) {
			console.warn('[echo] startup catch-up enqueue failed', e);
		}

		// Start legacy structural indexing watcher for backwards compat (will delegate to orchestration triggers)
		// Keep for now but orchestration triggers is canonical
		try {
			await startWatching({ provider });
			console.info('[echo] indexing watcher started (legacy shim)');
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
		if (orchestrationScheduler) {
			orchestrationScheduler.dispose();
			orchestrationScheduler = null;
		}
		if (orchestrationTriggers) {
			orchestrationTriggers.dispose();
			orchestrationTriggers = null;
		}
		stopGlobalTriggers();
		// Abort in-progress runner run after current note
		try {
			const current = getCurrentRun();
			if (current) {
				const { cancelRun } = await import('../orchestration/runner');
				await cancelRun(current.id);
			}
		} catch {}
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