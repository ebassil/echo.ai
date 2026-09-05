import joplin from 'api';
import { initDataDirectory } from './dataDir';
import { openDatabase, closeDatabase } from '../storage/db';
import { registerSettings, resolveSettings, watchSettings } from '../settings/registry';
import { registerCommands } from '../commands/registry';
import { createProvider } from '../llm/factory';
import type { EchoSettings } from '../settings/registry';
import type { LLMProvider } from '../llm/provider';
import { errorMessage } from '../util/errors';

export interface PluginContext {
	dataDir: string;
	settings: EchoSettings;
	provider: LLMProvider;
}

let context: PluginContext | null = null;

export function getContext(): PluginContext {
	if (!context) throw new Error('echo.ai plugin has not been started');
	return context;
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

		const provider = createProvider(resolution.settings);
		await registerCommands(provider);

		await watchSettings();

		context = { dataDir, settings: resolution.settings, provider };

		console.info('[echo] plugin started', { dataDir });
	} catch (error) {
		console.error('[echo] startup failed', error);
		await surfaceErrors([`echo.ai failed to start: ${errorMessage(error)}`]);
		throw error;
	}
}

export async function stop(): Promise<void> {
	try {
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