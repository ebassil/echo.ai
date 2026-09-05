const assert = require('assert');

function damerauLevenshtein(s1, s2) {
    const len1 = s1.length;
    const len2 = s2.length;

    if (len1 === 0) return len2;
    if (len2 === 0) return len1;

    const INF = len1 + len2;
    const d = Array(len1 + 2).fill(null).map(() => Array(len2 + 2).fill(0));

    d[0][0] = INF;
    for (let i = 0; i <= len1; i++) {
        d[i + 1][1] = i;
        d[i + 1][0] = INF;
    }
    for (let j = 0; j <= len2; j++) {
        d[1][j + 1] = j;
        d[0][j + 1] = INF;
    }

    const da = new Map();

    for (let i = 1; i <= len1; i++) {
        let db = 0;
        for (let j = 1; j <= len2; j++) {
            const i1 = da.get(s2[j - 1]) ?? 0;
            const j1 = db;
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;

            if (cost === 0) db = j;

            d[i + 1][j + 1] = Math.min(
                d[i][j] + cost,
                d[i + 1][j] + 1,
                d[i][j + 1] + 1,
                d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1),
            );
        }
        da.set(s1[i - 1], i);
    }

    return d[len1 + 1][len2 + 1];
}

console.log('Running fuzzy retriever unit tests...');

function testEditDistance() {
    assert.strictEqual(damerauLevenshtein('hello', 'hello'), 0);
    assert.strictEqual(damerauLevenshtein('hello', 'hallo'), 1);
    assert.strictEqual(damerauLevenshtein('hello', 'helo'), 1);
    assert.strictEqual(damerauLevenshtein('hello', 'hllo'), 1);
    assert.strictEqual(damerauLevenshtein('hello', 'heoll'), 2);
    assert.strictEqual(damerauLevenshtein('', 'hello'), 5);
    assert.strictEqual(damerauLevenshtein('hello', ''), 5);
    console.log('✓ Damerau-Levenshtein edit distance');
}

function testNormalized() {
    function normalize(text) {
        return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    }
    assert.strictEqual(normalize('Hello World!'), 'hello world');
    assert.strictEqual(normalize('  Multiple   Spaces  '), 'multiple spaces');
    assert.strictEqual(normalize('Special!@#Chars'), 'specialchars');
    console.log('✓ Title normalization for edit distance');
}

testEditDistance();
testNormalized();

console.log('All fuzzy tests passed');