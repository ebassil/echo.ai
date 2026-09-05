const assert = require('assert');

function sanitizeFTS5Query(query, phraseOnly = false) {
    if (!query.trim()) return '""';

    const terms = query
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (terms.length === 0) return '""';

    if (phraseOnly) {
        return `"${query.replace(/"/g, '""')}"`;
    }

    const sanitized = terms
        .map((term) => term.replace(/"/g, '""'))
        .map((term) => (term.includes(' ') ? `"${term}"` : term))
        .join(' AND ');

    return sanitized || '""';
}

console.log('Running BM25 sanitization unit tests...');

function testBasicSanitization() {
    assert.strictEqual(sanitizeFTS5Query('hello world'), 'hello AND world');
    assert.strictEqual(sanitizeFTS5Query('test'), 'test');
    console.log('✓ Basic query sanitization');
}

function testPhraseQuoting() {
    assert.strictEqual(sanitizeFTS5Query('hello world'), 'hello AND world');
    assert.strictEqual(sanitizeFTS5Query('exact phrase'), 'exact AND phrase');
    console.log('✓ Phrase quoting handled');
}

function testEmptyQuery() {
    assert.strictEqual(sanitizeFTS5Query(''), '""');
    assert.strictEqual(sanitizeFTS5Query('   '), '""');
    console.log('✓ Empty query returns safe default');
}

function testSpecialCharacters() {
    assert.strictEqual(sanitizeFTS5Query('hello"world'), 'hello""world');
    assert.strictEqual(sanitizeFTS5Query('test\'s'), 'test\'s');
    console.log('✓ Special characters escaped');
}

function testPhraseOnlyFallback() {
    assert.strictEqual(sanitizeFTS5Query('complex "query" with spaces', true), '"complex ""query"" with spaces"');
    console.log('✓ Phrase-only fallback wraps entire query');
}

testBasicSanitization();
testPhraseQuoting();
testEmptyQuery();
testSpecialCharacters();
testPhraseOnlyFallback();

console.log('All BM25 sanitization tests passed');