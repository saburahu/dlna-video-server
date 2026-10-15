import {test} from 'node:test';
import assert from 'node:assert/strict';
import {QuantizedSelection,compareQuantizedTiming,reconstructTimestamp,reconstructionFilter,quantizedVideoTimestamp,type QuantizedTimingPolicy} from '../src/quantized-timing.js';
import {jitArguments} from '../src/jit-stream.js';
const policy:QuantizedTimingPolicy={version:'quantized-grid-experiment-v1',originTicks:0,gridNumerator:3003,gridDenominator:2,quantumTicks:90,evidence:'synthetic quantized grid'};
const source=(slots:number[])=>slots.map(n=>Math.round(n*1501.5/90)*90);
test('quantized 33ms deficit resolved without easing minimum or duplicates',()=>{
 const p=source(Array.from({length:300},(_,i)=>i*2)),r=compareQuantizedTiming(p,2989,policy);
 assert.ok(r.a.dropped.length>0);assert.equal(r.b.dropped.length,0);
 assert.equal(r.rows.length,p.length);assert.ok(r.maximumCorrectionTicks<=45);
 assert.ok(r.drops.every(d=>d.classification==='model-resolves-same-pair-deficit'));
});
test('true short bursts remain subject to exact same greedy constraint',()=>{
 const r=compareQuantizedTiming(source(Array.from({length:91},(_,i)=>i)),2989,policy);
 assert.equal(r.b.retained.length,46);assert.equal(r.b.dropped.length,45);
 assert.ok(r.b.retained.slice(1).every((v,i)=>v.pts-r.b.retained[i].pts>=2989));
});
test('restart from checkpoint reproduces selection and absolute corrected PTS',()=>{
 const pts=source(Array.from({length:900},(_,i)=>i*2+(i>400?1:0))),all=new QuantizedSelection(policy,2989);
 const before=pts.slice(0,430).map(p=>all.push(p)),state={...all.state};
 const tail=pts.slice(430).map(p=>all.push(p)),seek=new QuantizedSelection(policy,2989,state);
 assert.deepEqual(pts.slice(430).map(p=>seek.push(p)),tail);assert.equal(before.length,430);
});
test('no cumulative drift at long duration; grid mismatch fails closed',()=>{
 for(const slot of [0,100000,1000000,10000000])assert.ok(Math.abs(reconstructTimestamp(source([slot])[0],policy).correctionTicks)<=45);
 assert.throws(()=>reconstructTimestamp(700,policy),/does not fit/);
 assert.throws(()=>new QuantizedSelection(policy,2989).push(1.5));
 assert.match(reconstructionFilter(policy),/^settb=1\/90000/);
});
test('clock is opt-in; audio, encoder and transport arguments unchanged',()=>{
 const a=jitArguments('source.mkv',2989,150),b=jitArguments('source.mkv',2989,150,undefined,policy);
 const withoutFilter=(v:string[])=>v.filter((_,i)=>i!==v.indexOf('-vf')+1);
 assert.deepEqual(withoutFilter(a),withoutFilter(b));
 assert.ok(!a[a.indexOf('-vf')+1].includes('setpts='));
 assert.ok(b[b.indexOf('-vf')+1].includes(reconstructionFilter(policy)));
 assert.ok(!b[b.indexOf('-vf')+1].includes('fps='));
});
test('seek gates original anchor before reconstruction and restores corrected seed',()=>{
 const seek={requested:1,anchor:{pts:90090,index:60,lastRetainedTimestamp:87087},firstVideoTicks:93093,audioTrimTicks:90240,minimumTicks:2989,policyFingerprint:'test',preRollSeconds:.034};
 const a=jitArguments('source.mkv',2989,4,seek,policy),vf=a[a.indexOf('-vf')+1];
 assert.ok(vf.indexOf('gte(round(t*90000),90090)')<vf.indexOf('settb=1/90000'));
 assert.ok(vf.includes('round(t*90000)-87087'));assert.ok(vf.includes('gte(round(t*90000),93093)'));
});
test('unexplained cadence, duplicate grid slot and malformed checkpoint fail closed',()=>{
 const s=new QuantizedSelection(policy,2989);s.push(0);assert.throws(()=>s.push(1),/collapses/);
 assert.throws(()=>new QuantizedSelection(policy,2989,{nextIndex:1,lastRetained:0}));
 assert.throws(()=>new QuantizedSelection({...policy,evidence:''},2989));
 assert.throws(()=>compareQuantizedTiming([0,3600,7200],2989,policy),/does not fit/);
});
test('runtime reads precise integer video PTS and ignores interleaved audio',()=>{
 assert.equal(quantizedVideoTimestamp('[Parsed_showinfo_0 @ 123] n: 1 pts:1500123 pts_time:1500.12 fmt:yuv420p'),135011070);
 assert.equal(quantizedVideoTimestamp('[Parsed_showinfo_0 @ 123] color_range:tv n:435 pts:445456 pts_time:9.280333 fmt:fltp'),undefined);
 assert.equal(quantizedVideoTimestamp('[Parsed_ashowinfo_0 @ 123] n: 1 pts:1500123 pts_time:31.2'),undefined);
});

test('quantized encoder nominal rate restores initialization metadata without CFR, offset or audio changes',()=>{
 const old=jitArguments('source.mkv',2989,150,undefined,policy),fixed=jitArguments('source.mkv',2989,150,undefined,policy,'20/1');
 const at=old.indexOf('-x264-params')+1;
 assert.equal(fixed[at],old[at]+':fps=20/1');
 assert.deepEqual(fixed.filter((_,i)=>i!==at),old.filter((_,i)=>i!==at));
 assert.ok(!fixed.includes('-r:v'));assert.ok(!fixed[fixed.indexOf('-vf')+1].includes('fps='));
 assert.deepEqual(jitArguments('source.mp4',2989,150,undefined,undefined,'20/1'),jitArguments('source.mp4',2989,150));
 assert.throws(()=>jitArguments('source.mkv',2989,150,undefined,policy,'20/1:vbv=0'));
});
