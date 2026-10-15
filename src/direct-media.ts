import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {ExperimentalEntry} from './experimental-catalog.js';
import {escapeXml,parseRange,formatDuration} from './core.js';
import {withinSourcePath} from './library-discovery.js';
import {sourceProtection} from './source-protection.js';

const ip=(s:string)=>s.replace(/^::ffff:/,'');
const PREFIX='vlc-direct:';
// A client software hint permits original bytes only, never REGZA transcoding.
export const vlcRequest=(req:Pick<IncomingMessage,'headers'>)=>/\b(?:VLC|LibVLC|VLCKit|MobileVLCKit|VideoLAN)(?:\b|\/)/i.test(String(req.headers['user-agent']??''));
// VLC's UPnP module delegates SOAP to libupnp, which need not name VLC.
// This is a generic original-file candidate, not proof of VLC or Sink support.
const portableController=(req:Pick<IncomingMessage,'headers'>)=>/Portable SDK for UPnP devices|\b(?:libupnp|pupnp)\//i.test(String(req.headers['user-agent']??''));
const video=new Set(['h264','hevc','mpeg1video','mpeg2video','mpeg4','msmpeg4v1','msmpeg4v2','msmpeg4v3','wmv1','wmv2','wmv3','vc1','mjpeg','vp8','vp9','av1','theora']);
const audio=new Set(['aac','mp3','mp2','ac3','eac3','dts','flac','opus','vorbis','wmav1','wmav2','wmapro','wmalossless','alac']);
export function directCandidate(e:ExperimentalEntry){
 const p=e.lightweightProbe;
 if(e.sourceStale||!p||sourceProtection(p)||!Array.isArray(p.streams))return;
 const formats=String(p.format?.format_name??'').split(',');
 const mime=formats.includes('matroska')?'video/x-matroska':formats.includes('avi')?'video/x-msvideo':formats.includes('asf')?'video/x-ms-asf':formats.includes('mp4')?'video/mp4':undefined;
 const streams=p.streams.filter((s:any)=>s.codec_type==='video'&&!s.disposition?.attached_pic);
 if(!mime||!streams.length||streams.some((s:any)=>!video.has(s.codec_name)||!(s.width>0&&s.height>0)||s.width*s.height>7680*4320))return;
 if(p.streams.some((s:any)=>s.codec_type==='audio'&&!audio.has(s.codec_name)&&!/^pcm_[a-z0-9]+$/.test(s.codec_name??'')))return;
 const seconds=Number(p.format?.duration);
 return {mime,seconds:Number.isFinite(seconds)&&seconds>0?seconds:undefined};
}
export function createDirectMedia(folders:()=>string[],trace:(event:string,detail:unknown)=>void){
 type Lease={remote:string;fingerprint:ExperimentalEntry['fingerprint'];objectId:string;expires:number};
 const leases=new Map<string,Lease>(),keys=new Map<string,string>();
 const leaseKey=(l:Pick<Lease,'remote'|'objectId'|'fingerprint'>)=>JSON.stringify([l.remote,l.objectId,l.fingerprint]);
 const features='DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=00000000000000000000000000000000';
 function remove(k:string){const l=leases.get(k);if(l)keys.delete(leaseKey(l));leases.delete(k);}
 function prune(){while(leases.size>=8192||leases.size&&leases.values().next().value!.expires<Date.now())remove(leases.keys().next().value!);}
 return {
  client(req:IncomingMessage,remote:string){const candidate=vlcRequest(req)||portableController(req);if(candidate)trace('DIRECT_CLIENT',{remote:ip(remote),userAgent:req.headers['user-agent'],evidence:vlcRequest(req)?'VLC software hint':'generic libupnp controller; VLC identity unconfirmed',jitPermission:false});return candidate?PREFIX+ip(remote):remote;},
  item(e:ExperimentalEntry,base:string,client:string):string|undefined{
   if(!client.startsWith(PREFIX))return;
   const c=directCandidate(e);if(!c)return;
   prune();const remote=client.slice(PREFIX.length);
   // Reuse URLs while browsing pages; bounded leases expire without disk writes.
   const identity={remote,objectId:e.objectId,fingerprint:{...e.fingerprint}},index=leaseKey(identity);
   let key=keys.get(index);
   if(!key){key=randomUUID();leases.set(key,{...identity,expires:Date.now()+86400000});keys.set(index,key);}
   const token=e.objectId.split('/').at(-1)!;
   trace('DIRECT_RESOURCE',{sourceId:e.objectId,client:remote,route:'vlc-original-candidate-v1',mime:c.mime,verification:'client playback unverified; header codec allowlist',jit:false});
   return `<item id="library/item/${token}" parentID="all" restricted="1"><dc:title>${escapeXml(e.filename)}</dc:title><upnp:class>object.item.videoItem</upnp:class><dc:date>${new Date(e.fingerprint.mtimeMs).toISOString()}</dc:date><res protocolInfo="${escapeXml('http-get:*:'+c.mime+':'+features)}" size="${e.fingerprint.size}"${c.seconds!==undefined?' duration="'+formatDuration(c.seconds)+'"':''}>${escapeXml(`${base}/library/direct/${token}?access=${key}`)}</res></item>`;
  },
  async deliver(req:IncomingMessage,res:ServerResponse,e:ExperimentalEntry|undefined){
   const requestId=randomUUID(),began=performance.now();let bytes=0;
   const key=new URL(req.url??'','http://local').searchParams.get('access')??'',lease=leases.get(key);
   const reject=(status:number)=>{res.writeHead(status);res.end();trace('DIRECT_REJECT',{requestId,status,client:ip(req.socket.remoteAddress??'')});};
   if(!lease||lease.expires<Date.now()||lease.remote!==ip(req.socket.remoteAddress??'')||!e||lease.objectId!==e.objectId||JSON.stringify(lease.fingerprint)!==JSON.stringify(e.fingerprint))return reject(403);
   const c=directCandidate(e);if(!c)return reject(415);
   if(req.method!=='HEAD'&&req.method!=='GET'){res.setHeader('Allow','GET, HEAD');return reject(405);}
   if(req.headers['timeseekrange.dlna.org'])return reject(406); // byte seek only; do not invent a time-to-byte mapping
   let file:Awaited<ReturnType<typeof fs.open>>|undefined;
   try{
    const actual=await fs.realpath(e.fingerprint.path),roots=await Promise.all(folders().map(f=>fs.realpath(f).catch(()=>'')));
    if(!roots.some(r=>r&&withinSourcePath(actual,r)))return reject(403);
    file=await fs.open(actual,'r');const st=await file.stat();
    if(!st.isFile()||st.size!==lease.fingerprint.size||st.mtimeMs!==lease.fingerprint.mtimeMs)return reject(409);
    let range;try{range=parseRange(req.method==='GET'?req.headers.range:undefined,st.size);}catch{res.setHeader('Content-Range',`bytes */${st.size}`);return reject(416);}
    const start=range?.start??0,end=range?.end??st.size-1,length=range?end-start+1:st.size;
    res.setHeader('Content-Type',c.mime);res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',length);
    res.setHeader('contentFeatures.dlna.org',features);res.setHeader('transferMode.dlna.org','Streaming');
    if(range)res.setHeader('Content-Range',`bytes ${start}-${end}/${st.size}`);
    res.writeHead(range?206:200);
    trace('DIRECT_HTTP',{requestId,sourceId:e.objectId,requestHeaders:req.headers,status:range?206:200,responseHeaders:res.getHeaders(),start,end,length,jit:false});
    if(req.method==='HEAD'||!length){res.end();return;}
    const stream=file.createReadStream({start,end,autoClose:false});
    stream.on('data',chunk=>{if(!bytes)trace('DIRECT_FIRST_BODY',{requestId,seconds:(performance.now()-began)/1000});bytes+=chunk.length;});
    await pipeline(stream,res);
    trace('DIRECT_END',{requestId,bytes,expected:length,reason:'complete',seconds:(performance.now()-began)/1000});
   }catch(error){trace('DIRECT_END',{requestId,bytes,reason:res.destroyed?'client-disconnected':'error',error:String(error)});if(!res.headersSent&&!res.destroyed)reject(503);else if(!res.destroyed)res.destroy();}
   finally{await file?.close().catch(()=>{});}
  }
 };
}
