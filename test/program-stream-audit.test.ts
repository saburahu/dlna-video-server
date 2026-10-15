import test from 'node:test';
import assert from 'node:assert/strict';
import {auditProgramStream} from '../src/program-stream-audit.js';
test('PS audit distinguishes MPEG-1 Systems from MPEG-2 pack syntax independent of video codec',()=>{
 const mpeg1=Buffer.from('000001ba2100010001807fd7000001b9','hex'),a=auditProgramStream(mpeg1);assert.deepEqual(a.packSyntax,{mpeg1:1,mpeg2:0});assert.deepEqual(a.errors,[]);assert.equal(a.firstPack.scr,0);assert.equal(a.firstPack.muxBitsPerSecond,6545200);assert.equal(a.programEndCodes,1);
 const mpeg2=Buffer.from('000001ba4400040004010199d3f8000001b9','hex'),b=auditProgramStream(mpeg2);assert.deepEqual(b.packSyntax,{mpeg1:0,mpeg2:1});assert.deepEqual(b.errors,[]);
 assert.ok(auditProgramStream(Buffer.from('000001e0ffff','hex')).errors.length);
});
