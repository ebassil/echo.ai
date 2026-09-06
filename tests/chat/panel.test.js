const assert = require('assert');
const { load } = require('../helpers/load-ts');
const { makeMemoryDb, delay } = require('../helpers/memory-db');

const { ConversationStore } = load('chat/store.ts');
const { ChatController } = load('chat/controller.ts');
const { parseWebviewMessage, executePanelCommand, chatEventToWebviewMessage } = load('chat/protocol.ts');

console.log('Running chat panel protocol smoke test...');

const RETRIEVAL_CONTEXT = {
	chunks: [{ chunkId: 'c1', noteId: 'n1', title: 'Note 1', content: 'Relevant note content', score: 1, contributingRetrievers: [] }],
	totalTokens: 4,
};

function makeHarness(provider) {
	const { db, adapter } = makeMemoryDb();
	const store = new ConversationStore(adapter);
	const received = [];
	const openedCitations = [];
	const providerCalls = [];

	const chatStream = provider ?? (async function* (messages, options) {
		const call = providerCalls.length;
		providerCalls.push({ messages, options });
		yield `token${call}-a`;
		yield `token${call}-b`;
	});

	const controller = new ChatController({
		store,
		provider: {
			chatStream,
			listModels: async () => ['llama3', 'gemma'],
		},
		retrieveContext: async () => RETRIEVAL_CONTEXT,
		getChatSettings: async () => ({ systemPrompt: 'You are echo.', model: 'llama3', historyBudget: 8000 }),
		isVaultLocked: async () => false,
		onEvent: (event) => {
			const message = chatEventToWebviewMessage(event);
			if (message) received.push(message);
		},
	});

	return {
		controller,
		store,
		received,
		providerCalls,
		openedCitations,
		chatStream,
		openCitation: async (noteId) => openedCitations.push(noteId),
	};
}

function messagesOf(received) {
	const snapshots = received.filter((m) => m.type === 'snapshot');
	return snapshots[snapshots.length - 1]?.snapshot.messages ?? [];
}

function tokensOf(received) {
	return received.filter((m) => m.type === 'token').map((m) => m.delta);
}

async function testSendRoundTrip() {
	const harness = makeHarness();
	await executePanelCommand(harness.controller, { action: 'init' }, harness);
	await executePanelCommand(harness.controller, { action: 'send', text: 'hello notes' }, harness);
	await delay();

	const messages = messagesOf(harness.received);
	assert.deepStrictEqual(
		messages.map((m) => m.role),
		['user', 'assistant'],
	);
	assert.strictEqual(messages[0].content, 'hello notes');
	assert.deepStrictEqual(tokensOf(harness.received), ['token0-a', 'token0-b']);
	assert.strictEqual(messages[1].content, 'token0-atoken0-b');
	assert.ok(messages[1].citations.length >= 1, 'assistant message carries citations');

	// State persisted to the store.
	const persistedList = await harness.store.listConversations();
	assert.strictEqual(persistedList.length, 1);
	const stored = await harness.store.listMessages(persistedList[0].id);
	assert.deepStrictEqual(
		stored.map((m) => m.content),
		['hello notes', 'token0-atoken0-b'],
	);
	console.log('✓ send → tokens delivered → messages round-trip and persist');
}

async function testStopCommand() {
	const harness = makeHarness(async function* (messages, options) {
		yield 'partial';
		await delay(30);
		if (options?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
		yield ' rest';
	});
	await executePanelCommand(harness.controller, { action: 'init' }, harness);

	const sendPromise = executePanelCommand(harness.controller, { action: 'send', text: 'long' }, harness);
	await delay(15);
	await executePanelCommand(harness.controller, { action: 'stop' }, harness);
	await sendPromise;
	await delay();

	const messages = messagesOf(harness.received);
	const last = messages[messages.length - 1];
	assert.strictEqual(last.content, 'partial');
	assert.strictEqual(last.status, 'stopped');
	console.log('✓ stop aborts in-flight generation and leaves a partial message');
}

async function testRegenerateCommand() {
	const harness = makeHarness();
	await executePanelCommand(harness.controller, { action: 'init' }, harness);
	await executePanelCommand(harness.controller, { action: 'send', text: 'first question' }, harness);
	await delay();

	await executePanelCommand(harness.controller, { action: 'regenerate' }, harness);
	await delay();

	const messages = messagesOf(harness.received);
	assert.deepStrictEqual(
		messages.map((m) => m.role),
		['user', 'assistant'],
	);
	assert.strictEqual(messages[1].content, 'token1-atoken1-b');
	assert.strictEqual(harness.providerCalls.length, 2, 'regenerate re-ran the provider');
	console.log('✓ regenerate replaces the previous assistant response');
}

async function testStatePersistsAcrossRestart() {
	const harness = makeHarness();
	await executePanelCommand(harness.controller, { action: 'init' }, harness);
	await executePanelCommand(harness.controller, { action: 'send', text: 'persist me' }, harness);
	await executePanelCommand(harness.controller, { action: 'toggles', notesOn: false, graphEnabled: false }, harness);
	await delay();

	// Simulate a plugin restart: new controller over the same store.
	const restartedReceived = [];
	const restarted = new ChatController({
		store: harness.store,
		provider: {
			chatStream: harness.chatStream,
			listModels: async () => ['llama3', 'gemma'],
		},
		retrieveContext: async () => RETRIEVAL_CONTEXT,
		getChatSettings: async () => ({ systemPrompt: 'You are echo.', model: 'llama3', historyBudget: 8000 }),
		isVaultLocked: async () => false,
		onEvent: (event) => {
			const message = chatEventToWebviewMessage(event);
			if (message) restartedReceived.push(message);
		},
	});
	await restarted.init();
	await delay();

	const snapshot = restartedReceived.filter((m) => m.type === 'snapshot').pop()?.snapshot;
	assert.ok(snapshot, 'restart emits a snapshot');
	assert.strictEqual(snapshot.notesOn, false, 'notes on/off restored');
	assert.strictEqual(snapshot.retrievalToggles.graphEnabled, false, 'toggles restored');
	assert.deepStrictEqual(
		snapshot.messages.map((m) => m.content),
		['persist me', 'token0-atoken0-b'],
	);
	console.log('✓ conversations restored with messages, notes state, and toggles');
}

async function testCitationCommand() {
	const harness = makeHarness();
	await executePanelCommand(harness.controller, { action: 'openCitation', noteId: 'note-123' }, harness);
	assert.deepStrictEqual(harness.openedCitations, ['note-123']);
	console.log('✓ openCitation command routes the noteId to the opener');
}

async function testRenameConversationCommand() {
	const harness = makeHarness();
	await executePanelCommand(harness.controller, { action: 'init' }, harness);
	await executePanelCommand(harness.controller, { action: 'send', text: 'first question' }, harness);
	await delay();

	await executePanelCommand(harness.controller, { action: 'renameConversation', title: 'Renamed chat' }, harness);
	await delay();

	const snapshot = messagesOf(harness.received) && harness.received.filter((m) => m.type === 'snapshot').pop()?.snapshot;
	assert.strictEqual(snapshot.title, 'Renamed chat');
	const stored = await harness.store.getConversation(snapshot.conversationId);
	assert.strictEqual(stored.title, 'Renamed chat');
	console.log('✓ renameConversation command renames and persists the conversation');
}

async function testParseWebviewMessages() {
	assert.deepStrictEqual(parseWebviewMessage({ type: 'send', text: 'hi' }), { action: 'send', text: 'hi' });
	assert.deepStrictEqual(parseWebviewMessage({ message: { type: 'init' } }), { action: 'init' });
	assert.deepStrictEqual(
		parseWebviewMessage({ type: 'toggles', notesOn: true, toggles: { graph: false }, graphEnabled: false }),
		{ action: 'toggles', notesOn: true, toggles: { graph: false }, graphEnabled: false },
	);
	assert.deepStrictEqual(parseWebviewMessage({ type: 'renameConversation', title: 'My title' }), {
		action: 'renameConversation',
		title: 'My title',
	});
	assert.strictEqual(parseWebviewMessage({ type: 'bogus' }), null);
	console.log('✓ webview messages parse into controller commands');
}

(async () => {
	await testSendRoundTrip();
	await testStopCommand();
	await testRegenerateCommand();
	await testStatePersistsAcrossRestart();
	await testCitationCommand();
	await testRenameConversationCommand();
	await testParseWebviewMessages();
	console.log('All chat panel protocol smoke tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});