import {jitRecipeFingerprint} from '../src/jit-client-trial.js';
import {mpeg2JitProfile,MPEG2_JIT_PROTOCOL,MPEG2_JIT_FEATURES} from '../src/mpeg2-jit-target.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createExperimentalCatalog, experimentalObjectId, CATALOG_VERSION, type ExperimentalEntry } from '../src/experimental-catalog.js';
import { createExperimentalJit, inspectJitMetadata, jitMetadataPath, type ExperimentalJitPolicy } from '../src/experimental-jit.js';
import { jitExecutorKind } from '../src/jit-strategy.js';
import { snapshotHash } from '../src/playback-shadow.js';
import { JIT_PROTOCOL } from '../src/jit-server.js';
import { browseDIDL } from '../src/upnp.js';
import { profiles } from '../src/core.js';
import {openMediaIndex} from '../src/media-catalog-index.js';
import {resolveJitClient} from '../src/jit-client-policy.js';
import {FAMILY_VERSION} from '../src/client-family.js';

test('six client MP4/MKV matrix: fingerprint-bound trials and cached Browse/current GET share exact UDN/target',async t=>{
 const f=await setup();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));const p=f.policy;
 p.catalogMetadataResources=true;p.items=[];
 p.policy.capabilities={encoders:[{codec:'h264',available:true},{codec:'mpeg2video',available:true},{codec:'aac',available:true}],decoders:[{codec:'h264',available:true},{codec:'hevc',available:true},{codec:'aac',available:true}]};
 const zp={...p.capabilities[0],remoteIp:'192.168.1.113'};p.capabilities[0]=zp;const dbr={...zp,deviceId:'uuid:recorder',remoteIp:'192.168.1.42',sink:'',sinkHash:snapshotHash('')},tv={...dbr,deviceId:'uuid:other-client',remoteIp:'192.168.1.30'},mpeg=mpeg2JitProfile();
 p.capabilities.push(dbr,tv);p.policy.profiles.push(mpeg);
 p.clientTrials=[dbr,tv].map(c=>{const target=c===dbr?mpeg:p.policy.profiles[0];return {version:'jit-client-trial-v1',enabled:true,deviceId:c.deviceId,sinkHash:c.sinkHash,targetProfile:target.id,recipeFingerprint:jitRecipeFingerprint(target),containers:['mp4','matroska'],reference:'operator permitted; not receive advertisement or success'};});
 const implementation={version:FAMILY_VERSION,fingerprint:snapshotHash('endpoint implementation'),family:'intel-upnp-layout'};
 const candidates=['70','103'].map(n=>({...tv,deviceId:'uuid:candidate-'+n,remoteIp:'192.168.1.'+n,implementation}));p.capabilities.push(...candidates);
 p.clientTrials.push(...candidates.map(c=>({...p.clientTrials![1],deviceId:c.deviceId,familyEvidence:{version:FAMILY_VERSION as typeof FAMILY_VERSION,family:implementation.family,endpointFingerprint:implementation.fingerprint,requestFingerprint:snapshotHash('observed request'),observedAt:new Date().toISOString(),reference:'Observed request/endpoint association; unverified candidate'}})));
 await fs.writeFile(path.join(f.dir,'jit.json'),JSON.stringify(p));
 let wrongIdentity=false,wrongImplementation=false;const started:{deviceId:string;profile:string}[]=[];
 const service=createExperimentalJit(f.dir,()=>{},{inspect:async(_d,fp)=>({cacheHit:true,probe:entries.find(e=>e.fingerprint.path===fp.path)!.lightweightProbe}),devices:async()=>p.capabilities.map(c=>({...c,descriptionUrl:'http://test'})),capability:async d=>({...p.capabilities.find(c=>c.deviceId===d.deviceId)!,...(wrongIdentity?{deviceId:dbr.deviceId}:{}),...(wrongImplementation?{implementation:{...implementation,fingerprint:'changed'}}:{})}),timing:async(_d,source,target)=>({version:'fixture',key:'original',sourceFingerprint:source,targetTimingFingerprint:snapshotHash(JSON.stringify(target)),mode:'original',assessment:{},cacheHit:true}),createRuntime:async(_c,input)=>{started.push({deviceId:input!.reference.capabilitySnapshot.deviceId,profile:input!.reference.targetProfile});return {server:createServer(),status:()=>({state:'stopped',active:false,executors:0,maxConcurrentExecutors:1,cancellations:0,lastResult:undefined}),stop:async()=>{},handle:async(_req,res)=>{res.writeHead(200);res.end(input!.reference.targetProfile);}};}});
 const entries:ExperimentalEntry[]=[];for(const container of ['mp4','matroska']){const file=path.join(f.dir,container+'.media');await fs.writeFile(file,'fixture');const st=await fs.stat(file);entries.push({objectId:experimentalObjectId(file).replace('/item/','/catalog-item/'),filename:path.basename(file),fingerprint:{path:file,size:st.size,mtimeMs:st.mtimeMs},sourceState:'unanalysed',decisions:[],lightweightProbe:{format:{duration:'1798.195',format_name:container},executionDecoders:['h264','hevc','aac'],streams:[{codec_type:'video',codec_name:container==='mp4'?'h264':'hevc',profile:'Main',level:container==='mp4'?40:120,width:1920,height:1080,pix_fmt:'yuv420p',field_order:'progressive'},{codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2}]}});}
 const server=createServer((req,res)=>{void service.deliver(req,res,entries[req.url==='/mkv'?1:0]);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 for(const entry of entries){for(const [cap,target] of [[zp,'jp'],[dbr,mpeg.id],[tv,'jp'],...candidates.map(c=>[c,'jp'] as const)] as const){const decorated=await service.decorate(entry,cap.remoteIp);assert.equal(decorated.jit?.targetProfile,target);assert.equal(decorated.jit?.protocolInfo,target===mpeg.id?MPEG2_JIT_PROTOCOL:JIT_PROTOCOL);const r=await fetch(base+(entry===entries[1]?'/mkv':''),{headers:{'x-pt3-jit-verify':snapshotHash(JSON.stringify(p)),'x-pt3-jit-device':cap.deviceId,'User-Agent':'same-REGZA-UA'}});assert.equal(r.status,200);assert.equal(await r.text(),target);assert.deepEqual(started.at(-1),{deviceId:cap.deviceId,profile:target});}assert.equal((await service.decorate(entry,'192.168.1.99')).jit,undefined);assert.equal((await fetch(base,{headers:{'User-Agent':'same-REGZA-UA'}})).status,503);}
 wrongIdentity=true;const before=started.length;assert.equal((await fetch(base,{headers:{'x-pt3-jit-verify':snapshotHash(JSON.stringify(p)),'x-pt3-jit-device':tv.deviceId}})).status,503,'Same empty Sink hash cannot substitute another UDN');assert.equal(started.length,before);
 wrongIdentity=false;wrongImplementation=true;for(const cap of candidates){const n=started.length;assert.equal((await fetch(base,{headers:{'x-pt3-jit-verify':snapshotHash(JSON.stringify(p)),'x-pt3-jit-device':cap.deviceId}})).status,503);assert.equal(started.length,n,'Fingerprint change cannot start encoder');}
 const ambiguous=structuredClone(p);ambiguous.capabilities.push({...tv,deviceId:'uuid:collision'});assert.equal(resolveJitClient(ambiguous,tv.remoteIp).reason,'ambiguous-client-address');
 const noTrial=structuredClone(p);noTrial.clientTrials=noTrial.clientTrials!.filter(t=>t.deviceId!==tv.deviceId);assert.equal(resolveJitClient(noTrial,tv.remoteIp).profile,undefined,'DMS Source and sibling success never authorize reception');
 const advertisedOnly=structuredClone(noTrial);Object.assign(advertisedOnly.capabilities.find(c=>c.deviceId===tv.deviceId)!,{sink:zp.sink,sinkHash:zp.sinkHash});assert.equal(resolveJitClient(advertisedOnly,tv.remoteIp).profile,undefined,'Sibling observation is not transferable even with the same advertised Sink');
 const corrupt=structuredClone(p);corrupt.capabilities.find(c=>c.deviceId===tv.deviceId)!.sinkHash='bad';assert.equal(resolveJitClient(corrupt,tv.remoteIp).reason,'invalid-capability-snapshot');
 const moved=structuredClone(p);moved.capabilities.find(c=>c.deviceId===tv.deviceId)!.remoteIp='192.168.1.31';assert.equal(resolveJitClient(moved,tv.remoteIp).profile,undefined);assert.equal(resolveJitClient(moved,'::ffff:192.168.1.31').profile?.id,'jp');
 const otherObserved=structuredClone(p);otherObserved.targetProfile=mpeg.id;assert.equal(resolveJitClient(otherObserved,zp.remoteIp).profile?.id,'jp','Select observed target rather than unrelated global default');
});

test('generic catalog view bypasses fixture overlay, exposes target contract and fails closed on GET disagreement',async t=>{
 const f=await setup(),media=path.join(f.dir,'media');await fs.mkdir(media);const relocated=path.join(media,'source.mp4');await fs.rename(f.entry.fingerprint.path,relocated);
 f.entry.fingerprint.path=relocated;f.entry.objectId=experimentalObjectId(relocated);f.policy.items[0]={...f.policy.items[0],objectId:f.entry.objectId,sourceFingerprint:f.entry.fingerprint};
 await fs.writeFile(path.join(f.dir,'catalog.json'),JSON.stringify({version:CATALOG_VERSION,enabled:true,entries:[f.entry]}));
 const db=await openMediaIndex(f.dir);await db.scan([media],f.dir);
 const probe={format:{duration:'1798.195',format_name:'mov,mp4'},streams:[{codec_type:'video',codec_name:'h264',profile:'High',level:42,width:1920,height:1080,pix_fmt:'yuv420p',field_order:'progressive'},{codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2}]};
 db.setMetadata(f.entry.objectId,f.entry.fingerprint,probe,1798.195);
 const p=f.policy;p.catalogMetadataResources=true;p.catalogGenericView=true;
 p.policy.capabilities={encoders:[{codec:'h264',available:true},{codec:'aac',available:true}],decoders:[{codec:'h264',available:true},{codec:'aac',available:true}]};
 Object.assign(p.policy.profiles[0].video.value,{codedWidth:1920,codedHeight:1088,bitDepth:8,chroma:'420',scan:'progressive',maxDpbFrames:4,maxBitrate:20e6,maxCpbBits:25e6,timing:{id:'test',mediaProfile:'AVC_TS_JP_AAC_T',evidence:'compatibility-experiment',maxFrameMacroblocks:8192,constraint:{codedWidth:1920,codedHeight:1088,maxMBPS:245760,minimumFrameSeconds:1/172,timebase:90000}}});
 await fs.writeFile(path.join(f.dir,'jit.json'),JSON.stringify(p));
 let inspections=0,starts=0,unsupported=false;
 const c=createExperimentalCatalog(f.dir,()=>{},()=>[media],{inspect:async()=>{inspections++;return {cacheHit:true,probe:unsupported?{...probe,streams:[{...probe.streams[0],codec_name:'unknown'},probe.streams[1]]}:probe};},devices:async()=>[{remoteIp:'127.0.0.1',descriptionUrl:'http://test',controlUrl:'http://test',deviceId:'uuid:test'}],capability:async()=>p.capabilities[0],createRuntime:async()=>{
  starts++;return {server:createServer(),status:()=>({state:'stopped',active:false,executors:0,maxConcurrentExecutors:1,cancellations:0,lastResult:undefined}),stop:async()=>{},handle:async(_req,res)=>{res.writeHead(200,{'Content-Type':'video/vnd.dlna.mpeg-tts'});res.end('generated on GET');}};
 }});
 t.after(async()=>{await c.closeIndex();db.close();await fs.rm(f.dir,{recursive:true,force:true});});
 const legacy=(m:boolean)=>browseDIDL('0',0,0,[], 'http://test',profiles.standard,m),request={objectId:'experimental/catalog',start:0,count:125,metadata:false};
 const generic=await c.browse(request,'127.0.0.1','http://test',legacy);assert.ok(generic?.didl.includes('/experimental/catalog-jit/'));assert.ok(generic?.didl.includes(JIT_PROTOCOL));assert.ok(generic?.didl.includes('parentID="experimental/catalog"'));assert.equal(inspections+starts,0);
 const id=f.entry.objectId.replace('/item/','/catalog-item/'),entry=await c.entry(id);assert.ok(entry);assert.equal(entry.adapter,undefined);assert.equal(entry.decisions.length,0);
 const old=await c.browse({...request,objectId:'experimental'},'127.0.0.1','http://test',legacy);assert.ok(old?.didl.includes('/experimental/jit/'));assert.ok(old?.didl.includes('Catalog JIT (generic)'));assert.equal(old?.total,2);
 const server=createServer((req,res)=>{void c.jitMedia(req,res,f.entry.objectId.split('/').at(-1)!,true);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/generic`;
 assert.equal((await fetch(base)).status,200);assert.equal(starts,1);unsupported=true;assert.equal((await fetch(base)).status,503);assert.equal(starts,1);
 assert.equal(await c.browse({...request,objectId:'rec'},'', '',legacy),undefined);
 await fs.writeFile(path.join(f.dir,'library.json'),JSON.stringify({version:'recording-library-v1',enabled:true}));
 const oldTs={id:'unchanged',published:true,title:'TS',filename:'TS.ts',size:188,mtimeMs:0,path:'unchanged.ts'} as any;
 const libraryLegacy=(start:number,count:number,metadata:boolean)=>browseDIDL('all',start,count,[oldTs],'http://test',profiles.standard,metadata);
 const integrated=await c.libraryBrowse({objectId:'all',start:0,count:125,metadata:false},'127.0.0.1','http://test',libraryLegacy);
 assert.equal(integrated?.total,2);assert.ok(integrated!.didl.includes('id="item:unchanged"'));assert.ok(integrated!.didl.includes('/library/jit/'));assert.ok(integrated!.didl.includes(JIT_PROTOCOL));
 const beforeProbe=inspections;
 const meta=await c.libraryBrowse({objectId:'library/item/'+id.split('/').at(-1),start:0,count:1,metadata:true},'127.0.0.1','http://test',libraryLegacy);
 assert.equal(meta?.numberReturned,1);assert.ok(meta!.didl.includes('duration="0:29:58.195"'));assert.equal(inspections,beforeProbe);
 await fs.appendFile(relocated,'changed');
 const stale=await c.libraryBrowse({objectId:'all',start:1,count:125,metadata:false},'127.0.0.1','http://test',libraryLegacy);
 assert.ok(!stale!.didl.includes('<res'));
});

test('Experimental JIT dispatch accepts five strategy modes without silent legacy fallback', () => {
  assert.equal(jitExecutorKind('full-transcode'), 'software-main40-jp');
  for (const mode of ['direct', 'remux', 'audio-transcode', 'video-transcode'] as const) assert.equal(jitExecutorKind(mode), 'not-connected');
});

test('overlapping GET preparation converges on latest request rather than late old preparation or 409', {timeout:10000},async t=>{
 const f=await setup();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
 let enter!:()=>void,release!:()=>void,admit!:()=>void;
 const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r),admitted=new Promise<void>(r=>admit=r);
 let inspections=0;const handled:string[]=[];let admissionCount=0;
 const service=createExperimentalJit(f.dir,(category)=>{if(category==='REQUEST_ADMITTED'&&++admissionCount===2)admit();},{
  inspect:async()=>{if(++inspections===1){enter();await gate;}return {cacheHit:true,probe:{format:{duration:'1798.195'}}};},
  devices:async()=>[{remoteIp:'127.0.0.1',descriptionUrl:'http://test',controlUrl:'http://test',deviceId:'uuid:test'}],
  capability:async()=>f.policy.capabilities[0],
  createRuntime:async()=>({server:createServer(),status:()=>({state:'stopped',active:false,executors:0,maxConcurrentExecutors:1,cancellations:0,lastResult:undefined}),stop:async()=>{},
   handle:async(req,res)=>{handled.push(String(req.headers['timeseekrange.dlna.org']));res.end('latest output');}})
 });
 const server=createServer((req,res)=>{void service.deliver(req,res,f.entry);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{release();server.closeAllConnections();server.close();});const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const first=fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=300-'}}).then(r=>r.text()).catch(()=>undefined);
 await entered;
 const last=fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=60-'}});
 await admitted;release();const r=await last;assert.equal(r.status,200);assert.equal(await r.text(),'latest output');await first;
 assert.deepEqual(handled,['npt=60-']);assert.equal(inspections,2);
});

test('three real HTTP seeks with delayed old cleanup leave the final stream alive; HEAD does not cancel it', {timeout:10000},async t=>{
 const f=await setup();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
 let release!:()=>void,close!:()=>void,third!:()=>void;
 const cleanup=new Promise<void>(r=>release=r),closed=new Promise<void>(r=>close=r),admitted=new Promise<void>(r=>third=r);
 let active=0,peak=0;const handled:string[]=[];let lastRes:import('node:http').ServerResponse|undefined;
 const service=createExperimentalJit(f.dir,(category,detail:any)=>{if(category==='REQUEST_ADMITTED'&&detail.generation===3)third();},{
  inspect:async()=>({cacheHit:true,probe:{format:{duration:'1798.195'}}}),
  devices:async()=>[{remoteIp:'127.0.0.1',descriptionUrl:'http://test',controlUrl:'http://test',deviceId:'uuid:test'}],capability:async()=>f.policy.capabilities[0],
  createRuntime:async()=>({server:createServer(),status:()=>({state:active?'streaming':'stopped',active:!!active,executors:active,maxConcurrentExecutors:peak,cancellations:0,lastResult:undefined}),stop:async()=>{},handle:async(req,res)=>{
   const npt=String(req.headers['timeseekrange.dlna.org']);handled.push(npt);peak=Math.max(peak,++active);res.writeHead(200);res.write(npt);
   await new Promise<void>(r=>res.once('close',r));if(npt==='npt=0-'){close();await cleanup;}active--;
  }})
 });
 const server=createServer((req,res)=>{lastRes=res;void service.deliver(req,res,f.entry);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{release();server.closeAllConnections();server.close();});const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const first=await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=0-'}});const firstReader=first.body!.getReader();await firstReader.read();
 const second=fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=300-'}}).catch(()=>undefined);await closed;
 const last=fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=60-'}});await admitted;assert.deepEqual(handled,['npt=0-']);release();
 const r=await last,reader=r.body!.getReader();assert.equal(r.status,200);assert.match(new TextDecoder().decode((await reader.read()).value),/60/);
 await second;assert.deepEqual(handled,['npt=0-','npt=60-']);assert.equal(peak,1);
 assert.equal((await fetch(url,{method:'HEAD'})).status,200);assert.equal(active,1);assert.ok(lastRes);
 await reader.cancel();await firstReader.cancel().catch(()=>{});
 for(let i=0;i<100&&active;i++)await new Promise(r=>setTimeout(r,5));assert.equal(active,0);
});

test('arrival identity survives delayed catalog lookup even after the newest request completes', {timeout:10000},async t=>{
 const f=await setup();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));let release!:()=>void,enter!:()=>void;
 const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);const handled:string[]=[];
 const service=createExperimentalJit(f.dir,()=>{},{inspect:async()=>({cacheHit:true,probe:{format:{duration:'1798.195'}}}),devices:async()=>[{remoteIp:'127.0.0.1',descriptionUrl:'http://test',controlUrl:'http://test',deviceId:'uuid:test'}],capability:async()=>f.policy.capabilities[0],
 createRuntime:async()=>({server:createServer(),status:()=>({state:'stopped',active:false,executors:0,maxConcurrentExecutors:1,cancellations:0,lastResult:undefined}),stop:async()=>{},handle:async(req,res)=>{handled.push(String(req.headers['timeseekrange.dlna.org']));res.end('last');}})});
 const server=createServer((req,res)=>{service.receive(req);void(async()=>{if(req.headers['timeseekrange.dlna.org']==='npt=300-'){enter();await gate;}await service.deliver(req,res,f.entry);})();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{release();server.closeAllConnections();server.close();});const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const first=fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=300-'}}).catch(()=>undefined);await entered;
 const last=await fetch(url,{headers:{'TimeSeekRange.dlna.org':'npt=60-'}});assert.equal(last.status,200);assert.equal(await last.text(),'last');release();await first;
 assert.deepEqual(handled,['npt=60-']);
});

for (const override of [undefined,'auto','quantized-evidence-v1'] as const) test(`timing ${override??'omitted default'} is GET-only, runtime-authorized and rollback-safe`,async t=>{
 const f=await setup();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));f.policy.timingPolicy=override;await fs.writeFile(path.join(f.dir,'jit.json'),JSON.stringify(f.policy));
 let calls=0,starts=0,stops=0;const choices:any[]=[];const clock={version:'quantized-grid-experiment-v1' as const,originTicks:0,gridNumerator:3003,gridDenominator:2,quantumTicks:90,evidence:'synthetic metadata and bounded sample'};
 const service=createExperimentalJit(f.dir,(_category,detail)=>{const stage=detail as any;if(stage.stage==='TIMING_POLICY')choices.push(stage.detail);}, {inspect:async()=>({cacheHit:true,probe:{format:{duration:'1798.195'}}}),
  devices:async()=>[{remoteIp:'127.0.0.1',descriptionUrl:'http://test',controlUrl:'http://test',deviceId:'uuid:test'}],capability:async()=>f.policy.capabilities[0],
  timing:async(_d,source,target,_probe,mode,options)=>{calls++;return {version:'test',key:'test-'+mode,sourceFingerprint:source,targetTimingFingerprint:snapshotHash(JSON.stringify(target)),mode:mode??'auto',assessment:{},cacheHit:false,...(mode!=='original'&&!options?.cacheOnly?{clock}:{})};},
  createRuntime:async(config,runtime)=>{starts++;if(starts===1){assert.deepEqual(config.experimentalClock,clock);assert.deepEqual(runtime!.timingAuthorization!.clock,clock);}else assert.equal(config.experimentalClock,undefined);
   return {server:createServer(),status:()=>({state:'stopped',active:false,executors:0,maxConcurrentExecutors:1,cancellations:0,lastResult:undefined}),stop:async()=>{stops++;},handle:async(_req,res)=>{res.writeHead(200);res.end('generated');}};
  }
 });
 assert.ok((await service.decorate(f.entry,'127.0.0.1')).jit);assert.equal(calls,0);
 const server=createServer((req,res)=>{void service.deliver(req,res,f.entry);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/media`;
 assert.equal((await fetch(url,{method:'HEAD'})).status,200);assert.equal(starts,0);
 assert.equal(choices.at(-1).requestMethod,'HEAD');assert.equal(choices.at(-1).selectionFinal,false);
 assert.equal((await fetch(url)).status,200);assert.equal(starts,1);
 assert.equal(choices.at(-1).requestedMode,override??'auto');assert.equal(choices.at(-1).selectedPolicy,'quantized-evidence-v1');assert.equal(choices.at(-1).selectionFinal,true);
 f.policy.timingPolicy='original';await fs.writeFile(path.join(f.dir,'jit.json'),JSON.stringify(f.policy));
 assert.equal((await fetch(url)).status,200);assert.equal(starts,2);assert.equal(stops,1);
 assert.equal(choices.at(-1).selectedPolicy,'original');
});

test('Browse is metadata/stat only; stable JIT URL, full duration, no source MIME and unchanged rec subtree', async t => {
  const fixture = await setup(); t.after(() => fs.rm(fixture.dir, { recursive: true, force: true }));
  const c = createExperimentalCatalog(fixture.dir, () => {});
  const old = (metadata: boolean) => browseDIDL('0', 0, 0, [], 'http://test', profiles.standard, metadata);
  const page = await c.browse({ objectId: 'experimental', start: 0, count: 0, metadata: false }, '127.0.0.1', 'http://test', old);
  assert.ok(page); assert.ok(page.didl.includes(JIT_PROTOCOL)); assert.ok(page.didl.includes('duration="0:29:58.195"'));
  assert.ok(page.didl.includes(`/experimental/jit/${fixture.entry.objectId.split('/').at(-1)}`));
  assert.ok(!page.didl.includes('video/mp4')); assert.ok(!page.didl.includes(fixture.entry.fingerprint.path));
  assert.ok(!page.didl.includes(' size='));
  assert.deepEqual(c.jitStatus(), []); // no runtime/encoder creation
  // JIT must not depend on a completed artifact still existing.
  const manifest = JSON.parse(await fs.readFile(path.join(fixture.dir, 'catalog.json'), 'utf8'));
  manifest.entries[0].adapter = { kind: 'verified-artifact' };
  await fs.writeFile(path.join(fixture.dir, 'catalog.json'), JSON.stringify(manifest));
  assert.ok((await c.browse({ objectId: fixture.entry.objectId, start: 0, count: 0, metadata: true }, '127.0.0.1', 'http://test', old))!.didl.includes('/experimental/jit/'));
  const root = await c.browse({ objectId: '0', start: 0, count: 0, metadata: false }, '127.0.0.1', 'http://test', old);
  assert.ok(root!.didl.includes(old(false).didl.match(/<container[^]*?<\/container>/)![0]));
  assert.equal(await c.browse({ objectId: 'rec', start: 0, count: 0, metadata: false }, '', '', old), undefined);
  assert.ok(!(await c.browse({ objectId: fixture.entry.objectId, start: 0, count: 0, metadata: true }, '192.168.1.99', '', old))!.didl.includes('<res'));
  await fs.appendFile(fixture.entry.fingerprint.path, 'changed');
  assert.ok(!(await c.browse({ objectId: fixture.entry.objectId, start: 0, count: 0, metadata: true }, '127.0.0.1', '', old))!.didl.includes('<res'));
});

test('HTTP GET invokes the JIT boundary lazily; HEAD/Range never encode; capability/source mismatches fail closed', async t => {
  const f = await setup(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  let inspections = 0, starts = 0, wrongCapability = false;
  const service = createExperimentalJit(f.dir, () => {}, {
    inspect: async () => { inspections++; return { cacheHit: true, probe: { format: { duration: 1798.195 } } }; },
    devices: async () => [{ remoteIp: '127.0.0.1', descriptionUrl: 'http://127.0.0.1', controlUrl: 'http://127.0.0.1', deviceId: 'uuid:test' }],
    capability: async () => ({ ...f.policy.capabilities[0], sinkHash: wrongCapability ? 'different' : f.policy.capabilities[0].sinkHash }),
    createRuntime: async (config, input) => {
      starts++; assert.equal(config.source, f.entry.fingerprint.path); assert.equal(input!.reference.targetProfile, 'jp');
      let active = false;
      return { server: createServer(), status: () => ({ state: active ? 'streaming' : 'stopped', active, executors: active ? 1 : 0, maxConcurrentExecutors: 1, cancellations: 0, lastResult: undefined }),
        stop: async () => { active = false; },
        handle: async (req, res) => {
          assert.equal(req.url, '/jit/media.tts'); active = true;
          res.writeHead(200, { 'contentFeatures.dlna.org': 'DLNA.ORG_OP=10' }); res.write('generated after GET');
          await new Promise<void>(r => res.once('close', () => { active = false; r(); }));
        } };
    }
  });
  assert.ok((await service.decorate(f.entry, '127.0.0.1')).jit); assert.equal(inspections, 0); assert.equal(starts, 0);
  const server = createServer((req, res) => { void service.deliver(req, res, f.entry); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const head = await fetch(base, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(starts, 0);
  assert.equal((await fetch(base, { headers: { Range: 'bytes=0-1' } })).status, 400); assert.equal(starts, 0);
  const response = await fetch(base); const reader = response.body!.getReader(); await reader.read(); assert.equal(starts, 1); await reader.cancel();
  for (let i = 0; i < 50 && service.status()[0].active; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(service.status()[0].executors, 0);
  wrongCapability = true; assert.equal((await fetch(base)).status, 503); assert.equal(starts, 1);
  wrongCapability = false; await fs.appendFile(f.entry.fingerprint.path, 'stale');
  assert.equal((await fetch(base)).status, 503); assert.equal(starts, 1);
});

test('Persistent metadata reuse is fingerprint-bound and needs no FFprobe when valid', async t => {
  const f = await setup(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const cache = jitMetadataPath(f.dir, f.entry.fingerprint); await fs.mkdir(path.dirname(cache));
  await fs.writeFile(cache, JSON.stringify({ fingerprint: f.entry.fingerprint, probe: { format: { duration: 1798.195 } } }));
  const first = await inspectJitMetadata(f.dir, f.entry.fingerprint), second = await inspectJitMetadata(f.dir, f.entry.fingerprint);
  assert.ok(first.cacheHit && second.cacheHit);
  assert.notEqual(jitMetadataPath(f.dir, { ...f.entry.fingerprint, size: f.entry.fingerprint.size + 1 }), cache);
  assert.notEqual(jitMetadataPath(f.dir, { ...f.entry.fingerprint, mtimeMs: f.entry.fingerprint.mtimeMs + 1 }), cache);
  assert.equal(await fs.readFile(f.entry.fingerprint.path, 'utf8'), 'not a media file: Browse must not decode');
});

test('two HTTP clients reserve async runtime creation, replace independently and reject a third before inspection', {timeout:10000},async t=>{
 const f=await setup();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
 const p=f.policy,base=p.capabilities[0];p.capabilities=Array.from({length:3},(_,i)=>({...base,deviceId:'uuid:capacity-'+i,remoteIp:'192.168.1.'+(10+i)}));
 p.policy.observations=p.capabilities.map(c=>({...p.policy.observations[0],deviceId:c.deviceId}));
 await fs.writeFile(path.join(f.dir,'jit.json'),JSON.stringify(p));
 let release!:()=>void;const creation=new Promise<void>(r=>release=r);let creates=0,inspections=0,active=0,peak=0;
 const records:{client:string;response?:import('node:http').ServerResponse;active:boolean}[]=[];
 const service=createExperimentalJit(f.dir,()=>{},{inspect:async()=>{inspections++;return {cacheHit:true,probe:{format:{duration:'1798.195'}}};},devices:async()=>p.capabilities.map(c=>({...c,descriptionUrl:'http://test'})),capability:async d=>p.capabilities.find(c=>c.deviceId===d.deviceId)!,
 timing:async(_d,source,target)=>({version:'test',key:'original',sourceFingerprint:source,targetTimingFingerprint:snapshotHash(JSON.stringify(target)),mode:'original',assessment:{},cacheHit:true}),
 createRuntime:async(_config,input)=>{const record={client:input!.reference.capabilitySnapshot.deviceId,active:false,response:undefined as import('node:http').ServerResponse|undefined};records.push(record);creates++;await creation;
 return {server:createServer(),status:()=>({state:record.active?'streaming':'stopped',active:record.active,executors:record.active?1:0,maxConcurrentExecutors:1,cancellations:0,lastResult:undefined}),stop:async()=>{record.response?.destroy();},handle:async(req,res)=>{
 record.response=res;record.active=true;peak=Math.max(peak,++active);res.write(String(req.headers['timeseekrange.dlna.org']??'start'));
 await new Promise<void>(r=>res.once('close',r));record.active=false;active--;
 }};}});
 const server=createServer((req,res)=>{void service.deliver(req,res,f.entry);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{release();server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const get=(i:number,npt='npt=0-')=>fetch(url,{headers:{'x-pt3-jit-verify':snapshotHash(JSON.stringify(p)),'x-pt3-jit-device':p.capabilities[i].deviceId,'TimeSeekRange.dlna.org':npt}});
 const a=get(0),b=get(1);for(let i=0;i<200&&creates<2;i++)await new Promise(r=>setTimeout(r,5));assert.equal(creates,2);
 const inspected=inspections;assert.equal((await get(2)).status,409);assert.equal(inspections,inspected,'Third rejected before metadata/timing/runtime work');
 release();const [ar,br]=await Promise.all([a,b]);const ra=ar.body!.getReader(),rb=br.body!.getReader();await Promise.all([ra.read(),rb.read()]);assert.equal(active,2);
 const as=await get(0,'npt=60-'),ras=as.body!.getReader();await ras.read();assert.equal(active,2);assert.ok(records.find(r=>r.client===p.capabilities[1].deviceId)!.active);
 const [aa,bb]=await Promise.all([get(0,'npt=120-'),get(1,'npt=300-')]);const raa=aa.body!.getReader(),rbb=bb.body!.getReader();
 assert.match(new TextDecoder().decode((await raa.read()).value),/120/);assert.match(new TextDecoder().decode((await rbb.read()).value),/300/);assert.equal(peak,2);
 assert.equal((await get(2)).status,409);await raa.cancel();for(let i=0;i<100&&active>1;i++)await new Promise(r=>setTimeout(r,5));assert.equal(active,1);
 const cr=await get(2),rc=cr.body!.getReader();await rc.read();assert.equal(active,2);assert.equal(peak,2);
 await Promise.all([rc.cancel(),rbb.cancel()]);for(let i=0;i<100&&active;i++)await new Promise(r=>setTimeout(r,5));assert.equal(active,0);
 await Promise.all([ra.cancel().catch(()=>{}),rb.cancel().catch(()=>{}),ras.cancel().catch(()=>{})]);
});

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'experimental-jit-')), file = path.join(dir, 'source.mp4');
  await fs.writeFile(file, 'not a media file: Browse must not decode'); const st = await fs.stat(file);
  const entry: ExperimentalEntry = { objectId: experimentalObjectId(file), filename: 'source.mp4', fingerprint: { path: file, size: st.size, mtimeMs: st.mtimeMs }, sourceState: 'unanalysed', decisions: [] };
  const evidence = { status: 'experimentally-confirmed' as const, reference: 'synthetic fixture', scope: 'test only' };
  const sink = 'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_JP_AAC_T';
  const policy: ExperimentalJitPolicy = { version: 'experimental-jit-v1', enabled: true, targetProfile: 'jp', capabilities: [{ deviceId: 'uuid:test', remoteIp: '127.0.0.1', controlUrl: 'http://127.0.0.1', sink, sinkHash: snapshotHash(sink), acquiredAt: new Date().toISOString(), origin: 'cached-read' }],
    items: [{ objectId: entry.objectId, sourceFingerprint: entry.fingerprint, durationSeconds: 1798.195 }],
    policy: { version: 'fixture', capabilities: { encoders: [], decoders: [] }, observations: [{ deviceId: 'uuid:test', sinkHash: snapshotHash(sink), testedMediaCharacteristics: {}, observation: { profileId: 'jp', framing: 'jp-content-packet', videoCodec: 'h264', outcome: 'success', evidence } }],
      profiles: [{ id: 'jp', conformance: evidence, transport: { evidence, value: { container: 'mpegts', framing: 'jp-content-packet', mime: 'video/vnd.dlna.mpeg-tts', profileName: 'AVC_TS_JP_AAC_T', seek: 'time' } },
        video: { evidence, value: { codec: 'h264', profile: 'Main', level: 40, codedWidth: 1920, codedHeight: 1088, bitDepth: 8, chroma: '420', scan: 'progressive', maxDpbFrames: 4, maxBitrate: 20e6, maxCpbBits: 25e6, timing: { id: 'fixture', mediaProfile: 'AVC_TS_JP_AAC_T', evidence: 'compatibility-experiment', maxFrameMacroblocks: 8192, constraint: { codedWidth: 1920, codedHeight: 1088, maxMBPS: 245760, timebase: 90000, minimumFrameSeconds: 1 / 172 } } } },
        audio: { evidence, value: { codec: 'aac', format: 'mpeg2-aac-lc', maxChannels: 2, sampleRates: [48000], allowAbsent: false } } }] } };
  await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify({ version: CATALOG_VERSION, enabled: true, entries: [entry] }));
  await fs.writeFile(path.join(dir, 'jit.json'), JSON.stringify(policy));
  return { dir, entry, policy };
}


for(const mpeg2 of [false,true])test(`client trial ${mpeg2?'MPEG-2':'AVC'} advertises only validated metadata, GET rechecks identity, and second client cannot stop active executor`,async t=>{
 const f=await setup();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
 f.policy.maxConcurrentSessions=1; // Explicit rollback mode retains the original capacity contract.
 const original=structuredClone(f.policy);const cap={...f.policy.capabilities[0],deviceId:'uuid:trial',remoteIp:'192.168.1.42',sink:'',sinkHash:snapshotHash('')};
 const probe={format:{duration:'1798.195',format_name:'mov,mp4'},streams:[{codec_type:'video',codec_name:'h264',profile:'High',level:42,width:1920,height:1080,pix_fmt:'yuv420p',field_order:'progressive'},{codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2}]};
 f.entry.lightweightProbe=probe;f.policy.catalogMetadataResources=true;f.policy.capabilities.push(cap);
 f.policy.policy.capabilities={encoders:[{codec:'h264',available:true},{codec:'aac',available:true}],decoders:[{codec:'h264',available:true},{codec:'aac',available:true}]};
 const trialTarget={...(mpeg2?mpeg2JitProfile():structuredClone(f.policy.policy.profiles[0])),id:'receiver-candidate'};f.policy.policy.profiles.push(trialTarget);
 if(mpeg2)f.policy.policy.capabilities.encoders=[...f.policy.policy.capabilities.encoders,{codec:'mpeg2video',available:true}];
 f.policy.clientTrials=[{version:'jit-client-trial-v1',enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,targetProfile:trialTarget.id,recipeFingerprint:jitRecipeFingerprint(trialTarget),containers:['mp4','matroska'],reference:'explicit test'}];
 await fs.writeFile(path.join(f.dir,'jit.json'),JSON.stringify(f.policy));let starts=0,stops=0,wrong=false,active=false;
 const service=createExperimentalJit(f.dir,()=>{},{inspect:async()=>({cacheHit:true,probe}),devices:async()=>[...f.policy.capabilities.map(c=>({remoteIp:c.remoteIp,deviceId:c.deviceId,descriptionUrl:'http://test',controlUrl:'http://test'}))],capability:async d=>({...f.policy.capabilities.find(c=>c.deviceId===d.deviceId)!,...(wrong?{deviceId:'uuid:wrong'}:{})}),timing:async(_d,source,target,_probe,mode)=>({version:'test',key:'original',sourceFingerprint:source,targetTimingFingerprint:snapshotHash(JSON.stringify(target)),mode:mode??'auto',assessment:{},cacheHit:true}),createRuntime:async(_config,input)=>{
  starts++;assert.equal(input!.clientTrial?.deviceId,cap.deviceId);assert.equal(input!.reference.targetProfile,'receiver-candidate');return {server:createServer(),status:()=>({state:active?'streaming':'stopped',active,executors:active?1:0,maxConcurrentExecutors:1,cancellations:0,lastResult:undefined}),stop:async()=>{stops++;active=false;},handle:async(_req,res)=>{active=true;res.writeHead(200);res.write('generated');await new Promise<void>(r=>res.once('close',()=>{active=false;r();}));}};
 }});
 assert.equal((await service.decorate(f.entry,cap.remoteIp)).jit?.targetProfile,'receiver-candidate');assert.equal((await service.decorate(f.entry,'127.0.0.1')).jit?.targetProfile,'jp');assert.equal(starts,0);assert.deepEqual(await service.protocolInfos(cap.remoteIp,[]),[mpeg2?MPEG2_JIT_PROTOCOL:JIT_PROTOCOL]);
 assert.equal((await service.decorate({...f.entry,lightweightProbe:undefined},cap.remoteIp)).jit,undefined,'Trial never trusts filename overlay alone');
 const server=createServer((req,res)=>{void service.deliver(req,res,f.entry);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const headers={'x-pt3-jit-verify':snapshotHash(JSON.stringify(f.policy)),'x-pt3-jit-device':cap.deviceId};
 wrong=true;assert.equal((await fetch(url,{headers})).status,503);assert.equal(starts,0);wrong=false;
 assert.equal((await fetch(url,{method:'HEAD',headers})).status,200);assert.equal(starts,0);
 if(mpeg2){const head=await fetch(url,{method:'HEAD',headers:{...headers,'TimeSeekRange.dlna.org':'npt=37-38'}});assert.equal(head.status,200);assert.equal(head.headers.get('contentfeatures.dlna.org'),MPEG2_JIT_FEATURES);assert.ok(!head.headers.get('timeseekrange.dlna.org')!.includes('bytes='));assert.equal(starts,0);}
 const response=await fetch(url,{headers}),reader=response.body!.getReader();await reader.read();assert.equal(starts,1);
 const other=await fetch(url);assert.equal(other.status,409,'Capacity rejection, not cross-client cancellation');assert.equal(stops,0);assert.ok(active);
 await reader.cancel();for(let i=0;i<100&&active;i++)await new Promise(r=>setTimeout(r,10));assert.equal(active,false);
 assert.deepEqual(f.policy.policy.observations,original.policy.observations,'Trial creates no success observation');
});
