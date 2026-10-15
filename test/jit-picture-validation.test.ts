import test from 'node:test';import assert from 'node:assert/strict';
import {initialPictureEvidence} from '../src/jit-picture-validation.js';
test('initial picture regression detects detailed source collapsing to gray but accepts a genuinely flat scene',()=>{
 const detailed=Buffer.from(Array.from({length:100},(_,i)=>i%2?220:30)),gray=Buffer.alloc(100,131);
 assert.equal(initialPictureEvidence(detailed,gray).collapsedToGray,true);
 assert.equal(initialPictureEvidence(gray,gray).collapsedToGray,false);
 assert.equal(initialPictureEvidence(detailed,detailed).collapsedToGray,false);
});
