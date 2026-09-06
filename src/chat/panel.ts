import joplin from 'api';
import type { LLMProvider } from '../llm/provider';
import { ChatController } from './controller';
import { ConversationStore } from './store';
import { createRetrieveContext } from './retrieval';
import { resolveChatSettings } from './settings';
import { run, all, getDatabase } from '../storage/db';
import { isVaultLocked } from '../indexing/vault';
import { parseWebviewMessage, executePanelCommand, chatEventToWebviewMessage } from './protocol';
import { errorMessage } from '../util/errors';
import { PANEL_HTML } from './ui/panelHtml';

const PANEL_ID = 'echo.chat';

export interface ChatPanel {
	show(): Promise<void>;
	dispose(): void;
}

export async function createChatPanel(options: { getProvider: () => LLMProvider }): Promise<ChatPanel> {
	const handle = await joplin.views.panels.create(PANEL_ID);

	// Joplin drops postMessage calls sent to the webview before the webview has
	// loaded and registered its own onMessage handler ("no viewMessageHandler").
	// Buffer outgoing messages and flush them once the webview signals readiness
	// by posting its first message (the `init` handshake).
	let webviewReady = false;
	const pendingMessages: any[] = [];

	const sendToWebview = (message: any): void => {
		if (webviewReady) {
			joplin.views.panels.postMessage(handle, message);
		} else {
			pendingMessages.push(message);
			// Guard against unbounded growth if the webview never loads.
			if (pendingMessages.length > 200) pendingMessages.shift();
		}
	};

	const store = new ConversationStore({
		run: (sql, params) => run(getDatabase(), sql, params ?? []),
		all: (sql, params) => all(getDatabase(), sql, params ?? []),
	});

	const controller = new ChatController({
		store,
		provider: {
			chatStream: (messages, chatOptions) => options.getProvider().chatStream(messages, chatOptions),
			listModels: () => options.getProvider().listModels(),
		},
		retrieveContext: createRetrieveContext(),
		getChatSettings: resolveChatSettings,
		isVaultLocked,
		onEvent: (event) => {
			const message = chatEventToWebviewMessage(event);
			if (message) sendToWebview(message);
		},
	});

	const openCitation = async (noteId: string): Promise<void> => {
		if (!noteId) return;
		await (joplin.commands as any).execute('openItem', { id: noteId, type: 1 });
	};

	// Register the message handler BEFORE loading the webview: Joplin drops
	// postMessage calls sent before the webview has registered its own handler,
	// so the webview's `init` message (posted on load) must always be caught.
	await joplin.views.panels.onMessage(handle, async (message: any) => {
		// Any message from the webview proves it has loaded and registered its
		// handler — flush everything buffered so far.
		if (!webviewReady) {
			webviewReady = true;
			for (const buffered of pendingMessages) {
				joplin.views.panels.postMessage(handle, buffered);
			}
			pendingMessages.length = 0;
		}

		const command = parseWebviewMessage(message);
		if (!command) return;
		try {
			await executePanelCommand(controller, command, { openCitation });
		} catch (error) {
			console.error('[echo] chat panel command failed', error);
			// Never fail silently: echo the failure back so the panel can show it.
			try {
				sendToWebview({
					type: 'status',
					conversationId: null,
					status: 'idle',
					error: `Chat command failed: ${errorMessage(error)}`,
				});
			} catch {}
		}
	});

	await joplin.views.panels.setHtml(handle, PANEL_HTML);

	// Eager fallback: the webview's `init` message re-emits a snapshot anyway,
	// but this guarantees a conversation exists even before the webview loads.
	await controller.init();

	await joplin.views.panels.show(handle);

	return {
		show: () => joplin.views.panels.show(handle),
		dispose: () => controller.dispose(),
	};
}