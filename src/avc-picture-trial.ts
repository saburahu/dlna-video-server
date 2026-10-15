import assert from 'node:assert/strict';
import {createReadStream,promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {escapeXml,type PcrIndex} from './core.js';
import {readShadowJson,acquireCapability,type RegisteredDmp} from './playback-shadow-store.js';
import type {Fingerprint} from './playback-shadow.js';
import type {BrowseInput,BrowsePage} from './experimental-catalog.js';
import {createExperimentalHandler,experimentalFormat,type ExperimentalMediaConfig} from './experimental-media.js';
import {jpBlocks,startupBlocks} from './jit-stream.js';
import {waitJitDrain} from './jit-cancellation.js';
import {parseTimeSeek} from './time-seek.js';

export const AVC_PICTURE_ROOT='avc-picture-trial';
export interface PictureFile extends Fingerprint {sha256:string}
export interface PictureTrial {
 version:'avc-picture-trial-v1';enabled:boolean;device:RegisteredDmp;sinkHash:string;
 source:Fingerprint;seconds:number;variants:{id:string;title:string;capture:PictureFile;index:PictureFile;validation:PictureFile}[];
}
const ip=(s:string)=>s.replace(/^::ffff:/,'');
const wrap=(s:string)=>`<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${s}</DIDL-Lite>`;
const container=(count:number)=>`<container id="${AVC_PICTURE_ROOT}" parentID="0" restricted="1" childCount="${count}"><dc:title>AVC映像比較（実機未確認）</dc:title><upnp:class>object.container</upnp:class></container>`;
const config=(file:string,seconds:number):ExperimentalMediaConfig=>({file,title:'AVC picture comparison',durationSeconds:seconds,address:'127.0.0.1',port:0,udn:'uuid:00000000-0000-4000-8000-000000000000',mode:'remux',contentPacket:true,timeSeek:true,contentPacketBlockBytes:5568,pcrLeadMs:1100});
export const pictureProtocol=experimentalFormat(config('unused.m2ts',30)).protocolInfo;
export function appendPictureRoot(xml:string,b:BrowseInput,count:number){
 if(!count||b.objectId!=='0')return xml;
 if(b.metadata)return xml.replace(/(&lt;container\s+id=&quot;0&quot;[\s\S]*?childCount=&quot;)(\d+)/,(_,p,n)=>p+(Number(n)+1));
 const total=Number(/<TotalMatches>(\d+)</.exec(xml)?.[1]),returned=Number(/<NumberReturned>(\d+)</.exec(xml)?.[1]);
 assert.ok(Number.isSafeInteger(total)&&Number.isSafeInteger(returned));
 let result=xml.replace(/<TotalMatches>\d+</,`<TotalMatches>${total+1}<`);
 if((!b.count||returned<b.count)&&b.start<=total&&b.start+returned===total)result=result.replace('&lt;/DIDL-Lite&gt;',escapeXml(container(count))+'&lt;/DIDL-Lite&gt;').replace(/<NumberReturned>\d+</,`<NumberReturned>${returned+1}<`);
 return result;
}
async function statMatches(f:Fingerprint){try{const s=await fs.stat(f.path);return s.isFile()&&s.size===f.size&&s.mtimeMs===f.mtimeMs;}catch{return false;}}
async function hashMatches(f:PictureFile){const h=createHash('sha256');for await(const b of createReadStream(f.path))h.update(b);return h.digest('hex')===f.sha256&&await statMatches(f);}
/** Optional, explicit individual trial. Never changes production target selection. */
export function createAvcPictureTrial(directory:string,trace:(event:string,detail:unknown)=>void,acquire=acquireCapability){
 const proofs=new Set<string>();
 async function bound(remote:string){
  try{
   const c=await readShadowJson<PictureTrial>(path.join(directory,'contract.json'));
   if(c?.version!=='avc-picture-trial-v1'||!c.enabled||!c.device?.deviceId||ip(c.device.remoteIp)!==ip(remote)||!Number.isFinite(c.seconds)||c.seconds<5||c.seconds>60||!Array.isArray(c.variants)||!c.variants.length||c.variants.length>4)return;
   if(new Set(c.variants.map(v=>v.id)).size!==c.variants.length)return;
   const root=path.resolve(directory)+path.sep;
   for(const v of c.variants){
    if(!/^[a-z0-9-]+$/.test(v.id)||!v.capture.path.endsWith('.m2ts')||v.capture.size%192)return;
    for(const f of [v.capture,v.index,v.validation])if(!path.resolve(f.path).startsWith(root)||!/^[a-f0-9]{64}$/.test(f.sha256)||!await statMatches(f))return;
   }
   if(!await statMatches(c.source))return;
   const current=await acquire(c.device,AbortSignal.timeout(5000));
   if(current.deviceId!==c.device.deviceId||ip(current.remoteIp)!==ip(remote)||current.sinkHash!==c.sinkHash)throw Error('Trial identity/capability changed');
   return c;
  }catch(error){trace('PICTURE_TRIAL_DENIED',{remote,error:String(error)});return;}
 }
 return {
  async count(remote:string){return (await bound(remote))?.variants.length??0;},
  async browse(b:BrowseInput,remote:string,base:string):Promise<BrowsePage|undefined>{
   if(b.objectId!==AVC_PICTURE_ROOT&&!b.objectId.startsWith(AVC_PICTURE_ROOT+'/'))return;
   const c=await bound(remote);if(!c)return {didl:wrap(''),numberReturned:0,total:0};
   const items=c.variants.map(v=>`<item id="${AVC_PICTURE_ROOT}/${v.id}" parentID="${AVC_PICTURE_ROOT}" restricted="1"><dc:title>${escapeXml(v.title)}</dc:title><upnp:class>object.item.videoItem</upnp:class><dc:description>PC-validated single-variable comparison; receiver acceptance unconfirmed; captured output, no encoder at GET</dc:description><res protocolInfo="${pictureProtocol}" duration="0:00:${c.seconds.toFixed(3).padStart(6,'0')}">${escapeXml(base+'/'+AVC_PICTURE_ROOT+'/media/'+v.id)}</res></item>`);
   const selected=b.metadata?b.objectId===AVC_PICTURE_ROOT?[container(items.length)]:items.filter((_,i)=>b.objectId===AVC_PICTURE_ROOT+'/'+c.variants[i].id):b.objectId===AVC_PICTURE_ROOT?items.slice(b.start,b.count?b.start+b.count:undefined):[];
   return {didl:wrap(selected.join('')),numberReturned:selected.length,total:b.metadata?selected.length:b.objectId===AVC_PICTURE_ROOT?items.length:0,updateId:parseInt(createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0,8),16)};
  },
  async media(req:IncomingMessage,res:ServerResponse,id:string,remote=req.socket.remoteAddress??''){
   const requestId=randomUUID();let bytes=0,blocks=0,first:number|undefined,leadMin=Infinity,leadMax=-Infinity;
   const started=performance.now();trace('PICTURE_TRIAL_REQUEST',{requestId,id,remote,method:req.method,headers:req.headers});
   try{
    const c=await bound(remote),v=c?.variants.find(v=>v.id===id);
    if(!c||!v){res.writeHead(404);res.end();return;}
    if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
    if(req.headers.range){res.writeHead(400,{'Content-Length':0});res.end('Byte Range unsupported; use TimeSeekRange');return;}
    const key=JSON.stringify(v);
    if(!proofs.has(key)){
     for(const f of [v.capture,v.index,v.validation])assert.ok(await hashMatches(f),'Trial file digest mismatch');
     const report=await readShadowJson<any>(v.validation.path);
     assert.ok(report?.passed&&report.version==='avc-picture-validation-v1'&&report.variant===v.id&&report.captureHash===v.capture.sha256&&JSON.stringify(report.source)===JSON.stringify(c.source)&&report.seconds===c.seconds&&report.decode===true&&report.hrd?.violations===0&&report.hrd?.underflow===0&&report.hrd?.overflow===0,'Unvalidated picture trial');
     if(proofs.size>=4)proofs.clear();proofs.add(key);
    }
    const index=await readShadowJson<PcrIndex>(v.index.path);assert.ok(index&&index.packetCount*192===v.capture.size&&!index.discontinuities&&!index.invalidIntervals);
    const original=req.url;
    // TimeSeek uses the existing validated static TTS mapping. This experiment's
    // principal comparison is start/stop only; no changed seek planner is used.
    const seek=req.headers['timeseekrange.dlna.org'];let partial=false;
    if(seek!==undefined){try{const range=parseTimeSeek(String(seek),c.seconds);partial=range.start!==0||range.end!==c.seconds;}catch{res.writeHead(406,{'Content-Length':0});res.end();return;}}
    if(partial){
     const writeHead=res.writeHead;res.writeHead=function(this:ServerResponse,status:number,...args:any[]){const h=args[0];if(h){delete h['Content-Length'];h['Cache-Control']='no-store';}return(writeHead as any).call(this,status,...args);} as typeof res.writeHead;
     req.url='/media/sampleA.tts';try{await createExperimentalHandler(config(v.capture.path,c.seconds),(category,message,detail)=>trace('PICTURE_TRIAL_'+category,{id,requestId,message,detail}),index)(req,res);}finally{req.url=original;res.writeHead=writeHead;}return;
    }
    const headers={'Content-Type':'video/vnd.dlna.mpeg-tts','Accept-Ranges':'none','contentFeatures.dlna.org':pictureProtocol.split(':').slice(3).join(':'),'transferMode.dlna.org':'Streaming','Cache-Control':'no-store','TimeSeekRange.dlna.org':`npt=0.000000-${c.seconds.toFixed(6)}/${c.seconds.toFixed(6)}`};
    if(req.method==='HEAD'){res.writeHead(200,headers);res.end();return;}
    // Exactly the production JIT's 29-packet framing, 2.2-second startup gate
    // and media-clock/1.1-second lead equation; only the producer is a capture.
    async function* packets(){let carry:Buffer=Buffer.alloc(0);for await(const b of createReadStream(v!.capture.path)){const data=Buffer.concat([carry,b]);let i=0;for(;i+192<=data.length;i+=192)yield data.subarray(i,i+192);carry=Buffer.from(data.subarray(i));}assert.equal(carry.length,0);}
    for await(const block of startupBlocks(jpBlocks(packets()),2.2,(seconds,bufferBytes)=>trace('PICTURE_TRIAL_READY',{id,requestId,seconds,bufferBytes}))){
     if(res.destroyed)throw Error('Client disconnected');
     if(first===undefined){first=performance.now();trace('PICTURE_TRIAL_RESPONSE',{id,requestId,headers,chunked:true,producer:'validated capture',firstBodyMs:first-started});res.writeHead(200,headers);res.flushHeaders();}
     const wait=(block.mediaSeconds-1.1-(performance.now()-first)/1000)*1000;if(wait>1)await new Promise(r=>setTimeout(r,wait));
     if(res.destroyed)throw Error('Client disconnected');const elapsed=(performance.now()-first)/1000,lead=block.mediaSeconds-elapsed;if(elapsed>3){leadMin=Math.min(leadMin,lead);leadMax=Math.max(leadMax,lead);}
     bytes+=block.bytes.length;blocks++;if(!res.write(block.bytes))await waitJitDrain(res);
     if(blocks%300===0)trace('PICTURE_TRIAL_PROGRESS',{id,requestId,bytes,elapsed,lead});
    }
    res.end();trace('PICTURE_TRIAL_END',{id,requestId,bytes,blocks,outcome:'completed',leadMin,leadMax});
   }catch(error){trace('PICTURE_TRIAL_END',{id,requestId,bytes,blocks,outcome:res.destroyed?'client-disconnected':'error',error:String(error)});if(!res.headersSent){res.writeHead(503,{'Content-Length':0});res.end();}else if(!res.destroyed)res.destroy();}
  }
 };
}
