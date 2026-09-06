const assert = require('assert');
const { load } = require('../helpers/load-ts');

const { parseSSEStream } = load('llm/sse.ts');

console.log('Running SSE parser unit tests...');

function streamOf(text) {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

function streamOfChunks(chunks) {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function collect(stream) {
	const out = [];
	for await (const delta of parseSSEStream(stream)) out.push(delta);
	return out;
}

function event(payload) {
	return `data: ${payload}\n\n`;
}

async function testDeltaChunks() {
	const body =
		event('{"choices":[{"delta":{"content":"Hello"}}]}') +
		event('{"choices":[{"delta":{"content":" world"}}]}') +
		event('{"choices":[{"delta":{"content":"!"}}]}') +
		'data: [DONE]\n\n';
	const result = await collect(streamOf(body));
	assert.deepStrictEqual(result, ['Hello', ' world', '!']);
	console.log('✓ Deltas extracted from data: lines');
}

async function testDoneStopsStream() {
	const body =
		event('{"choices":[{"delta":{"content":"first"}}]}') +
		'data: [DONE]\n\n' +
		event('{"choices":[{"delta":{"content":"should not appear"}}]}');
	const result = await collect(streamOf(body));
	assert.deepStrictEqual(result, ['first']);
	console.log('✓ [DONE] terminates the stream');
}

async function testMalformedLinesIgnored() {
	const body =
		': a comment line\n' +
		'event: custom\n' +
		'data:\n' +
		'data: not-json{\n\n' +
		event('{"choices":[{"delta":{"content":"ok"}}]}');
	const result = await collect(streamOf(body));
	assert.deepStrictEqual(result, ['ok']);
	console.log('✓ Malformed / non-data lines ignored');
}

async function testMissingDeltaContent() {
	const body =
		event('{"choices":[{"delta":{"role":"assistant"}}]}') +
		event('{"choices":[{"delta":{}}]}') +
		event('{"choices":[{"delta":{"content":"real"}}]}') +
		'data: [DONE]\n\n';
	const result = await collect(streamOf(body));
	assert.deepStrictEqual(result, ['real']);
	console.log('✓ Chunks without delta.content yield nothing');
}

async function testEventSplitAcrossChunks() {
	const json = '{"choices":[{"delta":{"content":"split"}}]}';
	const body = `data: ${json}\n\n`;
	const midpoint = Math.floor(body.length / 2);
	const result = await collect(streamOfChunks([body.slice(0, midpoint), body.slice(midpoint)]));
	assert.deepStrictEqual(result, ['split']);
	console.log('✓ JSON event split across reads is reassembled');
}

async function testCrlfAndTrailingEvent() {
	const body = 'data: {"choices":[{"delta":{"content":"trail"}}]}\r\n\r\n';
	const result = await collect(streamOf(body));
	assert.deepStrictEqual(result, ['trail']);
	console.log('✓ CRLF line endings handled');
}

async function testEmptyStream() {
	const result = await collect(streamOf(''));
	assert.deepStrictEqual(result, []);
	console.log('✓ Empty stream yields nothing');
}

(async () => {
	await testDeltaChunks();
	await testDoneStopsStream();
	await testMalformedLinesIgnored();
	await testMissingDeltaContent();
	await testEventSplitAcrossChunks();
	await testCrlfAndTrailingEvent();
	await testEmptyStream();
	console.log('All SSE parser tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});