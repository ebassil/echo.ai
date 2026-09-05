const assert = require('assert');

function deserializeVector(buffer) {
    const floatArray = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    return Array.from(floatArray);
}

function cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function serializeVector(vector) {
    const floatArray = new Float32Array(vector);
    return Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
}

console.log('Running dense retriever unit tests...');

function testVectorSerialization() {
    const vec = [0.1, 0.2, 0.3, 0.4, 0.5];
    const buf = serializeVector(vec);
    const deserialized = deserializeVector(buf);
    for (let i = 0; i < vec.length; i++) {
        assert.ok(Math.abs(deserialized[i] - vec[i]) < 0.0001);
    }
    console.log('✓ Vector serialization round-trip');
}

function testCosineSimilarity() {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 0.0001);

    const c = [0, 1, 0];
    assert.ok(Math.abs(cosineSimilarity(a, c)) < 0.0001);

    const d = [1, 1, 0];
    const e = [1, 1, 0];
    assert.ok(Math.abs(cosineSimilarity(d, e) - 1) < 0.0001);

    const f = [-1, 0, 0];
    assert.ok(Math.abs(cosineSimilarity(a, f) + 1) < 0.0001);
    console.log('✓ Cosine similarity calculations correct');
}

function testZeroVectors() {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    assert.strictEqual(cosineSimilarity(a, b), 0);
    console.log('✓ Zero vector handling');
}

function testDimensionMismatch() {
    const a = [1, 2, 3];
    const b = [1, 2];
    const result = cosineSimilarity(a, b);
    assert.ok(Number.isNaN(result) || !Number.isFinite(result) || Math.abs(result) > 1);
    console.log('✓ Dimension mismatch produces invalid result');
}

testVectorSerialization();
testCosineSimilarity();
testZeroVectors();
testDimensionMismatch();

console.log('All dense retriever tests passed');