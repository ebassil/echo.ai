const assert=require('assert');
function isValidEntity(e){return e!=null && typeof e.name==='string' && e.name.trim().length>0 && typeof e.type==='string';}
function isValidRelation(r){return r!=null && typeof r.from==='string' && r.from.trim().length>0 && typeof r.to==='string' && r.to.trim().length>0 && typeof r.type==='string' && r.type.trim().length>0;}
function parseExtraction(raw){
	const jsonText=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/m,'').trim();
	try{
		const parsed=JSON.parse(jsonText); return {entities:Array.isArray(parsed.entities)?parsed.entities:[], relations:Array.isArray(parsed.relations)?parsed.relations:[]};
	}catch{return {entities:[], relations:[]};}
}
assert(isValidEntity({name:'Alice',type:'person'}));
assert(!isValidEntity({name:'',type:'person'}));
assert(isValidRelation({from:'A',to:'B',type:'knows'}));
assert(!isValidRelation({from:'',to:'B',type:'knows'}));
let r=parseExtraction('```json\n{"entities":[{"name":"Alice","type":"person"}],"relations":[]}\n```');
assert.strictEqual(r.entities[0].name,'Alice');
r=parseExtraction('invalid json');
assert.strictEqual(r.entities.length,0);
console.log('validate tests passed');
