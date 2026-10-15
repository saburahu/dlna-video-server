import {test} from "node:test";
import assert from "node:assert/strict";
import {jpInterlacedArguments,jpInterlacedConfig,validateJpInterlacedPackets} from "../src/experimental-jp-interlaced.js";
import {experimentalFormat,type ExperimentalMediaConfig} from "../src/experimental-media.js";
test("JP interlaced contrast copies existing video and AAC and preserves JP framing and seek declaration",()=>{
  const a=jpInterlacedArguments("hd60.m2ts","jp.m2ts",128523,"new.ts");assert.equal(a[a.indexOf("-c")+1],"copy");assert.ok(!a.includes("-vf")&&!a.includes("-c:a"));assert.equal(a[a.indexOf("-pcr_period")+1],"50");assert.ok(a.includes("-n"));
  const baseline:ExperimentalMediaConfig={file:"jp.m2ts",title:"JP",durationSeconds:150,address:"localhost",port:19097,udn:"uuid:1111",mode:"remux",timeSeek:true,contentPacket:true,contentPacketBlockBytes:5568,audioTreatment:"mpeg2-aac-lc",videoTreatment:"vfr-idr",videoEncoder:"libx264"};
  const c=jpInterlacedConfig(baseline,"new.m2ts",150,"uuid:2222");assert.equal(experimentalFormat(c).protocolInfo,experimentalFormat(baseline).protocolInfo);assert.equal(c.contentPacketBlockBytes,5568);assert.equal(c.timeSeek,true);assert.equal(c.audioTreatment,baseline.audioTreatment);
  assert.throws(()=>jpInterlacedConfig({...baseline,contentPacket:false},"new",150,"uuid:2222"));
});
test("JP interlaced gate rejects AAC byte/timestamp changes and irregular video clock",()=>{
  const video=Array.from({length:121},(_,i)=>({stream_index:0,pts:126480+i*3003,dts:126480+i*3003,size:10,data_hash:`v${i}`,flags:i%60===0?"K_":"__"}));
  const audio=Array.from({length:180},(_,i)=>({stream_index:1,pts:253083+i*1920,dts:253083+i*1920,size:10,data_hash:`a${i}`,flags:"K_"}));
  const output=[...video.map(p=>({...p,pts:p.pts+128523,dts:p.dts+128523})),...audio];assert.equal(validateJpInterlacedPackets(video,audio,output,128523).keyFrames,3);
  for(const mutate of [(p:typeof output)=>p[121].pts++,(p:typeof output)=>p[121].data_hash="bad",(p:typeof output)=>p[2].dts++]){const p=output.map(v=>({...v}));mutate(p);assert.throws(()=>validateJpInterlacedPackets(video,audio,p,128523));}
});
