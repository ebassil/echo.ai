const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { load } = require('../helpers/load-ts');
const { makeMemoryDb, delay } = require('../helpers/memory-db');

const { ConversationStore } = load('chat/store.ts');
const { ChatController } = load('chat/controller.ts');
const { OllamaProvider } = load('llm/providers/ollama.ts');

console.log('Running chat privacy posture tests...');

const originalFetch = global.fetch;

const RETRIEVAL_CONTEXT = {
	chunks: [
		{ chunkId: 'c1', noteId: 'n1', title: 'Note 1', content: 'Secret note content', score: 1, contributingRetrievers: [] },
	],
	totalTokens: 4,
};

async function testNoNetworkBeyondProvider() {
	const fetchCalls = [];
	global.fetch = async (url) => {
		fetchCalls.push(url);
		if (url.includes('/v1/models')) {
			return new Response(JSON.stringify({ data: [{ id: 'llama3' }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		const encoder = new TextEncoder();
		const body = 'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n';
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(body));
					controller.close();
				},
			}),
			{ status: 200, headers: { 'content-type': 'text/event-stream' } },
		);
	};

	const { db, adapter } = makeMemoryDb();
	const store = new ConversationStore(adapter);
	const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'llama3' });

	const controller = new ChatController({
		store,
		provider,
		retrieveContext: async () => RETRIEVAL_CONTEXT,
		getChatSettings: async () => ({ systemPrompt: 'You are echo.', model: 'llama3', historyBudget: 8000 }),
		isVaultLocked: async () => false,
		onEvent: () => {},
	});

	await controller.init();
	await controller.send('what do my notes say?');
	await delay();

	assert.ok(fetchCalls.length >= 1, 'provider is contacted when notes are on');
	for (const url of fetchCalls) {
		assert.ok(
			url.startsWith('http://localhost:11434/'),
			`every network call targets the configured provider endpoint (got ${url})`,
		);
	}
	assert.ok(
		fetchCalls.some((url) => url.endsWith('/v1/chat/completions')),
		'note-derived context reaches only the provider chat endpoint',
	);
	console.log('✓ note-derived context sent only to the configured provider endpoint');
}

async function testChatModulesHaveNoDirectNetworkAccess() {
	const chatDir = path.resolve(__dirname, '..', '..', 'src', 'chat');
	const offenders = [];
	for (const file of fs.readdirSync(chatDir).filter((f) => f.endsWith('.ts'))) {
		const content = fs.readFileSync(path.join(chatDir, file), 'utf8');
		// No raw fetch / http(s) URLs should appear in the chat modules; the
		// only network path is the LLM provider abstraction.
		if (/fetch\s*\(/.test(content) || /https?:\/\//.test(content)) {
			offenders.push(file);
		}
	}
	assert.deepStrictEqual(offenders, [], 'chat modules must not open their own network connections');
	console.log('✓ chat modules contain no direct network access; provider is the only egress');
}

(async () => {
	await testNoNetworkBeyondProvider();
	await testChatModulesHaveNoDirectNetworkAccess();
	global.fetch = originalFetch;
	console.log('All chat privacy tests passed');
})().catch((error) => {
	global.fetch = originalFetch;
	console.error(error);
	process.exit(1);
});