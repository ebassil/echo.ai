import joplin from 'api';
import { ToastType } from 'api/types';
import type { LLMProvider, ConnectionTestResult } from '../llm/provider';
import { providerHealth } from '../llm/health';
import { SETTINGS } from '../settings/registry';
import { errorMessage } from '../util/errors';

export const TEST_CONNECTION_COMMAND = 'echo.testConnection';

const DIALOG_ID = 'echo-test-connection';

let running = false;

export async function registerTestConnectionCommand(provider: LLMProvider): Promise<void> {
	await joplin.commands.register({
		name: TEST_CONNECTION_COMMAND,
		label: 'Echo AI: Test connection',
		iconName: 'fas fa-plug',
		execute: async () => {
			if (running) {
				await joplin.views.dialogs.showToast({
					message: 'A connection test is already in progress.',
					type: ToastType.Info,
				});
				return;
			}

			running = true;
			try {
				const timeoutSeconds = await readTimeoutSeconds();
				await runTestConnection(provider, timeoutSeconds);
			} finally {
				// A fresh manual probe just ran: drop cached health so the next
				// automatic check re-probes with current reachability.
				providerHealth.invalidate();
				running = false;
			}
		},
	});
}

async function readTimeoutSeconds(): Promise<number> {
	const value = await joplin.settings.value(SETTINGS.connectionTimeoutSeconds);
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
		return 15;
	}
	return Math.round(value);
}

async function runTestConnection(provider: LLMProvider, timeoutSeconds: number): Promise<void> {
	let cancelled = false;
	const controller = new AbortController();

	const handle = await joplin.views.dialogs.create(DIALOG_ID);
	await joplin.views.dialogs.setFitToContent(handle, true);
	await updateProgress(handle, 'Preparing connection test...', 5);
	await joplin.views.dialogs.setButtons(handle, [
		{
			id: 'cancel',
			title: 'Cancel',
			onClick: () => {
				cancelled = true;
				controller.abort();
			},
		},
	]);

	const dialogPromise = joplin.views.dialogs.open(handle);
	const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

	let result: ConnectionTestResult;
	try {
		result = await provider.testConnection({
			signal: controller.signal,
			onProgress: (label, percent) => updateProgress(handle, label, percent),
		});
	} catch (error) {
		result = { ok: false, message: errorMessage(error) };
	} finally {
		clearTimeout(timer);
	}

	// The Cancel button already closed the dialog; nothing to update.
	if (cancelled) return;

	if (controller.signal.aborted) {
		result = { ok: false, message: `Connection test timed out after ${timeoutSeconds} seconds.` };
	}

	await joplin.views.dialogs.setHtml(handle, resultHtml(result.ok, result.message));
	await joplin.views.dialogs.setButtons(handle, [{ id: 'ok', title: 'OK' }]);

	// Resolves once the user acknowledges the result.
	await dialogPromise;
}

async function updateProgress(handle: string, label: string, percent: number): Promise<void> {
	await joplin.views.dialogs.setHtml(handle, progressHtml(label, percent));
}

function progressHtml(label: string, percent: number): string {
	const clamped = Math.max(0, Math.min(100, Math.round(percent)));
	return `
<div style="font-family:sans-serif;padding:16px;min-width:340px">
	<div style="font-size:14px;font-weight:600;margin-bottom:12px">Echo AI: Testing provider connection</div>
	<div style="background:#e0e0e0;border-radius:6px;height:8px;overflow:hidden">
		<div style="background:#508bea;height:8px;width:${clamped}%;transition:width .2s ease"></div>
	</div>
	<div style="font-size:12px;color:#555;margin-top:8px">${escapeHtml(label)}</div>
</div>`;
}

function resultHtml(ok: boolean, message: string): string {
	const color = ok ? '#1a7f37' : '#cf222e';
	const title = ok ? 'Connection test succeeded' : 'Connection test failed';
	return `
<div style="font-family:sans-serif;padding:16px;min-width:360px">
	<div style="font-size:14px;font-weight:600;color:${color};margin-bottom:8px">${escapeHtml(title)}</div>
	<div style="font-size:13px;color:#333;white-space:pre-wrap">${escapeHtml(message)}</div>
</div>`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}