import {createHash} from 'node:crypto';
import {escapeXml,isPrivateAddress} from './core.js';
import {xmlValue} from './experimental-renderer.js';
import {inspectClientCapability} from './client-capability-inspection.js';

const decode=(s:string)=>s.replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
/** Bounded DIDL inspection, not a general XML validator or a playback assertion. */
export function declaredResources(didl:string){
 return [...didl.matchAll(/<(?:\w+:)?res\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?res>/g)].map(m=>{
  const attributes=Object.fromEntries([...m[1].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(a=>[a[1],decode(a[2]??a[3])]));
  const protocolInfo=attributes.protocolInfo??'',parts=protocolInfo.split(':'),mime=parts[2]??'',additional=parts.slice(3).join(':'),parameters=Object.fromEntries(additional.split(';').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
  const url=decode(m[2].trim());
  return {attributes,protocolInfo,mime,parameters,url,protection:/dtcp|DTCP/.test(protocolInfo+' '+url)?'dtcp-signalled':'not-signalled-not-proof-of-unprotected',framing:'unknown-from-DIDL-alone'};
 });
}

/** Keep each resource attached to its display object; do not merge PN and fallback resources. */
export function declaredObjects(didl:string){
 return [...didl.matchAll(/<(item|container)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map(m=>({
  kind:m[1],attributes:Object.fromEntries([...m[2].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(a=>[a[1],decode(a[2]??a[3])])),
  title:decode(xmlValue(m[3],'title')),class:decode(xmlValue(m[3],'class')),resources:declaredResources(m[3])
 }));
}

/** Description + GetProtocolInfo + one bounded Browse. Never fetch a media URL or control a renderer. */
export async function snapshotDmsContract(location:string,objectId='0',start=0,count=20,request:typeof fetch=fetch){
 if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(count)||count<1||count>100)throw Error('Browse page must have nonnegative start and 1..100 count');
 const signal=AbortSignal.timeout(15000),inspection=await inspectClientCapability(location,undefined,signal,request);
 const service=inspection.device.services.find(s=>/^urn:schemas-upnp-org:service:ContentDirectory:\d+$/.test(s.type));if(!service)throw Error('ContentDirectory not advertised');
 const url=new URL(service.controlUrl),base=new URL(location);
 if(url.protocol!=='http:'||url.hostname!==base.hostname||!isPrivateAddress(url.hostname)||url.username||url.password)throw Error('Browse URL must remain on the same private host');
 const response=await request(url,{method:'POST',redirect:'error',signal,headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:`"${service.type}#Browse"`},body:`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="${service.type}"><ObjectID>${escapeXml(objectId)}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>${start}</StartingIndex><RequestedCount>${count}</RequestedCount><SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`});
 let bytes=0;const chunks:Buffer[]=[];
 for await(const c of response.body??[]){bytes+=c.length;if(bytes>1048576)throw Error('Browse XML exceeds 1 MiB');chunks.push(Buffer.from(c));}
 const responseXml=Buffer.concat(chunks).toString('utf8');if(!response.ok||/<(?:\w+:)?Fault\b/.test(responseXml))throw Error(`Browse failed HTTP ${response.status}`);
 const didl=decode(xmlValue(responseXml,'Result'));
 return {version:'dms-contract-snapshot-v1',acquiredAt:new Date().toISOString(),scope:'server advertisement only; no media HEAD/GET, renderer control or receiver-success evidence',inspection,browse:{objectId,start,count,status:response.status,numberReturned:xmlValue(responseXml,'NumberReturned'),totalMatches:xmlValue(responseXml,'TotalMatches'),updateId:xmlValue(responseXml,'UpdateID'),responseXml,sha256:createHash('sha256').update(responseXml).digest('hex'),resources:declaredResources(didl)},unknowns:['Actual HTTP response contract and transport framing require a separate passive successful-playback trace','Server Source entries are not DBR Sink capabilities','DTCP absence in DIDL is not proof of unprotected content']};
}
