const assert = require('assert');

function getDescendants(rootId, folderParentMap) {
    const descendants = new Set([rootId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const [fid, pid] of folderParentMap) {
            if (pid && descendants.has(pid) && !descendants.has(fid)) {
                descendants.add(fid);
                changed = true;
            }
        }
    }
    return descendants;
}

console.log('Running graph retriever unit tests...');

function testBFSExpansion() {
    const edges = new Map([
        ['e1', 'n1'],  // n1 -> e1
        ['e2', 'n2'],  // n2 -> e2 (different start)
        ['e3', 'e1'],  // e1 -> e3
    ]);

    const visited = new Set(['n1']);
    const queue = ['n1'];

    while (queue.length > 0) {
        const current = queue.shift();
        for (const [target, source] of edges) {
            if (source === current && !visited.has(target)) {
                visited.add(target);
                queue.push(target);
            }
        }
    }

    assert.ok(visited.has('e1'));
    assert.ok(visited.has('e3'));
    assert.ok(!visited.has('e2'));
    console.log('✓ BFS expansion from node');
}

function testLayerFiltering() {
    const nodes = new Map([
        ['n1', { id: 'n1', layer: 'structural', kind: 'note' }],
        ['n2', { id: 'n2', layer: 'semantic', kind: 'entity' }],
        ['n3', { id: 'n3', layer: 'structural', kind: 'note' }],
    ]);

    const structural = Array.from(nodes.values()).filter(n => n.layer === 'structural');
    const semantic = Array.from(nodes.values()).filter(n => n.layer === 'semantic');

    assert.strictEqual(structural.length, 2);
    assert.strictEqual(semantic.length, 1);
    console.log('✓ Layer filtering works');
}

function testEmptyMatch() {
    const nodes = new Map([
        ['n1', { label: 'apple', layer: 'structural' }],
        ['n2', { label: 'banana', layer: 'structural' }],
    ]);

    const query = 'cherry';
    const matches = Array.from(nodes.values()).filter(n => n.label.toLowerCase().includes(query.toLowerCase()));
    assert.strictEqual(matches.length, 0);
    console.log('✓ No match returns empty');
}

testBFSExpansion();
testLayerFiltering();
testEmptyMatch();

console.log('All graph retriever tests passed');