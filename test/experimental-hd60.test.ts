import {test} from "node:test";
import assert from "node:assert/strict";
import {hd60Arguments,checkHd60Packets,HD60_PROFILE,rawHd60Config} from "../src/experimental-hd60.js";
import {experimentalFormat,experimentalDidl,type ExperimentalMediaConfig} from "../src/experimental-media.js";
test("HD60 reference creates real top-field interlace and AC3 in a bounded offline output",()=>{
  const a=hd60Arguments("original.mp4","new.ts"),value=(key: string)=>a[a.indexOf(key)+1];
  assert.equal(value("-t"),"150");assert.equal(value("-c:a"),"ac3");assert.equal(value("-level:v"),"4.0");
  assert.match(value("-vf"),/fps=60000\/1001:round=near,tinterlace=interleave_top/);
  assert.equal(value("-pcr_period"),"40");assert.ok(a.includes("-n") && !a.includes("-y"));assert.notEqual(a.at(-1),"original.mp4");
});
test("HD60 PN is restricted to its independent reference; old experiments retain JP and direct declarations",()=>{
  const base:ExperimentalMediaConfig={file:"ref.m2ts",title:"ref",durationSeconds:150,address:"localhost",port:19095,udn:"uuid:1111",mode:"remux"};
  assert.match(experimentalFormat(base).protocolInfo,/AVC_TS_JP_AAC_T/);
  assert.throws(()=>experimentalFormat({...base,dlnaProfile:HD60_PROFILE}));
  const reference:ExperimentalMediaConfig={...base,dlnaProfile:HD60_PROFILE,audioTreatment:"ac3-reference",videoTreatment:"interlaced-reference"};
  assert.match(experimentalDidl(reference,100,"tts:sampleA",true).wrap(experimentalDidl(reference,100,"tts:sampleA",true).entries),/AVC_TS_HD_60_AC3_T/);
  assert.equal(experimentalFormat(reference).strategy.copyVideo,false);assert.equal(experimentalFormat(reference).strategy.copyAudio,false);
  assert.throws(()=>experimentalFormat({...reference,mode:"direct"}));
});
test("HD60 packet validation rejects cadence breaks, wrong AAC clock and missing initial random access",()=>{
  const packets=[...Array.from({length:4500},(_,i)=>({stream_index:0,pts:126000+i*3003,dts:126000+i*3003,flags:i%60===0?"K_":"__"})),...Array.from({length:4688},(_,i)=>({stream_index:1,pts:126000+i*2880,dts:126000+i*2880,flags:"K_"}))];
  assert.equal(checkHd60Packets(packets).keyFrames,75);
  for(const change of [(p:typeof packets)=>p[2].pts++,(p:typeof packets)=>p[4501].pts+=1920,(p:typeof packets)=>p[0].flags="__"]){const p=packets.map(v=>({...v}));change(p);assert.throws(()=>checkHd60Packets(p));}
});
test("raw TTS countertrial preserves the same encoded file, PN, AV treatments and PCR lead",()=>{
  const wrapped:ExperimentalMediaConfig={file:"same.m2ts",title:"reference",durationSeconds:150,address:"localhost",port:19095,udn:"uuid:1111",mode:"remux",dlnaProfile:HD60_PROFILE,audioTreatment:"ac3-reference",videoTreatment:"interlaced-reference",contentPacket:true,contentPacketBlockBytes:5568,pcrLeadMs:1100};
  const raw=rawHd60Config(wrapped,"uuid:2222");
  assert.equal(raw.file,wrapped.file);assert.equal(raw.contentPacket,false);assert.equal(raw.contentPacketBlockBytes,undefined);assert.equal(raw.pcrLeadMs,1100);
  assert.equal(experimentalFormat(raw).protocolInfo,experimentalFormat(wrapped).protocolInfo);
  const {port,title,udn,contentPacket,contentPacketBlockBytes,...a}=wrapped;
  const {port:p,title:t,udn:u,contentPacket:c,contentPacketBlockBytes:b,...other}=raw;
  assert.deepEqual(other,a);assert.equal(wrapped.contentPacket,true);
  assert.throws(()=>rawHd60Config({...wrapped,pcrLeadMs:3000},"uuid:2222"));
  assert.throws(()=>rawHd60Config({...wrapped,audioTreatment:"mpeg2-aac-lc"},"uuid:2222"));
});
