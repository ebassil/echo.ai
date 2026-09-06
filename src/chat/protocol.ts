import type { ChatController, ChatEvent } from './controller';
import type { RetrievalToggles } from './store';

// Pure mapping between webview JSON messages and controller actions, so the
// panel logic can be driven in tests without the Joplin API.

export type RetrieverKey = 'bm25' | 'tfidf' | 'fuzzy' | 'dense' | 'graph';

export type PanelCommand =
	| { action: 'init' }
	| { action: 'send'; text: string }
	| { action: 'stop' }
	| { action: 'regenerate' }
	| { action: 'toggles'; notesOn?: boolean; toggles?: Partial<Record<RetrieverKey, boolean>>; graphEnabled?: boolean }
	| { action: 'model'; model: string }
	| { action: 'systemPrompt'; prompt: string }
	| { action: 'renameConversation'; title: string }
	| { action: 'selectConversation'; conversationId: string }
	| { action: 'newConversation' }
	| { action: 'deleteConversation'; conversationId: string }
	| { action: 'openCitation'; noteId: string };

const RETRIEVER_KEYS: RetrieverKey[] = ['bm25', 'tfidf', 'fuzzy', 'dense', 'graph'];

export function parseWebviewMessage(message: any): PanelCommand | null {
	const payload = message?.message ?? message;
	if (!payload || typeof payload !== 'object') return null;

	switch (payload.type) {
		case 'init':
			return { action: 'init' };
		case 'send':
			return { action: 'send', text: typeof payload.text === 'string' ? payload.text : '' };
		case 'stop':
			return { action: 'stop' };
		case 'regenerate':
			return { action: 'regenerate' };
		case 'toggles': {
			const command: PanelCommand = { action: 'toggles' };
			if (typeof payload.notesOn === 'boolean') command.notesOn = payload.notesOn;
			if (payload.toggles && typeof payload.toggles === 'object') {
				const toggles: Partial<Record<RetrieverKey, boolean>> = {};
				for (const key of RETRIEVER_KEYS) {
					if (typeof payload.toggles[key] === 'boolean') toggles[key] = payload.toggles[key];
				}
				command.toggles = toggles;
			}
			if (typeof payload.graphEnabled === 'boolean') command.graphEnabled = payload.graphEnabled;
			return command;
		}
		case 'model':
			return { action: 'model', model: typeof payload.model === 'string' ? payload.model : '' };
		case 'systemPrompt':
			return { action: 'systemPrompt', prompt: typeof payload.prompt === 'string' ? payload.prompt : '' };
		case 'renameConversation':
			return { action: 'renameConversation', title: typeof payload.title === 'string' ? payload.title : '' };
		case 'selectConversation':
			return { action: 'selectConversation', conversationId: payload.conversationId };
		case 'newConversation':
			return { action: 'newConversation' };
		case 'deleteConversation':
			return { action: 'deleteConversation', conversationId: payload.conversationId };
		case 'openCitation':
			return { action: 'openCitation', noteId: typeof payload.noteId === 'string' ? payload.noteId : '' };
		default:
			return null;
	}
}

export interface PanelCommandDeps {
	openCitation(noteId: string): Promise<void>;
}

export async function executePanelCommand(
	controller: ChatController,
	command: PanelCommand,
	deps: PanelCommandDeps,
): Promise<void> {
	switch (command.action) {
		case 'init':
			await controller.init();
			break;
		case 'send':
			await controller.send(command.text);
			break;
		case 'stop':
			await controller.stop();
			break;
		case 'regenerate':
			await controller.regenerate();
			break;
		case 'toggles':
			if (command.notesOn !== undefined) await controller.setNotesOn(command.notesOn);
			if (command.toggles) {
				for (const [key, value] of Object.entries(command.toggles)) {
					await controller.setRetrieverToggle(key as keyof RetrievalToggles, value);
				}
			}
			if (command.graphEnabled !== undefined) await controller.setGraphEnabled(command.graphEnabled);
			break;
		case 'model':
			await controller.setModel(command.model);
			break;
		case 'systemPrompt':
			await controller.setSystemPrompt(command.prompt);
			break;
		case 'renameConversation':
			await controller.setConversationTitle(command.title);
			break;
		case 'selectConversation':
			await controller.selectConversation(command.conversationId);
			break;
		case 'newConversation':
			await controller.createConversation();
			break;
		case 'deleteConversation':
			await controller.deleteConversation(command.conversationId);
			break;
		case 'openCitation':
			await deps.openCitation(command.noteId);
			break;
	}
}

export function chatEventToWebviewMessage(event: ChatEvent): Record<string, any> | null {
	switch (event.type) {
		case 'snapshot':
			return { type: 'snapshot', conversationId: event.conversationId, snapshot: event.snapshot };
		case 'token':
			return { type: 'token', conversationId: event.conversationId, seq: event.seq, delta: event.delta };
		case 'status':
			return { type: 'status', conversationId: event.conversationId, status: event.status, error: event.error };
	}
}