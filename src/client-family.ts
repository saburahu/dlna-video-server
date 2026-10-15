import {createHash} from 'node:crypto';

export const FAMILY_VERSION='upnp-implementation-shadow-v1';
export type Family='intel-upnp-layout'|'dixim-service-layout';
export interface FamilySignal {family:Family;dimension:'stack-token'|'service-layout'|'request-stack'|'browse-extension';feature:string;provenance:string}
export interface FamilyEndpoint {signals:FamilySignal[];services:string[];roles:string[];serverTokens:string[];advertisedTypes:string[];usnSuffixes:string[]}
export interface FamilyBinding {remoteIp:string;collectedAt:string;endpoints:FamilyEndpoint[];identities?:{deviceId:string;location:string}[]}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const unique=(v:string[])=>[...new Set(v)].sort();

/** Whitelist implementation features. Never retain model, names, serials, addresses,
 * UUID bytes, Source/Sink or content titles as classifier inputs. */
export function endpointFamilyFeatures(xml:string,servers:readonly string[],advertisements:readonly {st?:string;usn?:string}[]=[]):FamilyEndpoint {
 const services=unique([...xml.matchAll(/<(?:\w+:)?serviceType>([^<]+)</g)].map(m=>m[1]));
 const roles=unique([...xml.matchAll(/<(?:\w+:)?deviceType>([^<]+)</g)].map(m=>m[1]));
 const paths=[...xml.matchAll(/<(?:\w+:)?(?:controlURL|SCPDURL)>([^<]+)</g)].map(m=>m[1]);
 const signals:FamilySignal[]=[],serverTokens:string[]=[];
 if(servers.some(s=>/Intel_SDK_for_UPnP_devices\/\d+(?:\.\d+)*/i.test(s))){serverTokens.push('Intel_SDK_for_UPnP_devices');signals.push({family:'intel-upnp-layout',dimension:'stack-token',feature:'Intel_SDK_for_UPnP_devices token (version independent)',provenance:'SSDP/description HTTP SERVER'});}
 if(servers.some(s=>/DiXiM\/\d+(?:\.\d+)*/i.test(s))){serverTokens.push('DiXiM');signals.push({family:'dixim-service-layout',dimension:'stack-token',feature:'DiXiM token (version independent)',provenance:'SSDP/description HTTP SERVER'});}
 if(services.some(s=>/ConnectionManager:\d+$/.test(s))&&paths.some(s=>/^\/?Media(?:Server|Renderer)\/ConnectionManager\/Control$/.test(s))&&paths.some(s=>/^\/?xml\/ConnectionManager\.xml$/.test(s)))signals.push({family:'intel-upnp-layout',dimension:'service-layout',feature:'MediaServer/MediaRenderer ConnectionManager Control + xml/ConnectionManager.xml',provenance:'device description service URL structure'});
 if(services.some(s=>/^urn:schemas-digion-com:service:X_AccessControl:\d+$/.test(s))&&services.some(s=>/^urn:schemas-digion-com:service:X_DeviceConfiguration:\d+$/.test(s)))signals.push({family:'dixim-service-layout',dimension:'service-layout',feature:'digion X_AccessControl + X_DeviceConfiguration services',provenance:'device description service types'});
 const types=advertisements.map(a=>a.st??'').filter(s=>s==='upnp:rootdevice'||/^urn:[\w:.-]+$/.test(s));
 const suffixes=advertisements.map(a=>a.usn?.split('::')[1]??'').filter(s=>s==='upnp:rootdevice'||/^urn:[\w:.-]+$/.test(s));
 return {signals,services,roles,serverTokens:unique(serverTokens),advertisedTypes:unique(types),usnSuffixes:unique(suffixes)};
}

export function requestFamilyFeatures(headers:Record<string,unknown>,xml=''):FamilySignal[]{
 const h=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),String(v)])),signals:FamilySignal[]=[];
 if(/Intel_SDK_for_UPnP_devices\/\d/i.test(h['user-agent']??''))signals.push({family:'intel-upnp-layout',dimension:'request-stack',feature:'Intel_SDK_for_UPnP_devices request UA token',provenance:'actual HTTP request'});
 // A product marker is evidence of a request implementation, never a model match.
 if(/JLABSDOC\/\d/i.test(h['user-agent']??'')&&/TOSHIBA_JP_BDR_V\d/i.test(h['user-agent']??''))signals.push({family:'dixim-service-layout',dimension:'request-stack',feature:'JLABSDOC + BDR software UA product tokens',provenance:'actual HTTP request; empirically associated, not vendor lineage proof'});
 const filter=/<(?:\w+:)?Filter>([^<]*)</.exec(xml)?.[1]?.split(',').map(s=>s.trim())??[];
 if(/<(?:\w+:)?Browse\b/.test(xml)&&filter.includes('funai:dnUrl')&&filter.includes('res@dlna:cleartextSize'))signals.push({family:'dixim-service-layout',dimension:'browse-extension',feature:'funai:dnUrl + res@dlna:cleartextSize Browse filter',provenance:'actual Browse SOAP Filter'});
 if(/<(?:\w+:)?Browse\b/.test(xml)&&filter.includes('regza:network_id')&&filter.includes('regza:service_id'))signals.push({family:'intel-upnp-layout',dimension:'browse-extension',feature:'regza:network_id + regza:service_id Browse filter',provenance:'actual Browse SOAP Filter; not required for older implementations'});
 return signals;
}

export function classifyClientFamily(signals:readonly FamilySignal[]){
 const evidence=[...new Map(signals.map(s=>[JSON.stringify(s),s])).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const families:Family[]=['intel-upnp-layout','dixim-service-layout'];
 const dimensions=Object.fromEntries(families.map(f=>[f,unique(evidence.filter(e=>e.family===f).map(e=>e.dimension))]));
 // SERVER and UA can repeat one library's token: require structural evidence too.
 const eligible=families.filter(f=>dimensions[f].length>=2&&dimensions[f].some(d=>d==='service-layout'||d==='browse-extension'));
 const conflicting=families.every(f=>dimensions[f].length>0);
 const family=!conflicting&&eligible.length===1?eligible[0]:undefined;
 return {version:FAMILY_VERSION,mode:'shadow-only' as const,status:conflicting?'ambiguous':family?'classified':'unknown',family,
  confidence:family?(dimensions[family].length>=3?'strong-observation':'supporting-observation'):'insufficient',
  fingerprint:hash(evidence),evidence,dimensions,
  reason:conflicting?'Conflicting implementation signals; host may contain multiple stacks':family?'Multiple feature dimensions including service/Browse structure agree':'Need at least two feature dimensions, including service/Browse structure',
  playbackAuthorization:'unchanged; family classification grants no receive capability',
  unknowns:['Observed stack similarity is not manufacturing lineage proof','DMS implementation is not necessarily the DMP decoder implementation','No codec/profile or target acceptance is inferred from family']};
}

/** A multi-stack host is not one client implementation. Correlate only stack
 * evidence compatible with actual outbound request features; still not decoder proof. */
export function classifyRequestContext(endpoints:readonly FamilyEndpoint[],requests:readonly FamilySignal[]){
 const observed=[...new Set(requests.map(s=>s.family))];
 const matching=observed.length===1?endpoints.flatMap(e=>e.signals).filter(s=>s.family===observed[0]):[];
 const result=classifyClientFamily([...requests,...matching]);
 const otherEndpointFamilies=unique(endpoints.flatMap(e=>e.signals.map(s=>s.family)).filter(f=>!observed.includes(f as Family)));
 const browseObserved=requests.some(s=>s.dimension==='browse-extension');
 return {...result,...(result.family&&otherEndpointFamilies.length&&!browseObserved?{confidence:'supporting-observation'}:{}),
  requestEvidence:browseObserved?'UA/Browse implementation features':'request UA only; Browse/media behavior may be unobserved',otherEndpointFamilies,
  scope:'request implementation with corroborating endpoint; no playback capability inferred'};
}

/** Bounded, synchronous, no I/O. Signals survive generic UA media requests but
 * cannot cancel or authorize playback. Cache is optional and expires. */
export function createFamilyShadow(bindings:readonly FamilyBinding[]=[],now=()=>Date.now()){
 const states=new Map<string,{signals:FamilySignal[];fingerprint:string;at:number}>();
 // Duplicate address bindings are ambiguous; never silently select the first.
 const cache=new Map<string,FamilyBinding>();const duplicates=new Set<string>();
 for(const b of bindings.slice(0,256)){const ip=b.remoteIp.replace(/^::ffff:/,'');if(cache.has(ip)||duplicates.has(ip)){cache.delete(ip);duplicates.add(ip);}else cache.set(ip,b);}
 return {observe(remote:string,headers:Record<string,unknown>,xml=''){
  const ip=remote.replace(/^::ffff:/,''),t=now();let state=states.get(ip);
  if(!state||t-state.at>86400000)state={signals:[],fingerprint:'',at:t};
  const binding=cache.get(ip),current=binding&&t-Date.parse(binding.collectedAt)>=0&&t-Date.parse(binding.collectedAt)<86400000;
  const requests=classifyClientFamily([...state.signals,...requestFamilyFeatures(headers,xml)]).evidence.slice(0,32);
  const signals=[...(current?binding.endpoints.flatMap(e=>e.signals):[]),...requests];
  const result=classifyClientFamily(signals);state.signals=requests;
  const changed=state.fingerprint!==result.fingerprint;state.fingerprint=result.fingerprint;states.delete(ip);states.set(ip,state);if(states.size>256)states.delete(states.keys().next().value!);
  return changed?{...result,requestContext:classifyRequestContext(current?binding.endpoints:[],requests),bindingStatus:current?'fresh-read-only-discovery':duplicates.has(ip)?'ambiguous-address-discovery':'request-only-or-expired-discovery',
   identity:current?{endpoints:binding.identities??[],trust:'address-correlated discovery only; not HTTP-authenticated identity'}:undefined,remoteIp:ip}:undefined;
 }};
}
