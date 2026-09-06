const assert = require('assert');
const { load } = require('../helpers/load-ts');
const { makeMemoryDb } = require('../helpers/memory-db');

const { ConversationStore, DEFAULT_RETRIEVAL_TOGGLES } = load('chat/store.ts');

console.log('Running conversation repository unit tests...');

function makeStore() {
	const { db, adapter } = makeMemoryDb();
	return { store: new ConversationStore(adapter), db };
}

async function testCreateAndList() {
	const { store } = makeStore();
	const conv = await store.createConversation({ model: 'llama3', systemPrompt: 'be helpful' });
	assert.ok(conv.id);
	assert.strictEqual(conv.model, 'llama3');
	assert.strictEqual(conv.systemPrompt, 'be helpful');
	assert.strictEqual(conv.notesOn, true);

	const list = await store.listConversations();
	assert.strictEqual(list.length, 1);
	assert.strictEqual(list[0].id, conv.id);
	console.log('✓ Create + list conversation');
}

async function testRoundTrip() {
	const { store } = makeStore();
	const conv = await store.createConversation({ model: 'llama3', systemPrompt: 'sys' });

	const m1 = await store.appendMessage(conv.id, { role: 'user', content: 'hello' });
	const m2 = await store.appendMessage(conv.id, {
		role: 'assistant',
		content: 'hi there',
		citations: [{ index: 1, noteId: 'n1', title: 'Note 1' }],
	});
	const m3 = await store.appendMessage(conv.id, { role: 'user', content: 'again' });

	assert.deepStrictEqual(m1.citations, []);
	assert.deepStrictEqual(m2.citations, [{ index: 1, noteId: 'n1', title: 'Note 1' }]);
	assert.strictEqual(m3.seq, m2.seq + 1);

	const rehydrated = await store.listMessages(conv.id);
	assert.deepStrictEqual(
		rehydrated.map((m) => m.role),
		['user', 'assistant', 'user'],
	);
	assert.deepStrictEqual(rehydrated.map((m) => m.content), ['hello', 'hi there', 'again']);
	assert.deepStrictEqual(rehydrated.map((m) => m.seq), [1, 2, 3]);
	assert.deepStrictEqual(rehydrated[1].citations, [{ index: 1, noteId: 'n1', title: 'Note 1' }]);
	console.log('✓ Create + append + rehydrate round-trip (ordered by seq)');
}

async function testCascadeDelete() {
	const { store, db } = makeStore();
	const conv = await store.createConversation({ model: 'llama3', systemPrompt: 'sys' });
	await store.appendMessage(conv.id, { role: 'user', content: 'hello' });

	await store.deleteConversation(conv.id);

	const convs = db.prepare('SELECT COUNT(*) AS c FROM conversations').get();
	const msgs = db.prepare('SELECT COUNT(*) AS c FROM conversation_messages').get();
	assert.strictEqual(convs.c, 0);
	assert.strictEqual(msgs.c, 0);
	console.log('✓ Deleting a conversation cascades to its messages');
}

async function testTogglePersistence() {
	const { store } = makeStore();
	const conv = await store.createConversation({ model: 'llama3', systemPrompt: 'sys' });

	const toggles = { ...DEFAULT_RETRIEVAL_TOGGLES, graph: false, graphEnabled: false, dense: false };
	await store.updateConversation(conv.id, { notesOn: false, retrievalToggles: toggles, systemPrompt: 'new prompt', model: 'gemma' });

	const updated = await store.getConversation(conv.id);
	assert.strictEqual(updated.notesOn, false);
	assert.strictEqual(updated.systemPrompt, 'new prompt');
	assert.strictEqual(updated.model, 'gemma');
	assert.deepStrictEqual(updated.retrievalToggles, toggles);
	console.log('✓ Notes on/off, toggles, system prompt, model persist per conversation');
}

async function testEmptyConversation() {
	const { store } = makeStore();
	const conv = await store.createConversation({ model: 'llama3', systemPrompt: 'sys' });
	const messages = await store.listMessages(conv.id);
	assert.deepStrictEqual(messages, []);
	console.log('✓ Empty conversation returns no messages');
}

async function testReplaceMessage() {
	const { store } = makeStore();
	const conv = await store.createConversation({ model: 'llama3', systemPrompt: 'sys' });
	await store.appendMessage(conv.id, { role: 'user', content: 'q' });
	const first = await store.appendMessage(conv.id, { role: 'assistant', content: 'old', citations: [{ index: 1, noteId: 'n1', title: 'T' }] });

	await store.replaceMessage(conv.id, first.seq, { content: 'new', citations: [{ index: 2, noteId: 'n2', title: 'T2' }] });

	const messages = await store.listMessages(conv.id);
	assert.strictEqual(messages[1].content, 'new');
	assert.deepStrictEqual(messages[1].citations, [{ index: 2, noteId: 'n2', title: 'T2' }]);
	console.log('✓ Assistant message replaced (regenerate)');
}

async function testSetMessageError() {
	const { store } = makeStore();
	const conv = await store.createConversation({ model: 'llama3', systemPrompt: 'sys' });
	const message = await store.appendMessage(conv.id, { role: 'user', content: 'hello' });
	assert.strictEqual(message.error, null);

	await store.setMessageError(conv.id, message.seq, 'Provider error: connection refused');
	const [failed] = await store.listMessages(conv.id);
	assert.strictEqual(failed.error, 'Provider error: connection refused');

	await store.setMessageError(conv.id, message.seq, null);
	const [cleared] = await store.listMessages(conv.id);
	assert.strictEqual(cleared.error, null);
	console.log('✓ setMessageError persists and clears a message delivery error');
}

(async () => {
	await testCreateAndList();
	await testRoundTrip();
	await testCascadeDelete();
	await testTogglePersistence();
	await testEmptyConversation();
	await testReplaceMessage();
	await testSetMessageError();
	console.log('All conversation repository tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});