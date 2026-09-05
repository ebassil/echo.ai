const assert = require('assert');

const fs = require('fs');
const path = require('path');

console.log('Running local-first posture verification...');

const retrievalDir = path.join(__dirname, '..', '..', 'src', 'retrieval');
const files = fs.readdirSync(retrievalDir).filter(f => f.endsWith('.ts'));

let hasNetworkImport = false;
let hasSyncCode = false;
let usesLocalDb = false;
let usesLocalProvider = false;

for (const file of files) {
    const content = fs.readFileSync(path.join(retrievalDir, file), 'utf-8');
    
    if (content.includes('fetch(') || content.includes('http') || content.includes('https:')) {
        hasNetworkImport = true;
        console.log(`⚠ ${file}: contains network references`);
    }
    
    const words = content.split(/\s+/);
    for (const word of words) {
        if (word === 'sync' || word === 'replicate' || word === 'replication') {
            hasSyncCode = true;
            console.log(`⚠ ${file}: contains sync/replication keyword: ${word}`);
            break;
        }
    }
    
    if (content.includes('getDatabase()') || content.includes('db.all') || content.includes('db.run')) {
        usesLocalDb = true;
    }
    
    if (content.includes('provider.embeddings') || content.includes('getProvider()')) {
        usesLocalProvider = true;
    }
}

assert.ok(!hasNetworkImport, 'Retrieval module should not make network requests');
assert.ok(!hasSyncCode, 'Retrieval module should not have sync/replication code');
assert.ok(usesLocalDb, 'Retrieval module should use local SQLite database');
assert.ok(usesLocalProvider, 'Retrieval module should use local LLM provider');

console.log('✓ No network requests (fetch, http, https)');
console.log('✓ No sync/replication code');
console.log('✓ Uses local SQLite database (getDatabase)');
console.log('✓ Uses local LLM provider (provider.embeddings)');

console.log('All local-first posture checks passed');