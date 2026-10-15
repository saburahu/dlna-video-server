import {test} from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {mkdtemp,writeFile,stat,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {AddressInfo} from "node:net";
import type {PcrIndex} from "../src/core.js";
import {createExperimentalServer,experimentalFormat,experimentalDidl,type ExperimentalMediaConfig} from "../src/experimental-media.js";
import {timeSeekSlice,formatNpt} from "../src/time-seek.js";

test("JP time seek preserves complete wrapped GET bytes and reuses normal boundary contract",async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"pt3-exp-seek-")),file=path.join(dir,"test.m2ts"),bytes=Buffer.alloc(400*192);
  for(let i=0;i<400;i++){bytes.writeUInt32BE(2**30+i*27000,i*192);bytes[i*192+4]=0x47;}
  await writeFile(file,bytes);const before=await stat(file);
  const index:PcrIndex={pid:256,packetCount:400,points:[0,399].map(packet=>({packet,pcr:packet*27000,unwrappedPcr:packet*27000,discontinuityBefore:false})),firstPacket:0,lastPacket:399,durationSeconds:.4,averageBitrate:bytes.length*8/.4,discontinuities:0,invalidIntervals:0};
  const cfg:ExperimentalMediaConfig={file,title:"test",durationSeconds:.4,address:"127.0.0.1",port:0,udn:"uuid:1111",mode:"remux",contentPacket:true,contentPacketBlockBytes:1920};
  const logs:{category:string;detail:any}[]=[],servers=[false,true].map(timeSeek=>createExperimentalServer({...cfg,timeSeek},(category,_m,detail)=>logs.push({category,detail}),index));
  for(const s of servers){s.listen(0,"127.0.0.1");await once(s,"listening");}
  t.after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}await rm(dir,{recursive:true,force:true});});
  const urls=servers.map(s=>`http://127.0.0.1:${(s.address() as AddressInfo).port}/media/sampleA.tts`);
  const old=await fetch(urls[0]),current=await fetch(urls[1]),body=Buffer.from(await current.arrayBuffer());
  assert.deepEqual(body,Buffer.from(await old.arrayBuffer()));assert.equal(current.headers.get("content-length"),old.headers.get("content-length"));
  assert.equal(current.headers.get("accept-ranges"),"none");assert.match(current.headers.get("contentfeatures.dlna.org")!,/OP=10/);
  const didl=experimentalDidl({...cfg,timeSeek:true},body.length,"tts:sampleA",true);assert.match(didl.wrap(didl.entries),/OP=10/);
  for(const method of ["GET","HEAD"]){const r=await fetch(urls[1],{method,headers:{Range:"bytes=0-192"}});assert.equal(r.status,400);assert.equal((await r.arrayBuffer()).byteLength,0);}
  for(const header of ["npt=0.123-0.257","npt=0.39-"]){const slice=timeSeekSlice(index,1920,header);const r=await fetch(urls[1],{headers:{"TimeSeekRange.dlna.org":header,"transferMode.dlna.org":"Streaming","getcontentFeatures.dlna.org":"1"}});
    assert.equal(r.status,200);assert.equal(r.headers.get("content-range"),null);assert.equal(r.headers.get("content-length"),String(slice.wireBytes));
    assert.equal(r.headers.get("timeseekrange.dlna.org"),`npt=${formatNpt(slice.actualStart)}-${formatNpt(slice.actualEnd)}/${formatNpt(slice.duration)} bytes=${slice.startByte}-${slice.startByte+slice.wireBytes-1}/${body.length}`);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()),body.subarray(slice.startByte,slice.startByte+slice.wireBytes));assert.equal(slice.firstPacket%10,0);
  }
  const head=await fetch(urls[1],{method:"HEAD",headers:{"TimeSeekRange.dlna.org":"npt=0.1-0.2"}});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
  for(const h of ["npt=5-","garbage"]){const r=await fetch(urls[1],{headers:{"TimeSeekRange.dlna.org":h}});assert.equal(r.status,416);await r.arrayBuffer();}
  assert.ok(logs.some(l=>l.category==="HTTP_MEDIA_RESPONSE"&&l.detail.timeSlice));
  assert.ok(logs.some(l=>l.category==="HTTP_MEDIA"&&l.detail.headers?.["getcontentfeatures.dlna.org"]==="1"));
  assert.equal((await stat(file)).mtimeMs,before.mtimeMs);
});
test("time seek remains unavailable for MP4 and HD60",()=>{
  const c:ExperimentalMediaConfig={file:"test.m2ts",title:"test",durationSeconds:150,address:"localhost",port:0,udn:"uuid:1111",timeSeek:true};
  assert.throws(()=>experimentalFormat(c));assert.match(experimentalFormat({...c,mode:"remux"}).features,/OP=10/);
  assert.throws(()=>experimentalFormat({...c,mode:"remux",contentPacket:true,dlnaProfile:"AVC_TS_HD_60_AC3_T"}));
});

test("raw JP diagnostic preserves TTS bytes, OP10 and packet-aligned time seek",async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"pt3-raw-jp-")),file=path.join(dir,"raw.m2ts"),bytes=Buffer.alloc(400*192);
  for(let i=0;i<400;i++){bytes.writeUInt32BE(2**30+i*27000,i*192);bytes[i*192+4]=0x47;}
  await writeFile(file,bytes);const before=await stat(file);
  const index:PcrIndex={pid:256,packetCount:400,points:[0,399].map(packet=>({packet,pcr:packet*27000,unwrappedPcr:packet*27000,discontinuityBefore:false})),firstPacket:0,lastPacket:399,durationSeconds:.4,averageBitrate:bytes.length*8/.4,discontinuities:0,invalidIntervals:0};
  const cfg:ExperimentalMediaConfig={file,title:"raw diagnostic",durationSeconds:.4,address:"127.0.0.1",port:0,udn:"uuid:1111",mode:"remux",timeSeek:true,contentPacket:false};
  const server=createExperimentalServer(cfg,()=>{},index);server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/media/sampleA.tts`;
  const full=await fetch(url);assert.equal(full.headers.get("content-length"),String(bytes.length));assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
  assert.match(full.headers.get("contentfeatures.dlna.org")!,/AVC_TS_JP_AAC_T;DLNA.ORG_OP=10/);assert.equal(full.headers.get("accept-ranges"),"none");
  const h="npt=0.123-0.257",slice=timeSeekSlice(index,192,h),response=await fetch(url,{headers:{"TimeSeekRange.dlna.org":h}});
  const expected=bytes.subarray(slice.firstPacket*192,slice.endPacket*192);
  assert.equal(response.status,200);assert.equal(response.headers.get("content-length"),String(expected.length));assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
  assert.match(response.headers.get("timeseekrange.dlna.org")!,new RegExp(`bytes=${slice.firstPacket*192}-${slice.endPacket*192-1}/${bytes.length}$`));
  const range=await fetch(url,{headers:{Range:"bytes=0-191"}});assert.equal(range.status,400);await range.arrayBuffer();
  const head=await fetch(url,{method:"HEAD"});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
  assert.equal((await stat(file)).mtimeMs,before.mtimeMs);
});
