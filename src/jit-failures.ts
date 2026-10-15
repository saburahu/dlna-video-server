/** Server-observed failures only. Client cancellation is not a decoder failure. */
export interface JitEvent {at:string;category:string;trialId?:string;detail?:any}
export function summarizeJitFailures(events:JitEvent[]){
 const sourcesByTrial=new Map<string,Map<string,unknown>>(),sourcesByRequest=new Map<string,unknown>(),requests=new Map<string,JitEvent>();
 for(const e of events){
  if(e.category==='JIT_DECISION'&&e.trialId){const source=e.detail?.sourceFingerprint;if(source){const sources=sourcesByTrial.get(e.trialId)??new Map();sources.set(JSON.stringify({path:source.path,size:source.size,mtimeMs:source.mtimeMs}),source);sourcesByTrial.set(e.trialId,sources);if(e.detail.connectionId)sourcesByRequest.set(e.detail.connectionId,source);}}
  if(e.category==='HTTP_REQUEST'&&e.detail?.requestId)requests.set(e.detail.requestId,e);
 }
 const failures=events.filter(e=>e.category==='ERROR'||e.category==='TIMING_MODEL_ERROR'||e.category==='AUDIO_CLOCK_ERROR'||e.category==='JIT_END'&&e.detail?.completed===false&&!e.detail?.cancelled).map(e=>{
  const d=e.detail??{},request=requests.get(d.requestId??d.connectionId),message=String(d.error??'');
  const kind=/Packet timeline|Decoded display timeline/.test(message)?'source-timestamp-checkpoint':e.category==='TIMING_MODEL_ERROR'?'timing-policy':e.category==='AUDIO_CLOCK_ERROR'?'audio-timeline':/FFmpeg exit/.test(message)?'executor':'unclassified';
  const requestId=d.requestId??d.connectionId,trialSources=sourcesByTrial.get(e.trialId??''),directSource=d.sourceFingerprint??sourcesByRequest.get(requestId),trialSource=trialSources?.size===1?[...trialSources.values()][0]:undefined;
  return {at:e.at,trialId:e.trialId,requestId,kind,phase:d.phase,sourceFingerprint:directSource??trialSource,correlation:directSource?'request-source':trialSource?'unique-trial-source':'unresolved',headers:d.headers??request?.detail?.headers,error:message};
 });
 return {requests:events.filter(e=>e.category==='HTTP_REQUEST').length,completed:events.filter(e=>e.category==='JIT_END'&&e.detail?.completed).length,cancelled:events.filter(e=>e.category==='JIT_END'&&e.detail?.cancelled).length,failures,note:'Failure events can repeat for one request; absence of a server error does not prove TV playback success.'};
}
