// Generated patterns only. No SSDP, renderer command, real identity or user data.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
const execute=promisify(execFile),repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const installed=process.env.DLNA_VERIFY_PACKAGE?path.resolve(process.env.DLNA_VERIFY_PACKAGE):undefined,compiled=installed?path.join(installed,'app/src'):path.join(repository,'dist/src'),defaults=installed?path.join(installed,'defaults/jit.json'):path.join(repository,'packaging/defaults/jit.json');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dlna-dual-http-'));
const ffmpeg=process.env.PT3_FFMPEG,ffprobe=process.env.PT3_FFPROBE;
assert.ok(ffmpeg&&ffprobe,'Set PT3_FFMPEG and PT3_FFPROBE to separately installed binaries');
const run=(tool,args)=>execute(tool,args,{windowsHide:true,timeout:120000,maxBuffer:8*2**20});
const load=file=>import(pathToFileURL(path.join(compiled,file+'.js')));
process.env.PT3_DATA_DIR=directory;
const {createExperimentalCatalog,experimentalObjectId,experimentalBrowseSoap}=await load('experimental-catalog');
const {openMediaIndex}=await load('media-catalog-index');
const {inspectJitMetadata}=await load('experimental-jit');
const {compactCatalogProbe}=await load('catalog-background');
const {snapshotHash}=await load('playback-shadow');
const {endpointFamilyFeatures,classifyClientFamily,FAMILY_VERSION}=await load('client-family');
const {TsStabilityAudit}=await load('ts-stability-audit');
const media=path.join(directory,'media');await fs.mkdir(media);
const sources=[];
for(const [name,codec,rate] of [['pair.mp4','libx264','24000/1001'],['pair.mkv','libx265','20']]){
 const file=path.join(media,name);
 await run(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i',`testsrc2=size=320x240:rate=${rate}`,'-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','12','-map','0:v:0','-map','1:a:0','-map','2:a:0','-c:v',codec,...(codec==='libx264'?['-preset','veryfast','-profile:v','high']:['-preset','ultrafast','-x265-params','pools=1:frame-threads=1:log-level=error']),'-threads','1','-pix_fmt','yuv420p','-c:a','aac','-ac','2','-ar','48000',file]);
 sources.push(file);
}
const endpoints=[false,true,false].map((dixim,i)=>{
 const xml=dixim?'<serviceType>urn:schemas-digion-com:service:X_AccessControl:1</serviceType><serviceType>urn:schemas-digion-com:service:X_DeviceConfiguration:1</serviceType>':'<serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/MediaServer/ConnectionManager/Control</controlURL><SCPDURL>/xml/ConnectionManager.xml</SCPDURL>';
 const features=endpointFamilyFeatures(xml,[dixim?'DiXiM/4.0':'Intel_SDK_for_UPnP_devices/1.2']),family=classifyClientFamily(features.signals),remoteIp='192.0.2.'+(10+i),deviceId='uuid:synthetic-audio-'+i,controlUrl='http://'+remoteIp+'/cm';
 return {features,device:{remoteIp,deviceId,descriptionUrl:'http://'+remoteIp+'/description',controlUrl,allowEmptySink:true},capability:{remoteIp,deviceId,controlUrl,sink:'',sinkHash:snapshotHash(''),acquiredAt:new Date().toISOString(),origin:'current-read',implementation:{version:FAMILY_VERSION,fingerprint:family.fingerprint,family:family.family}}};
});
const initial=JSON.parse(await fs.readFile(defaults,'utf8'));
const expansion=process.argv.includes('--mpeg2-expansion');
const policy={...initial,...(expansion?{mpeg2InputTrial:true}:{}),items:[],capabilities:endpoints.map(e=>e.capability),clientTrials:[],clientAdmissions:undefined,maxConcurrentSessions:2,automaticClients:{...initial.automaticClients,enabled:true,priority:'automatic-first'},dualAudioPermissions:endpoints.slice(0,2).map((e,i)=>({version:'jit-dual-audio-permission-v1',enabled:true,deviceId:e.device.deviceId,sinkHash:e.capability.sinkHash,implementationFingerprint:e.capability.implementation.fingerprint,targetProfile:i?'mpeg2-jp-pcr-split-v1':'legacy-jp-observed',reference:'Generated HTTP fixture only; no receiver success claim'}))};
if(expansion)policy.dualAudioPermissions=policy.dualAudioPermissions.filter(p=>p.targetProfile!=='mpeg2-jp-pcr-split-v1');
await fs.writeFile(path.join(directory,'jit.json'),JSON.stringify(policy));await fs.writeFile(path.join(directory,'library.json'),JSON.stringify({version:'recording-library-v1',enabled:true}));
process.chdir(directory);
const db=await openMediaIndex(directory);await db.scan([media],directory);const durations=new Map();
for(const source of sources){const s=await fs.stat(source),fingerprint={path:source,size:s.size,mtimeMs:s.mtimeMs},probe=(await inspectJitMetadata(directory,fingerprint)).probe,id=experimentalObjectId(source),duration=Number(probe.format.duration);assert.ok(db.get(id));db.setMetadata(id,fingerprint,compactCatalogProbe(probe),duration);durations.set(source,duration);}
db.close();
let peak=0;const active=new Set();
const events=[],service=createExperimentalCatalog(directory,(category,detail)=>{events.push({category,detail});const event=detail.detail?.detail;if(category==='EXECUTOR_START'){active.add(event.pid);peak=Math.max(peak,active.size);}if(category==='EXECUTOR_EXIT')active.delete(event.pid);},()=>[media],{discover:async ip=>endpoints.filter(e=>e.device.remoteIp===ip),devices:async()=>[],capability:async device=>({...endpoints.find(e=>e.device.deviceId===device.deviceId).capability,acquiredAt:new Date().toISOString()})});
const headers=i=>({'x-pt3-jit-verify':snapshotHash(JSON.stringify(policy)),'x-pt3-jit-device':endpoints[i].device.deviceId,'User-Agent':i===1?'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0':'UPnP/1.0 Intel_SDK_for_UPnP_devices/1.2'});
let base='';
const server=createServer((req,res)=>void(async()=>{
 const url=new URL(req.url,base);
 if(url.pathname==='/browse'){
  let body='';for await(const chunk of req)body+=chunk;await service.observeClient(req,body);await service.automaticIdle();
  const page=await service.libraryBrowse({objectId:'library/item/'+url.searchParams.get('token'),start:0,count:1,metadata:true},await service.client(req),base,()=>({didl:'<DIDL-Lite></DIDL-Lite>',numberReturned:0,total:0}));res.end(experimentalBrowseSoap(page,0));
 }else{const m=/^\/library\/jit\/([a-f0-9]{32})$/.exec(url.pathname);if(m)await service.libraryMedia(req,res,m[1]);else{res.writeHead(404);res.end();}}
})().catch(error=>{if(!res.headersSent){res.writeHead(500);res.end(String(error));}else res.destroy(error);}));
server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
async function idle(){for(let n=0;n<200;n++){if(service.jitStatus().every(s=>!s.active&&!s.executors))return;await new Promise(r=>setTimeout(r,25));}assert.fail('Executor not cleaned up');}
const checks=[],issued=new Map(),concurrency=[];
try{
 for(const source of sources)for(const i of [0,1,2]){
  const token=experimentalObjectId(source).split('/').at(-1),browse=await fetch(base+'/browse?token='+token,{method:'POST',headers:headers(i),body:i===1?'<u:Browse><Filter>funai:dnUrl,res@dlna:cleartextSize</Filter></u:Browse>':''});
  const xml=(await browse.text()).replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&amp;','&'),url=/<res[^>]*>([^<]+)<\/res>/.exec(xml)?.[1];assert.ok(url?.includes('/library/jit/'));
  issued.set(source+'/'+i,url);
  for(const range of (i===2?['npt=0-2']:[`npt=0-${durations.get(source)}`,'npt=1-3'])){
   const response=await fetch(url,{headers:{...headers(i),'TimeSeekRange.dlna.org':range}});assert.equal(response.status,200);
   const wire=Buffer.from(await response.arrayBuffer());await idle();
   const last=service.jitStatus().find(s=>s.client.startsWith(endpoints[i].device.remoteIp+'/')).lastResult;assert.ok(last.completed);assert.equal(last.underruns,0);
   const tracks=i===2?1:2;if(tracks===2){assert.ok(last.segmentEnd&&last.secondarySegmentEnd);assert.equal(last.sourceAudioClocks.length,2);assert.ok(last.sourceAudioClocks.every(c=>c.maxErrorSeconds<=c.toleranceSeconds+1e-6));}
   const parts=[];for(let o=0;o<wire.length;){assert.deepEqual(wire.subarray(o,o+10),Buffer.alloc(10));const n=wire.readUInt32BE(o+10);assert.ok(n>0&&n%192===0);parts.push(wire.subarray(o+14,o+14+n));o+=14+n;}
   const tts=Buffer.concat(parts),file=path.join(directory,'capture-'+checks.length+'.m2ts');await fs.writeFile(file,tts);
   const probe=JSON.parse((await run(ffprobe,['-v','error','-show_streams','-show_programs','-of','json',file])).stdout),audio=probe.streams.filter(s=>s.codec_type==='audio'),start=i===1?321:257;
   assert.equal(audio.length,tracks);assert.deepEqual(audio.map(s=>Number(s.id)),Array.from({length:tracks},(_,a)=>start+a));assert.ok(probe.programs.some(p=>p.pcr_pid===256));
   const audits=Array.from({length:tracks},(_,a)=>new TsStabilityAudit({pmt:i===1?257:4096,pcr:256,video:i===1?320:256,audio:start+a}));let previous;
   for(let o=0;o<tts.length;o+=192){const current=tts.readUInt32BE(o);if(previous!==undefined)assert.ok(((current-previous+2**31)>>>0)-2**31>=0);previous=current;for(const audit of audits)audit.feed(tts.subarray(o+4,o+192),o/192);}
   for(const audit of audits){const s=audit.finish();for(const k of ['malformed','tei','scrambled','ccErrors','crcErrors','pcrBackwards','audioPtsGaps','audioInvalid'])assert.equal(s.counts[k],0,k);}
   const decoded=await run(ffmpeg,['-v','error','-i',file,'-map','0:v:0','-map','0:a','-enc_time_base:v','1/90000','-fps_mode','passthrough','-f','null','-']);assert.equal(decoded.stderr.trim(),'');
   const hashes=[];for(let a=0;a<tracks;a++)hashes.push((await run(ffmpeg,['-v','error','-i',file,'-map',`0:a:${a}`,'-vn','-f','hash','-hash','sha256','-'])).stdout.trim());if(tracks===2)assert.notEqual(hashes[0],hashes[1]);
   checks.push({source:path.basename(source),target:i===1?'mpeg2':'avc',range,tracks,completed:true,underruns:0});
  }
  if(i<2){const abort=new AbortController(),r=await fetch(url,{headers:{...headers(i),'TimeSeekRange.dlna.org':'npt=0-3'},signal:abort.signal});assert.equal(r.status,200);assert.ok(!(await r.body.getReader().read()).done);abort.abort();await idle();}
 }
 if(process.argv.includes('--concurrency')){
  const urls=[0,1,2].map(i=>issued.get(sources[0]+'/'+i));
  async function begin(i,range){const abort=new AbortController(),response=await fetch(urls[i],{headers:{...headers(i),'TimeSeekRange.dlna.org':range},signal:abort.signal});assert.equal(response.status,200);const reader=response.body.getReader(),first=await reader.read();assert.ok(!first.done);const task=(async()=>{let bytes=first.value.length;for(;;){const next=await reader.read();if(next.done)return {completed:true,bytes};bytes+=next.value.length;}})().catch(error=>({cancelled:true,error:String(error)}));return {task,cancel:()=>abort.abort()};}
  const initial=await Promise.all([begin(0,'npt=0-'),begin(1,'npt=0-')]);
  const busy=await fetch(urls[2],{headers:{...headers(2),'TimeSeekRange.dlna.org':'npt=0-2'}});assert.equal(busy.status,409);await busy.arrayBuffer();
  const replaced=await begin(0,'npt=2-4');assert.ok((await initial[0].task).cancelled);assert.ok((await replaced.task).completed);
  const other=service.jitStatus().find(s=>s.client.startsWith(endpoints[1].device.remoteIp+'/'));assert.ok(other.active||other.lastResult?.completed);assert.ok((await initial[1].task).completed);await idle();
  concurrency.push({case:'two-target-overlap-and-independent-seek',busy409:true,otherCompleted:true});
  const previous=await Promise.all([begin(0,'npt=0-'),begin(1,'npt=0-')]),both=await Promise.all([begin(0,'npt=2-4'),begin(1,'npt=2-4')]);assert.ok((await previous[0].task).cancelled);assert.ok((await previous[1].task).cancelled);assert.ok((await both[0].task).completed);assert.ok((await both[1].task).completed);await idle();
  concurrency.push({case:'simultaneous-seek-replacement',completed:true});
  const stopping=await Promise.all([begin(0,'npt=0-'),begin(1,'npt=0-')]);stopping[0].cancel();assert.ok((await stopping[0].task).cancelled);stopping[1].cancel();assert.ok((await stopping[1].task).cancelled);await idle();assert.equal(active.size,0);assert.equal(peak,2);
  const ends=events.filter(e=>e.category==='JIT_END').map(e=>e.detail.detail.detail);assert.ok(ends.every(e=>e.underruns===0));
  concurrency.push({case:'stop-and-cleanup',executors:0,peak});
 }
 await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,checks,concurrency,scope:'Generated sources, simulated individual permissions, real Browse/GET/FFmpeg; no TV verification'},null,2));
 console.log(JSON.stringify({passed:true,checks:checks.length,concurrency:concurrency.length,directory,scope:'Synthetic HTTP only, no receiver operation'}));
}finally{server.closeAllConnections();await service.stopBackground();await service.closeIndex();await new Promise(r=>server.close(r));await fs.writeFile(path.join(directory,'events.json'),JSON.stringify(events,null,2));}
