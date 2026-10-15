import {xmlValue} from './experimental-renderer.js';
import {inspectRecordingTimeContract} from './recording-time-contract.js';
const decode=(s:string)=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&amp;','&');
/** Join existing observations; never promote a client disconnect to receiver failure or decode success. */
export function auditRecordingClient(rows:any[],remoteIp:string){
 const selected=rows.filter(r=>String(r.clientIp??r.detail?.remote??'').replace(/^::ffff:/,'')===remoteIp).sort((a,b)=>String(a.at).localeCompare(String(b.at)));
 const resources=new Map<string,any>(),requests=new Map<string,any>();
 for(const r of selected){const d=r.detail??{};
  if(r.category==='SOAP'&&r.message==='Browse'){
   const didl=decode(xmlValue(d.responseXml??'','Result'));
   for(const m of didl.matchAll(/<item\b[\s\S]*?<\/item>/g)){
    const res=/<res\b([^>]*)>([\s\S]*?)<\/res>/.exec(m[0]);if(!res)continue;
    const attributes=Object.fromEntries([...res[1].matchAll(/([\w:.-]+)="([^"]*)"/g)].map(a=>[a[1],decode(a[2])]));
    const url=decode(res[2]),objectId=/\bid="([^"]+)"/.exec(m[0])?.[1];
    // Folder display IDs differ from source IDs. Resolve only the normal TS URL,
    // without making a request; do not attach stale "all" metadata to an alias.
    let programId:string|undefined;
    try{programId=/^\/media\/([^/]+)\//.exec(new URL(url).pathname)?.[1];}catch{/* Malformed/relative resources are not resolved. */}
    programId??=objectId?.startsWith('item:')?objectId.slice(5):undefined;
    if(programId)resources.set(programId,{at:r.at,objectId,attributes,url,title:decode(xmlValue(m[0],'title')),browseRequestedDuration:/res@duration|<Filter>\*<\/Filter>/.test(d.requestXml??'')});
   }
  }
  if(r.category==='HTTP_MEDIA'&&r.connectionId){
   requests.set(r.connectionId,{connectionId:r.connectionId,programId:r.programId,title:r.programTitle,at:r.at,method:r.method??d.method,url:r.url,requestHeaders:d.requestHeaders,protocolInfo:d.protocolInfo,packetSize:d.actualPacketSize,encapsulation:d.encapsulation,responseStatus:d.responseStatus,responseHeaders:d.responseHeaders,expectedBytes:d.expectedBytes,pcrIndex:d.pcrIndex,timeSeek:d.timeSeek,resource:resources.get(r.programId),verification:'receiver-result-unknown'});
  }
  const entry=requests.get(r.connectionId);if(!entry)continue;
  if(r.category==='HTTP_MEDIA_END'||r.category==='ERROR')entry.end={at:r.at,...d};
  if(r.category==='HTTP_TRANSFER')entry.transfer={at:r.at,event:r.message,...d};
 }
 const entries=[...requests.values()].map(e=>({...e,timeContract:inspectRecordingTimeContract({didl:e.resource?.attributes,headers:e.responseHeaders,status:e.responseStatus,method:e.method,slice:e.timeSeek?.slice,pcr:e.pcrIndex}),classification:e.end?.outcome==='completed'?'http-completed-receiver-unknown':e.end?.outcome==='client-disconnected'?'interrupted-stop-seek-or-device-failure-unresolved':e.end?'server-rejection-or-error':'no-end-observation',untransmittedCounterBytes:e.end&&Number.isFinite(e.expectedBytes)&&Number.isFinite(e.end.sentBytes)?e.expectedBytes-e.end.sentBytes:undefined}));
 return {version:'recording-client-audit-v1',remoteIp,scope:'Retained logs only. User stop, seek cancellation and device reboot cannot be separated without observation/packet evidence.',recordingRequests:entries.length,headRequests:entries.filter(e=>e.method==='HEAD').length,byteRangeRequests:entries.filter(e=>e.requestHeaders?.range).length,timeSeekRequests:entries.filter(e=>e.requestHeaders?.['timeseekrange.dlna.org']).length,entries};
}
