import {createHash} from 'node:crypto';
import {createReadStream,promises as fs} from 'node:fs';
import path from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {escapeXml,type PcrIndex} from './core.js';
import {createExperimentalHandler,experimentalFormat,type ExperimentalMediaConfig} from './experimental-media.js';
import type {BrowseInput,BrowsePage} from './experimental-catalog.js';
import {readShadowJson,acquireCapability,type RegisteredDmp} from './playback-shadow-store.js';
import {snapshotHash,type Fingerprint,type CapabilitySnapshot} from './playback-shadow.js';
import {matchingJitTrial,jitRecipeFingerprint} from './jit-client-trial.js';
import type {ExperimentalJitPolicy} from './experimental-jit.js';

export const AVC_CONTROL_ROOT='avc-http-control';
interface HashedFile extends Fingerprint {sha256:string}
export interface AvcHttpControl {
 version:'avc-http-control-v1';enabled:boolean;device:RegisteredDmp;sinkHash:string;
 source:Fingerprint;capture:HashedFile;validation:HashedFile;index:HashedFile;
 targetProfile:string;recipeFingerprint:string;title:string;duration:number;wireBytes:number;
}
const ip=(s:string)=>s.replace(/^::ffff:/,'');
const wrap=(s:string)=>`<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${s}</DIDL-Lite>`;
const container=()=>`<container id="${AVC_CONTROL_ROOT}" parentID="0" restricted="1" childCount="2"><dc:title>AVC HTTP比較（未確認）</dc:title><upnp:class>object.container</upnp:class></container>`;
export function appendAvcControlRoot(xml:string,b:BrowseInput,enabled:boolean){
 if(!enabled||b.objectId!=='0')return xml;
 if(b.metadata)return xml.replace(/(&lt;container\s+id=&quot;0&quot;[\s\S]*?childCount=&quot;)(\d+)/,(_,p,n)=>p+(Number(n)+1));
 const total=Number(/<TotalMatches>(\d+)</.exec(xml)?.[1]),returned=Number(/<NumberReturned>(\d+)</.exec(xml)?.[1]);
 if(!Number.isSafeInteger(total)||!Number.isSafeInteger(returned))throw Error('Invalid root page');
 let result=xml.replace(/<TotalMatches>\d+</,`<TotalMatches>${total+1}<`);
 if((b.count===0||returned<b.count)&&b.start<=total&&b.start+returned===total)
  result=result.replace('&lt;/DIDL-Lite&gt;',escapeXml(container())+'&lt;/DIDL-Lite&gt;').replace(/<NumberReturned>\d+</,`<NumberReturned>${returned+1}<`);
 return result;
}
async function statMatches(f:Fingerprint){try{const s=await fs.stat(f.path);return s.isFile()&&s.size===f.size&&s.mtimeMs===f.mtimeMs;}catch{return false;}}
async function digest(f:HashedFile){const hash=createHash('sha256');for await(const b of createReadStream(f.path))hash.update(b);return hash.digest('hex')===f.sha256&&await statMatches(f);}
/** Read-only comparison of one PC-validated captured JIT payload. Never an automatic playback fallback. */
export function createAvcHttpControl(directory:string,policyFile:string,trace:(event:string,detail:unknown)=>void,acquire=acquireCapability){
 let cachedProof:string|undefined;
 async function bound(remote:string){
  try{
  const c=await readShadowJson<AvcHttpControl>(path.join(directory,'contract.json'));
  if(c?.version!=='avc-http-control-v1'||c.enabled!==true||!c.device.deviceId||ip(c.device.remoteIp)!==ip(remote)||
   !Number.isFinite(c.duration)||c.duration<=0||c.duration>150||!Number.isSafeInteger(c.wireBytes)||c.wireBytes<=0||
   !Number.isSafeInteger(c.capture.size)||c.capture.size<=0||c.capture.size%192!==0||
   c.wireBytes!==c.capture.size+Math.ceil(c.capture.size/5568)*14)return;
  const p=await readShadowJson<ExperimentalJitPolicy>(policyFile),cap=p?.capabilities.find(v=>v.deviceId===c.device.deviceId&&ip(v.remoteIp)===ip(remote));
  const target=p?.policy.profiles.find(v=>v.id===c.targetProfile);
  if(!p?.enabled||!cap||cap.sinkHash!==c.sinkHash||!target||jitRecipeFingerprint(target)!==c.recipeFingerprint||!matchingJitTrial(p.clientTrials,cap,target)||target.transport.value.profileName!=='AVC_TS_JP_AAC_T'||target.transport.value.framing!=='jp-content-packet')return;
  if(!await statMatches(c.source)||!await statMatches(c.capture)||!await statMatches(c.validation)||!await statMatches(c.index))return;
  return {c,cap,target};
  }catch(error){trace('AVC_CONTROL_MANIFEST_ERROR',{error:String(error),normalPlaybackUnaffected:true});return;}
 }
 const config=(c:AvcHttpControl):ExperimentalMediaConfig=>({file:c.capture.path,title:c.title,durationSeconds:c.duration,address:'127.0.0.1',port:0,udn:'uuid:00000000-0000-4000-8000-000000000000',mode:'remux',contentPacket:true,timeSeek:true,contentPacketBlockBytes:5568,pcrLeadMs:1100});
 return {
  async enabled(remote:string){return !!await bound(remote);},
  async updateId(remote:string){const v=await bound(remote);return v?parseInt(snapshotHash(JSON.stringify(v.c)).slice(0,8),16):0;},
  async browse(b:BrowseInput,remote:string,base:string):Promise<BrowsePage|undefined>{
   if(b.objectId!==AVC_CONTROL_ROOT&&!b.objectId.startsWith(AVC_CONTROL_ROOT+'/'))return;
   const v=await bound(remote);if(!v)return {didl:wrap(''),numberReturned:0,total:0};
   const entries=['fixed','chunked'].map(mode=>`<item id="${AVC_CONTROL_ROOT}/${mode}" parentID="${AVC_CONTROL_ROOT}" restricted="1"><dc:title>${escapeXml(v.c.title)} — ${mode==='fixed'?'固定長HTTP':'chunked対照'}</dc:title><upnp:class>object.item.videoItem</upnp:class><dc:description>Captured JIT diagnostic control; receiver acceptance unconfirmed; no encoder</dc:description><res protocolInfo="${experimentalFormat(config(v.c)).protocolInfo}"${mode==='fixed'?` size="${v.c.wireBytes}"`:''} duration="0:${String(Math.floor(v.c.duration/60)).padStart(2,'0')}:${(v.c.duration%60).toFixed(3).padStart(6,'0')}">${escapeXml(base+'/avc-http-control/media/'+mode)}</res></item>`);
   const selected=b.metadata?b.objectId===AVC_CONTROL_ROOT?[container()]:entries.filter((_,i)=>b.objectId===AVC_CONTROL_ROOT+'/'+['fixed','chunked'][i]):b.objectId===AVC_CONTROL_ROOT?entries.slice(b.start,b.count?b.start+b.count:undefined):[];
   return {didl:wrap(selected.join('')),numberReturned:selected.length,total:b.metadata?selected.length:b.objectId===AVC_CONTROL_ROOT?2:0};
  },
  async media(req:IncomingMessage,res:ServerResponse,mode:string,resolvedClient=req.socket.remoteAddress||''){
   const remote=ip(resolvedClient);
   try{
    const v=await bound(remote);if(!v||!['fixed','chunked'].includes(mode)){res.writeHead(404);res.end();return;}
    if(!['GET','HEAD'].includes(req.method||'')){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
    if(req.headers.range){res.writeHead(400);res.end('Byte Range unsupported; use TimeSeekRange');return;}
    const current:CapabilitySnapshot=await acquire(v.c.device,AbortSignal.timeout(10000));
    if(current.deviceId!==v.c.device.deviceId||current.sinkHash!==v.c.sinkHash)throw Error('Client identity/capability changed');
    const key=snapshotHash(JSON.stringify(v.c));
    if(cachedProof!==key){
     for(const f of [v.c.capture,v.c.validation,v.c.index])if(!await digest(f))throw Error('Control fingerprint mismatch');
     const report=await readShadowJson<any>(v.c.validation.path);
     if(!report?.passed||typeof report.directory!=='string'||path.resolve(report.directory,'media.m2ts')!==path.resolve(v.c.capture.path)||report.source!==v.c.source.path||report.bytes!==v.c.wireBytes||report.duplicate!==0||report.decoded!==report.retained||
      report.hrd?.violations!==0||report.hrd?.underflow!==0||report.hrd?.overflow!==0||report.receivedLead?.underruns!==0||
      !report.transport?.contentPacket?.bodyExact||!report.transport?.tts?.all32bitWithinOneTick||report.transport?.pcr?.discontinuities!==0)throw Error('Missing captured JIT validation');
     cachedProof=key;
    }
    const index=await readShadowJson<PcrIndex>(v.c.index.path);
    if(!index||index.packetCount*192!==v.c.capture.size||Math.abs(index.durationSeconds-v.c.duration)>.1)throw Error('Capture/index duration mismatch');
    const writeHead=res.writeHead;
    // Only this diagnostic response changes length framing. The body and shared pacer are identical.
    res.writeHead=function(this:ServerResponse,status:number,...args:any[]){
     const headerIndex=typeof args[0]==='string'?1:0,headers=args[headerIndex];
     if(headers&&mode==='chunked'){const next={...headers};for(const k of Object.keys(next))if(k.toLowerCase()==='content-length')delete next[k];args[headerIndex]=next;}
     trace('AVC_CONTROL_RESPONSE',{mode,deviceId:current.deviceId,status,headers:args[headerIndex],sourceFingerprint:v.c.source,captureFingerprint:v.c.capture,receiverVerification:'diagnostic-only',executorStarted:false});
     return (writeHead as any).call(this,status,...args);
    } as typeof res.writeHead;
    const original=req.url;req.url='/media/sampleA.tts';
    try{await createExperimentalHandler(config(v.c),(category,message,detail)=>trace('AVC_CONTROL_'+category,{mode,message,detail}),index)(req,res);}
    finally{req.url=original;res.writeHead=writeHead;}
   }catch(error){trace('AVC_CONTROL_ERROR',{mode,error:String(error)});if(!res.headersSent){res.writeHead(503,{'Content-Length':0});res.end();}else res.destroy();}
  }
 };
}
