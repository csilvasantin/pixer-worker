import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTextPositions,TEXT_POSITIONS_SCHEMA} from '../src/capsule-text-positions.mjs';
test('text positions use bounded numeric frame fractions and reject unknown fields',()=>{
 assert.equal(TEXT_POSITIONS_SCHEMA,'admira.text-positions.v1');
 assert.deepEqual(normalizeTextPositions(),{ok:true,positions:{}});
 assert.deepEqual(normalizeTextPositions({horizontal:{heading:{x:-.123456,y:.2},remate:{x:0,y:0}},vertical:{fuente:{x:.1,y:-.05}}}),{ok:true,positions:{horizontal:{heading:{x:-.12346,y:.2}},vertical:{fuente:{x:.1,y:-.05}}}});
 for(const value of [[],true,'bad',{square:{}},{horizontal:[]},{horizontal:{script:{x:0,y:0}}},...[NaN,Infinity,1.001,'0.2',true,null].map(x=>({horizontal:{heading:{x,y:0}}})),{vertical:{heading:{x:.2}}},{horizontal:{heading:{x:.1,y:.1,animation:'fade'}}}])assert.equal(normalizeTextPositions(value).ok,false,JSON.stringify(value));
});
