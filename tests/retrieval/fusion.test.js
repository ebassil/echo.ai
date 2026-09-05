const assert = require('assert');

function reciprocalRankFusion(results, settings) {
    const { rrfK, enabledRetrievers } = settings;
    const scores = new Map();

    for (const [retrieverId, hits] of results) {
        if (!enabledRetrievers[retrieverId]) continue;
        for (let i = 0; i < hits.length; i++) {
            const hit = hits[i];
            const key = hit.chunkId ?? `note:${hit.noteId}`;
            const rrfScore = 1 / (rrfK + i + 1);
            const existing = scores.get(key);
            if (existing) {
                existing.score += rrfScore;
            } else {
                scores.set(key, { hit: { ...hit }, score: rrfScore });
            }
        }
    }

    const fused = Array.from(scores.values())
        .sort((a, b) => b.score - a.score)
        .map((s) => ({ ...s.hit, score: s.score }));

    return fused;
}

const testSettings = {
    rrfK: 60,
    enabledRetrievers: { bm25: true, tfidf: true, fuzzy: true, dense: true, graph: true },
};

console.log('Running fusion (RRF) unit tests...');

function testRRFCombination() {
    const results = new Map([
        ['bm25', [
            { chunkId: 'c1', noteId: 'n1', title: 'A', content: '...', score: 0.9 },
            { chunkId: 'c2', noteId: 'n2', title: 'B', content: '...', score: 0.8 },
        ]],
        ['tfidf', [
            { chunkId: 'c1', noteId: 'n1', title: 'A', content: '...', score: 0.7 },
            { chunkId: 'c3', noteId: 'n3', title: 'C', content: '...', score: 0.6 },
        ]],
    ]);

    const fused = reciprocalRankFusion(results, testSettings);
    assert.strictEqual(fused.length, 3);
    assert.strictEqual(fused[0].chunkId, 'c1');
    assert.ok(fused[0].score > fused[1].score);
    console.log('✓ RRF combines multiple rankings');
}

function testDisabledRetrieverExcluded() {
    const settings = { ...testSettings, enabledRetrievers: { bm25: true, tfidf: false, fuzzy: true, dense: true, graph: true } };
    const results = new Map([
        ['bm25', [{ chunkId: 'c1', noteId: 'n1', title: 'A', content: '...', score: 0.9 }]],
        ['tfidf', [{ chunkId: 'c2', noteId: 'n2', title: 'B', content: '...', score: 0.8 }]],
    ]);

    const fused = reciprocalRankFusion(results, settings);
    assert.strictEqual(fused.length, 1);
    assert.strictEqual(fused[0].chunkId, 'c1');
    console.log('✓ Disabled retrievers excluded from fusion');
}

function testEmptyRetrieverSets() {
    const results = new Map([
        ['bm25', []],
        ['tfidf', []],
    ]);

    const fused = reciprocalRankFusion(results, testSettings);
    assert.strictEqual(fused.length, 0);
    console.log('✓ Empty retriever sets fuse to empty');
}

function testRRFScoreCalculation() {
    const results = new Map([
        ['bm25', [
            { chunkId: 'c1', noteId: 'n1', title: 'A', content: '...', score: 0.9 },
        ]],
        ['tfidf', [
            { chunkId: 'c1', noteId: 'n1', title: 'A', content: '...', score: 0.7 },
        ]],
    ]);

    const fused = reciprocalRankFusion(results, testSettings);
    const expectedScore = 1 / (60 + 1) + 1 / (60 + 1);
    assert.ok(Math.abs(fused[0].score - expectedScore) < 0.0001);
    console.log('✓ RRF score calculation correct');
}

function testMergeByNoteIdWhenNoChunkId() {
    const results = new Map([
        ['bm25', [
            { noteId: 'n1', title: 'A', content: '...', score: 0.9 },
        ]],
        ['tfidf', [
            { noteId: 'n1', title: 'A', content: '...', score: 0.7 },
        ]],
    ]);

    const fused = reciprocalRankFusion(results, testSettings);
    assert.strictEqual(fused.length, 1);
    assert.strictEqual(fused[0].noteId, 'n1');
    console.log('✓ Merge by noteId when no chunkId');
}

testRRFCombination();
testDisabledRetrieverExcluded();
testEmptyRetrieverSets();
testRRFScoreCalculation();
testMergeByNoteIdWhenNoChunkId();

console.log('All fusion tests passed');