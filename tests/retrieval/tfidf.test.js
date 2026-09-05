const assert = require('assert');

const STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
    'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were', 'will', 'with',
]);

function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function computeTFIDFVector(tokens, cache) {
    const tf = new Map();
    for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    const tfidf = new Map();
    const totalTokens = tokens.length;
    for (const [token, count] of tf) {
        const tfVal = count / totalTokens;
        const df = cache.df.get(token) ?? 1;
        const idf = Math.log((cache.docCount + 1) / (df + 1)) + 1;
        tfidf.set(token, tfVal * idf);
    }

    return tfidf;
}

function cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (const [token, val] of a) {
        dot += val * (b.get(token) ?? 0);
        normA += val * val;
    }
    for (const val of b.values()) {
        normB += val * val;
    }

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildCache(docs) {
    const df = new Map();
    for (const doc of docs) {
        const tokens = new Set(tokenize(doc));
        for (const token of tokens) {
            df.set(token, (df.get(token) ?? 0) + 1);
        }
    }
    return { df, docCount: docs.length };
}

console.log('Running TF-IDF unit tests...');

function testTokenize() {
    const tokens = tokenize('The quick brown fox jumps over the lazy dog');
    assert.deepStrictEqual(tokens.sort(), ['brown', 'dog', 'fox', 'jumps', 'lazy', 'over', 'quick'].sort());
    console.log('✓ Tokenization removes stop words and punctuation');
}

function testCosineSimilarity() {
    const cache = buildCache(['hello world', 'hello there', 'world peace']);
    const q1 = computeTFIDFVector(tokenize('hello world'), cache);
    const q2 = computeTFIDFVector(tokenize('hello there'), cache);
    const q3 = computeTFIDFVector(tokenize('unrelated terms'), cache);

    const sim1 = cosineSimilarity(q1, q2);
    const sim2 = cosineSimilarity(q1, q3);

    assert.ok(sim1 > sim2);
    console.log('✓ Cosine similarity ranks related queries higher');
}

function testEmptyQuery() {
    const cache = buildCache(['hello world']);
    const q = computeTFIDFVector([], cache);
    assert.strictEqual(q.size, 0);
    console.log('✓ Empty query produces empty vector');
}

function testCacheInvalidation() {
    const docs1 = ['doc one', 'doc two'];
    const docs2 = ['doc one', 'doc two', 'doc three'];

    const cache1 = buildCache(docs1);
    const cache2 = buildCache(docs2);

    assert.strictEqual(cache1.docCount, 2);
    assert.strictEqual(cache2.docCount, 3);
    assert.ok(cache2.df.has('three'));
    assert.ok(!cache1.df.has('three'));
    console.log('✓ Cache reflects document count changes');
}

function testStopWords() {
    const tokens = tokenize('a an and the of to');
    assert.strictEqual(tokens.length, 0);
    console.log('✓ Stop words filtered out');
}

testTokenize();
testCosineSimilarity();
testEmptyQuery();
testCacheInvalidation();
testStopWords();

console.log('All TF-IDF tests passed');