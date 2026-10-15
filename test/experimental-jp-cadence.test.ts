import {test} from "node:test";import assert from "node:assert/strict";
import {jpCadenceArguments,jpCadenceConfig,cadenceStats} from "../src/experimental-jp-cadence.js";
import {experimentalFormat,type ExperimentalMediaConfig} from "../src/experimental-media.js";
test("cadence pair uses same x264 controls and source, preserves frames in VFR",()=>{
 const a=jpCadenceArguments("source.mp4","a.ts","cfr"),b=jpCadenceArguments("source.mp4","b.ts","vfr"),v=(x:string[],k:string)=>x[x.indexOf(k)+1];
 for(const k of ["-c:v","-profile:v","-level:v","-b:v","-maxrate","-bufsize","-g","-keyint_min","-bf","-refs","-force_key_frames","-fps_mode"])assert.equal(v(a,k),v(b,k));
 assert.equal(v(b,"-vf"),"format=yuv420p");assert.equal(v(b,"-fps_mode"),"passthrough");assert.match(v(b,"-x264-params"),/force-cfr=0/);assert.ok(!b.includes("-r")&&b.includes("-an")&&b.includes("-n"));
});
test("cadence statistics separate picture counts, variable intervals and compressed sizes",()=>{
 const p=[0,1502,4505].map((pts,i)=>({pts,dts:pts,size:10+i,flags:i===0?"K__":"___",stream_index:0}));const s=cadenceStats(p);assert.deepEqual(s.intervalTicks,{1502:1,3003:1});assert.equal(s.frames,3);assert.equal(s.maxPicturesInSecond,3);assert.equal(s.maxAuBytes,12);assert.throws(()=>cadenceStats([...p,{...p[0]}]));
});
test("CFR and VFR isolated configs preserve the successful transport declaration",()=>{
 const b:ExperimentalMediaConfig={file:"old.m2ts",title:"old",durationSeconds:150,address:"localhost",port:19100,udn:"uuid:1111",mode:"remux",videoEncoder:"libx264",videoTreatment:"progressive-reference",audioTreatment:"mpeg2-aac-lc",contentPacket:true,contentPacketBlockBytes:5568,timeSeek:true};
 for(const mode of ["cfr","vfr"] as const)assert.equal(experimentalFormat(jpCadenceConfig(b,"new.m2ts",150,"uuid:2222",mode)).protocolInfo,experimentalFormat(b).protocolInfo);
 assert.throws(()=>jpCadenceConfig({...b,timeSeek:false},"new",150,"uuid:2222","vfr"));
});
