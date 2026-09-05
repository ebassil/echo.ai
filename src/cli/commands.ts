import joplin from 'api';
import { startCliServer, stopCliServer, getCliServerHandle, rotateCliToken, CliServerHandle } from './server';
import { errorMessage } from '../util/errors';

let cliHandle: CliServerHandle | null = null;

/**
 * Start the loopback CLI endpoint. Failure is logged but never crashes the
 * plugin — orchestration commands keep working without the HTTP surface.
 */
export async function startCliEndpoint(dataDir: string): Promise<void> {
	try {
		let port = 0;
		try {
			const { resolveCliPort } = await import('../orchestration/settings');
			port = await resolveCliPort();
		} catch {}
		cliHandle = await startCliServer(dataDir, { port: port || undefined });
	} catch (e) {
		console.warn('[echo] CLI endpoint failed to start (plugin continues without it):', errorMessage(e));
		cliHandle = null;
	}
}

export async function stopCliEndpoint(): Promise<void> {
	try {
		await stopCliServer();
	} catch (e) {
		console.warn('[echo] CLI endpoint failed to stop cleanly', e);
	}
	cliHandle = null;
}

export function getCliEndpointHandle(): CliServerHandle | null {
	return cliHandle ? { ...cliHandle } : null;
}

export async function registerCliCommands(): Promise<void> {
	await joplin.commands.register({
		name: 'echo.cli.showEndpointStatus',
		label: 'Echo: Show CLI endpoint status',
		iconName: 'fas fa-terminal',
		execute: async () => {
			const h = cliHandle;
			if (!h) {
				await joplin.views.dialogs.showMessageBox(
					'echo.ai CLI endpoint is not running.\n\nIt starts with the plugin and binds to 127.0.0.1 only.',
				);
				return;
			}
			let runLine = 'Current run: none';
			try {
				const { getCurrentRun } = await import('../orchestration/runner');
				const current = getCurrentRun();
				if (current) runLine = `Current run: ${current.id} (${current.pipeline}, ${current.trigger})`;
			} catch {}
			await joplin.views.dialogs.showMessageBox(
				[
					'echo.ai CLI endpoint',
					'',
					`Listening: 127.0.0.1:${h.port} (loopback only)`,
					`Token fingerprint: ${h.tokenFingerprint}`,
					runLine,
					'',
					'The raw token is stored in the plugin data directory file "echo-token".',
					'Use "Echo: Copy CLI token" to copy it for the echo CLI (or set ECHO_TOKEN).',
					'',
					'Security: loopback-only, per-install token, no remote access, stops with the plugin.',
				].join('\n'),
			);
		},
	});

		await joplin.commands.register({
		name: 'echo.cli.copyToken',
		label: 'Echo: Copy CLI token',
		iconName: 'fas fa-terminal',
		execute: async () => {
			if (!cliHandle) {
				await joplin.views.dialogs.showMessageBox('echo.ai CLI endpoint is not running; no token is available.');
				return;
			}
			// Copy to clipboard via Electron (plugins run in a BrowserWindow with Node
			// access); the raw token is never shown in a dialog or log.
			let copied = false;
			try {
				const electron = (joplin as any).require('electron');
				electron.clipboard.writeText(cliHandle.token);
				copied = true;
			} catch {
				try {
					// Fallback for environments without joplin.require('electron')
					const e = require('electron');
					e.clipboard.writeText(cliHandle.token);
					copied = true;
				} catch {}
			}
			const dataDir = await joplin.plugins.dataDir();
			await joplin.views.dialogs.showMessageBox(
				copied
					? `echo.ai CLI token copied to clipboard (fingerprint ${cliHandle.tokenFingerprint}).\n\nSet it as ECHO_TOKEN or keep <dataDir>/echo-token for the echo CLI.\nTip: "Echo: Rotate CLI token" if you suspect it leaked.`
					: `Clipboard unavailable. The token is in ${dataDir}/echo-token (fingerprint ${cliHandle.tokenFingerprint}).\nSet it as ECHO_TOKEN for the echo CLI.`,
			);
		},
	});

	await joplin.commands.register({
		name: 'echo.cli.rotateToken',
		label: 'Echo: Rotate CLI token',
		iconName: 'fas fa-terminal',
		execute: async () => {
			try {
				const dataDir = await joplin.plugins.dataDir();
				const rotated = await rotateCliToken(dataDir);
				if (rotated) cliHandle = rotated;
				await joplin.views.dialogs.showMessageBox(
					`echo.ai CLI token rotated.\nNew fingerprint: ${rotated?.tokenFingerprint ?? 'n/a'}\n\nUpdate your ECHO_TOKEN / CLI config; old tokens are rejected immediately.`,
				);
			} catch (e) {
				await joplin.views.dialogs.showMessageBox(`Failed to rotate token: ${errorMessage(e)}`);
			}
		},
	});
}
