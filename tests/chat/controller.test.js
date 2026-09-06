const assert = require('assert');
const { load } = require('../helpers/load-ts');
const { makeMemoryDb, delay } = require('../helpers/memory-db');

const { ConversationStore } = load('chat/store.ts');
const { ChatController, buildProviderMessages, trimHistory } = load('chat/controller.ts');

console.log('Running chat controller unit tests...');

const RETRIEVAL_CONTEXT = {
	chunks: [
		{ chunkId: 'c1', noteId: 'n1', title: 'Note 1', content: 'Relevant note content', score: 1, contributingRetrievers: [] },
		{ chunkId: 'c2', noteId: 'n2', title: 'Note 2', content: 'More note content', score: 0.8, contributingRetrievers: [] },
	],
	totalTokens: 8,
};

function setup(overrides = {}) {
	const { db, adapter } = makeMemoryDb();
	const store = new ConversationStore(adapter);
	const provider = { calls: [] };
	const retrieveCalls = [];
	const events = [];
	let vaultLocked = overrides.vaultLocked ?? false;

	const chatStream = overrides.provider ?? (async function* (messages, options) {
		const call = provider.calls.length;
		provider.calls.push({ messages, options });
		yield `a${call}`;
		yield `b${call}`;
	});

	const controller = new ChatController({
		store,
		provider: {
			chatStream,
			listModels: overrides.listModels ?? (async () => ['llama3', 'gemma']),
		},
		retrieveContext:
			overrides.retrieveContext ??
			(async (query, options) => {
				retrieveCalls.push({ query, options });
				if (overrides.emptyRetrieval) return { chunks: [], totalTokens: 0 };
				return RETRIEVAL_CONTEXT;
			}),
		getChatSettings:
			overrides.getChatSettings ?? (async () => ({ systemPrompt: 'You are echo.', model: 'llama3', historyBudget: 8000 })),
		isVaultLocked: async () => vaultLocked,
		onEvent: (event) => events.push(event),
	});

	return {
		controller,
		store,
		provider,
		retrieveCalls,
		events,
		db,
		setVaultLocked: (value) => (vaultLocked = value),
	};
}

async function lastSnapshot(events) {
	await delay();
	const snapshots = events.filter((e) => e.type === 'snapshot');
	return snapshots[snapshots.length - 1]?.snapshot;
}

async function testNotesOnInjectsContext() {
	const { controller, provider, retrieveCalls, events } = setup();
	await controller.init();
	await controller.send('What is in my notes?');

	const last = provider.calls[provider.calls.length - 1];
	assert.strictEqual(retrieveCalls.length, 1);
	assert.strictEqual(last.messages[0].role, 'system');
	assert.ok(last.messages[0].content.includes('## Relevant notes'), 'system prompt includes injected context');
	assert.ok(last.messages[0].content.includes('[1] Note 1'));
	assert.ok(last.messages[0].content.includes('Relevant note content'));

	const snapshot = await lastSnapshot(events);
	const assistant = snapshot.messages[snapshot.messages.length - 1];
	assert.deepStrictEqual(assistant.citations, [
		{ index: 1, noteId: 'n1', title: 'Note 1' },
		{ index: 2, noteId: 'n2', title: 'Note 2' },
	]);
	assert.strictEqual(assistant.content, 'a0b0');
	console.log('✓ Notes on: context injected with [n] citation markers');
}

async function testNotesOffSkipsRetrieval() {
	const { controller, provider, retrieveCalls } = setup();
	await controller.init();
	await controller.setNotesOn(false);
	await controller.send('Hello');

	assert.strictEqual(retrieveCalls.length, 0);
	const last = provider.calls[provider.calls.length - 1];
	assert.strictEqual(last.messages.length, 2);
	assert.strictEqual(last.messages[0].content, 'You are echo.');
	assert.strictEqual(last.messages[1].content, 'Hello');
	console.log('✓ Notes off: no retrieval, plain system + history request');
}

async function testEmptyRetrievalProceedsWithoutContext() {
	const { controller, provider, events } = setup({ emptyRetrieval: true });
	await controller.init();
	await controller.send('Anything?');

	const last = provider.calls[provider.calls.length - 1];
	assert.ok(!last.messages[0].content.includes('## Relevant notes'));
	const snapshot = await lastSnapshot(events);
	assert.strictEqual(snapshot.messages[snapshot.messages.length - 1].citations.length, 0);
	console.log('✓ Empty retrieval result proceeds with no injected context');
}

async function testTogglesAppliedToRetrievers() {
	const { controller, retrieveCalls } = setup();
	await controller.init();
	await controller.setRetrieverToggle('dense', false);
	await controller.setRetrieverToggle('graph', false);
	await controller.send('Graph off via per-retriever toggle');

	let opts = retrieveCalls[retrieveCalls.length - 1].options;
	assert.ok(!opts.retrievers.includes('dense'));
	assert.ok(!opts.retrievers.includes('graph'));
	assert.ok(opts.retrievers.includes('bm25'));

	await controller.setRetrieverToggle('graph', true);
	await controller.setGraphEnabled(false);
	await controller.send('Graph off via master switch');

	opts = retrieveCalls[retrieveCalls.length - 1].options;
	assert.ok(!opts.retrievers.includes('graph'), 'master graph switch forces graph off');
	console.log('✓ Retrieval toggles and master graph switch map to RetrieveOptions.retrievers');
}

async function testStopLeavesPartialMessage() {
	const { controller, events } = setup({
		provider: async function* (messages, options) {
			yield 'partial';
			await delay(30);
			if (options?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
			yield ' rest';
		},
	});
	await controller.init();

	const sendPromise = controller.send('long question');
	await delay(15);
	await controller.stop();
	await sendPromise;

	const snapshot = await lastSnapshot(events);
	const assistant = snapshot.messages[snapshot.messages.length - 1];
	assert.strictEqual(assistant.content, 'partial');
	assert.strictEqual(assistant.status, 'stopped');
	console.log('✓ Stop leaves the partial assistant message complete');
}

async function testRegenerateReplacesResponse() {
	const { controller, provider, events } = setup();
	await controller.init();
	await controller.send('question one');
	await controller.send('question two');
	await delay();

	await controller.regenerate();

	const snapshot = await lastSnapshot(events);
	const roles = snapshot.messages.map((m) => m.role);
	assert.deepStrictEqual(roles, ['user', 'assistant', 'user', 'assistant']);
	assert.strictEqual(snapshot.messages[snapshot.messages.length - 1].content, 'a2b2');
	assert.strictEqual(provider.calls.length, 3); // 2 sends + regenerated
	console.log('✓ Regenerate re-runs the last user message and replaces the response');
}

async function testProviderErrorSurfacesWithoutCrash() {
	const { controller, events } = setup({
		provider: async function* () {
			throw new Error('connection refused');
		},
	});
	await controller.init();
	await controller.send('hello');

	const statuses = events.filter((e) => e.type === 'status');
	const idleWithError = statuses.find((s) => s.status === 'idle' && s.error);
	assert.ok(idleWithError, 'an idle status with provider error is emitted');
	assert.ok(idleWithError.error.includes('connection refused'));

	const snapshot = await lastSnapshot(events);
	assert.strictEqual(snapshot.messages.length, 1, 'empty assistant bubble is dropped on failure');
	const user = snapshot.messages[0];
	assert.strictEqual(user.role, 'user');
	assert.strictEqual(user.status, 'error', 'the triggering user message is flagged as failed');
	assert.ok(user.error.includes('connection refused'), 'the failure message rides on the user bubble');
	console.log('✓ Provider error flags the user message as failed (red bubble) without crashing');
}

async function testPartialResponseKeptOnError() {
	const { controller, events } = setup({
		provider: async function* () {
			yield 'partial answer';
			throw new Error('timeout');
		},
	});
	await controller.init();
	await controller.send('hello');

	const snapshot = await lastSnapshot(events);
	assert.strictEqual(snapshot.messages.length, 2);
	assert.strictEqual(snapshot.messages[1].role, 'assistant');
	assert.strictEqual(snapshot.messages[1].content, 'partial answer', 'partial stream content is preserved');
	assert.strictEqual(snapshot.messages[0].status, 'error');
	assert.ok(snapshot.messages[0].error.includes('timeout'));
	console.log('✓ Partial responses are kept and the send is still flagged as failed');
}

async function testErrorPersistsAcrossReload() {
	const { db, adapter } = makeMemoryDb();
	const store = new ConversationStore(adapter);
	const events = [];

	const failing = new ChatController({
		store,
		provider: {
			chatStream: async function* () {
				throw new Error('agent not defined');
			},
			listModels: async () => ['llama3'],
		},
		retrieveContext: async () => RETRIEVAL_CONTEXT,
		getChatSettings: async () => ({ systemPrompt: 'You are echo.', model: 'llama3', historyBudget: 8000 }),
		isVaultLocked: async () => false,
		onEvent: () => {},
	});
	await failing.init();
	await failing.send('hello');
	await delay();

	const working = new ChatController({
		store,
		provider: {
			chatStream: async function* () {
				yield 'ok';
			},
			listModels: async () => ['llama3'],
		},
		retrieveContext: async () => RETRIEVAL_CONTEXT,
		getChatSettings: async () => ({ systemPrompt: 'You are echo.', model: 'llama3', historyBudget: 8000 }),
		isVaultLocked: async () => false,
		onEvent: (event) => events.push(event),
	});
	await working.init();
	await delay();

	const snapshot = await lastSnapshot(events);
	assert.strictEqual(snapshot.messages[0].status, 'error', 'failed message reloads as an error bubble');
	assert.strictEqual(snapshot.messages[0].error, 'Provider error: agent not defined');
	console.log('✓ Failed sends reload as red error bubbles');
}

async function testRegenerateClearsError() {
	let invocations = 0;
	const { controller, events } = setup({
		provider: async function* () {
			invocations++;
			if (invocations === 1) throw new Error('agent not defined');
			yield 'recovered';
		},
	});
	await controller.init();
	await controller.send('hello');
	await delay();
	assert.strictEqual((await lastSnapshot(events)).messages[0].status, 'error');

	await controller.regenerate();
	await delay();

	const snapshot = await lastSnapshot(events);
	assert.strictEqual(snapshot.messages[0].status, 'complete');
	assert.strictEqual(snapshot.messages[0].error, null);
	assert.strictEqual(snapshot.messages[snapshot.messages.length - 1].content, 'recovered');
	console.log('✓ Regenerate clears the error flag and retries the failed send');
}

async function testVaultLockBlocksSend() {
	const { controller, provider, events, setVaultLocked } = setup();
	await controller.init();
	setVaultLocked(true);
	await controller.send('secret question');

	assert.strictEqual(provider.calls.length, 0);
	const status = events.find((e) => e.type === 'status' && e.error);
	assert.ok(status && status.error.includes('vault is locked'), 'user-visible locked message pushed');

	setVaultLocked(false);
	await controller.send('now works');
	assert.strictEqual(provider.calls.length, 1);
	console.log('✓ Vault lock blocks send; unlock resumes normally');
}

async function testEmptyMessageRejected() {
	const { controller, provider } = setup();
	await controller.init();
	await controller.send('   ');
	assert.strictEqual(provider.calls.length, 0);
	console.log('✓ Blank message is rejected without a provider request');
}

async function testAutoTitleAndRename() {
	const { controller, store, events } = setup();
	await controller.init();
	await controller.send('What is the capital of France?');
	await delay();

	let snapshot = await lastSnapshot(events);
	assert.strictEqual(snapshot.title, 'What is the capital of France?', 'conversation auto-titled from first message');
	assert.ok(snapshot.conversations[0].title === 'What is the capital of France?');

	await controller.setConversationTitle('Paris facts');
	snapshot = await lastSnapshot(events);
	assert.strictEqual(snapshot.title, 'Paris facts');

	const stored = await store.getConversation(snapshot.conversationId);
	assert.strictEqual(stored.title, 'Paris facts', 'rename persists');
	console.log('✓ Conversations auto-title from the first message and can be renamed');
}

async function testInitReEmitsSnapshot() {
	const { controller, events } = setup();
	await controller.init();
	await delay();
	const before = events.filter((e) => e.type === 'snapshot').length;

	await controller.init();
	await delay();
	const after = events.filter((e) => e.type === 'snapshot').length;
	assert.ok(after > before, 'repeated init re-emits a snapshot for late-loading webviews');
	console.log('✓ init re-emits a snapshot so late-loading webviews rehydrate');
}

async function testModelsInSnapshot() {
	const { controller, events } = setup();
	await controller.init();
	await delay();

	const snapshot = await lastSnapshot(events);
	assert.deepStrictEqual(snapshot.models, ['llama3', 'gemma'], 'provider model list included in snapshot');

	const single = setup({ listModels: async () => ['llama3'] });
	await single.controller.init();
	await delay();
	const singleSnapshot = await lastSnapshot(single.events);
	assert.deepStrictEqual(singleSnapshot.models, ['llama3']);
	console.log('✓ model list flows into snapshots (dropdown shows only when >1 model)');
}

function testTrimHistory() {
	const messages = [
		{ seq: 1, role: 'user', content: 'old message with quite a lot of content to count', status: 'complete', id: '1', citations: [], createdAt: '' },
		{ seq: 2, role: 'assistant', content: 'an old answer with some content too', status: 'complete', id: '2', citations: [], createdAt: '' },
		{ seq: 3, role: 'user', content: 'newest question here', status: 'complete', id: '3', citations: [], createdAt: '' },
	];
	const trimmed = trimHistory(messages, 2, 20);
	assert.ok(trimmed.length < messages.length, 'oldest messages dropped to fit budget');
	assert.strictEqual(trimmed[trimmed.length - 1].seq, 3, 'keeps the most recent history');
	console.log('✓ trimHistory drops oldest messages, keeps recent ones');
}

function testBuildProviderMessages() {
	const systemPrompt = 'You are echo.';
	const history = [
		{ seq: 1, role: 'user', content: 'first', status: 'complete', id: '1', citations: [], createdAt: '' },
		{ seq: 2, role: 'assistant', content: 'answer one', status: 'complete', id: '2', citations: [], createdAt: '' },
	];
	const messages = buildProviderMessages(systemPrompt, history, 'current', null, 1000);
	assert.deepStrictEqual(
		messages.map((m) => m.role),
		['system', 'user', 'assistant', 'user'],
	);
	assert.strictEqual(messages[0].content, 'You are echo.');
	assert.strictEqual(messages[messages.length - 1].content, 'current');

	const withContext = buildProviderMessages(systemPrompt, history, 'current', '[1] Note', 1000);
	assert.ok(withContext[0].content.includes('## Relevant notes'));
	console.log('✓ buildProviderMessages orders system/history/current and injects context');
}

(async () => {
	await testNotesOnInjectsContext();
	await testNotesOffSkipsRetrieval();
	await testEmptyRetrievalProceedsWithoutContext();
	await testTogglesAppliedToRetrievers();
	await testStopLeavesPartialMessage();
	await testRegenerateReplacesResponse();
	await testProviderErrorSurfacesWithoutCrash();
	await testPartialResponseKeptOnError();
	await testErrorPersistsAcrossReload();
	await testRegenerateClearsError();
	await testVaultLockBlocksSend();
	await testEmptyMessageRejected();
	await testAutoTitleAndRename();
	await testInitReEmitsSnapshot();
	await testModelsInSnapshot();
	testTrimHistory();
	testBuildProviderMessages();
	console.log('All chat controller tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});