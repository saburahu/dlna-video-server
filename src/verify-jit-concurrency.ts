import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createExperimentalJit,inspectJitMetadata,type ExperimentalJitPolicy} from './experimental-jit.js';
import {experimentalObjectId,type ExperimentalEntry} from './experimental-catalog.js';
import {chooseJitTiming} from './jit-timing-policy.js';
import {snapshotHash} from './playback-shadow.js';
import {AUTOMATIC_CLIENT_VERSION} from './automatic-jit-client.js';
import type {DiscoveredClientEndpoint} from './client-family-discovery.js';
import {execute,ffmpeg,ffprobe} from './prepare-executor.js';
import {TsStabilityAudit} from './ts-stability-audit.js';
import {modularDelta,TTS_MODULUS} from './full-clocks.js';

// PC-only: simulated fresh client identities, observed family evidence, real
// source/PlaybackDecision/executors/HTTP. Never commands a renderer or edits DMS policy.
const [policyFile,auditFile,output]=process.argv.slice(2);
assert.ok(policyFile&&auditFile&&output,'policy.json audit.json output-directory required');
const original:ExperimentalJitPolicy=JSON.parse(await fs.readFile(policyFile,'utf8'));
const observed=JSON.parse(await fs.readFile(auditFile,'utf8')).rows.flatMap((r:any)=>r.endpoints) as DiscoveredClientEndpoint[];
await fs.mkdir(output,{recursive:true});
const previous=process.argv.includes('--resume')?JSON.parse(await fs.readFile(path.join(output,'result.json'),'utf8')):undefined;
const results:any[]=previous?.results??[],events:any[]=previous?.events??[],samples:any[]=previous?.samples??[];
const sources=original.items.map(v=>v.sourceFingerprint);
const receiverTrialFile=process.argv.find(a=>a.startsWith('--receiver-cfr='))?.slice('--receiver-cfr='.length);
if(receiverTrialFile)sources.push(JSON.parse(await fs.readFile(receiverTrialFile,'utf8')).source);
const scenarios=receiverTrialFile?[{name:'receiver-cfr-and-original-avc',families:['intel-upnp-layout','intel-upnp-layout'],inputs:[sources.length-1,0]}]:[{name:'avc-avc-same-hevc',families:['intel-upnp-layout','intel-upnp-layout'],inputs:[2,2]},
 {name:'avc-mpeg2',families:['intel-upnp-layout','dixim-service-layout'],inputs:[0,2]},
 {name:'mpeg2-mpeg2',families:['dixim-service-layout','dixim-service-layout'],inputs:[0,2]}];
for(const scenario of scenarios){
 if(results.some(r=>r.scenario===scenario.name&&r.passed))continue;
 const directory=path.join(output,scenario.name);await fs.mkdir(directory,{recursive:true});
 const endpoints=[...scenario.families,scenario.families[0]].map((family,i)=>{
  const e=observed.find(e=>e.capability.implementation?.family===family);assert.ok(e);
  const remoteIp='10.254.42.'+(10+i),deviceId='uuid:pc-concurrency-'+i,controlUrl='http://'+remoteIp+'/pc-cm';
  return {...e,device:{...e.device,deviceId,remoteIp,controlUrl,descriptionUrl:'http://'+remoteIp+'/pc-description'},capability:{...e.capability,deviceId,remoteIp,controlUrl,acquiredAt:new Date().toISOString()}};
 });
 const p:ExperimentalJitPolicy={...original,maxConcurrentSessions:2,items:[],clientTrials:[],capabilities:endpoints.map(e=>e.capability),policy:{...original.policy,observations:[]},automaticClients:{...original.automaticClients,version:AUTOMATIC_CLIENT_VERSION,enabled:true,priority:'automatic-first'}};
 if(receiverTrialFile)p.receiverCfrTrials=[{version:'receiver-cfr-trial-v1',enabled:true,deviceId:endpoints[0].capability.deviceId,sinkHash:endpoints[0].capability.sinkHash,implementationFingerprint:endpoints[0].capability.implementation!.fingerprint,reference:'Isolated two-client receiver CFR test; no live registration'}];
 await fs.writeFile(path.join(directory,'jit.json'),JSON.stringify(p));
 const scenarioEvents:any[]=[],active=new Map<number,any>();let peak=0,overlapMs=0,lastAt=performance.now(),sampling=false;
 const trace=(category:string,detail:any)=>{
  // Integrated runtime trace wraps the record once more with its trial ID.
  if(detail.detail?.trialId&&detail.detail?.detail)detail={...detail,trialId:detail.detail.trialId,detail:detail.detail.detail};
  const now=performance.now();if(active.size===2)overlapMs+=now-lastAt;lastAt=now;
  const e={at:new Date().toISOString(),monotonicMs:now,scenario:scenario.name,category,detail};scenarioEvents.push(e);events.push(e);
  if(category==='EXECUTOR_START'){active.set(detail.detail.pid,{client:detail.client,connectionId:detail.detail.connectionId});peak=Math.max(peak,active.size);assert.ok(active.size<=2,'More than two encoding executors');}
  if(category==='EXECUTOR_EXIT')active.delete(detail.detail.pid);
 };
 const service=createExperimentalJit(directory,trace,{discover:async ip=>endpoints.filter(e=>e.device.remoteIp===ip),devices:async()=>[],capability:async d=>endpoints.find(e=>e.device.deviceId===d.deviceId)!.capability,
  inspect:(_d,...a)=>inspectJitMetadata(path.dirname(policyFile),...a),timing:(_d,...a)=>chooseJitTiming(path.dirname(policyFile),...a)});
 const entries:ExperimentalEntry[]=[];
 for(const i of [...scenario.inputs,scenario.inputs[0]]){
  const fingerprint=sources[i],probe=(await inspectJitMetadata(path.dirname(policyFile),fingerprint)).probe;
  entries.push({objectId:experimentalObjectId(fingerprint.path).replace('/item/','/catalog-item/'),filename:path.basename(fingerprint.path),fingerprint,sourceState:'unanalysed',decisions:[],lightweightProbe:probe});
 }
 const headers=(i:number)=>({'x-pt3-jit-verify':snapshotHash(JSON.stringify(p)),'x-pt3-jit-device':endpoints[i].device.deviceId!,
  'user-agent':endpoints[i].capability.implementation?.family==='intel-upnp-layout'?'UPnP/1.0 Intel_SDK_for_UPnP_devices/1.2':'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0'});
 const server=createServer((req,res)=>{void(async()=>{const url=new URL(req.url??'/','http://localhost'),i=Number(url.searchParams.get('client'));assert.ok(entries[i]);
  if(url.pathname==='/browse'){const xml=endpoints[i].capability.implementation?.family==='dixim-service-layout'?'<u:Browse><Filter>funai:dnUrl,res@dlna:cleartextSize</Filter></u:Browse>':'';await service.observeClient(req,xml);res.end(JSON.stringify((await service.decorate(entries[i],endpoints[i].device.remoteIp)).jit??null));}
  else await service.deliver(req,res,entries[i]);})().catch(e=>{res.writeHead(500);res.end(String(e));});});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const urls:string[]=[];
 const idle=async(i?:number)=>{for(let j=0;j<200;j++){const states=service.status().filter(s=>i===undefined||s.client.startsWith(endpoints[i].device.remoteIp+'/'));if(states.every(s=>!s.active&&!s.executors))return;await new Promise(r=>setTimeout(r,25));}assert.fail('Executor cleanup timeout');};
 const timer=setInterval(()=>{if(sampling||!active.size)return;sampling=true;const ids=[...active.keys()];
  const script=`Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{pid=$_.Id;cpu=$_.CPU;rss=$_.WorkingSet64} } | ConvertTo-Json -Compress`;
  void execute('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:1048576}).then(r=>{if(r.stdout.trim())samples.push({scenario:scenario.name,at:performance.now(),nodeRss:process.memoryUsage().rss,processes:[JSON.parse(r.stdout)].flat().map(v=>({...v,owner:active.get(v.pid)}))});}).catch(()=>{}).finally(()=>sampling=false);
 },1000);
 interface Request {i:number;range:string;response:Response;task:Promise<Buffer>;started:number;first:number;abort:AbortController;cancel:()=>void}
 const start=async(i:number,range:string):Promise<Request>=>{
  const started=performance.now(),abort=new AbortController(),response=await fetch(urls[i],{headers:{...headers(i),'TimeSeekRange.dlna.org':range},signal:abort.signal});assert.equal(response.status,200);
  assert.match(response.headers.get('contentfeatures.dlna.org')!,/DLNA.ORG_OP=10/);assert.equal(response.headers.get('content-length'),null);assert.equal(response.headers.get('transfer-encoding'),'chunked');
  const request={i,range,response,started,first:0,abort,cancel:()=>abort.abort()} as Request;
  request.task=(async()=>{const chunks:Buffer[]=[];try{for await(const chunk of response.body!){request.first||=(performance.now()-started)/1000;chunks.push(Buffer.from(chunk));}}catch(e){if(!abort.signal.aborted)throw e;}return Buffer.concat(chunks);})();void request.task.catch(()=>{});return request;
 };
 const check=async(req:Request,label:string)=>{
  const wire=await req.task;assert.ok(wire.length);const mpeg=endpoints[req.i].capability.implementation?.family==='dixim-service-layout';
  const stability=new TsStabilityAudit(mpeg?{pmt:257,pcr:256,video:320,audio:321}:{pmt:4096,pcr:256,video:256,audio:257});
  const packets:Buffer[]=[];let count=0,previous:number|undefined,wraps=0;
  for(let o=0;o+14<=wire.length;){assert.deepEqual(wire.subarray(o,o+10),Buffer.alloc(10));const n=wire.readUInt32BE(o+10);assert.ok(n>0&&n%192===0&&n<=(mpeg?799872:5568));if(o+14+n>wire.length){assert.ok(req.abort.signal.aborted,'Truncated completed block');break;}
   for(let j=o+14;j<o+14+n;j+=192){const t=wire.readUInt32BE(j);if(previous!==undefined){const d=modularDelta(t,previous,TTS_MODULUS);assert.ok(d>0&&d<2700000);if(t<previous)wraps++;}previous=t;const packet=wire.subarray(j+4,j+192);stability.feed(packet,count++);packets.push(packet);}o+=14+n;
  }
  const audit=stability.finish();for(const k of ['malformed','tei','scrambled','ccErrors','crcErrors','pcrBackwards','audioPtsGaps','audioInvalid'] as const)assert.equal(audit.counts[k],0,k);
  const file=path.join(directory,label+'.ts');await fs.writeFile(file,Buffer.concat(packets));
  const decoded=await execute(ffmpeg(),['-nostdin','-v','error','-i',file,'-map','0:v:0','-map','0:a:0','-f','null','-'],{windowsHide:true,timeout:60000,maxBuffer:1048576});
  // Cancelled captures can end mid-PES; complete captures must decode without diagnostics.
  if(!req.abort.signal.aborted)assert.equal(decoded.stderr.trim(),'');
  const probe=JSON.parse((await execute(ffprobe(),['-v','error','-show_streams','-of','json',file],{windowsHide:true,timeout:30000,maxBuffer:1048576})).stdout);
  assert.equal(probe.streams.find((s:any)=>s.codec_type==='video').codec_name,mpeg?'mpeg2video':'h264');assert.equal(probe.streams.find((s:any)=>s.codec_type==='audio').codec_name,'aac');
  return {label,client:req.i,range:req.range,firstBody:req.first,bytes:wire.length,audit,ttsWraps:wraps,decode:decoded.stderr.trim()||'AV decode passed',cancelled:req.abort.signal.aborted};
 };
 try{
  for(let i=0;i<3;i++){await fetch(base+'/browse?client='+i,{headers:headers(i)});await service.automaticIdle();const resource=await(await fetch(base+'/browse?client='+i,{headers:headers(i)})).json();assert.ok(resource.clientBinding);urls[i]=base+'/media?client='+i+'&clientBinding='+resource.clientBinding;}
  const rows:any[]=[];
  // Finite overlapping streams prove normal completion/AV decode, including SampleA 90s.
  const initial=await Promise.all([start(0,scenario.inputs[0]===0?'npt=5-25':'npt=0-20'),start(1,'npt=0-20')]);
  await Promise.all(initial.map(r=>r.task));await idle();for(let i=0;i<2;i++)rows.push(await check(initial[i],'finite-'+i));
  const first=await Promise.all([start(0,'npt=0-'),start(1,'npt=0-')]);
  const rejected=await fetch(urls[2],{headers:{...headers(2),'TimeSeekRange.dlna.org':'npt=0-1'}});assert.equal(rejected.status,409);assert.equal(active.size,2,JSON.stringify([...active]));
  const otherPid=[...active].find(([,v])=>v.client===endpoints[1].device.remoteIp)![0];
  const one=await start(0,'npt=10-');await first[0].task.catch(()=>{});assert.ok(active.has(otherPid),'One seek interrupted other client');
  const both=await Promise.all([start(0,'npt=20-28'),start(1,'npt=20-28')]);
  await Promise.all(both.map(r=>r.task));await idle();for(let i=0;i<2;i++)rows.push(await check(both[i],'simultaneous-seek-'+i));
  const stopping=await Promise.all([start(0,'npt=0-'),start(1,'npt=0-')]);
  stopping[0].cancel();await stopping[0].task;await idle(0);assert.equal(active.size,1);
  const newcomer=await start(2,'npt=2-10');await newcomer.task;await idle(2);assert.equal(active.size,1);
  rows.push(await check(newcomer,'newcomer'));stopping[1].cancel();await stopping[1].task;await idle();
  // Original cancelled responses settle without affecting the latest completed request.
  await Promise.allSettled([first[1].task,one.task]);
  const ends=scenarioEvents.filter(e=>e.category==='JIT_END').map(e=>e.detail.detail);
  assert.ok(ends.length);assert.ok(ends.every(e=>e.underruns===0));assert.equal(peak,2);assert.ok(overlapMs>10000);
  assert.ok(!scenarioEvents.some(e=>['ERROR','EXPERIMENTAL_JIT_ERROR'].includes(e.category)));
  if(receiverTrialFile){
   const encoders=scenarioEvents.filter(e=>e.category==='EXECUTOR_START');
   assert.ok(encoders.filter(e=>e.detail.client===endpoints[0].device.remoteIp).every(e=>e.detail.detail.args[e.detail.detail.args.indexOf('-vf')+1].includes('fps=30000/1001')));
   assert.ok(encoders.filter(e=>e.detail.client!==endpoints[0].device.remoteIp).every(e=>!e.detail.detail.args[e.detail.detail.args.indexOf('-vf')+1].includes('fps=')));
  }
  const selections=scenarioEvents.filter(e=>e.category==='EXPERIMENTAL_JIT_STAGE'&&e.detail.stage==='CLIENT_FAMILY_SELECTION');assert.ok(selections.every(e=>e.detail.detail.route==='automatic'));
  results.push({scenario:scenario.name,passed:true,peakExecutors:peak,overlapSeconds:overlapMs/1000,rows,ends,cleanup:service.status()});
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:results.length===scenarios.length,results,samples,events},null,2));
  console.log(JSON.stringify({scenario:scenario.name,passed:true,overlapSeconds:overlapMs/1000,peak,underruns:ends.map(e=>e.underruns)}));
 }finally{clearInterval(timer);server.closeAllConnections();await idle();await service.closeAutomatic();await new Promise<void>(r=>server.close(()=>r()));await fs.writeFile(path.join(directory,'events.json'),JSON.stringify({events:scenarioEvents,samples:samples.filter(s=>s.scenario===scenario.name)},null,2));}
}
