import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {escapeXml,profiles,contentFeatures,type PcrIndex} from './core.js';
import {REGZA_BUFFERED_PROFILE} from './playback-policy.js';
import {Tts192Transform} from './tts.js';
import {contentPacketLayout,ContentPacketTransform} from './content-packet.js';
import {PcrPacingTransform} from './pacing.js';
import {packetTime,timeSeekSlice,formatNpt} from './time-seek.js';
import {readShadowJson,acquireCapability,type RegisteredDmp} from './playback-shadow-store.js';
import {browseDIDL} from './upnp.js';
import type {Program} from './store.js';
import type {Fingerprint} from './playback-shadow.js';
import type {BrowseInput,BrowsePage} from './experimental-catalog.js';

export const MPEG_TS_TRIAL_ROOT='mpeg-ts-trial';
interface HashedFile extends Fingerprint {sha256:string}
export interface MpegTsTrial {version:'mpeg-ts-trial-v1';enabled:boolean;mode?:'original-broadcast';allowChunkedComparison?:boolean;broadcastProgram?:Program;device:RegisteredDmp;sinkHash:string;artifactId:string;source:Fingerprint;artifact:HashedFile;validation:HashedFile;index:HashedFile;duration:number;wireBytes:number;title:string;verification:'pc-validated-diagnostic-only'}
const ip=(v:string)=>v.replace(/^::ffff:/,'');
const wrap=(s:string)=>`<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${s}</DIDL-Lite>`;
const container=(count=1)=>`<container id="${MPEG_TS_TRIAL_ROOT}" parentID="0" restricted="1" childCount="${count}"><dc:title>MPEG-2 TS受信確認（未確認）</dc:title><upnp:class>object.container</upnp:class></container>`;
export const mpegTsTrialFeatures=(c?:MpegTsTrial)=>contentFeatures({...profiles[REGZA_BUFFERED_PROFILE],ci:c?.mode==='original-broadcast'?'0':'1'});
export const mpegTsTrialProtocol=(c?:MpegTsTrial)=>`http-get:*:${profiles[REGZA_BUFFERED_PROFILE].mime}:${mpegTsTrialFeatures(c)}`;
export function appendMpegTsTrialRoot(xml:string,b:BrowseInput,enabled:boolean,childCount=1){
 if(!enabled||b.objectId!=='0')return xml;
 if(b.metadata)return xml.replace(/(&lt;container\s+id=&quot;0&quot;[\s\S]*?childCount=&quot;)(\d+)/,(_,p,n)=>p+(Number(n)+1));
 const total=Number(/<TotalMatches>(\d+)</.exec(xml)?.[1]),returned=Number(/<NumberReturned>(\d+)</.exec(xml)?.[1]);if(!Number.isSafeInteger(total)||!Number.isSafeInteger(returned))throw Error('Invalid root page');
 let result=xml.replace(/<TotalMatches>\d+</,`<TotalMatches>${total+1}<`);
 if((!b.count||returned<b.count)&&b.start<=total&&b.start+returned===total)result=result.replace('&lt;/DIDL-Lite&gt;',escapeXml(container(childCount))+'&lt;/DIDL-Lite&gt;').replace(/<NumberReturned>\d+</,`<NumberReturned>${returned+1}<`);
 return result;
}
async function statMatches(f:Fingerprint){try{const s=await fs.stat(f.path);return s.isFile()&&s.size===f.size&&s.mtimeMs===f.mtimeMs;}catch{return false;}}
async function hashMatches(f:HashedFile){const h=createHash('sha256');for await(const b of createReadStream(f.path))h.update(b);return h.digest('hex')===f.sha256&&await statMatches(f);}
/** Explicit per-receiver diagnostic permission, not advertised receiver capability or production fallback. */
export function createMpegTsTrial(directory:string,trace:(event:string,detail:unknown)=>void,acquire=acquireCapability,manifest='contract.json'){
 if(path.basename(manifest)!==manifest)throw Error('Invalid manifest name');
 let proof='';
 async function bound(remote:string){try{
  const c=await readShadowJson<MpegTsTrial>(path.join(directory,manifest));
  if(c?.version!=='mpeg-ts-trial-v1'||!c.enabled||c.verification!=='pc-validated-diagnostic-only'||!c.device.deviceId||ip(c.device.remoteIp)!==ip(remote)||!Number.isFinite(c.duration)||c.duration<5||(!c.mode&&c.duration>61)||!Number.isSafeInteger(c.wireBytes)||c.wireBytes<=0||!Number.isSafeInteger(c.artifact.size)||c.artifact.size%188!==0||!c.artifactId.match(/^[a-f0-9-]{36}$/))return;
  if(c.mode!==undefined&&c.mode!=='original-broadcast')return;
  if(c.allowChunkedComparison!==undefined&&typeof c.allowChunkedComparison!=='boolean')return;
  if(c.mode&&c.allowChunkedComparison)return;
  const root=path.resolve(directory,c.artifactId)+path.sep;
  if(![c.validation,c.index,...(c.mode==='original-broadcast'?[]:[c.artifact])].every(f=>path.resolve(f.path).startsWith(root))||![c.source,c.artifact,c.validation,c.index].every(f=>f&&Number.isFinite(f.mtimeMs)))return;
  if(c.mode==='original-broadcast'&&(path.resolve(c.artifact.path)!==path.resolve(c.source.path)||c.artifact.size!==c.source.size||c.artifact.mtimeMs!==c.source.mtimeMs))return;
  for(const f of [c.source,c.artifact,c.validation,c.index])if(!await statMatches(f))return;
  return c;
 }catch(error){trace('MPEG_TS_TRIAL_MANIFEST_ERROR',{error:String(error),normalPlaybackUnaffected:true});return;}}
 return {
  async enabled(remote:string){return !!await bound(remote);},
  async childCount(remote:string){const c=await bound(remote);return c?(c.allowChunkedComparison?2:1):0;},
  async protocolInfo(remote:string){const c=await bound(remote);return c?mpegTsTrialProtocol(c):undefined;},
  async updateId(remote:string){const c=await bound(remote);return c?parseInt(createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0,8),16):0;},
  async browse(b:BrowseInput,remote:string,base:string):Promise<BrowsePage|undefined>{
   if(b.objectId!==MPEG_TS_TRIAL_ROOT&&!b.objectId.startsWith(MPEG_TS_TRIAL_ROOT+'/'))return;
   const c=await bound(remote);if(!c)return {didl:wrap(''),numberReturned:0,total:0};
   const duration=`0:${String(Math.floor(c.duration/60)).padStart(2,'0')}:${(c.duration%60).toFixed(3).padStart(6,'0')}`;
   let item=`<item id="${MPEG_TS_TRIAL_ROOT}/${c.artifactId}" parentID="${MPEG_TS_TRIAL_ROOT}" restricted="1"><dc:title>${escapeXml(c.title)}</dc:title><upnp:class>object.item.videoItem.videoBroadcast</upnp:class><dc:description>${c.mode==='original-broadcast'?'Unmodified successful broadcast TS; isolated delivery path control':'Diagnostic MPEG-2 TS candidate; receiver acceptance and full DLNA conformance unconfirmed'}</dc:description><res protocolInfo="${mpegTsTrialProtocol(c)}" size="${c.wireBytes}" duration="${duration}">${escapeXml(base+'/mpeg-ts-trial/media/'+c.artifactId)}</res></item>`;
   if(c.mode==='original-broadcast'){if(!c.broadcastProgram||path.resolve(c.broadcastProgram.filePath)!==path.resolve(c.source.path))return {didl:wrap(''),numberReturned:0,total:0};
    const p=c.broadcastProgram,normal=browseDIDL('item:'+p.id,0,1,[p],base,profiles[REGZA_BUFFERED_PROFILE],true,new Map([[p.id,{url:base+'/mpeg-ts-trial/media/'+c.artifactId,size:c.wireBytes,profile:profiles[REGZA_BUFFERED_PROFILE]}]])).didl;
    item=normal.slice(normal.indexOf('<item '),normal.indexOf('</item>')+7).replace('id="item:'+p.id+'"','id="'+MPEG_TS_TRIAL_ROOT+'/'+c.artifactId+'"').replace('parentID="all"','parentID="'+MPEG_TS_TRIAL_ROOT+'"').replace(/<dc:title>[\s\S]*?<\/dc:title>/,'<dc:title>'+escapeXml(c.title)+'</dc:title>');
   }
   // Same immutable artifact and metadata; only HTTP transfer framing changes.
   const items=[item];if(c.allowChunkedComparison)items.push(item.replace(`id="${MPEG_TS_TRIAL_ROOT}/${c.artifactId}"`,`id="${MPEG_TS_TRIAL_ROOT}/${c.artifactId}/chunked"`).replace(/<dc:title>[\s\S]*?<\/dc:title>/,'<dc:title>【chunked比較】'+escapeXml(c.title)+'</dc:title>').replace('</res>','?transfer=chunked</res>'));
   const entries=b.metadata?(b.objectId===MPEG_TS_TRIAL_ROOT?[container(items.length)]:b.objectId===MPEG_TS_TRIAL_ROOT+'/'+c.artifactId?[items[0]]:c.allowChunkedComparison&&b.objectId===MPEG_TS_TRIAL_ROOT+'/'+c.artifactId+'/chunked'?[items[1]]:[]):b.objectId===MPEG_TS_TRIAL_ROOT?items.slice(b.start,b.count?b.start+b.count:undefined):[];
   return {didl:wrap(entries.join('')),numberReturned:entries.length,total:b.metadata?entries.length:b.objectId===MPEG_TS_TRIAL_ROOT?items.length:0};
  },
  async media(req:IncomingMessage,res:ServerResponse,id:string,remote=req.socket.remoteAddress??''){
   const requestId=randomUUID(),started=performance.now();let readBytes=0,firstBodyMs:number|undefined,timer:NodeJS.Timeout|undefined,pacer:PcrPacingTransform|undefined;
   trace('MPEG_TS_TRIAL_REQUEST',{requestId,remote,method:req.method,headers:req.headers,id});
   try{
    const c=await bound(remote);if(!c||c.artifactId!==id){res.writeHead(404);res.end();return;}
    const transfer=new URL(req.url??'/', 'http://localhost').searchParams.get('transfer');
    if(transfer!==null&&(transfer!=='chunked'||!c.allowChunkedComparison)){res.writeHead(400,{'Content-Length':0});res.end();return;}
    const chunked=transfer==='chunked';
    if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
    if(req.headers.range){res.writeHead(400,{'Content-Length':0});res.end();return;}
    const current=await acquire(c.device,AbortSignal.timeout(10000));if(current.deviceId!==c.device.deviceId||current.sinkHash!==c.sinkHash)throw Error('Receiver identity/capability changed');
    const key=JSON.stringify(c);if(proof!==key){for(const f of [c.artifact,c.validation,c.index])if(!await hashMatches(f))throw Error('Diagnostic fingerprint mismatch');const report=await readShadowJson<any>(c.validation.path);if(!report?.passed||report.version!==(c.mode==='original-broadcast'?'broadcast-path-control-validation-v1':'mpeg-ts-trial-validation-v1')||report.video?.codec_name!=='mpeg2video'||report.audio?.codec_name!=='aac'||(c.mode==='original-broadcast'?report.remuxed!==false:report.decode!=='complete-video-and-audio')||JSON.stringify(report.source)!==JSON.stringify(c.source)||JSON.stringify(report.artifact)!==JSON.stringify(c.artifact))throw Error('Missing or unbound MPEG-2 TS validation');proof=key;}
    const index=await readShadowJson<PcrIndex>(c.index.path);if(!index||index.packetCount*188!==c.artifact.size||index.discontinuities||index.invalidIntervals||index.points.length<2||Math.abs(packetTime(index,index.packetCount)-c.duration)>.001)throw Error('TS/index mismatch');
    const layout=contentPacketLayout(index.packetCount*192,index.averageBitrate*192/188);if(layout.servedBytes!==c.wireBytes)throw Error('TS/wire length mismatch');
    let slice:ReturnType<typeof timeSeekSlice>;try{slice=timeSeekSlice(index,layout.blockBytes,String(req.headers['timeseekrange.dlna.org']??`npt=0-${c.duration}`));}catch{res.writeHead(c.mode==='original-broadcast'?416:406,{'Content-Length':0});res.end();return;}
    const headers={'Connection':'keep-alive','Content-Type':profiles[REGZA_BUFFERED_PROFILE].mime,'Content-Length':slice.wireBytes,'Accept-Ranges':'none','contentFeatures.dlna.org':mpegTsTrialFeatures(c),'transferMode.dlna.org':'Streaming','availableSeekRange.dlna.org':`1 npt=0.000-${formatNpt(c.duration)}`,'TimeSeekRange.dlna.org':`npt=${formatNpt(slice.actualStart)}-${formatNpt(slice.actualEnd)}/${formatNpt(c.duration)} bytes=${slice.startByte}-${slice.startByte+slice.wireBytes-1}/${c.wireBytes}`,Vary:'TimeSeekRange.dlna.org'};
    if(c.mode==='original-broadcast'&&req.headers['timeseekrange.dlna.org']===undefined)delete (headers as Record<string,unknown>)['TimeSeekRange.dlna.org'];
    if(chunked){delete (headers as Record<string,unknown>)['Content-Length'];if(req.method==='GET')(headers as Record<string,unknown>)['Transfer-Encoding']='chunked';}
    trace('MPEG_TS_TRIAL_RESPONSE',{requestId,deviceId:current.deviceId,artifactId:id,revision:chunked?'chunked-control-v1':'fixed-length',mode:c.mode??'generated',headers,slice,verification:c.verification,encoderStarted:false,transport:'188 TS -> 192 TTS /32bit/27MHz/offset -500ms -> Content Packet/normal block layout -> local PCR/lead1100ms'});
    res.writeHead(200,headers);if(req.method==='HEAD'){res.end();return;}
    pacer=new PcrPacingTransform(index,192,slice.firstPacket,layout.blockBytes,1100);
    const metrics=()=>({requestId,artifactId:id,revision:chunked?'chunked-control-v1':'fixed-length',elapsedMs:performance.now()-started,readBytes,firstBodyMs,pacer:pacer?.getStats(),queue:res.writableLength,needDrain:res.writableNeedDrain});
    const meter=new Transform({transform(b,_e,done){readBytes+=b.length;if(firstBodyMs===undefined){firstBodyMs=performance.now()-started;trace('MPEG_TS_TRIAL_FIRST_BODY',metrics());}done(null,b);}});
    res.setTimeout(30000,()=>{trace('MPEG_TS_TRIAL_TIMEOUT',metrics());res.destroy(Error('Diagnostic transfer idle timeout'));});
    timer=setInterval(()=>trace('MPEG_TS_TRIAL_PROGRESS',metrics()),1000);timer.unref();
    await pipeline(createReadStream(c.artifact.path,{start:slice.firstPacket*188,end:slice.endPacket*188-1}),new Tts192Transform(slice.firstPacket,index.averageBitrate*192/188,0,slice.payloadBytes,index,profiles[REGZA_BUFFERED_PROFILE]),new ContentPacketTransform(slice.payloadBytes,layout.blockBytes),pacer,meter,res);
    if(readBytes!==slice.wireBytes)throw Error('Diagnostic response length mismatch');
    trace('MPEG_TS_TRIAL_END',{...metrics(),outcome:'completed',expectedBytes:slice.wireBytes});
   }catch(error){trace('MPEG_TS_TRIAL_END',{requestId,readBytes,elapsedMs:performance.now()-started,outcome:res.destroyed?'client-disconnected':'error',error:String(error)});if(!res.headersSent){res.writeHead(503,{'Content-Length':0});res.end();}else if(!res.destroyed)res.destroy();}
   finally{clearInterval(timer);if(!res.destroyed)res.setTimeout(0);}
  }
 };
}
