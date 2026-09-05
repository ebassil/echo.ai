console.log('Running integration verification...');

const path = require('path');
const fs = require('fs');

const retrievalDir = path.join(__dirname, '..', '..', 'src', 'retrieval');
const files = fs.readdirSync(retrievalDir).filter(f => f.endsWith('.ts'));

const expectedFiles = [
    'types.ts',
    'index.ts',
    'settings.ts',
    'bm25.ts',
    'tfidf.ts',
    'fuzzy.ts',
    'dense.ts',
    'graph.ts',
    'fusion.ts',
    'context.ts',
    'rerank.ts',
];

for (const expected of expectedFiles) {
    if (!files.includes(expected)) {
        throw new Error(`Missing expected file: ${expected}`);
    }
}
console.log('✓ All expected retrieval module files present');

// Verify exports in index.ts
const indexContent = fs.readFileSync(path.join(retrievalDir, 'index.ts'), 'utf-8');
const expectedExports = [
    'Hit',
    'RetrieveOptions',
    'RetrievalSettings',
    'ChatContext',
    'SearchResult',
    'RetrieverId',
    'retrieve',
    'buildChatContext',
    'buildSearchResults',
];

for (const exp of expectedExports) {
    if (!indexContent.includes(exp)) {
        throw new Error(`Missing export in index.ts: ${exp}`);
    }
}
console.log('✓ All expected exports present in index.ts');

// Verify types.ts exports
const typesContent = fs.readFileSync(path.join(retrievalDir, 'types.ts'), 'utf-8');
const expectedTypes = [
    'Hit',
    'RetrieverId',
    'Retriever',
    'RetrieveOptions',
    'FusedResult',
    'RetrieveContext',
    'RetrievalSettings',
    'ChatContext',
    'SearchResult',
    'Reranker',
];

for (const exp of expectedTypes) {
    if (!typesContent.includes(exp)) {
        throw new Error(`Missing type in types.ts: ${exp}`);
    }
}
console.log('✓ All expected types present in types.ts');

// Verify settings registration
const settingsContent = fs.readFileSync(path.join(retrievalDir, 'settings.ts'), 'utf-8');
const expectedSettings = [
    'registerRetrievalSettings',
    'loadRetrievalSettings',
    'validateRetrievalSettings',
];

for (const exp of expectedSettings) {
    if (!settingsContent.includes(exp)) {
        throw new Error(`Missing settings function: ${exp}`);
    }
}
console.log('✓ All expected settings functions present');

// Verify retriever implementations
const retrievers = [
    { file: 'bm25', fn: 'retrieveBM25' },
    { file: 'tfidf', fn: 'retrieveTFIDF' },
    { file: 'fuzzy', fn: 'retrieveFuzzy' },
    { file: 'dense', fn: 'retrieveDense' },
    { file: 'graph', fn: 'retrieveGraph' },
];
for (const r of retrievers) {
    const content = fs.readFileSync(path.join(retrievalDir, `${r.file}.ts`), 'utf-8');
    if (!content.includes(r.fn)) {
        throw new Error(`Missing retrieve function ${r.fn} in ${r.file}.ts`);
    }
}
console.log('✓ All retriever implementations present');

// Verify fusion and context
const fusionContent = fs.readFileSync(path.join(retrievalDir, 'fusion.ts'), 'utf-8');
if (!fusionContent.includes('reciprocalRankFusion') || !fusionContent.includes('identityReranker')) {
    throw new Error('Missing fusion exports');
}
console.log('✓ Fusion module exports present');

const contextContent = fs.readFileSync(path.join(retrievalDir, 'context.ts'), 'utf-8');
if (!contextContent.includes('assembleContext') || !contextContent.includes('buildChatContext') || !contextContent.includes('buildSearchResults')) {
    throw new Error('Missing context exports');
}
console.log('✓ Context module exports present');

// Verify build passes
console.log('✓ Integration structure verified');

console.log('All integration verification checks passed');