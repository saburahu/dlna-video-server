import path from 'node:path';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {requestFamilyFeatures} from './client-family.js';
import {escapeXml} from './core.js';
import type {BrowseInput,BrowsePage} from './experimental-catalog.js';
import {deliverCapturedMpeg2} from './captured-mpeg2-trial.js';
import {MPEG2_JIT_FEATURES} from './mpeg2-jit-target.js';
import {verifyColorAsset,type ColorAsset} from './dbr-color-asset.js';

export const COLOR_ROOT='dbr-color-trial';
const FEATURES=MPEG2_JIT_FEATURES.replace('DLNA.ORG_OP=10','DLNA.ORG_OP=00');
export const colorRequestMatches=(headers:Record<string,unknown>,xml='')=>{const f=[...new Set(requestFamilyFeatures(headers,xml).map(v=>v.family))];return f.length===1&&f[0]==='dixim-service-layout';};
export const COLOR_PROTOCOL=`http-get:*:video/vnd.dlna.mpeg-tts:${FEATURES}`;
const TITLE='【危険性未確認・一時試験】DBR BT.709 冒頭30秒';
const wrap=(s:string)=>`<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${s}</DIDL-Lite>`;
const container=()=>`<container id="${COLOR_ROOT}" parentID="0" restricted="1" childCount="1"><dc:title>${TITLE}</dc:title><upnp:class>object.container</upnp:class></container>`;
interface Peer {id:string;remote:string;title:unknown;eligible:boolean}
interface Dependencies {
 prepare:(sourceId:string,signal:AbortSignal,progress:(v:any)=>void)=>Promise<ColorAsset>;
 peers:()=>Promise<Peer[]>;verifyPeer:(id:string,remote?:string)=>Promise<string>;
 busy:()=>boolean;trace:(event:string,detail:unknown)=>void;
 verifyAsset?:typeof verifyColorAsset;now?:()=>number;ttlMs?:number;
 deliver?:typeof deliverCapturedMpeg2;requestAllowed?:(headers:Record<string,unknown>,xml?:string)=>boolean;
}
/** Ephemeral, receiver-bound playback session. Never writes normal admission or catalog. */
export function createDbrColorTrial(d:Dependencies){
 const now=d.now??Date.now;let preparedSourceId='',revision=0,phase='idle',progress:any,asset:ColorAsset|undefined,error:string|undefined,controller:AbortController|undefined,job:Promise<void>|undefined;
 type Grant={token:string;peer:Peer;binding:string;expires:number;gets:number;heads:number;firstGet?:number;lastClose?:number;active?:ServerResponse;delivery?:Promise<void>};let grant:Grant|undefined;
 const changed=(event:string,detail:unknown={})=>{revision++;d.trace(event,{revision,detail});};
 function revoke(reason:string){const previous=grant;grant=undefined;if(previous?.active&&!previous.active.writableEnded)previous.active.destroy();if(previous)changed('REVOKED',{reason,gets:previous.gets,heads:previous.heads});}
 function tick(){if(grant&&now()>=grant.expires)revoke('expired');}
 const timer=setInterval(tick,250);timer.unref();
 async function status(){tick();return {revision,phase,progress,error,asset:asset?{sourceId:preparedSourceId,sourceTitle:asset.source?path.basename(asset.source):preparedSourceId,sha256:asset.sha256,size:asset.size,seconds:asset.seconds,audit:asset.audit}:undefined,publication:grant?{expires:grant.expires,peer:grant.peer.title,gets:grant.gets,heads:grant.heads,active:!!grant.active}:undefined,peers:await d.peers(),risk:'過去にDBRが操作不能となり電源再投入が必要でした。色変換・30秒制限は安全を保証しません。異常時は試験を中止し、再試行しないでください。'};}
 let mutation=Promise.resolve();
 async function change(input:any){
  tick();assert.equal(input?.revision,revision,'State changed; refresh');
  if(input.action==='cancel'){revoke('operator');controller?.abort();await job;return status();}
  if(input.action==='prepare'){
   assert.ok(!job&&!grant&&!d.busy(),'Stop playback/preparation before preparing');assert.match(input.sourceId,/^experimental\/catalog-item\/[a-f0-9]{32}$/);
   preparedSourceId=input.sourceId;asset=undefined;error=undefined;phase='preparing';controller=new AbortController();const signal=controller.signal;changed('PREPARING');
   job=d.prepare(input.sourceId,signal,v=>{progress=v;}).then(a=>{signal.throwIfAborted();asset=a;phase='ready';changed('READY',{sha256:a.sha256,size:a.size});}).catch(e=>{asset=undefined;error=String(e);phase=signal.aborted?'cancelled':'failed';changed('PREPARATION_FAILED',{error});}).finally(()=>{job=undefined;controller=undefined;});
   return status();
  }
  assert.equal(input.action,'publish');assert.equal(input.riskAcknowledged,true,'Explicit freeze risk acknowledgement required');assert.ok(asset&&phase==='ready'&&!job&&!grant&&!d.busy(),'Audited ready asset and idle server required');
  assert.equal(input.sourceId,preparedSourceId,'Selected source differs from prepared asset; prepare again');
  const selected=(await d.peers()).filter(p=>p.id===input.peerId&&p.eligible);assert.equal(selected.length,1,'Select a current unambiguous MPEG-2 receiver');const peer=selected[0],binding=await d.verifyPeer(peer.id);
  await (d.verifyAsset??verifyColorAsset)(asset);assert.ok(!d.busy(),'Playback started during validation');
  grant={token:randomBytes(24).toString('hex'),peer,binding,expires:now()+(d.ttlMs??300000),gets:0,heads:0};changed('PUBLISHED',{expires:grant.expires,peerId:peer.id,asset:asset.sha256});return status();
 }
 async function authorized(remote:string){tick();const g=grant;if(!g)return;try{assert.equal(await d.verifyPeer(g.peer.id,remote),g.binding);tick();if(grant===g)return g;}catch{if(remote.replace(/^::ffff:/,'')===g.peer.remote.replace(/^::ffff:/,''))revoke('binding-changed');}}
 return {
  status,revision:()=>{tick();return revision;},
  configure(input:unknown){const result=mutation.then(()=>change(input));mutation=result.then(()=>{},()=>{});return result;},
  async visible(remote:string,headers:Record<string,unknown>={},xml=''){return (d.requestAllowed??colorRequestMatches)(headers,xml)&&!!await authorized(remote);},
  async browse(b:BrowseInput,remote:string,base:string,headers:Record<string,unknown>={},requestXml=''):Promise<BrowsePage|undefined>{
   if(b.objectId!==COLOR_ROOT&&!b.objectId.startsWith(COLOR_ROOT+'/'))return;
   const g=(d.requestAllowed??colorRequestMatches)(headers,requestXml)?await authorized(remote):undefined;if(!g||!asset)return {didl:wrap(''),numberReturned:0,total:0,updateId:revision};
   const id=COLOR_ROOT+'/'+g.token,item=`<item id="${id}" parentID="${COLOR_ROOT}" restricted="1"><dc:title>${TITLE}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:video/vnd.dlna.mpeg-tts:${FEATURES}" duration="0:00:30">${escapeXml(base+'/dbr-color-trial/media/'+g.token)}</res></item>`;
   const match=b.objectId===COLOR_ROOT||b.objectId===id,xml=match&&(b.metadata||b.start===0)?b.metadata&&b.objectId===COLOR_ROOT?container():item:'';
   return {didl:wrap(xml),numberReturned:xml?1:0,total:match?1:0,updateId:revision};
  },
  async media(req:IncomingMessage,res:ServerResponse,token:string,remote:string){
   const g=(d.requestAllowed??colorRequestMatches)(req.headers)?await authorized(remote):undefined;if(!g||g.token!==token||!asset){res.writeHead(404);res.end();return;}
   if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405);res.end();return;}
   // Start-only fixed capture. Invalid seeks cannot consume an approval or bypass admission.
   if(req.headers.range||req.headers['timeseekrange.dlna.org']){res.writeHead(406);res.end();return;}
   if(req.method==='HEAD'){if(++g.heads>16){revoke('head-limit');res.writeHead(429);res.end();return;}res.writeHead(200,{'Content-Type':'video/vnd.dlna.mpeg-tts','contentFeatures.dlna.org':FEATURES,'Cache-Control':'no-store','Accept-Ranges':'none'});res.end();return;}
   const first=g.firstGet??now();
   if(g.gets>=4||(g.firstGet!==undefined&&(now()-first>8000||(g.lastClose!==undefined&&now()-g.lastClose>2000)))){revoke('reconnect-window-ended');res.writeHead(410);res.end();return;}
   g.gets++;const attempt=g.gets;g.firstGet=first;g.active?.destroy();await g.delivery?.catch(()=>{});
   try{
    await (d.verifyAsset??verifyColorAsset)(asset);assert.equal(await d.verifyPeer(g.peer.id,remote),g.binding);tick();assert.equal(grant,g,'Publication expired or cancelled');if(attempt!==g.gets){res.writeHead(409);res.end();return;}
    g.active=res;changed('GET_START',{attempt:g.gets,asset:asset.sha256});
    const currentAsset=asset;g.delivery=(async()=>{
     try{await(d.deliver??deliverCapturedMpeg2)(req,res,currentAsset.file,currentAsset.seconds,currentAsset.wireBytes,FEATURES,(event,detail)=>d.trace(event,detail));if(res.writableEnded)revoke('completed');}
     catch(e){d.trace('DELIVERY_END',{error:String(e),clientClosed:res.destroyed});if(!res.destroyed)revoke('delivery-error');}
     finally{if(g.active===res)g.active=undefined;g.lastClose=now();if(grant===g&&now()-first>8000)revoke('playback-ended');}
    })();await g.delivery;
   }catch(e){revoke('validation-failed');if(!res.headersSent){res.writeHead(409);res.end();}else res.destroy();d.trace('VALIDATION_FAILED',{error:String(e)});}
  },
  async close(){clearInterval(timer);const delivery=grant?.delivery;revoke('shutdown');controller?.abort();await job;await delivery?.catch(()=>{});},
 };
}
export function appendColorTrialRoot(xml:string,b:BrowseInput){
 if(b.objectId!=='0')return xml;
 if(b.metadata)return xml.replace(/(&lt;container\s+id=&quot;0&quot;[\s\S]*?childCount=&quot;)(\d+)/,(_,p,n)=>p+(Number(n)+1));
 const total=Number(/<TotalMatches>(\d+)</.exec(xml)?.[1]),returned=Number(/<NumberReturned>(\d+)</.exec(xml)?.[1]);assert.ok(Number.isSafeInteger(total)&&Number.isSafeInteger(returned));
 let result=xml.replace(/<TotalMatches>\d+</,`<TotalMatches>${total+1}<`);
 if((!b.count||returned<b.count)&&b.start<=total&&b.start+returned===total)result=result.replace('&lt;/DIDL-Lite&gt;',escapeXml(container())+'&lt;/DIDL-Lite&gt;').replace(/<NumberReturned>\d+</,`<NumberReturned>${returned+1}<`);return result;
}
