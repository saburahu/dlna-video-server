import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {FAMILY_VERSION,requestFamilyFeatures,classifyClientFamily,classifyRequestContext,type FamilySignal} from './client-family.js';
import {discoverClientEndpoints,type DiscoveredClientEndpoint} from './client-family-discovery.js';
import {jitRecipeFingerprint,type JitClientTrial} from './jit-client-trial.js';
import {snapshotHash} from './playback-shadow.js';
import {readShadowJson,saveShadowJson} from './playback-shadow-store.js';
import type {ExperimentalJitPolicy} from './experimental-jit.js';
import type {MediaProfileDefinition} from './playback-decision.js';

export const AUTOMATIC_CLIENT_VERSION='family-candidate-v1';
export interface AutomaticClientResolution {reason:string;binding?:string;endpoint?:DiscoveredClientEndpoint;profile?:MediaProfileDefinition;trial?:JitClientTrial;context?:ReturnType<typeof classifyRequestContext>;evidence?:typeof FAMILY_RECEIVE_EVIDENCE[number];observed?:{fresh:boolean;endpoints:DiscoveredClientEndpoint[];requests:FamilySignal[]}}
/** Recipe-pinned empirical associations. Counts/references are observations,
 * never a normative guarantee, a Source advertisement or a model match. */
export const FAMILY_RECEIVE_EVIDENCE=[
 {id:'intel-avc-observed-v1',family:'intel-upnp-layout',target:'legacy-jp-observed',recipe:'84f0107ac736c7e14f7f7df582469f98ec3a97528d1fb2d72f1372e66fcf9bae',independentReceivers:4,reference:'CLIENT_IMPLEMENTATION_FAMILIES.md; FAMILY_AVC_RECEIVER_TRIALS.md; commits 976fccd, 676b44d, 7be3966'},
 {id:'bdr-request-mpeg2-observed-v1',family:'dixim-service-layout',target:'mpeg2-jp-pcr-split-v1',recipe:'a487bdd1789ec39ee4dd2e0b1f0739061e34bf2b5c61897e1d8cb271312cea99',independentReceivers:1,reference:'DBR_MPEG2_JIT.md; DBR_CONTINUOUS_SEEK.md; commit 1518e2a'}
] as const;
export function automaticClientSelection(endpoints:readonly DiscoveredClientEndpoint[],requests:readonly FamilySignal[],p:ExperimentalJitPolicy){
 const requestFamilies=new Set(requests.map(s=>s.family));
 if(requestFamilies.size!==1)return {reason:requestFamilies.size?'conflicting-request-implementations':'request-implementation-missing'};
 const family=[...requestFamilies][0];
 const has=(dimension:string)=>requests.some(s=>s.family===family&&s.dimension===dimension);
 if(!has('request-stack')||(family==='dixim-service-layout'&&!has('browse-extension')))return {reason:'request-structure-insufficient'};
 const matching=endpoints.filter(e=>{
  const endpoint=classifyClientFamily(e.features.signals),context=classifyRequestContext([e.features],requests),cap=e.capability;
  return endpoint.status==='classified'&&endpoint.family===family&&context.status==='classified'&&context.family===family&&
   e.features.signals.some(s=>s.dimension==='stack-token')&&e.features.signals.some(s=>s.dimension==='service-layout')&&
   cap.deviceId===e.device.deviceId&&cap.remoteIp===e.device.remoteIp&&cap.controlUrl===e.device.controlUrl&&cap.sinkHash===snapshotHash(cap.sink)&&
   cap.implementation?.version===FAMILY_VERSION&&cap.implementation.family===family&&cap.implementation.fingerprint===endpoint.fingerprint;
 });
 if(matching.length!==1)return {reason:matching.length?'ambiguous-request-endpoints':'no-corroborating-current-endpoint'};
 const evidence=FAMILY_RECEIVE_EVIDENCE.find(e=>e.family===family),profile=p.policy.profiles.find(v=>v.id===evidence?.target);
 if(!evidence||!profile||jitRecipeFingerprint(profile)!==evidence.recipe)return {reason:'no-matching-empirical-recipe'};
 const endpoint=matching[0],context=classifyRequestContext([endpoint.features],requests);
 const trial:JitClientTrial={version:'jit-client-trial-v1',enabled:true,deviceId:endpoint.capability.deviceId,sinkHash:endpoint.capability.sinkHash,targetProfile:profile.id,
  recipeFingerprint:evidence.recipe,containers:p.automaticClients?.legacyInputs?['mp4','matroska','avi','asf','ogg']:['mp4','matroska'],reference:`${evidence.reference}; inferred family candidate, this receiver unverified`,
  automaticEvidence:{version:AUTOMATIC_CLIENT_VERSION,evidenceId:evidence.id,family,confidence:context.confidence,requestFingerprint:classifyClientFamily(requests).fingerprint,endpointFingerprint:endpoint.capability.implementation!.fingerprint,...(p.automaticClients?.legacyInputs?{inputPolicy:'jit-legacy-inputs-v1' as const}:{})},
  familyEvidence:{version:FAMILY_VERSION,family,endpointFingerprint:endpoint.capability.implementation!.fingerprint,requestFingerprint:classifyClientFamily(requests).fingerprint,observedAt:endpoint.capability.acquiredAt,reference:evidence.reference}};
 return {reason:'empirical-family-candidate',endpoint,profile,trial,context,evidence};
}

/** Bounds both peer state and read-only jobs. Browse only observes/enqueues: no
 * network wait, source analysis, codec probe or encoder on its response path. */
export function createAutomaticJitClients(directory:string,trace:(event:string,detail:unknown)=>void,discover=discoverClientEndpoints,now=()=>Date.now()){
 type State={requests:FamilySignal[];endpoints:DiscoveredClientEndpoint[];at:number;checked:number;nonce:string};
 const states=new Map<string,State>(),pending=new Map<string,Promise<void>>();let tail=Promise.resolve(),closed=false,loading:Promise<void>|undefined,revision=0;
 const file=path.join(directory,'client-family-bindings.json');
 const fresh=(s:State)=>now()-s.checked>=0&&now()-s.checked<300000;
 function load(){return loading??=(async()=>{try{const cache=await readShadowJson<{version:string;states:[string,State][]}>(file);if(cache?.version===AUTOMATIC_CLIENT_VERSION)for(const [ip,s] of cache.states.slice(-128))if(fresh(s))states.set(ip,{...s,requests:[],nonce:randomUUID()});}catch{}})();}
 async function observe(remote:string,headers:Record<string,unknown>,xml='',enabled=false){
  if(!enabled||closed)return;await load();const ip=remote.replace(/^::ffff:/,''),t=now();
  const signals=requestFamilyFeatures(headers,xml);let s=states.get(ip);if(!signals.length&&!s)return;
  if(!s||t-s.at>86400000)s={requests:[],endpoints:[],at:t,checked:0,nonce:randomUUID()};
  const previousRequestFingerprint=classifyClientFamily(s.requests).fingerprint;
  s.requests=classifyClientFamily([...s.requests,...signals]).evidence;if(previousRequestFingerprint!==classifyClientFamily(s.requests).fingerprint)revision++;
  if(signals.length)s.at=t;states.delete(ip);states.set(ip,s);
  if(states.size>128)states.delete(states.keys().next().value!);
  if(fresh(s)||pending.has(ip)||pending.size>=16)return;
  const state=s;
  const job=tail.then(async()=>{if(closed||states.get(ip)!==state)return;try{const wasExpired=!fresh(state);const previous=snapshotHash(JSON.stringify(state.endpoints.map(e=>({device:e.device,implementation:e.capability.implementation,sinkHash:e.capability.sinkHash}))));state.endpoints=await discover(ip,state.endpoints.map(e=>e.device));state.checked=now();state.nonce=randomUUID();if(wasExpired||previous!==snapshotHash(JSON.stringify(state.endpoints.map(e=>({device:e.device,implementation:e.capability.implementation,sinkHash:e.capability.sinkHash})))))revision++;trace('AUTO_CLIENT_DISCOVERED',{remoteIp:ip,endpoints:state.endpoints.map(e=>({deviceId:e.device.deviceId,controlUrl:e.device.controlUrl,implementation:e.capability.implementation,sinkHash:e.capability.sinkHash,discovery:e.discovery})),sourceIsNotSink:true});await saveShadowJson(file,{version:AUTOMATIC_CLIENT_VERSION,states:[...states].map(([ip,s])=>[ip,{...s,requests:[]}])});}catch(e){if(state.endpoints.length)revision++;state.endpoints=[];state.checked=now();trace('AUTO_CLIENT_DISCOVERY_FAILED',{remoteIp:ip,error:String(e)});}}).finally(()=>pending.delete(ip));
  pending.set(ip,job);tail=job.catch(()=>{});
 }
 function resolve(p:ExperimentalJitPolicy,remote:string):AutomaticClientResolution{
  if(p.automaticClients?.version!==AUTOMATIC_CLIENT_VERSION||!p.automaticClients.enabled)return {reason:'automatic-disabled',binding:undefined};
  const ip=remote.replace(/^::ffff:/,''),s=states.get(ip),observed=s?{fresh:fresh(s),endpoints:s.endpoints,requests:s.requests}:undefined;if(!s||!fresh(s)||now()-s.at>86400000)return {reason:'automatic-binding-pending-or-expired',binding:undefined,observed};
  let selected:ReturnType<typeof automaticClientSelection>;try{selected=automaticClientSelection(s.endpoints,s.requests,p);}catch{return {reason:'invalid-automatic-binding-cache'};}
  if(!selected.trial||!selected.endpoint)return {...selected,binding:undefined,observed};
  const implementation={...selected.trial.automaticEvidence};delete implementation.inputPolicy;
  const binding=snapshotHash(JSON.stringify({version:AUTOMATIC_CLIENT_VERSION,ip,deviceId:selected.endpoint.capability.deviceId,control:selected.endpoint.device.controlUrl,sinkHash:selected.endpoint.capability.sinkHash,target:selected.profile!.id,recipe:selected.trial.recipeFingerprint,implementation}));
  return {...selected,binding,observed};
 }
 return {observe,resolve,peers:()=>[...states].map(([remoteIp,s])=>({remoteIp,fresh:fresh(s),endpoints:s.endpoints})),async refresh(remote:string){await pending.get(remote.replace(/^::ffff:/,''));},async idle(){await tail;},async close(){closed=true;await tail;},status:()=>({peers:states.size,pending:pending.size,revision})};
}
