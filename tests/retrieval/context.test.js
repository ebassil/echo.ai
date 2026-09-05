const assert = require('assert');

function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

function getTokenCount(hit) {
    return hit.content ? estimateTokens(hit.content) : 0;
}

function deduplicateHits(hits) {
    const seen = new Map();

    for (const hit of hits) {
        const key = hit.chunkId ?? `note:${hit.noteId}`;
        const existing = seen.get(key);
        if (!existing || hit.score > existing.score) {
            seen.set(key, hit);
        }
    }

    return Array.from(seen.values());
}

function groupByNote(hits, maxChunksPerNote) {
    const noteGroups = new Map();

    for (const hit of hits) {
        const group = noteGroups.get(hit.noteId) ?? [];
        group.push(hit);
        noteGroups.set(hit.noteId, group);
    }

    const result = [];
    for (const [, group] of noteGroups) {
        const sorted = group.sort((a, b) => b.score - a.score);
        result.push(...sorted.slice(0, maxChunksPerNote));
    }

    return result.sort((a, b) => b.score - a.score);
}

function truncateByTokenBudget(hits, tokenBudget) {
    let totalTokens = 0;
    const result = [];

    for (const hit of hits) {
        const tokens = getTokenCount(hit);
        if (totalTokens + tokens > tokenBudget && totalTokens > 0) {
            break;
        }
        result.push(hit);
        totalTokens += tokens;
    }

    return result;
}

function assembleContext(hits, settings, options = {}) {
    const tokenBudget = options.tokenBudget ?? settings.tokenBudget;
    const maxChunksPerNote = options.perNoteLimit ?? settings.maxChunksPerNote;

    const deduped = deduplicateHits(hits);
    const grouped = groupByNote(deduped, maxChunksPerNote);
    const truncated = truncateByTokenBudget(grouped, tokenBudget);

    const chunks = truncated.map((hit) => ({
        chunkId: hit.chunkId ?? '',
        noteId: hit.noteId,
        title: hit.title,
        content: hit.content,
        score: hit.score,
        contributingRetrievers: [],
    }));

    const totalTokens = chunks.reduce((sum, c) => sum + estimateTokens(c.content), 0);

    const searchResults = truncated.map((hit) => ({
        noteId: hit.noteId,
        title: hit.title,
        chunkText: hit.content,
        score: hit.score,
        contributingRetrievers: [],
    }));

    return { chatContext: { chunks, totalTokens }, searchResults };
}

const testSettings = {
    tokenBudget: 100,
    maxChunksPerNote: 2,
};

const testHits = [
    { chunkId: 'c1', noteId: 'n1', title: 'Note 1', content: 'Content one', score: 0.9 },
    { chunkId: 'c2', noteId: 'n1', title: 'Note 1', content: 'Content two', score: 0.8 },
    { chunkId: 'c3', noteId: 'n2', title: 'Note 2', content: 'Content three', score: 0.7 },
    { chunkId: 'c4', noteId: 'n2', title: 'Note 2', content: 'Content four', score: 0.6 },
    { chunkId: 'c5', noteId: 'n3', title: 'Note 3', content: 'Content five', score: 0.5 },
];

console.log('Running context assembly unit tests...');

function testDeduplicate() {
    const dupes = [
        { chunkId: 'c1', noteId: 'n1', title: 'Note', content: 'A', score: 0.5 },
        { chunkId: 'c1', noteId: 'n1', title: 'Note', content: 'A', score: 0.8 },
        { chunkId: 'c2', noteId: 'n2', title: 'Note', content: 'B', score: 0.7 },
    ];
    const result = deduplicateHits(dupes);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result.find(h => h.chunkId === 'c1').score, 0.8);
    console.log('✓ Deduplication keeps highest score');
}

function testGroupByNote() {
    const result = groupByNote(testHits, 2);
    const n1Chunks = result.filter(h => h.noteId === 'n1');
    assert.strictEqual(n1Chunks.length, 2);
    assert.strictEqual(n1Chunks[0].chunkId, 'c1');
    assert.strictEqual(n1Chunks[1].chunkId, 'c2');
    console.log('✓ Per-note chunk limit respected');
}

function testTokenBudgetTruncation() {
    const largeHits = testHits.map(h => ({ ...h, content: 'x'.repeat(200) }));
    const result = assembleContext(largeHits, testSettings);
    assert.ok(result.chatContext.totalTokens <= 100);
    console.log('✓ Token budget truncation');
}

function testChatContextShape() {
    const result = assembleContext(testHits, testSettings);
    assert.ok(result.chatContext.chunks.length > 0);
    assert.ok(result.chatContext.totalTokens >= 0);
    assert.ok(result.searchResults.length > 0);
    console.log('✓ Chat context and search results shape');
}

function testNoHits() {
    const result = assembleContext([], testSettings);
    assert.strictEqual(result.chatContext.chunks.length, 0);
    assert.strictEqual(result.searchResults.length, 0);
    console.log('✓ Empty hits handled');
}

testDeduplicate();
testGroupByNote();
testTokenBudgetTruncation();
testChatContextShape();
testNoHits();

console.log('All context assembly tests passed');