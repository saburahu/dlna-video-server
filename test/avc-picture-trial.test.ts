import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createAvcPictureTrial,appendPictureRoot,AVC_PICTURE_ROOT,type PictureTrial} from '../src/avc-picture-trial.js';
import {picturePatternArguments} from '../src/avc-picture-patterns.js';

test('picture patterns change only duration/output and the chosen video filter variable',()=>{
 const original=['-i','source.avi','-vf','select=x,scale=1920:1080,pad=1920:1080,setsar=1','-c:v','libx264','-bf','0','-refs','1','-t','999','-f','mpegts','pipe:1'];
 const baseline=picturePatternArguments(original,'baseline','new.ts');
 assert.equal(original.at(-1),'pipe:1');assert.equal(baseline[baseline.indexOf('-t')+1],'30');
 for(const variant of ['resolution720','cfr2997','cfr23976','cfr24','cfr30'] as const){const next=picturePatternArguments(original,variant,'new.ts');assert.deepEqual(next.map((v,i)=>i===3?'FILTER':v),baseline.map((v,i)=>i===3?'FILTER':v));}
 assert.equal(picturePatternArguments(original,'resolution720','new.ts')[3],'select=x,scale=1280:720,pad=1280:720,setsar=1');
 assert.equal(picturePatternArguments(original,'cfr2997','new.ts')[3],original[3]+',fps=30000/1001:round=near');
 assert.equal(picturePatternArguments(original,'cfr23976','new.ts')[3],original[3]+',fps=24000/1001:round=near');
 assert.equal(picturePatternArguments(original,'cfr24','new.ts')[3],original[3]+',fps=24/1:round=near');
 assert.equal(picturePatternArguments(original,'cfr30','new.ts')[3],original[3]+',fps=30/1:round=near');
 assert.throws(()=>picturePatternArguments([...original.slice(0,-1),'source.avi'],'baseline','source.avi'));
});

test('picture trial scopes Browse and chunked body to one current identity, with stale proof and partial Seek checks',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'picture-trial-'));
 const source=path.join(dir,'source.avi'),capture=path.join(dir,'media.m2ts'),index=path.join(dir,'index.json'),report=path.join(dir,'report.json');
 await fs.writeFile(source,'unchanged source');const bytes=Buffer.alloc(120*192,0xff);for(let i=0;i<120;i++){bytes.writeUInt32BE(Math.round(i*5/120*27000000),i*192);bytes[i*192+4]=0x47;}await fs.writeFile(capture,bytes);
 await fs.writeFile(index,JSON.stringify({pid:256,packetCount:120,points:[{packet:0,pcr:0,unwrappedPcr:0,discontinuityBefore:false},{packet:119,pcr:Math.round(119*5/120*27000000),unwrappedPcr:Math.round(119*5/120*27000000),discontinuityBefore:false}],firstPacket:0,lastPacket:119,durationSeconds:119*5/120,averageBitrate:120*188*8/5,discontinuities:0,invalidIntervals:0}));
 const fp=async(file:string)=>{const s=await fs.stat(file);return {path:file,size:s.size,mtimeMs:s.mtimeMs};};
 const hashed=async(file:string)=>({...await fp(file),sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')});
 const cap={deviceId:'uuid:fixture',remoteIp:'127.0.0.1',sinkHash:'sink',sink:'',acquiredAt:new Date().toISOString(),controlUrl:'http://127.0.0.1/cm',origin:'current-read' as const};let current={...cap};
 await fs.writeFile(report,JSON.stringify({version:'avc-picture-validation-v1',passed:true,variant:'baseline',source:await fp(source),seconds:5,captureHash:(await hashed(capture)).sha256,decode:true,hrd:{violations:0,underflow:0,overflow:0}}));
 const c:PictureTrial={version:'avc-picture-trial-v1',enabled:true,device:{remoteIp:cap.remoteIp,deviceId:cap.deviceId,descriptionUrl:'http://127.0.0.1/device',controlUrl:cap.controlUrl,allowEmptySink:true},sinkHash:cap.sinkHash,source:await fp(source),seconds:5,variants:[{id:'baseline',title:'01 基準 & picture',capture:await hashed(capture),index:await hashed(index),validation:await hashed(report)}]};
 const save=()=>fs.writeFile(path.join(dir,'contract.json'),JSON.stringify(c));await save();const logs:any[]=[];const trial=createAvcPictureTrial(dir,(event,detail)=>logs.push({event,detail}),async()=>current);
 const page=await trial.browse({objectId:AVC_PICTURE_ROOT,start:0,count:1,metadata:false},'127.0.0.1','http://test');assert.equal(page?.total,1);assert.match(page!.didl,/parentID="avc-picture-trial"/);assert.doesNotMatch(page!.didl,/ size=/);assert.match(page!.didl,/&amp;/);
 assert.equal(await trial.count('192.168.1.2'),0);assert.equal((await trial.browse({objectId:AVC_PICTURE_ROOT,start:0,count:0,metadata:false},'192.168.1.2','http://test'))?.total,0);
 assert.equal((await trial.browse({objectId:AVC_PICTURE_ROOT,start:1,count:1,metadata:false},'127.0.0.1','http://test'))?.numberReturned,0);
 const metadata=await trial.browse({objectId:AVC_PICTURE_ROOT+'/baseline',start:0,count:0,metadata:true},'127.0.0.1','http://test');assert.equal(metadata?.numberReturned,1);
 const server=createServer((req,res)=>void trial.media(req,res,'baseline'));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(dir,{recursive:true,force:true});});const url='http://127.0.0.1:'+(server.address() as any).port;
 const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),null);assert.equal(head.headers.get('timeseekrange.dlna.org'),'npt=0.000000-5.000000/5.000000');
 const response=await fetch(url);assert.equal(response.headers.get('transfer-encoding'),'chunked');assert.equal(response.headers.get('content-length'),null);const wire=Buffer.from(await response.arrayBuffer()),payload:Buffer[]=[];for(let i=0;i<wire.length;){const n=wire.readUInt32BE(i+10);payload.push(wire.subarray(i+14,i+14+n));i+=n+14;}assert.deepEqual(Buffer.concat(payload),bytes);assert.ok(logs.some(l=>l.event==='PICTURE_TRIAL_END'&&l.detail.outcome==='completed'));
 const partial=await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=1-2'}});assert.equal(partial.status,200);assert.equal(partial.headers.get('content-length'),null);assert.match(partial.headers.get('timeseekrange.dlna.org')!,/npt=/);await partial.arrayBuffer();
 assert.equal((await fetch(url,{headers:{Range:'bytes=0-9'}})).status,400);assert.equal((await fetch(url,{headers:{'TimeSeekRange.dlna.org':'invalid'}})).status,406);
 current={...cap,deviceId:'uuid:other'};assert.equal((await fetch(url)).status,404);assert.equal(await trial.count('127.0.0.1'),0);current={...cap};
 c.variants[0].capture.sha256='0'.repeat(64);await save();assert.equal((await fetch(url)).status,503);c.variants[0].capture=await hashed(capture);
 c.enabled=false;await save();assert.equal((await fetch(url)).status,404);c.enabled=true;await save();await fs.writeFile(source,'changed');assert.equal(await trial.count('127.0.0.1'),0);
});

test('picture diagnostic root is optional and preserves root page boundaries',()=>{
 const xml='<Result>&lt;/DIDL-Lite&gt;</Result><NumberReturned>1</NumberReturned><TotalMatches>1</TotalMatches>';
 const b={objectId:'0',start:0,count:1,metadata:false};assert.equal(appendPictureRoot(xml,b,0),xml);
 const full=appendPictureRoot(xml,b,3);assert.match(full,/<TotalMatches>2</);assert.match(full,/<NumberReturned>1</);assert.doesNotMatch(full,/AVC映像/);
 const tail=appendPictureRoot(xml.replace('NumberReturned>1','NumberReturned>0'),{...b,start:1},3);assert.match(tail,/AVC映像比較/);assert.match(tail,/<NumberReturned>1</);
});
