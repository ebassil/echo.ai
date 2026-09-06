const assert = require('assert');

// Redirect the Joplin `api` virtual module so modules that only reference it at
// load time (never call it) can be exercised under Node.
const Module = require('module');
const path = require('path');
const mockApi = path.join(__dirname, '..', 'helpers', 'mock-api.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'api') return mockApi;
	return origResolve.call(this, request, ...args);
};

const { load } = require('../helpers/load-ts');

const {
	providerHealth,
	__resetProviderHealthForTests,
	upTtlMs,
	downTtlMs,
} = load('llm/health.ts');

console.log('Running provider health gate unit tests...');

function makeProvider({ models = ['test-model'], failList = false, hangMs = 0 } = {}) {
	const provider = {
		name: 'fake',
		models,
		callCount: 0,
		async listModels() {
			this.callCount++;
			if (this.hangMs > 0) await new Promise((r) => setTimeout(r, this.hangMs));
			if (this.failList) throw new Error('listModels failed');
			return this.models;
		},
		hangMs,
		failList,
	};
	return provider;
}

async function testUpIsCachedWithinTtl() {
	__resetProviderHealthForTests();
	const provider = makeProvider();
	assert.strictEqual(await providerHealth.check(provider), 'up');
	assert.strictEqual(await providerHealth.check(provider), 'up');
	assert.strictEqual(provider.callCount, 1, 'no re-probe while cached');
	console.log(`✓ cached 'up' within ${upTtlMs}ms TTL performs no network I/O`);
}

async function testExpiryTriggersOneProbe() {
	__resetProviderHealthForTests();
	const provider = makeProvider();
	const realNow = Date.now;
	let fakeNow = realNow();
	Date.now = () => fakeNow;

	try {
		assert.strictEqual(await providerHealth.check(provider), 'up');
		assert.strictEqual(provider.callCount, 1);
		fakeNow += upTtlMs + 1000; // expire up TTL
		assert.strictEqual(await providerHealth.check(provider), 'up');
		assert.strictEqual(provider.callCount, 2, 'expired TTL triggers exactly one probe');
	} finally {
		Date.now = realNow;
	}
	console.log('✓ expired up-state TTL triggers exactly one probe');
}

async function testInvalidateForcesReProbe() {
	__resetProviderHealthForTests();
	const provider = makeProvider();
	assert.strictEqual(await providerHealth.check(provider), 'up');
	providerHealth.invalidate();
	assert.strictEqual(await providerHealth.check(provider), 'up');
	assert.strictEqual(provider.callCount, 2, 'invalidate() forces a re-probe');
	console.log('✓ invalidate() forces a re-probe');
}

async function testDownStateRecovery() {
	__resetProviderHealthForTests();
	const provider = makeProvider({ models: [] });
	const realNow = Date.now;
	let fakeNow = realNow();
	Date.now = () => fakeNow;

	try {
		assert.strictEqual(await providerHealth.check(provider), 'down');
		assert.strictEqual(provider.callCount, 1);
		fakeNow += downTtlMs - 1000; // still within down TTL
		assert.strictEqual(await providerHealth.check(provider), 'down');
		assert.strictEqual(provider.callCount, 1, 'down state cached within its TTL');
		fakeNow += 2000; // down TTL expired
		provider.models = ['recovered'];
		assert.strictEqual(await providerHealth.check(provider), 'up');
		assert.strictEqual(provider.callCount, 2, 'short down TTL re-probes for quick recovery');
	} finally {
		Date.now = realNow;
	}
	console.log(`✓ 'down' cached for ${downTtlMs}ms then recovers to 'up' on next probe`);
}

async function testProbeIsNonBlocking() {
	__resetProviderHealthForTests();
	const provider = makeProvider({ models: ['slow'], hangMs: 10_000 });
	const started = Date.now();
	const status = await providerHealth.check(provider);
	const elapsed = Date.now() - started;
	assert.strictEqual(status, 'down', 'hanging provider is treated as down');
	assert.ok(elapsed < 5000, `probe returned without waiting on the 10s hang (took ${elapsed}ms)`);
	console.log(`✓ non-blocking probe: hanging endpoint classified 'down' after ~2s timeout`);
}

async function testUnreachableEndpointSimulatesConnectionRefused() {
	__resetProviderHealthForTests();
	const { OllamaProvider } = load('llm/providers/ollama.ts');
	const provider = new OllamaProvider({ baseUrl: 'http://127.0.0.1:9', model: 'test-model' });
	const status = await providerHealth.check(provider);
	assert.strictEqual(status, 'down');
	console.log('✓ unreachable endpoint (connection refused) classified as down');
}

(async () => {
	await testUpIsCachedWithinTtl();
	await testExpiryTriggersOneProbe();
	await testInvalidateForcesReProbe();
	await testDownStateRecovery();
	await testProbeIsNonBlocking();
	await testUnreachableEndpointSimulatesConnectionRefused();
	console.log('All provider health gate tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});