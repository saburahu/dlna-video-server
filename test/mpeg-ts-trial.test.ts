import test from 'node:test';import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createServer} from 'node:http';import {once} from 'node:events';import {createHash} from 'node:crypto';
import {createMpegTsTrial,appendMpegTsTrialRoot,MPEG_TS_TRIAL_ROOT,mpegTsTrialProtocol,type MpegTsTrial} from '../src/mpeg-ts-trial.js';
import {mpegTsTrialArguments} from '../src/prepare-mpeg-ts-trial.js';
import {contentPacketLayout} from '../src/content-packet.js';import {packetTime} from '../src/time-seek.js';
import {timestampTicksFromPcrIndex,profiles} from '../src/core.js';import {REGZA_BUFFERED_PROFILE} from '../src/playback-policy.js';

test('bounded MPEG-2 receiver recipe uses TS, MPEG2 AAC copy, interlaced Main High and no production policy change',()=>{
 const a=mpegTsTrialArguments('source.mp4','audio.aac','sample.ts',40);assert.equal(a[a.indexOf('-f')+1],'mpegts');assert.equal(a[a.indexOf('-c:v')+1],'mpeg2video');assert.equal(a[a.indexOf('-c:a')+1],'copy');assert.equal(a[a.indexOf('-level:v')+1],'4');assert.ok(a.includes('+ilme+ildct'));assert.equal(a[a.indexOf('-top')+1],'1');assert.throws(()=>mpegTsTrialArguments('a','a','b',40));assert.throws(()=>mpegTsTrialArguments('a','b','c',150));assert.match(mpegTsTrialProtocol(),/MPEG_TS_JP_T;DLNA.ORG_OP=10;DLNA.ORG_CI=1/);assert.equal(profiles[REGZA_BUFFERED_PROFILE].ci,'0');
});
test('MPEG-2 TS trial is scoped, fixed-length, TTS/Content Packet byte exact, normal EOF/cancel and stale safe',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mpeg-ts-control-')),id='00000000-0000-4000-8000-000000000003',dir=path.join(directory,id);await fs.mkdir(dir);
 const hash=async(file:string)=>{const b=await fs.readFile(file),s=await fs.stat(file);return {path:file,size:s.size,mtimeMs:s.mtimeMs,sha256:createHash('sha256').update(b).digest('hex')};};
 const source=path.join(dir,'source.mp4'),artifact=path.join(dir,'sample.ts'),report=path.join(dir,'validation.json'),indexFile=path.join(dir,'index.json');await fs.writeFile(source,'source');
 const raw=Buffer.alloc(188*2000,0xff);for(let i=0;i<2000;i++)raw[i*188]=0x47;await fs.writeFile(artifact,raw);
 const origin=2**32-2700000,index={pid:256,packetCount:2000,points:[{packet:0,pcr:origin,unwrappedPcr:origin,discontinuityBefore:false},{packet:1999,pcr:origin+135000000,unwrappedPcr:origin+135000000,discontinuityBefore:false}],firstPacket:0,lastPacket:1999,durationSeconds:5,averageBitrate:2000*188*8/5,discontinuities:0,invalidIntervals:0};await fs.writeFile(indexFile,JSON.stringify(index));
 const af=await hash(artifact),sf=await hash(source);await fs.writeFile(report,JSON.stringify({version:'mpeg-ts-trial-validation-v1',passed:true,source:sf,artifact:af,video:{codec_name:'mpeg2video'},audio:{codec_name:'aac'},decode:'complete-video-and-audio'}));
 const layout=contentPacketLayout(index.packetCount*192,index.averageBitrate*192/188),c:MpegTsTrial={version:'mpeg-ts-trial-v1',enabled:true,device:{remoteIp:'127.0.0.1',deviceId:'uuid:receiver',descriptionUrl:'http://127.0.0.1/device',controlUrl:'http://127.0.0.1/cm',allowEmptySink:true},sinkHash:'empty',artifactId:id,source:sf,artifact:af,validation:await hash(report),index:await hash(indexFile),duration:packetTime(index,index.packetCount),wireBytes:layout.servedBytes,title:'任意 & TS',verification:'pc-validated-diagnostic-only'};
 const save=()=>fs.writeFile(path.join(directory,'contract.json'),JSON.stringify(c));await save();let calls=0,deviceId='uuid:receiver';const logs:any[]=[];
 const control=createMpegTsTrial(directory,(event,detail)=>logs.push({event,detail}),async()=>{calls++;return {deviceId,remoteIp:'127.0.0.1',controlUrl:c.device.controlUrl,sink:'',sinkHash:'empty',acquiredAt:new Date().toISOString(),origin:'current-read'};});
 assert.equal(await control.enabled('127.0.0.2'),false);assert.equal(await control.enabled('127.0.0.1'),true);
 assert.equal(await control.protocolInfo('127.0.0.2'),undefined);assert.equal(await control.protocolInfo('127.0.0.1'),mpegTsTrialProtocol());
 const page=await control.browse({objectId:MPEG_TS_TRIAL_ROOT,start:0,count:10,metadata:false},'127.0.0.1','http://test');assert.equal(page?.total,1);assert.match(page!.didl,/任意 &amp; TS/);assert.match(page!.didl,/MPEG_TS_JP_T/);assert.equal(calls,0);
 assert.equal((await control.browse({objectId:MPEG_TS_TRIAL_ROOT,start:1,count:10,metadata:false},'127.0.0.1','http://test'))?.numberReturned,0);
 const server=createServer((req,res)=>void control.media(req,res,id,req.url?.startsWith('/wrong')?'127.0.0.2':'127.0.0.1'));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(directory,{recursive:true,force:true});});const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 assert.equal((await fetch(url+'wrong')).status,404);const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(c.wireBytes));assert.equal((await head.arrayBuffer()).byteLength,0);
 const full=await fetch(url),body=Buffer.from(await full.arrayBuffer());assert.equal(body.length,c.wireBytes);assert.equal(full.headers.get('transfer-encoding'),null);assert.match(full.headers.get('contentfeatures.dlna.org')!,/OP=10/);
 let at=0,packet=0,wraps=0,last=0;while(at<body.length){assert.deepEqual(body.subarray(at,at+10),Buffer.alloc(10));const length=body.readUInt32BE(at+10);at+=14;for(let p=0;p<length;p+=192){const n=body.readUInt32BE(at+p),ticks=Math.floor(timestampTicksFromPcrIndex(packet,index))-13500000,expected=((ticks%2**32)+2**32)%2**32;assert.equal(n,expected);if(packet&&n<last)wraps++;last=n;assert.deepEqual(body.subarray(at+p+4,at+p+192),raw.subarray(packet*188,(packet+1)*188));packet++;}at+=length;}assert.equal(packet,2000);assert.equal(wraps,1);
 const range=await fetch(url,{headers:{Range:'bytes=0-99'}});assert.equal(range.status,400);await range.arrayBuffer();const invalid=await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=100-101'}});assert.equal(invalid.status,406);
 const ac=new AbortController(),cancel=await fetch(url,{signal:ac.signal});await cancel.body!.getReader().read();ac.abort();await new Promise(r=>setTimeout(r,50));
 const next=await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=1-2'}});assert.equal(next.status,200);const nb=await next.arrayBuffer();assert.equal(nb.byteLength,Number(next.headers.get('content-length')));
 // Transfer-only control is opt-in and keeps the successful fixed-length resource intact.
 assert.equal((await fetch(url+'?transfer=chunked')).status,400);
 c.allowChunkedComparison=true;await save();
 assert.equal(await control.childCount('127.0.0.1'),2);assert.equal(await control.childCount('127.0.0.2'),0);
 const rootMeta=await control.browse({objectId:MPEG_TS_TRIAL_ROOT,start:0,count:1,metadata:true},'127.0.0.1','http://test');assert.match(rootMeta!.didl,/childCount="2"/);
 const cp=await control.browse({objectId:MPEG_TS_TRIAL_ROOT,start:0,count:1,metadata:false},'127.0.0.1','http://test');assert.equal(cp!.total,2);assert.equal(cp!.numberReturned,1);assert.equal(cp!.didl,page!.didl);
 const second=await control.browse({objectId:MPEG_TS_TRIAL_ROOT,start:1,count:1,metadata:false},'127.0.0.1','http://test');assert.equal(second!.numberReturned,1);assert.match(second!.didl,/\/chunked"/);assert.match(second!.didl,/\?transfer=chunked/);
 const cm=await control.browse({objectId:MPEG_TS_TRIAL_ROOT+'/'+id+'/chunked',start:0,count:1,metadata:true},'127.0.0.1','http://test');assert.equal(cm!.didl,second!.didl);
 const ch=await fetch(url+'?transfer=chunked',{method:'HEAD'});assert.equal(ch.status,200);assert.equal(ch.headers.get('content-length'),null);assert.equal((await ch.arrayBuffer()).byteLength,0);
 const chunked=await fetch(url+'?transfer=chunked');assert.equal(chunked.headers.get('transfer-encoding'),'chunked');assert.equal(chunked.headers.get('content-length'),null);assert.equal(chunked.headers.get('timeseekrange.dlna.org'),full.headers.get('timeseekrange.dlna.org'));assert.deepEqual(Buffer.from(await chunked.arrayBuffer()),body);
 const cs=await fetch(url+'?transfer=chunked',{headers:{'TimeSeekRange.dlna.org':'npt=1-2'}});assert.equal(cs.headers.get('timeseekrange.dlna.org'),next.headers.get('timeseekrange.dlna.org'));assert.deepEqual(Buffer.from(await cs.arrayBuffer()),Buffer.from(nb));
 assert.equal((await fetch(url+'?transfer=chunked',{headers:{Range:'bytes=0-99'}})).status,400);
 const cancelChunk=new AbortController(),cr=await fetch(url+'?transfer=chunked',{signal:cancelChunk.signal});await cr.body!.getReader().read();cancelChunk.abort();await new Promise(r=>setTimeout(r,50));
 const follow=await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=0-1'}});assert.equal((await follow.arrayBuffer()).byteLength,Number(follow.headers.get('content-length')));
 assert.equal((await fetch(url+'wrong?transfer=chunked')).status,404);
 assert.equal((await fetch(url+'?transfer=invalid')).status,400);
 delete c.allowChunkedComparison;await save();
 deviceId='uuid:changed';assert.equal((await fetch(url)).status,503);deviceId='uuid:receiver';
 // Same payload, separate delivery contract: original broadcast never claims conversion.
 const oldValidation=c.validation;c.mode='original-broadcast';c.source=af;
 c.broadcastProgram={id:'stable-normal-id',filePath:artifact,title:'放送 & 番組',size:af.size,modified:new Date(af.mtimeMs).toISOString(),published:true,analysis:'ok',duration:5,videoCodec:'mpeg2video',audioCodec:'aac'};
 await fs.writeFile(report,JSON.stringify({version:'broadcast-path-control-validation-v1',passed:true,source:af,artifact:af,video:{codec_name:'mpeg2video'},audio:{codec_name:'aac'},remuxed:false}));c.validation=await hash(report);await save();
 assert.match((await control.protocolInfo('127.0.0.1'))!,/CI=0/);
 const bp=await control.browse({objectId:MPEG_TS_TRIAL_ROOT,start:0,count:10,metadata:false},'127.0.0.1','http://test');assert.match(bp!.didl,/duration="00:00:05.000"/);assert.match(bp!.didl,/parentID="mpeg-ts-trial"/);
 const bh=await fetch(url,{method:'HEAD'});assert.equal(bh.headers.get('timeseekrange.dlna.org'),null);assert.match(bh.headers.get('contentfeatures.dlna.org')!,/CI=0/);assert.equal(bh.headers.get('connection'),'keep-alive');
 const bs=await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=1-2'}});assert.equal(bs.status,200);assert.equal((await bs.arrayBuffer()).byteLength,Number(bs.headers.get('content-length')));
 assert.equal((await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=100-101'}})).status,416);
 c.source=sf;await save();assert.equal(await control.enabled('127.0.0.1'),false);
 delete c.mode;delete c.broadcastProgram;await fs.writeFile(report,JSON.stringify({version:'mpeg-ts-trial-validation-v1',passed:true,source:sf,artifact:af,video:{codec_name:'mpeg2video'},audio:{codec_name:'aac'},decode:'complete-video-and-audio'}));c.validation=await hash(report);
 c.artifact.sha256='0'.repeat(64);await save();assert.equal((await fetch(url)).status,503);c.artifact=af;c.enabled=false;await save();assert.equal((await fetch(url)).status,404);
 c.enabled=true;await save();await fs.unlink(artifact);assert.equal(await control.enabled('127.0.0.1'),false);assert.equal((await fetch(url)).status,404);
 await fs.writeFile(path.join(directory,'contract.json'),'{invalid');assert.equal(await control.enabled('127.0.0.1'),false);assert.ok(logs.some(l=>l.event==='MPEG_TS_TRIAL_END'&&l.detail.outcome==='completed'));
});
test('MPEG-2 TS diagnostic root appends without changing existing siblings or other clients',()=>{
 const xml='<Result>&lt;DIDL-Lite&gt;old siblings&lt;/DIDL-Lite&gt;</Result><NumberReturned>2</NumberReturned><TotalMatches>2</TotalMatches>',b={objectId:'0',start:0,count:10,metadata:false};assert.equal(appendMpegTsTrialRoot(xml,b,false),xml);const out=appendMpegTsTrialRoot(xml,b,true);assert.match(out,/old siblings/);assert.match(out,/<TotalMatches>3</);assert.match(out,/MPEG-2 TS/);assert.doesNotMatch(appendMpegTsTrialRoot(xml,{...b,count:2},true),/MPEG-2 TS/);
});
