import dgram from 'node:dgram';
import {isIP} from 'node:net';
import {networkInterfaces} from 'node:os';
import {isPrivateAddress} from './core.js';
import {xmlValue} from './experimental-renderer.js';
import {endpointFamilyFeatures,type FamilyEndpoint} from './client-family.js';
import {acquireCapability,type RegisteredDmp} from './playback-shadow-store.js';
import type {CapabilitySnapshot} from './playback-shadow.js';

export interface DiscoveredClientEndpoint {device:RegisteredDmp;features:FamilyEndpoint;capability:CapabilitySnapshot;discovery?:'ssdp'|'known-url-revalidated';description?:{manufacturer:string;modelName:string;modelNumber:string;friendlyName:string}}
/** URL is only a locator. Current description, UDN, CM and HTTP implementation
 * evidence must still be read and matched by admission; cached ability is not renewed. */
export function addKnownClientLocations(remote:string,locations:Map<string,string[]>,known:readonly RegisteredDmp[]){
 for(const d of known.slice(0,12))try{
  const u=new URL(d.descriptionUrl);
  if(d.remoteIp!==remote||u.protocol!=='http:'||u.hostname!==remote||u.username||u.password||locations.size>=12)continue;
  if(!locations.has(u.href))locations.set(u.href,[]);
 }catch{}
}
/** On-demand background discovery, restricted to the actual private request peer.
 * One M-SEARCH, bounded descriptions/CM reads; never renderer commands or media I/O. */
export async function discoverClientEndpoints(remote:string,known:readonly RegisteredDmp[]=[]):Promise<DiscoveredClientEndpoint[]> {
 if(isIP(remote)!==4||!isPrivateAddress(remote)||remote.startsWith('127.'))return [];
 const integer=(s:string)=>s.split('.').reduce((v,n)=>(v<<8)|Number(n),0);
 const local=Object.values(networkInterfaces()).flatMap(v=>v??[]).find(i=>i.family==='IPv4'&&!i.internal&&(integer(i.address)&integer(i.netmask))===(integer(remote)&integer(i.netmask)))?.address;
 if(!local)return [];
 const socket=dgram.createSocket('udp4'),locations=new Map<string,string[]>();
 try{
  await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.bind(0,local,()=>resolve());});
  socket.setMulticastInterface(local);
  socket.on('error',()=>{});
  socket.on('message',(data,peer)=>{
   if(peer.address!==remote||data.length>16384||locations.size>=12)return;
   const text=data.toString();if(!/^HTTP\/1\.[01] 200\b/.test(text))return;
   const headers=Object.fromEntries(text.split(/\r?\n/).slice(1).flatMap(l=>{const i=l.indexOf(':');return i>0?[[l.slice(0,i).toLowerCase(),l.slice(i+1).trim()]]:[];}));
   try{const u=new URL(headers.location);if(u.protocol!=='http:'||u.hostname!==remote||u.username||u.password)return;
    locations.set(u.href,[...(locations.get(u.href)??[]),headers.server??''].slice(0,16));}catch{}
  });
  const message=Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n');
  await new Promise<void>((resolve,reject)=>socket.send(message,1900,'239.255.255.250',e=>e?reject(e):resolve()));
  await new Promise(r=>setTimeout(r,1500));
 }finally{socket.close();}
 const ssdpLocations=new Set(locations.keys());
 addKnownClientLocations(remote,locations,known);
 return readClientLocations(remote,locations,ssdpLocations);
}
export async function readClientLocations(remote:string,locations:ReadonlyMap<string,string[]>,ssdpLocations:ReadonlySet<string>=new Set()):Promise<DiscoveredClientEndpoint[]> {
 if(isIP(remote)!==4||!isPrivateAddress(remote))return [];
 const result:DiscoveredClientEndpoint[]=[],deadline=Date.now()+15000;
 for(const [location,servers] of [...locations].slice(0,12)){if(Date.now()>deadline)break;try{
  const url=new URL(location);if(url.protocol!=='http:'||url.hostname!==remote||url.username||url.password)continue;
  const response=await fetch(location,{signal:AbortSignal.timeout(2000),redirect:'error'});if(!response.ok)continue;
  const chunks:Buffer[]=[];let size=0;for await(const part of response.body!){size+=part.length;if(size>262144){await response.body?.cancel().catch(()=>{});throw Error('Description too large');}chunks.push(Buffer.from(part));}
  const xml=Buffer.concat(chunks).toString('utf8'),deviceId=xmlValue(xml,'UDN');if(!deviceId)continue;
  const features=endpointFamilyFeatures(xml,[...servers,response.headers.get('server')??'']);
  if(!features.signals.some(s=>s.dimension==='service-layout'))continue;
  const service=[...xml.matchAll(/<(?:\w+:)?service\b[^>]*>([\s\S]*?)<\/(?:\w+:)?service>/g)].map(m=>m[1]).filter(s=>xmlValue(s,'serviceType')==='urn:schemas-upnp-org:service:ConnectionManager:1');
  if(service.length!==1)continue;
  const control=new URL(xmlValue(service[0],'controlURL'),location);if(control.protocol!=='http:'||control.hostname!==remote||control.username||control.password)continue;
  const device:RegisteredDmp={remoteIp:remote,deviceId,descriptionUrl:location,controlUrl:control.href,allowEmptySink:true};
  const capability=await acquireCapability(device,AbortSignal.timeout(4000));
  // Display hints only. Never part of family/capability classification or identity binding.
  const description={manufacturer:xmlValue(xml,'manufacturer').slice(0,256),modelName:xmlValue(xml,'modelName').slice(0,256),modelNumber:xmlValue(xml,'modelNumber').slice(0,256),friendlyName:xmlValue(xml,'friendlyName').slice(0,256)};
  if(!result.some(r=>r.device.deviceId===deviceId&&r.device.controlUrl===control.href))result.push({device,features,capability,description,discovery:ssdpLocations.has(location)?'ssdp':'known-url-revalidated'});
 }catch{/* One unavailable auxiliary service does not authorize or hide a different endpoint. */}}
 return result;
}
