const assert = require('assert');
const { load } = require('../helpers/load-ts');

const { OllamaProvider } = load('llm/providers/ollama.ts');

console.log('Running chatStream unit tests...');

const originalFetch = global.fetch;
const BASE_URL = 'http://localhost:11434';

function sseBody(eventLines) {
	const encoder = new TextEncoder();
	let index = 0;
	return {
		signal: null,
		stream() {
			return new ReadableStream(
				{
					type: 'bytes',
					pull: (controller) => {
						if (this.signal && this.signal.aborted) {
							controller.error(new DOMException('The operation was aborted.', 'AbortError'));
							return;
						}
						if (index >= eventLines.length) {
							controller.close();
							return;
						}
						controller.enqueue(encoder.encode(eventLines[index++]));
					},
				},
				{ highWaterMark: 0 },
			);
		},
	};
}

function event(payload) {
	return `data: ${payload}\n\n`;
}

function jsonResponse(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

async function collect(generator) {
	const out = [];
	for await (const delta of generator) out.push(delta);
	return out;
}

async function testTokenSequence() {
	const holder = { body: null, init: null };
	const body = sseBody([
		event('{"choices":[{"delta":{"content":"Hello"}}]}'),
		event('{"choices":[{"delta":{"content":" world"}}]}'),
		'data: [DONE]\n\n',
	]);
	global.fetch = async (url, init) => {
		holder.body = body;
		holder.init = init;
		return new Response(body.stream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
	};

	const provider = new OllamaProvider({ baseUrl: BASE_URL, model: 'llama3' });
	const deltas = await collect(provider.chatStream([{ role: 'user', content: 'hi' }]));

	assert.deepStrictEqual(deltas, ['Hello', ' world']);
	assert.strictEqual(holder.init.method, 'POST');
	assert.strictEqual(holder.init.url, undefined);
	const url = `${BASE_URL}/v1/chat/completions`;
	assert.ok(holder.body === body);
	const parsed = JSON.parse(holder.init.body);
	assert.strictEqual(parsed.stream, true);
	assert.strictEqual(parsed.model, 'llama3');
	assert.deepStrictEqual(parsed.messages, [{ role: 'user', content: 'hi' }]);
	console.log('✓ Token sequence yielded; request has stream:true, model, messages');
}

async function testAbortMidStream() {
	const ac = new AbortController();
	const body = sseBody([
		event('{"choices":[{"delta":{"content":"one"}}]}'),
		event('{"choices":[{"delta":{"content":"two"}}]}'),
		event('{"choices":[{"delta":{"content":"three"}}]}'),
	]);
	global.fetch = async (_url, init) => {
		assert.strictEqual(init.signal, ac.signal);
		body.signal = init.signal;
		return new Response(body.stream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
	};

	const provider = new OllamaProvider({ baseUrl: BASE_URL, model: 'llama3' });
	const iterator = provider.chatStream([{ role: 'user', content: 'hi' }], { signal: ac.signal })[Symbol.asyncIterator]();

	const first = await iterator.next();
	assert.strictEqual(first.value, 'one');

	ac.abort();

	await assert.rejects(() => iterator.next(), (error) => error.name === 'AbortError');
	console.log('✓ Abort mid-stream surfaces AbortError and stops yielding');
}

async function testProviderErrorThrown() {
	global.fetch = async () => jsonResponse(404, { error: { message: 'model not found' } });

	const provider = new OllamaProvider({ baseUrl: BASE_URL, model: 'nope' });
	await assert.rejects(() => collect(provider.chatStream([{ role: 'user', content: 'hi' }])), /model not found/);
	console.log('✓ Provider HTTP error surfaces as a thrown error');
}

async function testAbortBeforeSend() {
	const ac = new AbortController();
	ac.abort();
	global.fetch = async (_url, init) => {
		if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
		throw new Error('fetch should not have proceeded');
	};

	const provider = new OllamaProvider({ baseUrl: BASE_URL, model: 'llama3' });
	await assert.rejects(() => collect(provider.chatStream([{ role: 'user', content: 'hi' }], { signal: ac.signal })), (e) => e.name === 'AbortError');
	console.log('✓ Pre-aborted signal prevents the request');
}

async function testListModels() {
	const calls = [];
	global.fetch = async (url) => {
		calls.push(url);
		return new Response(
			JSON.stringify({ data: [{ id: 'llama3' }, { id: 'gemma2' }, { id: 42 }] }),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
	};

	const provider = new OllamaProvider({ baseUrl: BASE_URL, model: 'llama3' });
	const models = await provider.listModels();
	assert.deepStrictEqual(models, ['llama3', 'gemma2']);
	assert.strictEqual(calls.length, 1);
	assert.ok(calls[0].endsWith('/v1/models'), 'lists models from /v1/models');
	console.log('✓ listModels returns provider model ids');
}

async function testListModelsFailureReturnsEmpty() {
	global.fetch = async () => new Response('nope', { status: 500 });
	const provider = new OllamaProvider({ baseUrl: BASE_URL, model: 'llama3' });
	const models = await provider.listModels();
	assert.deepStrictEqual(models, []);
	console.log('✓ listModels returns empty list on provider failure');
}

(async () => {
	await testTokenSequence();
	await testAbortMidStream();
	await testProviderErrorThrown();
	await testAbortBeforeSend();
	await testListModels();
	await testListModelsFailureReturnsEmpty();
	global.fetch = originalFetch;
	console.log('All chatStream tests passed');
})().catch((error) => {
	global.fetch = originalFetch;
	console.error(error);
	process.exit(1);
});