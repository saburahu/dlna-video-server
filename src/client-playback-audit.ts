import {xmlValue} from './experimental-renderer.js';
import {compareTransferProgress,type TransferProgress} from './transfer-progress-audit.js';
/** HTTP delivery is an observation, never a decoder-success assertion. */
export class ClientPlaybackAudit {
 private progress=new Map<string,TransferProgress>();private transferStates:Record<string,number>={};
 private browse=0;private items=0;private resources=0;private requests=0;private heads=0;private gets=0;private sent=0;private httpErrors=0;private setupErrors=0;private cancelled=0;private completedTransfers=0;private incompleteTransfers=0;private idleTimeouts=0;private timeline:any[]=[];
 constructor(readonly remoteIp:string,readonly since?:string){if(since&&!Number.isFinite(Date.parse(since)))throw Error('Invalid audit start time');}
 observe(r:any){
  const ip=String(r.clientIp??r.detail?.remote??r.detail?.client??'').replace(/^::ffff:/,'');if(ip!==this.remoteIp||this.since&&Date.parse(r.at)<Date.parse(this.since))return;
  const diagnostic=r.category==='CLIENT_CONTRACT',response=r.detail??{};
  if((diagnostic||r.category==='HTTP_TRANSFER')&&(response.requestId||r.connectionId)&&Number.isFinite(response.socketBytesWrittenIncludingHeaders)){
   const key=String(response.requestId??r.connectionId),current={bodyBytesEnqueued:0,sourceEof:false,...response} as TransferProgress,previous=this.progress.get(key);
   if(previous){const comparison=compareTransferProgress(previous,current);this.transferStates[comparison.state]=(this.transferStates[comparison.state]??0)+1;}
   this.progress.set(key,current);if(r.message==='CLIENT_CONTRACT_END'||r.message==='HTTP_TRANSFER_CLOSE')this.progress.delete(key);if(this.progress.size>128)this.progress.delete(this.progress.keys().next().value!);
  }
  if(r.category==='SOAP'&&r.message==='Browse'){
   this.browse++;const didl=xmlValue(response.responseXml??'','Result').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&amp;','&');
   this.items+=(didl.match(/<item\b/g)??[]).length;this.resources+=(didl.match(/<res\b/g)??[]).length;
  }
  if(r.category==='HTTP_MEDIA'||diagnostic&&r.message==='CLIENT_CONTRACT_REQUEST'){
   this.requests++;const method=r.method??response.method;this.heads+=method==='HEAD'?1:0;this.gets+=method==='GET'?1:0;
  }
  if(r.category==='HTTP_MEDIA_END'||diagnostic&&r.message==='CLIENT_CONTRACT_END')this.sent+=Number(response.sentBytes??0);
  if(diagnostic&&r.message==='CLIENT_CONTRACT_END'){if(response.completed===true)this.completedTransfers++;else if(response.completed===false)this.incompleteTransfers++;}
  if(diagnostic&&r.message==='CLIENT_CONTRACT_TIMEOUT')this.idleTimeouts++;
  if(diagnostic&&r.message==='CLIENT_CONTRACT_CANCELLED')this.cancelled++;
  if(r.category==='HTTP_MEDIA'||diagnostic&&r.message==='CLIENT_CONTRACT_END'){if(Number(response.responseStatus??response.status)>=400)this.httpErrors++;}
  if(r.message==='EXPERIMENTAL_JIT_ERROR'||diagnostic&&r.message==='CLIENT_CONTRACT_ERROR')this.setupErrors++;
  if(r.message==='JIT_END'){const end=response.detail?.detail??response.detail??response;if(end.cancelled)this.cancelled++;}
  const event={at:r.at,event:r.message,category:r.category,connectionId:r.connectionId??response.requestId,method:r.method??response.method,url:r.url,headers:response.requestHeaders??response.headers,status:response.responseStatus??response.status,sentBytes:response.sentBytes,bodyBytesEnqueued:response.bodyBytesEnqueued,socketBytesWrittenIncludingHeaders:response.socketBytesWrittenIncludingHeaders,firstBodyEnqueuedMs:response.firstBodyEnqueuedMs,sourceEof:response.sourceEof,needDrain:response.needDrain,writableLength:response.writableLength,completed:response.completed,outcome:response.outcome};
  this.timeline.push(event);this.timeline.sort((a,b)=>String(a.at).localeCompare(String(b.at)));if(this.timeline.length>250)this.timeline.shift();
 }
 result(){return {remoteIp:this.remoteIp,since:this.since,scope:'retained logs only; repeated Browse resources counted as observations; sentBytes are server counters, not TCP ACK or receiver decode',browseRequests:this.browse,videoItemObservations:this.items,resourceObservations:this.resources,mediaRequests:this.requests,heads:this.heads,gets:this.gets,sentBytes:this.sent,httpErrors:this.httpErrors,setupErrors:this.setupErrors,cancellations:this.cancelled,completedTransfers:this.completedTransfers,incompleteTransfers:this.incompleteTransfers,serverIdleTimeouts:this.idleTimeouts,
  transferProgressComparisons:this.transferStates,transferProgressScope:'Local stream/socket counters only; no TCP ACK, zero-window, FIN/RST or decoder inference. Empty means measurements unavailable.',stage:this.setupErrors||this.httpErrors?'http-or-setup-failure':this.requests===0?this.items>0&&this.resources===0?'resource-not-published':'no-media-request':this.sent>0?'server-sent-receiver-decode-unconfirmed':'media-request-without-observed-body',timeline:this.timeline};}
}
