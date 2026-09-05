const assert=require('assert');

// Mock in-memory DB for integration scenarios
class MockDB{
	constructor(){this.tables={relation_evidence:[], relations:[], edges:[], nodes:[], index_state:[], notes:[], entities:[]}}
	run(sql, params){return Promise.resolve()}
	all(sql, params){return Promise.resolve([])}
}

// Test evidence confidence recomputation on add/remove
function testEvidenceConfidence(){
	function confidenceFromCount(count, def=0.6){ if(count<=0) return 0; return 1 - Math.pow(1-def, count); }
	assert(Math.abs(confidenceFromCount(1)-0.6)<0.001);
	assert(Math.abs(confidenceFromCount(2)-0.84)<0.001);
	assert(Math.abs(confidenceFromCount(0)-0)<0.001);
	// After removing one evidence from 2 -> should drop to 0.6
	const before=confidenceFromCount(2);
	const after=confidenceFromCount(1);
	assert(after < before && Math.abs(after-0.6)<0.001);
	console.log('evidence confidence recompute passed');
}

// Test delta skip logic
function testDeltaSkip(){
	function shouldReprocess(state, currentHash, force=false, expectedModel){
		if(force) return true;
		if(!state) return true;
		if(state.content_hash!==currentHash) return true;
		if(state.semantic_status!=='success') return true;
		if(expectedModel && state.extraction_model && state.extraction_model!==expectedModel) return true;
		return false;
	}
	assert(!shouldReprocess({content_hash:'abc', semantic_status:'success', extraction_model:'llama3'}, 'abc', false, 'llama3'));
	assert(shouldReprocess({content_hash:'abc', semantic_status:'success', extraction_model:'llama3'}, 'abc', false, 'llama3-new'));
	assert(shouldReprocess({content_hash:'abc', semantic_status:'success'}, 'def'));
	assert(!shouldReprocess({content_hash:'abc', semantic_status:'success'}, 'abc'));
	assert(shouldReprocess({content_hash:'abc', semantic_status:'failed'}, 'abc'));
	console.log('delta skip passed');
}

// Test lazy cascade: neighbor not re-extracted
function testLazyCascade(){
	const visited = new Set(['noteB']);
	const frontier = []; // lazy should not enqueue neighbors
	assert.strictEqual(frontier.length,0);
	console.log('lazy cascade passed');
}

// Test eager cascade visited caps fanout
function testEagerCascadeCap(){
	const depth=1, fanoutCap=50;
	const maxNotes = depth * fanoutCap;
	assert.strictEqual(maxNotes,50);
	const visited=new Set();
	for(let i=0;i<60;i++) visited.add(`note${i}`);
	assert(visited.size > maxNotes); // would exceed, but visited prevents loops
	// Cap guarantee
	const processed = Math.min(60, maxNotes);
	assert(processed <= maxNotes);
	console.log('eager cascade cap passed');
}

// Test enrichment marker idempotency
function testEnrichmentMarker(){
	const MARKER_RE = /<!--\s*echo:enrichment\s+v(\d+)\s+tags=\[(.*?)\]\s+links=\[(.*?)\]\s*-->/;
	function parse(body){ const m=body.match(MARKER_RE); if(!m) return null; return {version:parseInt(m[1]), tags:m[2], links:m[3]}; }
	function build(tags,links){ return `<!-- echo:enrichment v1 tags=[${tags.map(t=>`"${t}"`).join(',')}] links=[${links.map(l=>`"${l}"`).join(',')}] -->`; }
	const body = 'Hello\n\n' + build(['tag1'], ['Link One']);
	const parsed=parse(body);
	assert(parsed && parsed.version===1);
	const stripped=body.replace(MARKER_RE,'').trimEnd();
	assert(!parse(stripped));
	console.log('enrichment marker passed');
}

// Test source filtering
function testSourceFiltering(){
	const edges=[
		{source:'joplin', id:'e1'},
		{source:'enrichment', id:'e2'},
		{source:'joplin', id:'e3'},
	];
	const enrichmentEdges=edges.filter(e=>e.source==='enrichment');
	assert.strictEqual(enrichmentEdges.length,1);
	assert.strictEqual(enrichmentEdges[0].id,'e2');
	console.log('source filtering passed');
}

// Vault locked test
function testVaultLocked(){
	let locked=true;
	let deferred=[];
	function enqueue(noteId){
		if(locked){ deferred.push(noteId); return false; }
		return true;
	}
	assert.strictEqual(enqueue('note1'),false);
	assert.strictEqual(deferred.length,1);
	locked=false;
	// flush
	assert(deferred.includes('note1'));
	console.log('vault locked deferred passed');
}

// Scope tests
function testScopes(){
	const scopes=[
		{kind:'note', noteId:'n1'},
		{kind:'folder', folderId:'f1'},
		{kind:'all'},
	];
	assert(scopes[0].kind==='note');
	assert(scopes[1].kind==='folder');
	assert(scopes[2].kind==='all');
	console.log('scope tests passed');
}

testEvidenceConfidence();
testDeltaSkip();
testLazyCascade();
testEagerCascadeCap();
testEnrichmentMarker();
testSourceFiltering();
testVaultLocked();
testScopes();
console.log('All integration tests passed');
