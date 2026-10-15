import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createExperimentalJit,inspectJitMetadata,type ExperimentalJitPolicy} from './experimental-jit.js';
import {chooseJitTiming} from './jit-timing-policy.js';
import {AUTOMATIC_CLIENT_VERSION} from './automatic-jit-client.js';
import {ffmpeg,ffprobe,execute} from './prepare-executor.js';
import {TsStabilityAudit} from './ts-stability-audit.js';
import type {DiscoveredClientEndpoint} from './client-family-discovery.js';
import type {ExperimentalEntry} from './experimental-catalog.js';
import {experimentalObjectId} from './experimental-catalog.js';
import {createDirectMedia} from './direct-media.js';

// Real source/executor/HTTP, simulated unknown individual identities and observed
// endpoint features. No TV requests or live registry/config writes.
const [policyFile,auditFile,output,sourceList]=process.argv.slice(2);
if(!policyFile||!auditFile||!output)throw Error('Usage: media:verify-auto-jit <jit.json> <synthetic-endpoint-fixture.json> <output-directory>');
const original=JSON.parse(await fs.readFile(policyFile,'utf8')) as ExperimentalJitPolicy,audit=JSON.parse(await fs.readFile(auditFile,'utf8'));
await fs.mkdir(output,{recursive:true});const rows:any[]=[],events:any[]=[];
for(const family of ['intel-upnp-layout','dixim-service-layout']){
 const observed:DiscoveredClientEndpoint=audit.rows.flatMap((r:any)=>r.endpoints).find((e:DiscoveredClientEndpoint)=>e.capability.implementation?.family===family);assert.ok(observed);
 const directory=path.join(output,family),remote='127.0.0.1',deviceId=`uuid:pc-unregistered-${family}`,controlUrl='http://127.0.0.1/pc-cm';await fs.mkdir(directory,{recursive:true});
 const endpoint={...observed,device:{...observed.device,remoteIp:remote,deviceId,descriptionUrl:'http://127.0.0.1/pc-description',controlUrl},capability:{...observed.capability,remoteIp:remote,deviceId,controlUrl}};
 const sourceOptions=sourceList?JSON.parse(await fs.readFile(sourceList,'utf8')):undefined;
 const p:ExperimentalJitPolicy={...original,capabilities:[],clientTrials:[],items:[],policy:{...original.policy,observations:[]},automaticClients:{version:AUTOMATIC_CLIENT_VERSION,enabled:true,priority:'automatic-first',legacyInputs:!!sourceList||original.automaticClients?.legacyInputs,wmaInputs:sourceOptions?.wmaInputs===true?'source-clock-v1':original.automaticClients?.wmaInputs}};
 await fs.writeFile(path.join(directory,'jit.json'),JSON.stringify(p));
 const service=createExperimentalJit(directory,(category,detail)=>events.push({at:new Date().toISOString(),family,category,detail}),{discover:async()=>[endpoint],capability:async()=>endpoint.capability,devices:async()=>[],inspect:(_d,...a)=>inspectJitMetadata(path.dirname(policyFile),...a),timing:(_d,...a)=>chooseJitTiming(path.dirname(policyFile),...a)});
 const sources=sourceList?JSON.parse(await fs.readFile(sourceList,'utf8')).sources:[original.items[0].sourceFingerprint,original.items[2].sourceFingerprint];
 const entries:ExperimentalEntry[]=[];for(const fingerprint of sources)entries.push({objectId:experimentalObjectId(fingerprint.path).replace('/item/','/catalog-item/'),filename:path.basename(fingerprint.path),fingerprint,sourceState:'unanalysed' as const,decisions:[],lightweightProbe:(await inspectJitMetadata(path.dirname(policyFile),fingerprint)).probe});
 const direct=process.argv.includes('--with-direct')?createDirectMedia(()=>sources.map((s:any)=>path.dirname(s.path)),(category,detail)=>events.push({at:new Date().toISOString(),family,category,detail})):undefined;
 const headers={'user-agent':family==='intel-upnp-layout'?'UPnP/1.0 Intel_SDK_for_UPnP_devices/1.2':'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0'},xml=family==='dixim-service-layout'?'<u:Browse><Filter>funai:dnUrl,res@dlna:cleartextSize</Filter></u:Browse>':'';
 const server=createServer((req,res)=>{void(async()=>{const url=new URL(req.url??'/', 'http://localhost'),index=Number(/(?:browse|media)-(\d+)/.exec(url.pathname)?.[1]??0);assert.ok(entries[index]);if(url.pathname.startsWith('/library/direct/')&&direct){await direct.deliver(req,res,entries.find(e=>url.pathname.endsWith(e.objectId.split('/').at(-1)!)));return;}if(url.pathname.startsWith('/browse')){await service.observeClient(req,xml);res.setHeader('Content-Type','application/json');res.end(JSON.stringify((await service.decorate(entries[index],remote)).jit??null));}else await service.deliver(req,res,entries[index]);})().catch(e=>{res.writeHead(500);res.end(String(e));});});
 server.listen(0,remote);await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const idle=async()=>{for(let i=0;i<100&&service.status().some(s=>s.active||s.executors);i++)await new Promise(r=>setTimeout(r,20));assert.ok(service.status().every(s=>!s.active&&s.executors===0));};
 try{
  await fetch(base+'/browse-0',{headers});await service.automaticIdle();assert.equal(events.filter(e=>e.family===family&&e.category==='EXECUTOR_START').length,0);
  for(let index=0;index<entries.length;index++){
   const resource=await(await fetch(base+'/browse-'+index,{headers})).json();assert.ok(resource.clientBinding);const url=base+'/media-'+index+'?clientBinding='+resource.clientBinding;
   const head=await fetch(url,{method:'HEAD',headers});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),null);assert.match(head.headers.get('contentfeatures.dlna.org')!,/DLNA.ORG_OP=10/);
   const fullAt=performance.now(),eventStart=events.length,fullAbort=new AbortController(),full=await fetch(url,{headers,signal:fullAbort.signal});assert.equal(full.status,200);await full.body!.getReader().read();const fullFirstBody=(performance.now()-fullAt)/1000;
   if(direct){const before=service.status().filter(s=>s.active).map(s=>[s.client,s.executors]);assert.ok(before.length);const original=direct.item(entries[index],base,'vlc-direct:127.0.0.1')!;assert.ok(original);const directUrl=/<res\b[^>]*>([^<]+)<\/res>/.exec(original)![1].replaceAll('&amp;','&');const response=await fetch(directUrl,{headers:{Range:'bytes=0-1048575','User-Agent':'VLC/3.0'}});assert.equal(response.status,206);const received=Buffer.from(await response.arrayBuffer()),handle=await fs.open(entries[index].fingerprint.path,'r');try{const expected=Buffer.alloc(received.length);await handle.read(expected,0,expected.length,0);assert.deepEqual(received,expected);}finally{await handle.close();}assert.deepEqual(service.status().filter(s=>s.active).map(s=>[s.client,s.executors]),before);events.push({at:new Date().toISOString(),family,category:'DIRECT_JIT_OVERLAP_VERIFIED',detail:{source:entries[index].objectId,bytes:received.length,activeJitUnchanged:before}});}
   fullAbort.abort();await idle();assert.ok(fullFirstBody<10,'Full playback waited for excessive preparation');assert.ok(!events.slice(eventStart).some(e=>e.category==='SOURCE_AUDIO_ENDPOINT'),'Full startup must not scan unused audio endpoint evidence');console.log(JSON.stringify({family,index,fullPlaybackStartup:fullFirstBody,stopped:true}));
   const duration=Number(entries[index].lightweightProbe.format.duration);
   const fullDuration=sourceList&&JSON.parse(await fs.readFile(sourceList,'utf8')).fullDuration===true;
   if(fullDuration)assert.ok(duration<=120,'Buffered PC full-duration verifier is limited to a short representative source');
   const ranges=fullDuration?[`npt=0-${duration}`]:['npt=0-8',`npt=${Math.min(120,duration/2)}-${Math.min(120,duration/2)+1}`,`npt=${duration-2}-${duration}`];
   for(const range of ranges){
    const start=performance.now(),response=await fetch(url,{headers:{...headers,'TimeSeekRange.dlna.org':range},signal:AbortSignal.timeout(120000)});assert.equal(response.status,200);assert.equal(response.headers.get('transfer-encoding'),'chunked');assert.equal(response.headers.get('content-length'),null);
    const parts:Buffer[]=[];let first=0;for await(const b of response.body!){if(!first)first=(performance.now()-start)/1000;parts.push(Buffer.from(b));}const wire=Buffer.concat(parts),ts:Buffer[]=[];let packet=0;
    const mpeg=family==='dixim-service-layout',audit=new TsStabilityAudit(mpeg?{pmt:257,pcr:256,video:320,audio:321}:{pmt:4096,pcr:256,video:256,audio:257});
    for(let o=0;o<wire.length;){assert.deepEqual(wire.subarray(o,o+10),Buffer.alloc(10));const n=wire.readUInt32BE(o+10);assert.ok(n>0&&n%192===0&&n<=(mpeg?799872:5568)&&o+14+n<=wire.length);for(let j=o+14;j<o+14+n;j+=192){const p=wire.subarray(j+4,j+192);audit.feed(p,packet++);ts.push(p);}o+=14+n;}
    const stability=audit.finish();for(const k of ['malformed','tei','scrambled','ccErrors','crcErrors','pcrBackwards','audioPtsGaps','audioInvalid'] as const)assert.equal(stability.counts[k],0,k);
    const tsFile=path.join(directory,`${index}-${rows.length}.ts`);await fs.writeFile(tsFile,Buffer.concat(ts));const decode=await execute(ffmpeg(),['-v','error','-nostdin','-i',tsFile,'-map','0:v:0','-map','0:a:0','-f','null','-'],{windowsHide:true,timeout:30000,maxBuffer:1048576});assert.equal(decode.stderr.trim(),'');
    const probe=JSON.parse((await execute(ffprobe(),['-v','error','-show_streams','-of','json',tsFile],{windowsHide:true,timeout:30000,maxBuffer:1048576})).stdout);assert.equal(probe.streams.find((s:any)=>s.codec_type==='video').codec_name,mpeg?'mpeg2video':'h264');assert.equal(probe.streams.find((s:any)=>s.codec_type==='audio').codec_name,'aac');await idle();const result=service.status().find(s=>s.client.endsWith(entries[index].objectId))!.lastResult as any;assert.ok(result.completed);assert.equal(result.underruns,0);if(range==='npt=0-8')assert.ok(result.initialGenerationSpeed>1);
    rows.push({family,source:entries[index].objectId,range,firstBody:first,bytes:wire.length,headers:Object.fromEntries(response.headers),stability,result});console.log(JSON.stringify({family,index,range,firstBody:first,decode:'AV success',underruns:result.underruns}));
   }
   const abort=new AbortController(),cancel=await fetch(url,{headers,signal:abort.signal});await cancel.body!.getReader().read();abort.abort();await idle();
   const follow=await fetch(url,{headers:{...headers,'TimeSeekRange.dlna.org':'npt=2-3'}});assert.equal(follow.status,200);await follow.arrayBuffer();await idle();assert.ok((service.status().find(s=>s.client.endsWith(entries[index].objectId))!.lastResult as any).completed);
  }
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.writeFile(path.join(output,'progress.json'),JSON.stringify({rows,events},null,2));}
}
const selections=events.filter(e=>e.category==='EXPERIMENTAL_JIT_STAGE'&&e.detail.stage==='CLIENT_FAMILY_SELECTION');assert.ok(selections.length);assert.ok(selections.every(e=>e.detail.detail.route==='automatic'&&e.detail.detail.override===false));
await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,scope:'Unknown-identity simulated discovery; automatic-first; real media/executor/HTTP, not receiver verification',rows,events},null,2));
