import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {escapeXml,parseRange} from './core.js';
import {readShadowJson} from './playback-shadow-store.js';
import {inspectClientCapability,type ClientInspection} from './client-capability-inspection.js';
import type {BrowseInput,BrowsePage} from './experimental-catalog.js';

export const CLIENT_DIAGNOSTIC_ROOT='client-diagnostics';
export interface DiagnosticContract {version:'client-contract-diagnostic-v1';enabled:boolean;inspection:ClientInspection;sample:{id:string;title:string;path:string;size:number;mtimeMs:number;sha256:string;duration:number;mime:'video/mpeg';profileName:'MPEG_PS_NTSC';verification:'pc-validated-diagnostic-only';evidence:string}}
const normalize=(s:string)=>s.replace(/^::ffff:/,'');
const features='DLNA.ORG_PN=MPEG_PS_NTSC;DLNA.ORG_OP=01;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000';
/** Diagnostic-only HTTP contract; do not alter the established TS/JIT Range handlers. */
export function diagnosticRange(method:string,header:string|undefined,ifRange:string|undefined,size:number){
 if(method!=='GET'||!header||ifRange||!/^bytes=/i.test(header.trim())||header.includes(','))return null;
 return parseRange(header.trim().replace(/^bytes=/i,'bytes='),size);
}
const wrap=(s:string)=>`<?xml version="1.0"?><DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${s}</DIDL-Lite>`;
export const diagnosticContainer=()=>`<container id="${CLIENT_DIAGNOSTIC_ROOT}" parentID="0" restricted="1" childCount="1"><dc:title>再生互換診断（未確認候補）</dc:title><upnp:class>object.container</upnp:class></container>`;
/** Append only for the explicitly identified client; all other SOAP bytes stay untouched. */
export function appendDiagnosticRoot(xml:string,b:BrowseInput,enabled:boolean){
 if(!enabled||b.objectId!=='0')return xml;
 if(b.metadata)return xml.replace(/(&lt;container\s+id=&quot;0&quot;[\s\S]*?childCount=&quot;)(\d+)/,(_,p,n)=>p+(Number(n)+1));
 const total=Number(/<TotalMatches>(\d+)</.exec(xml)?.[1]),returned=Number(/<NumberReturned>(\d+)</.exec(xml)?.[1]);if(!Number.isSafeInteger(total)||!Number.isSafeInteger(returned))throw Error('Invalid root page');
 const room=b.count===0||returned<b.count,include=b.start<=total&&b.start+returned===total&&room;
 let result=xml.replace(/<TotalMatches>\d+</,`<TotalMatches>${total+1}<`);
 if(include)result=result.replace('&lt;/DIDL-Lite&gt;',escapeXml(diagnosticContainer())+'&lt;/DIDL-Lite&gt;').replace(/<NumberReturned>\d+</,`<NumberReturned>${returned+1}<`);
 return result;
}
export function createClientContractDiagnostics(directory:string,trace:(event:string,detail:unknown)=>void,inspect=inspectClientCapability,idleTimeoutMs=30000){
 let stamp=-1,cached:DiagnosticContract|undefined;
 let loading:Promise<DiagnosticContract|undefined>|undefined;
 async function refresh(){const file=path.join(directory,'contract.json'),s=await fs.stat(file).catch(()=>undefined);if(!s){cached=undefined;stamp=-1;return;}if(s.mtimeMs!==stamp){stamp=s.mtimeMs;cached=undefined;try{const v=await readShadowJson<DiagnosticContract>(file);if(v?.version==='client-contract-diagnostic-v1'&&v.enabled&&v.sample?.verification==='pc-validated-diagnostic-only'&&v.inspection?.device?.deviceId&&new URL(v.inspection.device.descriptionUrl).protocol==='http:')cached=v;}catch(error){trace('CLIENT_CONTRACT_MANIFEST_ERROR',{error:String(error),normalPlaybackUnaffected:true});}}return cached;}
 // Concurrent HEAD/GET/Browse must await the same manifest read, never a half-loaded cache.
 function load(){return loading??(loading=refresh().finally(()=>{loading=undefined;}));}
 async function bound(remote:string){const c=await load();if(c&&new URL(c.inspection.device.descriptionUrl).hostname===normalize(remote))return c;}
 return {
  async enabled(remote:string){return !!await bound(remote);},
  async updateId(remote:string){const c=await bound(remote);return c?parseInt(createHash('sha256').update(JSON.stringify({id:c.sample.id,identity:c.inspection.device.identityHash})).digest('hex').slice(0,8),16):0;},
  async protocolInfo(remote:string){return await bound(remote)?`http-get:*:video/mpeg:${features}`:undefined;},
  async browse(b:BrowseInput,remote:string,base:string):Promise<BrowsePage|undefined>{
   if(b.objectId!==CLIENT_DIAGNOSTIC_ROOT&&!b.objectId.startsWith(CLIENT_DIAGNOSTIC_ROOT+'/'))return;
   const c=await bound(remote);if(!c)return {didl:wrap(''),numberReturned:0,total:0};
   const token=c.sample.id,id=`${CLIENT_DIAGNOSTIC_ROOT}/${token}`;
   if(b.objectId===id&&!b.metadata)return {didl:wrap(''),numberReturned:0,total:0};
   const resource=`<item id="${id}" parentID="${CLIENT_DIAGNOSTIC_ROOT}" restricted="1"><dc:title>${escapeXml(c.sample.title)}</dc:title><upnp:class>object.item.videoItem</upnp:class><dc:description>Diagnostic candidate; receive capability and full DLNA conformance unconfirmed</dc:description><res protocolInfo="http-get:*:video/mpeg:${features}" size="${c.sample.size}" duration="00:00:${c.sample.duration.toFixed(3).padStart(6,'0')}">${escapeXml(`${base}/client-diagnostic/media/${token}`)}</res></item>`;
   const exists=b.objectId===CLIENT_DIAGNOSTIC_ROOT||b.objectId===id;
   const selected=exists&&(b.metadata||b.start===0)?b.metadata&&b.objectId===CLIENT_DIAGNOSTIC_ROOT?diagnosticContainer():resource:'';
   return {didl:wrap(selected),numberReturned:selected?1:0,total:exists?1:0};
  },
  async media(req:IncomingMessage,res:ServerResponse,token:string){
   const requestId=randomUUID(),start=performance.now(),remote=normalize(req.socket.remoteAddress??'');let sent=0;
   const socket=req.socket,socketStart=socket.bytesWritten;let firstBodyMs:number|undefined,eof=false,drains=0,timedOut=false;
   const metrics=()=>({requestId,remote,bodyBytesEnqueued:sent,socketBytesWrittenIncludingHeaders:socket.bytesWritten-socketStart,firstBodyEnqueuedMs:firstBodyMs,sourceEof:eof,drains,writableLength:res.writableLength,needDrain:res.writableNeedDrain,elapsedMs:performance.now()-start});
   let progress:ReturnType<typeof setInterval>|undefined;
   res.on('drain',()=>{drains++;trace('CLIENT_CONTRACT_DRAIN',metrics());});
   res.once('finish',()=>trace('CLIENT_CONTRACT_FINISH',{...metrics(),completed:true,meaning:'HTTP writable finished; not receiver ACK/decode'}));
   trace('CLIENT_CONTRACT_REQUEST',{requestId,remote,method:req.method,headers:req.headers,token});
   res.once('close',()=>{clearInterval(progress);trace('CLIENT_CONTRACT_END',{...metrics(),status:res.statusCode,completed:res.writableFinished,sentBytes:sent,outcome:res.writableFinished?'completed':timedOut?'server-idle-timeout':'connection-closed'});});
   try{const c=await bound(remote);if(!c||c.sample.id!==token){res.writeHead(404);res.end();return;}
    if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405,{'Allow':'GET, HEAD'});res.end();return;}
    const current=await inspect(c.inspection.device.descriptionUrl,c.inspection.device.deviceId,AbortSignal.timeout(10000));if(current.device.identityHash!==c.inspection.device.identityHash)throw Error('Client identity changed');
    const file=path.resolve(c.sample.path),root=path.resolve(directory)+path.sep;if(!file.startsWith(root))throw Error('Diagnostic artifact outside dedicated directory');
    const st=await fs.stat(file);if(st.size!==c.sample.size||st.mtimeMs!==c.sample.mtimeMs)throw Error('Diagnostic artifact stale');
    const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);if(hash.digest('hex')!==c.sample.sha256)throw Error('Diagnostic artifact hash mismatch');
    if(req.headers['timeseekrange.dlna.org']){res.writeHead(406,{'Content-Length':0});res.end();return;}
    let range:ReturnType<typeof parseRange>;try{range=diagnosticRange(req.method!,req.headers.range,req.headers['if-range'] as string|undefined,st.size);}catch{res.writeHead(416,{'Content-Range':`bytes */${st.size}`,'Content-Length':0});res.end();return;}
    const a=range?.start??0,z=range?.end??st.size-1,responseHeaders={'Content-Type':c.sample.mime,'Content-Length':z-a+1,'Accept-Ranges':'bytes','contentFeatures.dlna.org':features,'transferMode.dlna.org':'Streaming',...(range?{'Content-Range':`bytes ${a}-${z}/${st.size}`}:{})};
    trace('CLIENT_CONTRACT_RESPONSE',{requestId,remote,deviceId:current.device.deviceId,identityHash:current.device.identityHash,sinkStatus:current.sinkStatus,verification:c.sample.verification,status:range?206:200,headers:responseHeaders,framing:'mpeg2-program-stream',executorStarted:false});
    res.writeHead(range?206:200,responseHeaders);if(req.method==='HEAD'){res.end();return;}
    // Transfer-idle time starts after inspection/hash checks, not while preparing the response.
    res.setTimeout(idleTimeoutMs,()=>{timedOut=true;trace('CLIENT_CONTRACT_TIMEOUT',metrics());res.destroy(Error('Diagnostic HTTP idle timeout'));});
    const stream=createReadStream(file,{start:a,end:z});
    stream.once('error',error=>trace('CLIENT_CONTRACT_SOURCE_ERROR',{...metrics(),error:String(error)}));
    stream.once('end',()=>{eof=true;trace('CLIENT_CONTRACT_EOF',metrics());});stream.once('close',()=>trace('CLIENT_CONTRACT_FILE_CLOSED',metrics()));
    const meter=new Transform({transform(chunk,_encoding,done){sent+=chunk.length;if(firstBodyMs===undefined){firstBodyMs=performance.now()-start;trace('CLIENT_CONTRACT_FIRST_BODY',metrics());}done(null,chunk);}});
    progress=setInterval(()=>trace('CLIENT_CONTRACT_PROGRESS',metrics()),1000);progress.unref();await pipeline(stream,meter,res);
   }catch(error){if(res.destroyed){trace('CLIENT_CONTRACT_CANCELLED',{requestId,remote,reason:timedOut?'server-idle-timeout':'connection-closed',error:String(error)});return;}trace('CLIENT_CONTRACT_ERROR',{requestId,remote,error:String(error)});if(!res.headersSent){res.writeHead(503,{'Content-Length':0});res.end();}else res.destroy();}
   finally{clearInterval(progress);}
  }
 };
}
