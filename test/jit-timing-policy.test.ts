import {test} from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {chooseJitTiming,rejectJitTiming,hevcQuantizationClock,timingCacheKey} from '../src/jit-timing-policy.js';
const header='vui_timing_info_present_flag 1 = 1\nvui_num_units_in_tick 001 = 1001\nvui_time_scale 001 = 60000';
async function setup(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'timing-policy-')),file=path.join(dir,'source.mkv');await fs.writeFile(file,'synthetic');const st=await fs.stat(file);return {dir,source:{path:file,size:st.size,mtimeMs:st.mtimeMs}};}
test('clock evidence parser rejects nominal-only or inconsistent VUI',()=>{
 assert.ok(hevcQuantizationClock(header));assert.equal(hevcQuantizationClock('average fps=29.97'),undefined);
 assert.equal(hevcQuantizationClock(header+'\nvui_time_scale 01 = 50000'),undefined);
});
test('opt-in GET policy evidence is bounded, cached and source/target/version bound',async t=>{
 const f=await setup();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));let headers=0,scans=0;
 const dependencies={header:async()=>{headers++;return header;},timestamps:async()=>{scans++;return Array.from({length:300},(_,i)=>Math.round(i*3003/90)*90);}};
 const probe={streams:[{codec_type:'video',codec_name:'hevc',time_base:'1/1000',r_frame_rate:'20/1'}]},target={minimumTicks:2989};
 const off=await chooseJitTiming(f.dir,f.source,target,probe,'original',{dependencies});assert.equal(off.clock,undefined);assert.equal(scans,0);
 const head=await chooseJitTiming(f.dir,f.source,target,probe,'quantized-evidence-v1',{dependencies,cacheOnly:true});assert.equal(head.clock,undefined);assert.equal(scans,0);
 const first=await chooseJitTiming(f.dir,f.source,target,probe,'quantized-evidence-v1',{dependencies});assert.ok(first.clock);assert.equal(first.cacheHit,false);
 const second=await chooseJitTiming(f.dir,f.source,target,probe,'quantized-evidence-v1',{dependencies});assert.deepEqual(second.clock,first.clock);assert.ok(second.cacheHit);assert.equal(scans,1);assert.equal(headers,1);
 await chooseJitTiming(f.dir,f.source,{minimumTicks:3000},probe,'quantized-evidence-v1',{dependencies});assert.equal(scans,2);
 assert.notEqual(timingCacheKey(f.source,'target','original'),timingCacheKey(f.source,'target','quantized-evidence-v1'));
 assert.notEqual(timingCacheKey(f.source,'target','quantized-evidence-v1'),timingCacheKey({...f.source,size:1},'target','quantized-evidence-v1'));
 await rejectJitTiming(f.dir,first,'late grid mismatch');assert.equal((await chooseJitTiming(f.dir,f.source,target,probe,'quantized-evidence-v1',{dependencies})).clock,undefined);
});
test('SampleA and SampleB high precision source timestamps keep original contract; no probe scan',async t=>{
 const f=await setup();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
 for(const time_base of ['1/120000','1/30000']){const r=await chooseJitTiming(f.dir,f.source,{time_base},{streams:[{codec_type:'video',codec_name:'h264',time_base}]},'quantized-evidence-v1',{dependencies:{header:async()=>{throw Error('No header');},timestamps:async()=>{throw Error('No scan');}}});assert.equal(r.clock,undefined);}
});
test('insufficient evidence, model mismatch and analysis failure fall back without relaxing target',async t=>{
 const f=await setup();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));const probe={streams:[{codec_type:'video',codec_name:'hevc',time_base:'1/1000',r_frame_rate:'20/1'}]};
 for(const [i,timestamps] of [[0,async()=>[0,3000]],[1,async()=>Array.from({length:200},(_,i)=>i*3600)],[2,async()=>{throw Error('probe failed');}]] as const){
 const r=await chooseJitTiming(f.dir,f.source,{i},probe,'quantized-evidence-v1',{dependencies:{header:async()=>header,timestamps}});assert.equal(r.clock,undefined);}
});

test('auto default selects by evidence, persists choice and shares opt-in timing without source-name rules',async t=>{
 const f=await setup();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));let scans=0;
 const target={minimumTicks:2989},probe={streams:[{codec_type:'video',codec_name:'hevc',time_base:'1/1000',r_frame_rate:'20/1'}]};
 const dependencies={header:async()=>header,timestamps:async()=>{scans++;return Array.from({length:300},(_,i)=>Math.round(i*3003/90)*90);}};
 const auto=await chooseJitTiming(f.dir,f.source,target,probe,undefined,{dependencies});assert.equal(auto.mode,'auto');assert.ok(auto.clock);
 const explicit=await chooseJitTiming(f.dir,f.source,target,probe,'quantized-evidence-v1',{dependencies});assert.deepEqual(auto.clock,explicit.clock);assert.equal(auto.encoderNominalRate,explicit.encoderNominalRate);
 // A fresh chooser call has only the on-disk cache and must not launch probes.
 const cached=await chooseJitTiming(f.dir,f.source,target,probe,undefined,{dependencies:{header:async()=>{throw Error('Must use persistent cache');},timestamps:async()=>{throw Error('Must use persistent cache');}}});assert.equal(cached.cacheHit,true);assert.deepEqual(cached.clock,auto.clock);assert.equal(scans,2);
 const highPrecision=await chooseJitTiming(f.dir,f.source,{differentTarget:true},{streams:[{codec_type:'video',codec_name:'h264',time_base:'1/120000'}]});assert.equal(highPrecision.clock,undefined);
 const unknown=await chooseJitTiming(f.dir,f.source,{unknown:true},{streams:[]});assert.equal(unknown.clock,undefined);
 const insufficient=await chooseJitTiming(f.dir,f.source,{insufficient:true},probe,'auto',{dependencies:{header:async()=>header,timestamps:async()=>[0,3003]}});assert.equal(insufficient.clock,undefined);
});
