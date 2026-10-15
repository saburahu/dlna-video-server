import {test} from "node:test";import assert from "node:assert/strict";
import {jpProgressiveArguments,jpProgressiveConfig} from "../src/experimental-jp-progressive.js";
import {hd60Arguments} from "../src/experimental-hd60.js";
import {experimentalFormat,type ExperimentalMediaConfig} from "../src/experimental-media.js";
test("progressive scan contrast preserves x264 rate control, profile, GOP and copied AAC without frame filters",()=>{
 const a=jpProgressiveArguments("success.m2ts","new.ts"),ref=hd60Arguments("success.m2ts","old.ts"),value=(x:string[],k:string)=>x[x.indexOf(k)+1];
 for(const k of ["-c:v","-preset","-profile:v","-level:v","-g","-keyint_min","-bf","-refs","-b:v","-maxrate","-bufsize","-fps_mode","-muxrate","-muxdelay","-mpegts_copyts"])assert.equal(value(a,k),value(ref,k),k);
 assert.equal(value(a,"-vf"),"setfield=prog,format=yuv420p");assert.ok(!value(a,"-vf").includes("fps=")&&!value(a,"-vf").includes("yadif"));assert.equal(value(a,"-c:a"),"copy");assert.equal(value(a,"-pcr_period"),"50");assert.ok(a.includes("-n")&&!a.includes("-t")&&!a.includes("-top"));
 assert.equal(value(a,"-x264-params"),value(ref,"-x264-params").replace("interlaced=1:tff=1:","interlaced=0:"));assert.throws(()=>jpProgressiveArguments("same","same"));
});
test("progressive JP config changes video marker and identity but not transport contract",()=>{
 const b:ExperimentalMediaConfig={file:"old.m2ts",title:"success",durationSeconds:150,address:"localhost",port:19099,udn:"uuid:1111",mode:"remux",contentPacket:true,contentPacketBlockBytes:5568,timeSeek:true,audioTreatment:"mpeg2-aac-lc",videoTreatment:"interlaced-reference",videoEncoder:"libx264"};
 const c=jpProgressiveConfig(b,"new.m2ts",150,"uuid:2222");assert.equal(experimentalFormat(c).protocolInfo,experimentalFormat(b).protocolInfo);assert.equal(experimentalFormat(c).strategy.copyVideo,false);
 const {file,title,port,udn,videoTreatment,...a}=c,{file:f,title:t,port:p,udn:u,videoTreatment:v,...original}=b;assert.deepEqual(a,original);
 assert.throws(()=>jpProgressiveConfig({...b,timeSeek:false},"new",150,"uuid:2222"));
});
