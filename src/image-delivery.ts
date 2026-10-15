import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs,createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {randomUUID,createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {parseSinkProtocolInfo} from './playback-decision.js';
import {snapshotHash,matchingFingerprint,type CapabilitySnapshot} from './playback-shadow.js';
import {readShadowJson,saveShadowJson,acquireCapability,shadowDirectory,type RegisteredDmp} from './playback-shadow-store.js';
import type {ExperimentalJitPolicy} from './experimental-jit.js';
import type {CatalogRow} from './media-catalog-index.js';
import {inspectWebp,type WebpMetadata} from './webp-metadata.js';
import {execute,ffmpeg} from './prepare-executor.js';
import {escapeXml} from './core.js';

export const PHOTO_ROOT='photos';
const VERSION='webp-jpeg-white-exif-v1';
const ip=(s:string)=>s.replace(/^::ffff:/,'');
let decoder:Promise<boolean>|undefined;
export function installedWebpDecoder(){
 return decoder??=execute(ffmpeg(),['-hide_banner','-decoders'],{windowsHide:true,timeout:10000,maxBuffer:1048576})
  .then(r=>/^\s*V\S*\s+webp\s/m.test(r.stdout)).catch(e=>{decoder=undefined;throw e;});
}
export function photoTarget(sink:string){
 const entries=parseSinkProtocolInfo(sink);
 for(const [pn,width,height] of [['JPEG_MED',1024,768],['JPEG_SM',640,480]] as const){
  if(entries.some(e=>e.protocol==='http-get'&&e.mime==='image/jpeg'&&e.profileName===pn)){
   const features=`DLNA.ORG_PN=${pn};DLNA.ORG_OP=01;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=00f00000000000000000000000000000`;
   return {pn,width,height,features,protocolInfo:`http-get:*:image/jpeg:${features}`};
  }
 }
}
export function stillSupported(m:WebpMetadata|undefined){return !!m&&m.version==='webp-riff-v1'&&!m.animated&&m.frames===1&&m.width*m.height<=32_000_000&&m.colorSpace==='sRGB-assumed'&&!m.issues.length;}
export function photoItem(r:CatalogRow,base:string,target:ReturnType<typeof photoTarget>){
 const m=(r.metadata as any)?.image as WebpMetadata|undefined,token=r.objectId.split('/').at(-1)!;
 const state=m?.animated?'Animated WebP: playback unsupported; no silent first-frame substitution':!m?'Unanalysed':!stillSupported(m)?'Unsupported image size/color profile/metadata':'WebP -> JPEG on GET; white alpha background';
 return `<item id="photos/item/${token}" parentID="photos" restricted="1"><dc:title>${escapeXml(r.filename)}</dc:title><upnp:class>object.item.imageItem.photo</upnp:class><dc:description>${escapeXml(state)}</dc:description>${stillSupported(m)&&r.size<=64*1024*1024&&(r.metadata as any)?.imageDecoderAvailable===true&&target?`<res protocolInfo="${escapeXml(target.protocolInfo)}">${escapeXml(`${base}/library/image/${token}`)}</res>`:''}</item>`;
}
export function createImageDelivery(directory:string,trace:(event:string,detail:unknown)=>void,dependencies:{capability?:typeof acquireCapability}={}){
 const jobs=new Map<string,Promise<string>>();
 const current=async(remote:string)=>{
  const p=await readShadowJson<ExperimentalJitPolicy>(path.join(directory,'jit.json'));
  const cap=p?.capabilities.find(c=>ip(c.remoteIp)===ip(remote));
  return p?.enabled&&cap&&cap.sinkHash===snapshotHash(cap.sink)?cap:undefined;
 };
 const target=async(remote:string)=>{const c=await current(remote);return c?photoTarget(c.sink):undefined;};
 async function prepare(r:CatalogRow,t:NonNullable<ReturnType<typeof photoTarget>>,signal:AbortSignal){
  const source={path:r.path,size:r.size,mtimeMs:r.mtimeMs},key=snapshotHash(JSON.stringify({version:VERSION,source,target:t.pn,background:'white'}));
  const cache=path.join(directory,'image-cache'),file=path.join(cache,key+'.jpg'),manifest=file+'.json';
  const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
  try{const c=await readShadowJson<any>(manifest),st=await fs.stat(file);assert.ok(c?.version===VERSION&&c.key===key&&st.size===c.size&&st.size<=4*1024*1024);assert.equal(hash(await fs.readFile(file)),c.sha256);trace('IMAGE_CACHE_HIT',{sourceId:r.objectId,key});return file;}catch{}
  if(jobs.has(key))return jobs.get(key)!;
  if(jobs.size>=1)throw Error('Image conversion busy');
  const job=(async()=>{
   const m=await inspectWebp(r.path,signal);assert.ok(stillSupported(m)&&r.size<=64*1024*1024,'Unsupported WebP');
   const rotated=m.orientation>=5,w=rotated?m.height:m.width,h=rotated?m.width:m.height,scale=Math.min(1,t.width/w,t.height/h);
   const width=Math.max(2,Math.floor(w*scale/2)*2),height=Math.max(2,Math.floor(h*scale/2)*2);
   const orient=['','', 'hflip','hflip,vflip','vflip','transpose=clock,hflip','transpose=clock','transpose=clock,vflip','transpose=cclock'][m.orientation];
   const filters=`[0:v]${orient?orient+',':''}scale=${width}:${height}:flags=lanczos,setsar=1,format=rgba[fg];color=c=white:s=${width}x${height}[bg];[bg][fg]overlay=shortest=1,format=yuvj420p[out]`;
   await fs.mkdir(cache,{recursive:true});const temp=path.join(cache,key+'.'+randomUUID()+'.jpg');
   try{
    await execute(ffmpeg(),['-nostdin','-hide_banner','-v','error','-noautorotate','-threads','1','-i',r.path,'-filter_complex_threads','1','-filter_complex',filters,'-map','[out]','-frames:v','1','-c:v','mjpeg','-q:v','2','-threads','1','-map_metadata','-1','-f','image2',temp],{windowsHide:true,timeout:30000,maxBuffer:1048576,signal});
    const b=await fs.readFile(temp);assert.ok(b.length>100&&b.length<=4*1024*1024&&b[0]===255&&b[1]===216&&b.at(-2)===255&&b.at(-1)===217,'Invalid JPEG');
    const st=await fs.stat(r.path);assert.ok(matchingFingerprint(source,{path:r.path,size:st.size,mtimeMs:st.mtimeMs}),'Image source changed');
    signal.throwIfAborted();await fs.rename(temp,file);await saveShadowJson(manifest,{version:VERSION,key,size:b.length,sha256:hash(b),width,height,orientationApplied:m.orientation,background:'white',source});
    trace('IMAGE_CONVERTED',{sourceId:r.objectId,key,width,height,bytes:b.length});return file;
   }finally{await fs.unlink(temp).catch(()=>{});}
  })();jobs.set(key,job);try{return await job;}finally{jobs.delete(key);}
 }
 return {target,async deliver(req:IncomingMessage,res:ServerResponse,r:CatalogRow,remote:string){
  const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel);
  try{
   if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405);res.end();return;}
   const cap=await current(remote),t=cap?photoTarget(cap.sink):undefined;assert.ok(cap&&t&&stillSupported((r.metadata as any)?.image)&&await installedWebpDecoder());
   const st=await fs.stat(r.path);assert.ok(st.size===r.size&&st.mtimeMs===r.mtimeMs,'Stale image source');
   // Re-read current advertisement on GET, just like the video boundary.
   const devices=await readShadowJson<RegisteredDmp[]>(path.join(shadowDirectory(),'devices.json'))??[],device=devices.find(d=>ip(d.remoteIp)===ip(remote));assert.ok(device,'Unregistered image DMP');
   const live=await (dependencies.capability??acquireCapability)(device,controller.signal);assert.equal(live.sinkHash,cap.sinkHash);
   const file=await prepare(r,t,controller.signal),size=(await fs.stat(file)).size;
   let start=0,end=size-1,status=200;const range=req.headers.range;
   const headers:Record<string,string|number>={'Content-Type':'image/jpeg','Accept-Ranges':'bytes','contentFeatures.dlna.org':t.features,'transferMode.dlna.org':'Interactive'};
   if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||!m[1]&&!m[2]){res.writeHead(400,{'Content-Length':0});res.end();return;}start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));end=m[1]&&m[2]?Math.min(size-1,Number(m[2])):size-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
   }
   headers['Content-Length']=end-start+1;res.writeHead(status,headers);if(req.method==='HEAD'){res.end();return;}
   await pipeline(createReadStream(file,{start,end}),res);trace('IMAGE_HTTP_END',{sourceId:r.objectId,status,bytes:end-start+1});
  }catch(error){trace('IMAGE_ERROR',{sourceId:r.objectId,error:String(error),cancelled:res.destroyed});if(!res.headersSent)res.writeHead(503,{'Content-Length':0});res.end();}finally{res.off('close',cancel);}
 }};
}
