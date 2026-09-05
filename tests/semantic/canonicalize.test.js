const assert = require('assert');
// Mock normalize function inline (copy from canonicalize)
function normalize(name) {
	if (typeof name !== 'string') return '';
	let s = name.normalize('NFC');
	s = s.trim();
	s = s.toLocaleLowerCase();
	s = s.replace(/\s+/g, ' ');
	s = s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
	s = s.replace(/\s+/g, ' ').trim();
	return s;
}

function testNormalize() {
	assert.strictEqual(normalize(' Alice '), 'alice');
	assert.strictEqual(normalize('ALICE'), 'alice');
	assert.strictEqual(normalize('alice '), 'alice');
	assert.strictEqual(normalize('  ALICE  '), 'alice');
	assert.strictEqual(normalize('Hello   World'), 'hello world');
	assert.strictEqual(normalize('!!Hello!!'), 'hello');
	assert.strictEqual(normalize('  "Quoted"  '), 'quoted');
	// NFC test: e + combining accent vs é
	const eAcuteCombined = 'e\u0301';
	const eAcuteSingle = '\u00e9';
	assert.strictEqual(normalize(eAcuteCombined), normalize(eAcuteSingle));
	console.log('normalize tests passed');
}

function testDedupe() {
	const entities = [{name:'Alice', type:'person'}, {name:'alice ', type:'person'}, {name:'ALICE', type:'person'}];
	const grouped = new Map();
	for (const e of entities) {
		const norm = normalize(e.name);
		if (!grouped.has(norm)) grouped.set(norm, new Set());
		grouped.get(norm).add(e.name.trim());
	}
	assert.strictEqual(grouped.size, 1);
	assert.strictEqual(grouped.get('alice').size, 3);
	console.log('dedupe tests passed');
}

function testCosine() {
	function cosine(a,b){
		let dot=0, normA=0, normB=0;
		for(let i=0;i<a.length;i++){dot+=a[i]*b[i]; normA+=a[i]*a[i]; normB+=b[i]*b[i];}
		return dot/(Math.sqrt(normA)*Math.sqrt(normB));
	}
	const v1=[1,0,0], v2=[1,0,0], v3=[0,1,0];
	assert(Math.abs(cosine(v1,v2)-1) < 0.001);
	assert(Math.abs(cosine(v1,v3)-0) < 0.001);
	console.log('cosine tests passed');
}

function testConfidence() {
	function compute(confidences, def=0.6){
		let p=1; for(const c of confidences){const cc=c??def; p*=1-cc;} return 1-p;
	}
	assert(Math.abs(compute([0.6])-0.6) < 0.001);
	assert(Math.abs(compute([0.6,0.6]) - (1-0.4*0.4)) < 0.001);
	assert(Math.abs(compute([0.6,0.6,0.6]) - (1-0.064)) < 0.001);
	assert(compute([])===0);
	console.log('confidence tests passed');
}

testNormalize();
testDedupe();
testCosine();
testConfidence();
console.log('All unit tests passed');
