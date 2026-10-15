import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {startupBlocks,newJitStats} from '../src/jit-stream.js';
import {validateJitSegmentEnd} from '../src/jit-segment.js';
import {ENCODE_RECIPE} from '../src/prepare-executor.js';
const collect=async<T>(input:AsyncIterable<T>)=>{const values:T[]=[];for await(const v of input)values.push(v);return values;};
for(const duration of [.5,1,2])test(`finite ${duration}s EOF drains only after endpoint validation`,async()=>{
 const shift=ENCODE_RECIPE.commonShiftTicks,start=156.8,end=start+duration;
 const stats={...newJitStats(),videoPictures:12,audioFrames:24,pcrIntervals:10,firstVideoPts:Math.ceil(start*90000)+shift,lastVideoPts:Math.floor((end-.04)*90000)+shift,firstAudioPts:Math.ceil(start*90000)+shift-1920,lastAudioFramePts:Math.floor(end*90000)+shift-1920};
 const blocks=[{bytes:Buffer.alloc(100),mediaSeconds:duration/2},{bytes:Buffer.alloc(100),mediaSeconds:duration}];let validated=false,reason='';
 assert.deepEqual(await collect(startupBlocks(Readable.from(blocks),2.2,(_s,_b,r)=>{assert.ok(validated);reason=r;},async()=>{validateJitSegmentEnd(stats,start,end);validated=true;})),blocks);
 assert.equal(reason,'validated-segment-end');
});
test('shortened clean-exit, missing streams, empty output and failed encoder cannot open HTTP',async()=>{
 const stats={...newJitStats(),videoPictures:1,audioFrames:1,pcrIntervals:2,firstVideoPts:ENCODE_RECIPE.commonShiftTicks,lastVideoPts:ENCODE_RECIPE.commonShiftTicks,firstAudioPts:ENCODE_RECIPE.commonShiftTicks,lastAudioFramePts:ENCODE_RECIPE.commonShiftTicks};
 assert.throws(()=>validateJitSegmentEnd(stats,0,1),/endpoint/);assert.throws(()=>validateJitSegmentEnd({...stats,audioFrames:0},0,1),/needs video/);
 await assert.rejects(collect(startupBlocks(Readable.from([]),2.2,()=>assert.fail(),async()=>{})),/Empty/);
 await assert.rejects(collect(startupBlocks(Readable.from([{bytes:Buffer.alloc(1),mediaSeconds:1}]),2.2,()=>assert.fail(),async()=>{throw new Error('encoder exit 1');})),/encoder exit 1/);
});
test('long startup keeps 2.2s gate and does not invoke finite EOF validation after ready',async()=>{
 let reason='';const blocks=[{bytes:Buffer.alloc(1),mediaSeconds:1},{bytes:Buffer.alloc(1),mediaSeconds:2.2},{bytes:Buffer.alloc(1),mediaSeconds:3}];
 assert.deepEqual(await collect(startupBlocks(Readable.from(blocks),2.2,(_s,_b,r)=>reason=r,async()=>assert.fail())),blocks);assert.equal(reason,'buffer-target');
 await assert.rejects(collect(startupBlocks(Readable.from(blocks.slice(0,1)),2.2,()=>assert.fail())),/ended before startup/);
});
test('truncated parser input never reaches finite EOF authorization',async()=>{
 async function* broken(){yield {bytes:Buffer.alloc(1),mediaSeconds:.5};throw new Error('Partial TS packet');}
 await assert.rejects(collect(startupBlocks(broken(),2.2,()=>assert.fail(),async()=>assert.fail())),/Partial TS/);
});

test('A tail after a proven source audio endpoint needs no fabricated audio',()=>{
 const shift=ENCODE_RECIPE.commonShiftTicks,start=1457.7,end=1459.7;
 const stats={...newJitStats(),videoPictures:47,pcrIntervals:39,firstVideoPts:Math.ceil(start*90000)+shift,lastVideoPts:Math.floor((end-.04)*90000)+shift};
 assert.equal(validateJitSegmentEnd(stats,start,end,1454.93).audioCoverage,'source-ended-before-request');
 for(const endpoint of [undefined,NaN,Infinity,start+.1])assert.throws(()=>validateJitSegmentEnd(stats,start,end,endpoint));
 assert.throws(()=>validateJitSegmentEnd({...stats,videoPictures:0},start,end,1454.93));
});

test('independent decoded audio start preserves WMA delay without relaxing the coverage gate',()=>{
 const shift=ENCODE_RECIPE.commonShiftTicks;
 const stats={...newJitStats(),videoPictures:30,pcrIntervals:20,audioFrames:44,firstVideoPts:shift,lastVideoPts:shift+87000,firstAudioPts:shift+6450,lastAudioFramePts:shift+90000-1920};
 assert.throws(()=>validateJitSegmentEnd(stats,0,1),/starts outside/);
 assert.equal(validateJitSegmentEnd(stats,0,1,1,shift,.093).expectedAudioStart,.093);
 assert.throws(()=>validateJitSegmentEnd({...stats,firstAudioPts:shift+18000},0,1,1,shift,.093),/starts outside/);
 assert.throws(()=>validateJitSegmentEnd(stats,0,1,1,shift,NaN),/Invalid source/);
});
