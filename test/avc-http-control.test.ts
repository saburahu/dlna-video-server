import test from 'node:test';import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createServer} from 'node:http';import {once} from 'node:events';
import {createAvcHttpControl,appendAvcControlRoot,AVC_CONTROL_ROOT,type AvcHttpControl} from '../src/avc-http-control.js';
import {snapshotHash} from '../src/playback-shadow.js';import {jitRecipeFingerprint} from '../src/jit-client-trial.js';
import type {CapabilitySnapshot} from '../src/playback-shadow.js';

test('AVC HTTP control preserves identical body with fixed/chunked framing, scoped identity, stale gates, EOF and subsequent requests',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'avc-control-'));
 const fp=async(file:string)=>{const bytes=await fs.readFile(file),s=await fs.stat(file);return {path:file,size:s.size,mtimeMs:s.mtimeMs,sha256:snapshotHash(bytes.toString('base64'))};};
 // Binary hashes use the same SHA-256 as production; text fixtures use ordinary UTF-8 bytes.
 const hash=async(file:string)=>{const {createHash}=await import('node:crypto');const f=await fp(file);return {...f,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')};};
 const source=path.join(dir,'source.mp4'),capture=path.join(dir,'media.m2ts'),reportFile=path.join(dir,'report.json'),indexFile=path.join(dir,'index.json');
 await fs.writeFile(source,'fixture source');const payload=Buffer.alloc(192*120,0xff);for(let i=0;i<120;i++){payload.writeUInt32BE(i*1234,i*192);payload[i*192+4]=0x47;}await fs.writeFile(capture,payload);
 const index={pid:256,packetCount:120,points:[{packet:0,pcr:0,unwrappedPcr:0,discontinuityBefore:false},{packet:119,pcr:2700000,unwrappedPcr:2700000,discontinuityBefore:false}],firstPacket:0,lastPacket:119,durationSeconds:.1,averageBitrate:120*192*8/.1,discontinuities:0,invalidIntervals:0};await fs.writeFile(indexFile,JSON.stringify(index));
 const wireBytes=payload.length+Math.ceil(payload.length/5568)*14;
 const report={passed:true,directory:dir,source,bytes:wireBytes,duplicate:0,decoded:3,retained:3,hrd:{violations:0,underflow:0,overflow:0},receivedLead:{underruns:0},transport:{contentPacket:{bodyExact:true},tts:{all32bitWithinOneTick:true},pcr:{discontinuities:0}}};await fs.writeFile(reportFile,JSON.stringify(report));
 const cap:CapabilitySnapshot={deviceId:'uuid:fixture',remoteIp:'127.0.0.1',controlUrl:'http://127.0.0.1/cm',sink:'',sinkHash:snapshotHash(''),acquiredAt:new Date().toISOString(),origin:'current-read'};
 const profile:any={id:'test',transport:{value:{profileName:'AVC_TS_JP_AAC_T',framing:'jp-content-packet'}},video:{value:{}},audio:{value:{}}};
 const policy:any={enabled:true,capabilities:[cap],policy:{profiles:[profile]},clientTrials:[{version:'jit-client-trial-v1',enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,targetProfile:'test',recipeFingerprint:jitRecipeFingerprint(profile),containers:['mp4'],reference:'explicit test'}]};
 const policyFile=path.join(dir,'policy.json');await fs.writeFile(policyFile,JSON.stringify(policy));
 const contract:AvcHttpControl={version:'avc-http-control-v1',enabled:true,device:{remoteIp:'127.0.0.1',deviceId:cap.deviceId,descriptionUrl:'http://127.0.0.1/device',controlUrl:cap.controlUrl,allowEmptySink:true},sinkHash:cap.sinkHash,source:await hash(source),capture:await hash(capture),validation:await hash(reportFile),index:await hash(indexFile),targetProfile:'test',recipeFingerprint:jitRecipeFingerprint(profile),title:'任意の素材 & AVC',duration:.1,wireBytes};
 const save=()=>fs.writeFile(path.join(dir,'contract.json'),JSON.stringify(contract));await save();let acquisitions=0,identity=cap;const logs:any[]=[];
 const control=createAvcHttpControl(dir,policyFile,(event,detail)=>logs.push({event,detail}),async()=>{acquisitions++;return identity;});
 assert.equal(await control.enabled('192.168.1.20'),false);assert.equal(await control.enabled('127.0.0.1'),true);
 const page=await control.browse({objectId:AVC_CONTROL_ROOT,start:0,count:1,metadata:false},'127.0.0.1','http://test');assert.equal(page?.total,2);assert.equal(page?.numberReturned,1);assert.match(page!.didl,/固定長HTTP/);assert.equal(acquisitions,0);
 const chunkPage=await control.browse({objectId:AVC_CONTROL_ROOT,start:1,count:1,metadata:false},'127.0.0.1','http://test');assert.doesNotMatch(chunkPage!.didl,/ size=/);assert.match(chunkPage!.didl,/chunked対照/);
 const server=createServer((req,res)=>void control.media(req,res,req.url!.slice(1)));server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const fixed=await fetch(base+'/fixed');assert.equal(fixed.status,200);assert.equal(fixed.headers.get('content-length'),String(wireBytes));assert.equal(fixed.headers.get('transfer-encoding'),null);const full=Buffer.from(await fixed.arrayBuffer());assert.equal(full.length,wireBytes);
 const chunked=await fetch(base+'/chunked');assert.equal(chunked.headers.get('content-length'),null);assert.equal(chunked.headers.get('transfer-encoding'),'chunked');assert.deepEqual(Buffer.from(await chunked.arrayBuffer()),full);
 const head=await fetch(base+'/fixed',{method:'HEAD'});assert.equal(head.headers.get('content-length'),String(wireBytes));assert.equal((await head.arrayBuffer()).byteLength,0);
 for(const mode of ['fixed','chunked']){const response=await fetch(base+'/'+mode,{headers:{'TimeSeekRange.dlna.org':'npt=0-0.05'}});assert.equal(response.status,200);assert.match(response.headers.get('timeseekrange.dlna.org')!,/npt=/);await response.arrayBuffer();}
 const range=await fetch(base+'/fixed',{headers:{Range:'bytes=0-99'}});assert.equal(range.status,400);await range.arrayBuffer();
 profile.video.value.level=42;policy.clientTrials[0].recipeFingerprint=jitRecipeFingerprint(profile);await fs.writeFile(policyFile,JSON.stringify(policy));assert.equal(await control.enabled('127.0.0.1'),false);assert.equal((await fetch(base+'/fixed')).status,404);
 delete profile.video.value.level;policy.clientTrials[0].recipeFingerprint=jitRecipeFingerprint(profile);await fs.writeFile(policyFile,JSON.stringify(policy));
 identity={...cap,deviceId:'uuid:other'};assert.equal((await fetch(base+'/fixed')).status,503);identity=cap;
 contract.capture.sha256='0'.repeat(64);await save();assert.equal((await fetch(base+'/fixed')).status,503);
 contract.capture=await hash(capture);contract.enabled=false;await save();assert.equal((await fetch(base+'/fixed')).status,404);
 contract.enabled=true;await save();await fs.unlink(capture);assert.equal(await control.enabled('127.0.0.1'),false);assert.equal((await fetch(base+'/fixed')).status,404);
 await fs.writeFile(path.join(dir,'contract.json'),'{broken');assert.equal(await control.enabled('127.0.0.1'),false);assert.equal((await fetch(base+'/fixed')).status,404);
 assert.ok(logs.some(r=>r.event==='AVC_CONTROL_RESPONSE'&&r.detail.mode==='chunked'&&!r.detail.headers['Content-Length']));
});

test('AVC comparison root is invisible to other clients and appends without altering existing siblings',()=>{
 const xml='<Result>&lt;DIDL-Lite&gt;&lt;container id=&quot;rec&quot;&gt;existing&lt;/container&gt;&lt;/DIDL-Lite&gt;</Result><NumberReturned>1</NumberReturned><TotalMatches>1</TotalMatches>';
 const b={objectId:'0',start:0,count:10,metadata:false};assert.equal(appendAvcControlRoot(xml,b,false),xml);
 const out=appendAvcControlRoot(xml,b,true);assert.match(out,/existing&lt;\/container&gt;/);assert.match(out,/AVC HTTP比較/);assert.match(out,/<NumberReturned>2</);assert.match(out,/<TotalMatches>2</);
});
