import {test} from "node:test";import assert from "node:assert/strict";
import {pictureWindows,jitterOffset,patchLowDensityJitter} from "../src/experimental-jp-jitter.js";
test("moving windows keep artificial VFR low-density over all phases",()=>{const a=Array.from({length:4496},(_,i)=>i*3003),c=a.map((p,i)=>p+jitterOffset(i,a.length));assert.deepEqual(pictureWindows(a),{100:3,250:8,500:15,1000:30});assert.deepEqual(pictureWindows(c),{100:4,250:8,500:16,1000:30});assert.equal(c[0],a[0]);assert.equal(c.at(-1),a.at(-1));assert.ok(c.every((p,i)=>i===0||p>c[i-1]));assert.ok(a.every((p,i)=>i%60!==0||p===c[i]));});
test("unverified clock/count and unordered windows are refused",()=>{assert.throws(()=>pictureWindows([1,1]));assert.throws(()=>patchLowDensityJitter(Buffer.alloc(192),256,4495,Buffer.from([7,1]),10,15));});
test("bounded in-place patch preserves packet placement and changes corresponding PES/SEI only",()=>{
 const packets=Array.from({length:4496},(_,i)=>{
  const delay=(i%60)*2,sei=Buffer.from([0,0,1,6,1,3,delay>>7,(delay&127)<<1,0,128]);
  const sps=i===0?Buffer.from([0,0,1,103,128]):Buffer.alloc(0),aud=Buffer.from([0,0,1,9,16]);
  const pes=Buffer.concat([Buffer.from([0,0,1,224,0,0,128,128,5,33,0,1,0,1]),sps,aud,sei]);
  const ts=Buffer.alloc(192,255);ts.writeUInt32BE(i+1,0);ts[4]=71;ts[5]=65;ts[6]=0;ts[7]=48|(i%16);const length=183-pes.length;ts[8]=length;ts[9]=0;pes.copy(ts,9+length);return ts;
 });
 const original=Buffer.concat(packets),result=patchLowDensityJitter(original,256,4496,Buffer.from([103,128]),8,15);
 assert.equal(result.changedPictures,2247);assert.equal(result.output.length,original.length);
 for(let i=0;i<4496;i++)assert.ok(result.output.subarray(i*192,i*192+9).equals(original.subarray(i*192,i*192+9)));
 assert.ok(!original.equals(result.output));assert.equal(original[original.indexOf(Buffer.from([0,0,1,103]))+4],128);
 const plan={offsets:Array(4496).fill(0),removalDelays:Array(4496).fill(10),spsFields:[]};
 const retimed=patchLowDensityJitter(original,256,4496,Buffer.from([103,128]),8,15,plan);assert.equal(retimed.output.length,original.length);assert.equal(retimed.changedPictures,4496);for(let i=0;i<4496;i++)assert.ok(retimed.output.subarray(i*192,i*192+9).equals(original.subarray(i*192,i*192+9)));
 assert.throws(()=>patchLowDensityJitter(original,256,4496,Buffer.from([103,128]),8,15,{...plan,removalDelays:Array(4496).fill(2**19)}));
 const broken=Buffer.from(original);const seiAt=broken.indexOf(Buffer.from([0,0,1,6,1,3]));broken[seiAt+8]=128;assert.throws(()=>patchLowDensityJitter(broken,256,4496,Buffer.from([103,128]),8,15));
});
import {jpClockControlConfig,jpJitterConfig} from '../src/experimental-jp-jitter.js';
import {experimentalFormat,type ExperimentalMediaConfig} from '../src/experimental-media.js';
test('clock control preserves JP transport contract without mutating its baseline',()=>{const baseline:ExperimentalMediaConfig={file:'a.m2ts',title:'A',durationSeconds:150,address:'10.254.254.119',port:19101,udn:'uuid:abc',mode:'remux',ssdp:false,videoTreatment:'progressive-reference',videoEncoder:'libx264',timeSeek:true,contentPacket:true,contentPacketBlockBytes:5568,audioTreatment:'mpeg2-aac-lc',pcrLeadMs:1100};const saved={...baseline},c=jpJitterConfig(baseline,'c.m2ts','uuid:ccc'),e=jpClockControlConfig(baseline,'e.m2ts','uuid:eee');const contract=(v:ExperimentalMediaConfig)=>{const {file,title,port,udn,...rest}=v;return rest;};assert.deepEqual(contract(e),contract(c));assert.equal(experimentalFormat(e).protocolInfo,experimentalFormat(c).protocolInfo);assert.equal(e.port,19105);assert.deepEqual(baseline,saved);assert.throws(()=>jpClockControlConfig({...baseline,pcrLeadMs:3000},'e.m2ts','uuid:eee'));});
