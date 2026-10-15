import test from 'node:test';
import assert from 'node:assert/strict';
import {JitAudioClock} from '../src/jit-audio-clock.js';
test('sample clock accepts bounded MKV timestamp rounding without hiding gaps or accumulating drift',()=>{
 const clock=new JitAudioClock(48000,.002);
 for(let i=0;i<10000;i++)clock.push(Math.round(i*1024/48)/1000,1024,48000);
 assert.equal(clock.samples,10240000);assert.ok(clock.maxErrorSeconds<.000501);
 assert.throws(()=>clock.push(clock.samples/48000+.021,1024,48000),/gap\/drift/);
});
test('audio clock preserves nonzero seek origin and refuses invalid rate/sample metadata',()=>{
 const clock=new JitAudioClock(48000,2/48000);clock.push(900.032,1024,48000);clock.push(900.032+1024/48000,512,48000);
 assert.equal(clock.samples,1536);assert.throws(()=>clock.push(900.064,1024,44100),/Invalid/);
});
