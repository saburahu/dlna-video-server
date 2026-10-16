import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer,request, type IncomingMessage} from 'node:http';
import {AUTOMATIC_CLIENT_VERSION,automaticClientSelection,createAutomaticJitClients} from '../src/automatic-jit-client.js';
import {endpointFamilyFeatures,requestFamilyFeatures,classifyClientFamily,FAMILY_VERSION} from '../src/client-family.js';
import {initialShadowPolicy} from '../src/shadow-profile-policy.js';
import {mpeg2JitProfile} from '../src/mpeg2-jit-target.js';
import {snapshotHash} from '../src/playback-shadow.js';
import {createExperimentalJit,type ExperimentalJitPolicy} from '../src/experimental-jit.js';
import {libraryItem,type ExperimentalEntry} from '../src/experimental-catalog.js';
import {catalogJitCandidate} from '../src/catalog-jit-candidate.js';
import {jitRecipeFingerprint} from '../src/jit-client-trial.js';
import {matchingJitTrial} from '../src/jit-client-trial.js';
import {admissionIdentity} from '../src/jit-client-admission.js';

const intelUA={'user-agent':'UPnP/1.0 Intel_SDK_for_UPnP_devices/1.2'};
const bdrUA={'user-agent':'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0'};
const bdrBrowse='<u:Browse><Filter>funai:dnUrl,res@dlna:cleartextSize</Filter></u:Browse>';
function policy():ExperimentalJitPolicy {const p=initialShadowPolicy();p.profiles=[p.profiles[0],mpeg2JitProfile()];p.capabilities={encoders:[{codec:'h264',available:true},{codec:'mpeg2video',available:true},{codec:'aac',available:true}],decoders:[{codec:'h264',available:true},{codec:'hevc',available:true},{codec:'aac',available:true}]};return {version:'experimental-jit-v1',enabled:true,targetProfile:'legacy-jp-observed',policy:p,capabilities:[],items:[],catalogMetadataResources:true,automaticClients:{version:AUTOMATIC_CLIENT_VERSION,enabled:true}};}
function endpoint(dixim=false,deviceId='uuid:never-registered',remoteIp='127.0.0.1') {
 const xml=dixim?'<serviceType>urn:schemas-digion-com:service:X_AccessControl:1</serviceType><serviceType>urn:schemas-digion-com:service:X_DeviceConfiguration:1</serviceType>':'<serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/MediaServer/ConnectionManager/Control</controlURL><SCPDURL>/xml/ConnectionManager.xml</SCPDURL>';
 const features=endpointFamilyFeatures(xml,[dixim?'DiXiM/4.0':'Intel_SDK_for_UPnP_devices/1.2']),c=classifyClientFamily(features.signals),controlUrl=`http://${remoteIp}/cm`;
 return {features,device:{remoteIp,deviceId,descriptionUrl:`http://${remoteIp}/description.xml`,controlUrl,allowEmptySink:true},capability:{remoteIp,deviceId,controlUrl,sink:'',sinkHash:snapshotHash(''),acquiredAt:new Date().toISOString(),origin:'current-read' as const,implementation:{version:FAMILY_VERSION,fingerprint:c.fingerprint,family:c.family}}};
}
test('unknown identities select empirically pinned recipes by independent endpoint and request features, never names or UDN bytes',()=>{
 for(const dixim of [false,true])for(const id of ['uuid:random-one','uuid:entirely-different']){
  const ep=endpoint(dixim,id,'10.2.3.4'),requests=requestFamilyFeatures(dixim?bdrUA:intelUA,dixim?bdrBrowse:'');
  const result=automaticClientSelection([ep],requests,policy());
  assert.equal(result.profile?.id,dixim?'mpeg2-jp-pcr-split-v1':'legacy-jp-observed');assert.equal(result.trial?.automaticEvidence?.confidence,'strong-observation');assert.equal(result.trial?.deviceId,id);
  assert.equal(result.trial?.automaticEvidence?.family,dixim?'dixim-service-layout':'intel-upnp-layout');
 }
});
test('mixed host selects only one request-correlated endpoint; generic DiXiM, incomplete and conflicting requests never inherit MPEG-2',()=>{
 const p=policy(),intel=endpoint(),dixim=endpoint(true,'uuid:aux');
 assert.equal(automaticClientSelection([intel,dixim],requestFamilyFeatures(intelUA),p).profile?.id,'legacy-jp-observed');
 assert.equal(automaticClientSelection([intel,dixim],requestFamilyFeatures(bdrUA,bdrBrowse),p).profile?.id,'mpeg2-jp-pcr-split-v1');
 assert.equal(automaticClientSelection([dixim],requestFamilyFeatures({'user-agent':'DiXiM/4.0'}),p).profile,undefined);
 assert.equal(automaticClientSelection([dixim],requestFamilyFeatures(bdrUA),p).profile,undefined);
 assert.equal(automaticClientSelection([intel,dixim],[...requestFamilyFeatures(intelUA),...requestFamilyFeatures(bdrUA,bdrBrowse)],p).reason,'conflicting-request-implementations');
 assert.equal(automaticClientSelection([intel,endpoint(false,'uuid:second')],requestFamilyFeatures(intelUA),p).reason,'ambiguous-request-endpoints');
 for(const ep of [{...intel,features:{...intel.features,signals:intel.features.signals.filter(s=>s.dimension!=='service-layout')}},{...intel,capability:{...intel.capability,implementation:{...intel.capability.implementation,fingerprint:'changed'}}}])assert.equal(automaticClientSelection([ep],requestFamilyFeatures(intelUA),p).profile,undefined);
 p.policy.profiles[0].video.value.level=41;assert.equal(automaticClientSelection([intel],requestFamilyFeatures(intelUA),p).reason,'no-matching-empirical-recipe');
});
test('background identity cache deduplicates work, expires/rechecks, survives restart without trusting old request evidence and rejects changed identity tokens',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auto-client-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let now=Date.now(),calls=0,current=endpoint();
 const p=policy(),m=createAutomaticJitClients(dir,()=>{},async()=>{calls++;return [current];},()=>now);
 await Promise.all(Array.from({length:20},()=>m.observe('127.0.0.1',intelUA,'',true)));await m.idle();assert.equal(calls,1);
 const first=m.resolve(p,'127.0.0.1');assert.ok(first.binding);const revision=m.status().revision;
 now+=300001;assert.equal(m.resolve(p,'127.0.0.1').binding,undefined);await m.observe('127.0.0.1',{},'',true);await m.idle();assert.equal(calls,2);assert.equal(m.resolve(p,'127.0.0.1').binding,first.binding,'same identity refresh keeps TimeSeek URL valid');assert.ok(m.status().revision>revision,'expired availability restored emits UpdateID change');
 current=endpoint(false,'uuid:replacement');now+=300001;await m.observe('127.0.0.1',intelUA,'',true);await m.idle();assert.notEqual(m.resolve(p,'127.0.0.1').binding,first.binding);
 const restarted=createAutomaticJitClients(dir,()=>{},async()=>[current],()=>now);t.after(()=>restarted.close());await restarted.observe('127.0.0.1',{},'',true);assert.equal(restarted.resolve(p,'127.0.0.1').binding,undefined,'persisted cache alone cannot authorize playback');await restarted.observe('127.0.0.1',intelUA,'',true);await restarted.idle();assert.equal(restarted.resolve(p,'127.0.0.1').profile?.id,'legacy-jp-observed');
 await restarted.observe('127.0.0.1',bdrUA,bdrBrowse,true);assert.equal(restarted.resolve(p,'127.0.0.1').reason,'conflicting-request-implementations');
});

test('failed endpoint renewal never marks old capability fresh, and automatic-disabled admits no unregistered client',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auto-failure-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let now=Date.now(),fail=false;const p=policy();
 const m=createAutomaticJitClients(dir,()=>{},async()=>{if(fail)throw Error('peer unavailable');return [endpoint()];},()=>now);
 await m.observe('127.0.0.1',intelUA,'',true);await m.idle();assert.ok(m.resolve(p,'127.0.0.1').binding);
 p.automaticClients!.enabled=false;assert.equal(m.resolve(p,'127.0.0.1').reason,'automatic-disabled');p.automaticClients!.enabled=true;
 now+=300001;fail=true;await m.observe('127.0.0.1',intelUA,'',true);await m.idle();assert.equal(m.resolve(p,'127.0.0.1').binding,undefined);assert.equal(m.resolve(p,'127.0.0.1').reason,'automatic-binding-pending-or-expired');await m.close();
});

test('explicit individual override wins a conflicting family candidate; ambiguous overrides and duplicate identities remain blocked',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auto-override-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const p=policy(),ep=endpoint();
 p.capabilities=[ep.capability];const target=p.policy.profiles[1];p.clientTrials=[{version:'jit-client-trial-v1',enabled:true,deviceId:ep.capability.deviceId,sinkHash:ep.capability.sinkHash,targetProfile:target.id,recipeFingerprint:jitRecipeFingerprint(target),containers:['mp4','matroska'],reference:'explicit override test'}];
 const file=path.join(dir,'source.mp4');await fs.writeFile(file,'unchanged');const stat=await fs.stat(file),entry:ExperimentalEntry={objectId:'experimental/catalog-item/'+'a'.repeat(32),filename:'source.mp4',fingerprint:{path:file,size:stat.size,mtimeMs:stat.mtimeMs},sourceState:'unanalysed',decisions:[],lightweightProbe:{format:{duration:'100',format_name:'mov,mp4'},streams:[{codec_type:'video',codec_name:'h264',profile:'High',level:42,width:1920,height:1080,pix_fmt:'yuv420p',field_order:'progressive'},{codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2}]}};
 const save=async()=>{await fs.writeFile(path.join(dir,'jit.json'),JSON.stringify(p));await new Promise(r=>setTimeout(r,5));};await save();const events:any[]=[];
 const service=createExperimentalJit(dir,(event,detail)=>events.push({event,detail}),{discover:async()=>[ep]});const req={socket:{remoteAddress:'127.0.0.1'},headers:intelUA} as unknown as IncomingMessage;
 await service.observeClient(req);await service.automaticIdle();const item=await service.decorate(entry,'127.0.0.1');assert.equal(item.jit?.targetProfile,target.id);assert.equal(item.jit?.clientBinding,undefined);assert.ok(events.some(e=>e.event==='CLIENT_AUTO_SELECTION'&&e.detail.agreement===false&&e.detail.override));
 p.automaticClients!.automaticOnlyDeviceIds=[ep.capability.deviceId];await save();const onlyAuto=(await service.decorate(entry,'127.0.0.1')).jit;assert.equal(onlyAuto?.targetProfile,'legacy-jp-observed','diagnostic trial bypasses conflicting individual MPEG-2 override');assert.ok(onlyAuto?.clientBinding);assert.equal(p.clientTrials[0].targetProfile,target.id,'stored override retained');
 p.capabilities.push({...ep.capability,deviceId:'uuid:shared-address'});await save();assert.equal((await service.decorate(entry,'127.0.0.1')).jit,undefined,'diagnostic masking must not hide an ambiguous address');p.capabilities.pop();
 p.automaticClients!.enabled=false;await save();assert.equal((await service.decorate(entry,'127.0.0.1')).jit,undefined,'trial never falls back when automatic evidence is unavailable');
 p.automaticClients!.enabled=true;p.automaticClients!.automaticOnlyDeviceIds=['uuid:some-other-client'];await save();assert.equal((await service.decorate(entry,'127.0.0.1')).jit?.targetProfile,target.id,'other individual clients unaffected');
 delete p.automaticClients!.automaticOnlyDeviceIds;await save();assert.equal((await service.decorate(entry,'127.0.0.1')).jit?.targetProfile,target.id,'normal restores stored override');
 p.clientTrials.push({...p.clientTrials[0],targetProfile:p.policy.profiles[0].id,recipeFingerprint:jitRecipeFingerprint(p.policy.profiles[0])});await save();assert.equal((await service.decorate(entry,'127.0.0.1')).jit,undefined);
 p.clientTrials.pop();p.capabilities.push({...ep.capability,deviceId:'uuid:other-at-address'});await save();assert.equal((await service.decorate(entry,'127.0.0.1')).jit,undefined);
 p.capabilities.pop();p.automaticClients!.enabled=false;await save();assert.equal((await service.decorate(entry,'127.0.0.1')).jit?.targetProfile,target.id,'rollback preserves individual admission');
});

test('two unregistered peers keep independent Browse bindings and sessions; foreign GET cannot cancel the active client',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auto-peers-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const p=policy();await fs.writeFile(path.join(dir,'jit.json'),JSON.stringify(p));const file=path.join(dir,'source.mp4');await fs.writeFile(file,'unchanged');const st=await fs.stat(file),probe={format:{duration:'100',format_name:'mov,mp4'},streams:[{codec_type:'video',codec_name:'h264',profile:'High',level:42,width:1920,height:1080,pix_fmt:'yuv420p',field_order:'progressive'},{codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2}]};
 p.maxConcurrentSessions=1;await fs.writeFile(path.join(dir,'jit.json'),JSON.stringify(p)); // Explicit rollback mode.
 const entry:ExperimentalEntry={objectId:'experimental/catalog-item/'+'b'.repeat(32),filename:'source.mp4',fingerprint:{path:file,size:st.size,mtimeMs:st.mtimeMs},sourceState:'unanalysed',decisions:[],lightweightProbe:probe};let active=false,stops=0,starts=0;
 const service=createExperimentalJit(dir,()=>{},{discover:async ip=>[endpoint(false,'uuid:'+ip,ip)],devices:async()=>[],capability:async d=>endpoint(false,d.deviceId!,d.remoteIp).capability,inspect:async()=>({probe,cacheHit:true}),timing:async(_d,source,target,_probe,mode)=>({version:'test',key:'original',sourceFingerprint:source,targetTimingFingerprint:snapshotHash(JSON.stringify(target)),mode:mode??'auto',assessment:{},cacheHit:true}),createRuntime:async()=>{starts++;return {server:createServer(),status:()=>({state:active?'streaming' as const:'stopped' as const,active,executors:active?1:0,maxConcurrentExecutors:1,cancellations:0,lastResult:undefined}),stop:async()=>{active=false;stops++;},handle:async(_req,res)=>{active=true;res.writeHead(200);res.write('live');await new Promise<void>(r=>res.once('close',()=>{active=false;r();}));}};}});
 const server=createServer((req,res)=>{void(async()=>{if(req.url==='/browse'){await service.observeClient(req);res.end(JSON.stringify((await service.decorate(entry,req.socket.remoteAddress!)).jit??null));}else await service.deliver(req,res,entry);})();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const get=(url:string,ip:string)=>new Promise<IncomingMessage>((resolve,reject)=>{const req=request(url,{localAddress:ip,headers:intelUA},resolve);req.on('error',reject);req.end();});
 for(const ip of ['127.0.0.1','127.0.0.2']){const r=await get(base+'/browse',ip);r.resume();await new Promise(r=>setImmediate(r));}await service.automaticIdle();
 const first=(await service.decorate(entry,'127.0.0.1')).jit!,second=(await service.decorate(entry,'127.0.0.2')).jit!;assert.ok(first.clientBinding&&second.clientBinding);assert.notEqual(first.clientBinding,second.clientBinding);
 const streaming=await get(base+'/media?clientBinding='+first.clientBinding,'127.0.0.1');assert.equal(streaming.statusCode,200);
 const foreign=await get(base+'/media?clientBinding='+first.clientBinding,'127.0.0.2');assert.equal(foreign.statusCode,503);foreign.resume();assert.equal(starts,1);assert.equal(stops,0);assert.ok(active);
 const busy=await get(base+'/media?clientBinding='+second.clientBinding,'127.0.0.2');assert.equal(busy.statusCode,409);busy.resume();assert.ok(active);assert.equal(stops,0);
 streaming.destroy();for(let i=0;i<50&&active;i++)await new Promise(r=>setTimeout(r,10));assert.equal(active,false);
});

test('loopback verification uses stored identity while automatic-only admission still hides the individual target',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auto-identity-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const p=policy(),ep=endpoint(false,'uuid:diagnostic-identity','10.2.3.4');p.capabilities=[ep.capability];p.automaticClients!.automaticOnlyDeviceIds=[ep.device.deviceId];await fs.writeFile(path.join(dir,'jit.json'),JSON.stringify(p));const service=createExperimentalJit(dir,()=>{}, {discover:async()=>[]});
 const headers={'x-pt3-jit-verify':snapshotHash(JSON.stringify(p)),'x-pt3-jit-device':ep.device.deviceId};assert.equal(await service.client({socket:{remoteAddress:'127.0.0.1'},headers} as unknown as IncomingMessage),'10.2.3.4');assert.equal(await service.client({socket:{remoteAddress:'127.0.0.1'},headers:{...headers,'x-pt3-jit-verify':'wrong'}} as unknown as IncomingMessage),'127.0.0.1');assert.equal(await service.client({socket:{remoteAddress:'10.2.3.5'},headers} as unknown as IncomingMessage),'10.2.3.5','LAN callers cannot impersonate the stored identity');
});

test('normal HTTP fallback binds a freshly corroborated identity, rechecks GET, and requires a new URL when fingerprint becomes complete',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auto-fallback-http-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const ep=endpoint(),p=policy(),profile=p.policy.profiles[0];p.automaticClients!.priority='automatic-first';p.capabilities=[ep.capability];p.clientTrials=[{version:'jit-client-trial-v1',enabled:true,deviceId:ep.device.deviceId,sinkHash:ep.capability.sinkHash,targetProfile:profile.id,recipeFingerprint:jitRecipeFingerprint(profile),containers:['mp4','matroska'],reference:'past manual permission'}];p.clientAdmissions={version:'client-admission-v1',legacySuccesses:[{deviceId:ep.device.deviceId,targetProfile:profile.id,recipeFingerprint:jitRecipeFingerprint(profile),identityFingerprint:admissionIdentity(ep.capability),reference:'human-confirmed playback',confirmedAt:new Date().toISOString()}]};await fs.writeFile(path.join(dir,'jit.json'),JSON.stringify(p));
 const seed=createAutomaticJitClients(dir,()=>{},async()=>[ep]);await seed.observe('127.0.0.1',intelUA,'',true);await seed.idle();await seed.close();
 const file=path.join(dir,'source.mp4');await fs.writeFile(file,'source');const st=await fs.stat(file),probe={format:{duration:'100',format_name:'mov,mp4'},streams:[{codec_type:'video',codec_name:'h264',profile:'High',level:42,width:1920,height:1080,pix_fmt:'yuv420p',field_order:'progressive'},{codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2}]},entry:ExperimentalEntry={objectId:'experimental/catalog-item/'+'c'.repeat(32),filename:'source.mp4',fingerprint:{path:file,size:st.size,mtimeMs:st.mtimeMs},sourceState:'unanalysed',decisions:[],lightweightProbe:probe};
 const events:any[]=[];let changed=false,starts=0;const service=createExperimentalJit(dir,(category,detail)=>events.push({category,detail}),{discover:async()=>[ep],devices:async()=>[ep.device],capability:async()=>({...ep.capability,...(changed?{deviceId:'uuid:other'}:{})}),inspect:async()=>({probe,cacheHit:true}),timing:async(_d,source,target)=>({version:'test',key:'original',sourceFingerprint:source,targetTimingFingerprint:snapshotHash(JSON.stringify(target)),mode:'original',assessment:{},cacheHit:true}),createRuntime:async()=>{starts++;return {server:createServer(),status:()=>({state:'stopped' as const,active:false,executors:0,maxConcurrentExecutors:0,cancellations:0,lastResult:undefined}),stop:async()=>{},handle:async(_req,res)=>{res.end('test stream');}};}});
 const server=createServer((req,res)=>{void(async()=>{if(req.url==='/browse'){await service.observeClient(req);res.end(JSON.stringify((await service.decorate(entry,'127.0.0.1')).jit??null));}else await service.deliver(req,res,entry);})();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const fallback=await(await fetch(base+'/browse')).json();assert.ok(fallback.clientBinding);assert.equal((await fetch(base+'/media?clientBinding='+fallback.clientBinding)).status,200);assert.equal(starts,1);assert.ok(events.some(e=>e.detail?.stage==='CLIENT_FAMILY_SELECTION'&&e.detail.detail.route==='legacy-fallback'));
 changed=true;assert.equal((await fetch(base+'/media?clientBinding='+fallback.clientBinding)).status,503);assert.equal(starts,1);changed=false;
 assert.equal((await fetch(base+'/media?clientBinding='+fallback.clientBinding,{headers:intelUA})).status,503,'new evidence invalidates the old Browse claim rather than silently changing route');
 const automatic=await(await fetch(base+'/browse',{headers:intelUA})).json();assert.ok(automatic.clientBinding);assert.notEqual(automatic.clientBinding,fallback.clientBinding);assert.equal((await fetch(base+'/media?clientBinding='+automatic.clientBinding,{headers:intelUA})).status,200);assert.equal(starts,2);assert.ok(events.some(e=>e.detail?.stage==='CLIENT_FAMILY_SELECTION'&&e.detail.detail.route==='automatic'));
});

for(const dixim of [false,true])for(const registeredOnly of [false,true,'automatic-first'])test(`automatic ${dixim?'MPEG-2':'AVC'} HTTP ${registeredOnly==='automatic-first'?'normal automatic-first':registeredOnly?'registered automatic-only trial':'unknown identity'}: Browse enqueues only, bound GET/HEAD, current change fail closed`,async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auto-http-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'unregistered-source.mkv');await fs.writeFile(file,'unchanged source');const stat=await fs.stat(file),ep=endpoint(dixim);
 const probe={format:{duration:'1800',format_name:'matroska'},streams:[{codec_type:'video',codec_name:'hevc',profile:'Main',level:120,width:1920,height:1080,pix_fmt:'yuv420p',field_order:'progressive'},{codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2}]};
 const entry:ExperimentalEntry={objectId:'experimental/catalog-item/'+'a'.repeat(32),filename:'not a known show.mkv',fingerprint:{path:file,size:stat.size,mtimeMs:stat.mtimeMs},sourceState:'unanalysed',decisions:[],lightweightProbe:probe};
 const p=policy();if(registeredOnly){p.capabilities=[ep.capability];if(registeredOnly==='automatic-first')p.automaticClients!.priority='automatic-first';else p.automaticClients!.automaticOnlyDeviceIds=[ep.device.deviceId];const opposite=p.policy.profiles[registeredOnly==='automatic-first'?(dixim?1:0):(dixim?0:1)];p.clientTrials=[{version:'jit-client-trial-v1',enabled:true,deviceId:ep.device.deviceId,sinkHash:ep.capability.sinkHash,targetProfile:opposite.id,recipeFingerprint:jitRecipeFingerprint(opposite),containers:['mp4','matroska'],reference:'stored individual trial'}];}const stored=JSON.stringify(p);await fs.writeFile(path.join(dir,'jit.json'),stored);let probes=0,starts=0,discoveries=0,wrong='' as ''|'identity'|'implementation';
 const events:{category:string;detail:any}[]=[];
 const service=createExperimentalJit(dir,(category,detail)=>events.push({category,detail}),{discover:async()=>{discoveries++;return [ep];},devices:async()=>registeredOnly?[ep.device]:[],capability:async()=>({...ep.capability,...(wrong==='identity'?{deviceId:'uuid:changed'}:wrong==='implementation'?{implementation:{...ep.capability.implementation,fingerprint:'changed'}}:{})}),inspect:async()=>{probes++;return {probe,cacheHit:true};},timing:async(_d,source,target,_probe,mode)=>({version:'test',key:'original',sourceFingerprint:source,targetTimingFingerprint:snapshotHash(JSON.stringify(target)),mode:mode??'auto',assessment:{},cacheHit:true}),createRuntime:async(_config,input)=>{
  starts++;assert.equal(input?.clientTrial?.automaticEvidence?.family,dixim?'dixim-service-layout':'intel-upnp-layout');assert.equal(input?.device?.deviceId,ep.device.deviceId);
  const candidate=catalogJitCandidate(entry,{...p,targetProfile:input!.reference.targetProfile,clientTrials:[input!.clientTrial!]},ep.capability);assert.ok(candidate);assert.equal(candidate.execution.transport.profileName,dixim?'MPEG_TS_JP_T':'AVC_TS_JP_AAC_T');
  return {server:createServer(),status:()=>({state:'stopped' as const,active:false,executors:0,maxConcurrentExecutors:0,cancellations:0,lastResult:undefined}),stop:async()=>{},handle:async(req,res)=>{assert.equal(req.url,'/jit/media.tts');res.writeHead(200,{'Content-Type':'video/vnd.dlna.mpeg-tts'});res.end('generated only after bound GET');}};
 }});
 const headers=dixim?bdrUA:intelUA;
 const server=createServer((req,res)=>{void(async()=>{if(req.url==='/browse'){await service.observeClient(req,dixim?bdrBrowse:'');const item=await service.decorate(entry,'127.0.0.1');res.end(JSON.stringify(item.jit??null));}else await service.deliver(req,res,entry);})();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 await fetch(base+'/browse',{headers});await service.automaticIdle();assert.equal(probes,0);assert.equal(starts,0);assert.equal(discoveries,1);
 const resource=await (await fetch(base+'/browse',{headers})).json();assert.ok(resource.clientBinding);assert.match(libraryItem({...entry,jit:resource},base),/clientBinding=/);
 assert.equal((await fetch(base+'/media',{headers})).status,503);assert.equal(starts,0);
 const url=base+'/media?clientBinding='+resource.clientBinding;
 assert.equal((await fetch(url,{method:'HEAD',headers})).status,200);assert.equal(starts,0);
 assert.equal((await fetch(url,{headers:{...headers,'TimeSeekRange.dlna.org':'npt=120-121'}})).status,200);assert.equal(starts,1);
 for(const change of ['identity','implementation'] as const){wrong=change;assert.equal((await fetch(url,{headers})).status,503);assert.equal(starts,1);}wrong='';
 assert.equal((await fetch(base+'/media?clientBinding=other-client',{headers})).status,503);
 assert.equal((await fetch(url,{headers:dixim?intelUA:bdrUA})).status,503,'conflicting current request invalidates automatic resource');assert.equal(starts,1);
 assert.ok(events.some(e=>e.category==='EXPERIMENTAL_JIT_STAGE'&&e.detail.stage==='CLIENT_FAMILY_SELECTION'));
 if(registeredOnly==='automatic-first')assert.ok(events.some(e=>e.category==='EXPERIMENTAL_JIT_STAGE'&&e.detail.stage==='CLIENT_FAMILY_SELECTION'&&e.detail.detail.route==='automatic'&&e.detail.detail.override===false));
 assert.equal(JSON.stringify(p),stored,'stored individual registration/override is never deleted');assert.equal(await fs.readFile(file,'utf8'),'unchanged source');
});

test('automatic legacy input admission inspects actual container/codec independently of the selected output recipe',()=>{
 for(const dixim of [false,true])for(const [container,video,audio] of [['avi','mpeg4','mp3'],['asf','wmv3','mp3'],['asf','wmv3','wmav2'],['ogg','mpeg4','vorbis']]){
  const ep=endpoint(dixim),p=policy();p.automaticClients!.legacyInputs=true;p.automaticClients!.wmaInputs='source-clock-v1';const automatic=automaticClientSelection([ep],requestFamilyFeatures(dixim?bdrUA:intelUA,dixim?bdrBrowse:''),p);assert.ok(automatic.trial);p.targetProfile=automatic.profile!.id;p.capabilities=[ep.capability];p.clientTrials=[automatic.trial];
  const probe={format:{duration:'100',format_name:container},executionDecoders:[video,audio],streams:[{codec_type:'video',codec_name:video,width:640,height:480,pix_fmt:'yuv420p',r_frame_rate:'25/1'},{codec_type:'audio',codec_name:audio,channels:2,sample_rate:'44100'}]};const entry:ExperimentalEntry={objectId:'experimental/catalog-item/'+'d'.repeat(32),filename:'misleading-name.mp4',fingerprint:{path:'X:/test/source',size:100,mtimeMs:1},sourceState:'unanalysed',decisions:[],lightweightProbe:probe};
  const admitted=catalogJitCandidate(entry,p,ep.capability);assert.ok(admitted);assert.equal(admitted.execution.transport.profileName,dixim?'MPEG_TS_JP_T':'AVC_TS_JP_AAC_T');assert.ok(admitted.execution.resample);assert.equal(admitted.execution.reconcileAudioTimeline,true);
  if(audio==='wmav2'){delete p.automaticClients!.wmaInputs;assert.equal(catalogJitCandidate(entry,p,ep.capability),undefined,'WMA publication requires the validated source-clock version');p.automaticClients!.wmaInputs='source-clock-v1';}
  p.automaticClients!.legacyInputs=false;assert.equal(catalogJitCandidate(entry,p,ep.capability),undefined);p.automaticClients!.legacyInputs=true;
  for(const bad of [{...probe,format:{...probe.format,format_name:'unrecognized'}},{...probe,protection:'ASF header declares DRM protection'},{...probe,executionDecoders:[video,'wmalossless'],streams:[probe.streams[0],{...probe.streams[1],codec_name:'wmalossless'}]},{...probe,streams:[{...probe.streams[0],width:0},probe.streams[1]]},{...probe,streams:[{...probe.streams[0],codec_name:'vp6'},probe.streams[1]]},{...probe,streams:[{...probe.streams[0],pix_fmt:'yuv420p10le'},probe.streams[1]]},{...probe,streams:[probe.streams[0]]},{...probe,streams:[probe.streams[0],{...probe.streams[1],codec_name:'gsm_ms'}]}])assert.equal(catalogJitCandidate({...entry,lightweightProbe:bad},p,ep.capability),undefined);
  assert.equal(matchingJitTrial([{...automatic.trial,automaticEvidence:undefined}],ep.capability,automatic.profile!),undefined,'legacy containers do not silently expand historical manual trials');
 }
});

test('input publication changes preserve identity/output binding and unchanged scans do not change the policy revision',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auto-input-policy-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const ep=endpoint(),p=policy(),m=createAutomaticJitClients(dir,()=>{},async()=>[ep]);await m.observe('127.0.0.1',intelUA,'',true);await m.idle();const before=m.resolve(p,'127.0.0.1');p.automaticClients!.legacyInputs=true;const after=m.resolve(p,'127.0.0.1');assert.equal(before.binding,after.binding,'MP4/MKV resources retain the same output/identity contract');assert.equal(after.trial?.automaticEvidence?.inputPolicy,'jit-legacy-inputs-v1');assert.ok(after.trial?.containers.includes('asf'));
 const file=path.join(dir,'jit.json');p.automaticClients!.legacyInputs=false;await fs.writeFile(file,JSON.stringify(p));let inspections=0;const service=createExperimentalJit(dir,()=>{},{inspect:async()=>{inspections++;throw Error('No inspection during revision/Browse');}});const initial=await service.revision();p.automaticClients!.legacyInputs=true;await new Promise(r=>setTimeout(r,5));await fs.writeFile(file,JSON.stringify(p));const changed=await service.revision();assert.ok(changed>initial);await new Promise(r=>setTimeout(r,5));await fs.writeFile(file,JSON.stringify(p));assert.equal(await service.revision(),changed);assert.equal(inspections,0);
});
