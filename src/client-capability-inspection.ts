import {createHash} from 'node:crypto';
import {isPrivateAddress} from './core.js';
import {xmlValue} from './experimental-renderer.js';

export const CLIENT_INSPECTION_VERSION='client-capability-inspection-v1';
const unescape=(s:string)=>s.replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
export function clientDeviceDescription(xml:string,location:string){
 const base=new URL(location),urlBase=xmlValue(xml,'URLBase');
 const origin=urlBase?new URL(unescape(urlBase),base):base;
 const services=[...xml.matchAll(/<(?:\w+:)?service\b[^>]*>([\s\S]*?)<\/(?:\w+:)?service>/g)].map(m=>({type:xmlValue(m[1],'serviceType'),controlUrl:new URL(unescape(xmlValue(m[1],'controlURL')),origin).href}));
 const deviceId=xmlValue(xml,'UDN');if(!deviceId.startsWith('uuid:'))throw Error('Missing device UDN');
 const identity={deviceId,deviceType:xmlValue(xml,'deviceType'),manufacturer:unescape(xmlValue(xml,'manufacturer')),model:unescape(xmlValue(xml,'modelName'))};
 return {...identity,friendlyName:unescape(xmlValue(xml,'friendlyName')),descriptionUrl:base.href,services,
  identityHash:createHash('sha256').update(JSON.stringify(identity)).digest('hex')};
}
export interface ClientInspection {version:typeof CLIENT_INSPECTION_VERSION;acquiredAt:string;device:ReturnType<typeof clientDeviceDescription>;connectionManagers:{controlUrl:string;status:number;source:string;sink:string;responseXml:string;error?:string}[];sinkStatus:'advertised'|'not-advertised'|'service-unavailable';unknowns:string[]}
export async function inspectClientCapability(location:string,expectedDeviceId?:string,signal=AbortSignal.timeout(10000),request:typeof fetch=fetch):Promise<ClientInspection>{
 const base=new URL(location);
 const safe=(u:URL)=>{if(u.protocol!=='http:'||u.hostname!==base.hostname||!isPrivateAddress(u.hostname)||u.username||u.password)throw Error('Client URL must remain on the same private host');};safe(base);
 const read=async(r:Response)=>{let bytes=0;const chunks:Buffer[]=[];try{for await(const c of r.body!){bytes+=c.length;if(bytes>262144)throw Error('Client XML too large');chunks.push(Buffer.from(c));}}catch(e){await r.body?.cancel().catch(()=>{});throw e;}return Buffer.concat(chunks).toString('utf8');};
 const description=await request(base,{signal,redirect:'error'});if(!description.ok)throw Error(`Description HTTP ${description.status}`);
 const device=clientDeviceDescription(await read(description),base.href);if(expectedDeviceId&&device.deviceId!==expectedDeviceId)throw Error('Client UDN changed; no profile binding');
 const connectionManagers:ClientInspection['connectionManagers']=[];
 for(const service of device.services.filter(s=>/^urn:schemas-upnp-org:service:ConnectionManager:\d+$/.test(s.type))){
  const u=new URL(service.controlUrl);safe(u);
  try{const r=await request(u,{method:'POST',signal,redirect:'error',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:`"${service.type}#GetProtocolInfo"`},body:`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetProtocolInfo xmlns:u="${service.type}"/></s:Body></s:Envelope>`});
   const responseXml=await read(r),fault=/<(?:\w+:)?Fault\b/.test(responseXml);connectionManagers.push({controlUrl:u.href,status:r.status,source:unescape(xmlValue(responseXml,'Source')),sink:!fault&&r.ok?unescape(xmlValue(responseXml,'Sink')):'',responseXml,...(!r.ok||fault?{error:'GetProtocolInfo failed'}:{})});
  }catch(error){signal.throwIfAborted();connectionManagers.push({controlUrl:u.href,status:0,source:'',sink:'',responseXml:'',error:String(error)});}
 }
 const sinkStatus=connectionManagers.some(c=>c.sink.trim())?'advertised':connectionManagers.some(c=>c.status===200&&!c.error)?'not-advertised':'service-unavailable';
 return {version:CLIENT_INSPECTION_VERSION,acquiredAt:new Date().toISOString(),device,connectionManagers,sinkStatus,unknowns:sinkStatus==='advertised'?['Sink names do not establish all normative profile constraints']:['DMP receive capability is not exposed by the inspected services','Source protocolInfo describes transmission, not reception','No DRM requirement or decoder limitation inferred from absent Sink']};
}
