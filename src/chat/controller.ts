import type { ChatMessage } from '../llm/provider';
import type { RetrieveOptions, ChatContext } from '../retrieval/types';
import type {
	ChatRole,
	ConversationRecord,
	ConversationStore,
	Citation,
	RetrievalToggles,
} from './store';
import { errorMessage } from '../util/errors';

export interface ControllerMessage {
	id: string;
	role: ChatRole;
	content: string;
	citations: Citation[];
	createdAt: string;
	seq: number;
	status: 'complete' | 'streaming' | 'stopped' | 'error';
	error?: string | null;
}

export interface ConversationSummary {
	id: string;
	title: string | null;
	updatedAt: string;
}

export interface ChatSnapshot {
	conversationId: string;
	title: string | null;
	messages: ControllerMessage[];
	notesOn: boolean;
	retrievalToggles: RetrievalToggles;
	model: string;
	models: string[];
	systemPrompt: string;
	streaming: boolean;
	conversations: ConversationSummary[];
}

export type ChatEvent =
	| { type: 'snapshot'; conversationId: string; snapshot: ChatSnapshot }
	| { type: 'token'; conversationId: string; seq: number; delta: string }
	| { type: 'status'; conversationId: string; status: 'idle' | 'streaming' | 'stopped'; error?: string };

export interface ChatControllerDeps {
	store: ConversationStore;
	provider: {
		chatStream(messages: ChatMessage[], options?: { signal?: AbortSignal }): AsyncIterable<string>;
		listModels(): Promise<string[]>;
	};
	retrieveContext: (query: string, options: RetrieveOptions) => Promise<ChatContext>;
	getChatSettings: () => Promise<{ systemPrompt: string; model: string; historyBudget: number }>;
	isVaultLocked: () => Promise<boolean>;
	onEvent: (event: ChatEvent) => void;
}

interface ChatState {
	id: string;
	title: string | null;
	messages: ControllerMessage[];
	notesOn: boolean;
	retrievalToggles: RetrievalToggles;
	model: string;
	systemPrompt: string;
	streaming: boolean;
}

export class ChatController {
	private state: ChatState | null = null;
	private activeController: AbortController | null = null;
	private emitChain: Promise<void> = Promise.resolve();
	private models: string[] = [];
	private modelsLoaded = false;

	constructor(private readonly deps: ChatControllerDeps) {}

	async init(): Promise<void> {
		await this.ensureModels();
		if (!this.state) {
			const conversations = await this.deps.store.listConversations();
			if (conversations.length > 0) {
				await this.activate(conversations[0]);
			} else {
				await this.createConversation();
			}
		} else {
			// Re-emit so late-loading webviews (which missed the first snapshot)
			// can rehydrate via their `init` message.
			this.emitSnapshot();
		}
	}

	private async ensureModels(): Promise<void> {
		if (this.modelsLoaded) return;
		this.modelsLoaded = true;
		try {
			const list = await this.deps.provider.listModels();
			this.models = Array.isArray(list) ? list.filter((m) => typeof m === 'string' && m.length > 0) : [];
		} catch {
			this.models = [];
		}
	}

	async createConversation(): Promise<void> {
		if (this.activeController) this.activeController.abort();
		const chatSettings = await this.deps.getChatSettings();
		const conversation = await this.deps.store.createConversation({
			model: chatSettings.model,
			systemPrompt: chatSettings.systemPrompt,
		});
		await this.activate(conversation);
	}

	async selectConversation(id: string): Promise<void> {
		const conversation = await this.deps.store.getConversation(id);
		if (!conversation) throw new Error(`Conversation not found: ${id}`);
		if (this.activeController) this.activeController.abort();
		await this.activate(conversation);
	}

	async deleteConversation(id: string): Promise<void> {
		if (this.state?.id === id) {
			if (this.activeController) this.activeController.abort();
			this.state = null;
		}
		await this.deps.store.deleteConversation(id);
		await this.init();
	}

	async setNotesOn(notesOn: boolean): Promise<void> {
		const state = this.requireActive();
		state.notesOn = notesOn;
		await this.deps.store.updateConversation(state.id, { notesOn });
		this.emitSnapshot();
	}

	async setRetrieverToggle(retriever: keyof RetrievalToggles, enabled: boolean): Promise<void> {
		const state = this.requireActive();
		state.retrievalToggles = { ...state.retrievalToggles, [retriever]: enabled };
		await this.deps.store.updateConversation(state.id, { retrievalToggles: state.retrievalToggles });
		this.emitSnapshot();
	}

	async setGraphEnabled(enabled: boolean): Promise<void> {
		const state = this.requireActive();
		state.retrievalToggles = { ...state.retrievalToggles, graphEnabled: enabled };
		await this.deps.store.updateConversation(state.id, { retrievalToggles: state.retrievalToggles });
		this.emitSnapshot();
	}

	async setModel(model: string): Promise<void> {
		const state = this.requireActive();
		state.model = model;
		await this.deps.store.updateConversation(state.id, { model });
		this.emitSnapshot();
	}

	async setSystemPrompt(systemPrompt: string): Promise<void> {
		const state = this.requireActive();
		state.systemPrompt = systemPrompt;
		await this.deps.store.updateConversation(state.id, { systemPrompt });
		this.emitSnapshot();
	}

	async setConversationTitle(title: string): Promise<void> {
		const state = this.requireActive();
		const clean = title.trim();
		state.title = clean.length > 0 ? clean : null;
		await this.deps.store.updateConversation(state.id, { title: state.title });
		this.emitSnapshot();
	}

	async send(rawText: string): Promise<void> {
		const state = this.requireActive();
		if (state.streaming) return;

		const text = rawText.trim();
		if (!text) return;

		if (await this.deps.isVaultLocked()) {
			this.emitStatus('idle', 'The vault is locked. Unlock it before chatting.');
			return;
		}

		const userMessage = await this.deps.store.appendMessage(state.id, { role: 'user', content: text });
		state.messages.push(toControllerMessage(userMessage));

		// Auto-title the conversation from its first user message.
		if (!state.title) {
			state.title = autoTitle(text);
			await this.deps.store.updateConversation(state.id, { title: state.title });
		}

		this.emitSnapshot();

		await this.runStream(text, userMessage.seq, state);
	}

	async regenerate(): Promise<void> {
		const state = this.requireActive();
		if (state.streaming) return;

		const lastUser = lastOfRole(state.messages, 'user');
		if (!lastUser) return;

		if (await this.deps.isVaultLocked()) {
			this.emitStatus('idle', 'The vault is locked. Unlock it before chatting.');
			return;
		}

		// A previously failed send is retried from the same user message.
		if (lastUser.status === 'error') {
			lastUser.status = 'complete';
			lastUser.error = null;
			await this.deps.store.setMessageError(state.id, lastUser.seq, null);
		}

		for (const message of state.messages.filter((m) => m.seq > lastUser.seq)) {
			await this.deps.store.deleteMessage(state.id, message.seq);
		}
		state.messages = state.messages.filter((m) => m.seq <= lastUser.seq);
		this.emitSnapshot();

		await this.runStream(lastUser.content, lastUser.seq, state);
	}

	async stop(): Promise<void> {
		this.activeController?.abort();
	}

	dispose(): void {
		this.activeController?.abort();
		this.activeController = null;
	}

	private async activate(conversation: ConversationRecord): Promise<void> {
		const messages = await this.deps.store.listMessages(conversation.id);
		this.state = {
			id: conversation.id,
			title: conversation.title,
			messages: messages.map((message) => ({
				...message,
				status: message.error ? ('error' as const) : ('complete' as const),
			})),
			notesOn: conversation.notesOn,
			retrievalToggles: conversation.retrievalToggles,
			model: conversation.model,
			systemPrompt: conversation.systemPrompt,
			streaming: false,
		};
		this.emitSnapshot();
	}

	private async runStream(text: string, currentSeq: number, state: ChatState): Promise<void> {
		// 1. Context injection (notes on only).
		let injected: { text: string; citations: Citation[] } | null = null;
		if (state.notesOn) {
			try {
				const retrievers = togglesToRetrievers(state.retrievalToggles);
				const context = await this.deps.retrieveContext(text, { retrievers });
				if (context.chunks.length > 0) {
					injected = renderContextBlock(context);
				}
			} catch (error) {
				// Retrieval failure must not break the chat; proceed without context.
				console.error('[echo] chat context retrieval failed', error);
			}
		}

		// 2. Pending assistant message (streaming).
		const assistantMessage = await this.deps.store.appendMessage(state.id, {
			role: 'assistant',
			content: '',
			citations: injected?.citations ?? [],
		});
		const pending = toControllerMessage(assistantMessage, 'streaming');
		state.messages.push(pending);
		this.emitSnapshot();

		// 3. Provider request.
		const chatSettings = await this.deps.getChatSettings();
		const providerMessages = buildProviderMessages(
			state.systemPrompt,
			state.messages.filter((m) => m.seq < currentSeq),
			text,
			injected?.text ?? null,
			chatSettings.historyBudget,
		);

		// 4. Stream.
		state.streaming = true;
		const controller = new AbortController();
		this.activeController = controller;
		this.emitStatus('streaming');
		let streamError: string | null = null;

		try {
			let content = '';
			for await (const delta of this.deps.provider.chatStream(providerMessages, { signal: controller.signal })) {
				if (controller.signal.aborted) break;
				content += delta;
				pending.content = content;
				this.deps.onEvent({ type: 'token', conversationId: state.id, seq: pending.seq, delta });
			}
			await this.finishMessage(state, pending, controller.signal.aborted ? 'stopped' : 'complete');
		} catch (error) {
			if (controller.signal.aborted) {
				await this.finishMessage(state, pending, 'stopped');
			} else {
				const errorText = `Provider error: ${errorMessage(error)}`;
				if (pending.content.length === 0) {
					// Nothing was generated: drop the empty assistant bubble so the
					// failed send reads as a red-bordered user message instead.
					await this.deps.store.deleteMessage(state.id, pending.seq);
					state.messages = state.messages.filter((m) => m.seq !== pending.seq);
				} else {
					// Keep whatever partial response was produced.
					await this.finishMessage(state, pending, 'complete');
				}
				// Flag the triggering user message as failed so the panel can show
				// the error (red bubble with an X icon + tooltip).
				const lastUser = lastOfRole(state.messages, 'user');
				if (lastUser) {
					lastUser.status = 'error';
					lastUser.error = errorText;
					await this.deps.store.setMessageError(state.id, lastUser.seq, errorText);
				}
				streamError = errorText;
				this.emitSnapshot();
			}
		} finally {
			state.streaming = false;
			if (this.activeController === controller) this.activeController = null;
			this.emitStatus('idle', streamError ?? undefined);
		}
	}

	private async finishMessage(state: ChatState, message: ControllerMessage, status: 'complete' | 'stopped'): Promise<void> {
		message.status = status;
		await this.deps.store.replaceMessage(state.id, message.seq, {
			content: message.content,
			citations: message.citations,
		});
		this.emitSnapshot();
	}

	private requireActive(): ChatState {
		if (!this.state) throw new Error('No active chat conversation');
		return this.state;
	}

	private emitStatus(status: 'idle' | 'streaming', error?: string): void {
		const state = this.requireActive();
		this.deps.onEvent({ type: 'status', conversationId: state.id, status, error });
	}

	private emitSnapshot(): void {
		const state = this.requireActive();
		const snapshot: ChatSnapshot = {
			conversationId: state.id,
			title: state.title,
			messages: state.messages.map((m) => ({ ...m })),
			notesOn: state.notesOn,
			retrievalToggles: state.retrievalToggles,
			model: state.model,
			models: this.models,
			systemPrompt: state.systemPrompt,
			streaming: state.streaming,
			conversations: [],
		};
		// Serialize snapshot emissions so ordering matches the sequence of
		// in-memory changes (e.g. user message before pending assistant).
		this.emitChain = this.emitChain.then(async () => {
			const conversations = await this.deps.store.listConversations();
			snapshot.conversations = conversations.map((conversation) => ({
				id: conversation.id,
				title: conversation.title,
				updatedAt: conversation.updatedAt,
			}));
			this.deps.onEvent({ type: 'snapshot', conversationId: state.id, snapshot });
		});
	}
}

function toControllerMessage(message: {
	id: string;
	role: ChatRole;
	content: string;
	citations: Citation[];
	createdAt: string;
	seq: number;
	error?: string | null;
}, status: ControllerMessage['status'] = 'complete'): ControllerMessage {
	return {
		id: message.id,
		role: message.role,
		content: message.content,
		citations: message.citations,
		createdAt: message.createdAt,
		seq: message.seq,
		status,
		error: message.error ?? null,
	};
}

function lastOfRole(messages: ControllerMessage[], role: ChatRole): ControllerMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === role) return messages[i];
	}
	return null;
}

export function autoTitle(text: string): string {
	const singleLine = text.replace(/\s+/g, ' ').trim();
	return singleLine.length > 60 ? singleLine.slice(0, 60) + '…' : singleLine;
}

export function togglesToRetrievers(toggles: RetrievalToggles): RetrieveOptions['retrievers'] {
	const ids: NonNullable<RetrieveOptions['retrievers']> = [];
	if (toggles.bm25) ids.push('bm25');
	if (toggles.tfidf) ids.push('tfidf');
	if (toggles.fuzzy) ids.push('fuzzy');
	if (toggles.dense) ids.push('dense');
	if (toggles.graph && toggles.graphEnabled) ids.push('graph');
	return ids;
}

export function renderContextBlock(context: ChatContext): { text: string; citations: Citation[] } {
	const blocks: string[] = [];
	const citations: Citation[] = [];

	context.chunks.forEach((chunk, index) => {
		const n = index + 1;
		citations.push({ index: n, noteId: chunk.noteId, title: chunk.title });
		blocks.push(`[${n}] ${chunk.title}\n${chunk.content}`);
	});

	return { text: blocks.join('\n\n'), citations };
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function buildProviderMessages(
	systemPrompt: string,
	history: ControllerMessage[],
	currentText: string,
	injectedContextText: string | null,
	historyBudget: number,
): ChatMessage[] {
	const systemContent = injectedContextText
		? `${systemPrompt}\n\n## Relevant notes\n${injectedContextText}`
		: systemPrompt;

	const baseTokens = estimateTokens(systemContent) + estimateTokens(currentText);
	const trimmed = trimHistory(history, baseTokens, historyBudget);

	const messages: ChatMessage[] = [{ role: 'system', content: systemContent }];
	for (const message of trimmed) {
		messages.push({ role: message.role, content: message.content });
	}
	messages.push({ role: 'user', content: currentText });
	return messages;
}

// Drop the oldest history messages until system prompt + injected context +
// current message + remaining history fit within the budget. Never drops the
// system prompt or the current message (both are outside `history`).
export function trimHistory(history: ControllerMessage[], baseTokens: number, budget: number): ControllerMessage[] {
	let used = baseTokens;
	const kept: ControllerMessage[] = [];

	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i];
		const cost = estimateTokens(message.content) + 2;
		if (used + cost > budget) break;
		kept.unshift(message);
		used += cost;
	}

	return kept;
}