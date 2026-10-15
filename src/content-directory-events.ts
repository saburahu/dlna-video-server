import {randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
const address=(s:string)=>s.replace(/^::ffff:/,'').replace(/^\[|\]$/g,'');
/** Bounded GENA subscriptions. Notifications report the same index revision as SOAP. */
export function contentDirectoryEvents(update:()=>Promise<number>,trace:(event:string,detail:unknown)=>void,
 send:(url:string,options:RequestInit)=>Promise<unknown>=fetch){
 const subscriptions=new Map<string,{callback:string;owner:string;expires:number;sequence:number;last?:number}>();
 let timer:ReturnType<typeof setInterval>|undefined,busy=false;const pending=new Set<AbortController>();
 async function tick(){if(busy)return;busy=true;try{
  const value=(await update())>>>0;
  for(const [sid,s] of subscriptions){if(s.expires<Date.now()){subscriptions.delete(sid);continue;}if(s.last===value)continue;s.last=value;
   const sequence=s.sequence;s.sequence=s.sequence===0xffffffff?1:s.sequence+1;
   const body=`<?xml version="1.0"?><e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><SystemUpdateID>${value}</SystemUpdateID></e:property></e:propertyset>`,controller=new AbortController();pending.add(controller);const timeout=setTimeout(()=>controller.abort(),2000);
   try{await send(s.callback,{method:'NOTIFY',redirect:'error',headers:{'Content-Type':'text/xml; charset=utf-8','Content-Length':String(Buffer.byteLength(body)),NT:'upnp:event',NTS:'upnp:propchange',SID:sid,SEQ:String(sequence)},body,signal:controller.signal});trace('CD_NOTIFY',{sid,sequence,updateId:value});}
   catch(error){trace('CD_NOTIFY_FAILED',{sid,error:String(error)});}finally{clearTimeout(timeout);pending.delete(controller);}
  }
 }finally{busy=false;}}
 return {tick,handle(req:IncomingMessage,res:ServerResponse){
  const owner=address(req.socket.remoteAddress??''),sid=String(req.headers.sid??'');
  if(req.method==='UNSUBSCRIBE'){const s=subscriptions.get(sid);if(!s||s.owner!==owner){res.writeHead(412);res.end();return;}subscriptions.delete(sid);res.writeHead(200,{'Content-Length':0});res.end();return;}
  let key=sid;
  if(sid){const s=subscriptions.get(sid);if(!s||s.owner!==owner){res.writeHead(412);res.end();return;}}
  else{let callback:URL|undefined;try{callback=new URL(/<([^>]+)>/.exec(String(req.headers.callback??''))?.[1]??'');}catch{}
   // Callback must point at the subscribing peer, not arbitrary network hosts.
   if(!callback||callback.protocol!=='http:'||callback.username||callback.password||address(callback.hostname)!==owner||req.headers.nt!=='upnp:event'||subscriptions.size>=64){res.writeHead(412);res.end();return;}
   key=`uuid:${randomUUID()}`;subscriptions.set(key,{callback:callback.href,owner,expires:0,sequence:0});
  }
  const seconds=Math.min(1800,Math.max(1,Number(/^Second-(\d+)$/i.exec(String(req.headers.timeout??''))?.[1])||1800));subscriptions.get(key)!.expires=Date.now()+seconds*1000;
  res.writeHead(200,{SID:key,TIMEOUT:`Second-${seconds}`,'Content-Length':0});res.end();
  if(!timer){timer=setInterval(()=>void tick().catch(error=>trace('CD_EVENT_ERROR',{error:String(error)})),2000);timer.unref();}
  setImmediate(()=>void tick().catch(error=>trace('CD_EVENT_ERROR',{error:String(error)})));
 },close(){if(timer)clearInterval(timer);for(const controller of pending)controller.abort();subscriptions.clear();}};
}
