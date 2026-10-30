import {decodeArib,sectionCrc} from './arib-metadata.js';

export interface NitTransport {
 networkId:number;transportStreamId:number;originalNetworkId:number;
 delivery:'terrestrial'|'satellite'|'unknown'|'ambiguous';
 services:{serviceId:number;serviceType:number}[];
 remoteControlKeyId?:number;remoteServices?:number[];
}
/** Current actual-network NIT only; never borrow a neighbouring TS's key. */
export function parseNit(s:Buffer):NitTransport[]{
 if(s.length<16||s[0]!==0x40||!(s[5]&1))return [];
 if(s.length!==3+(((s[1]&15)<<8)|s[2])||sectionCrc(s)!==0)throw Error('Invalid NIT');
 const stop=s.length-4,networkEnd=10+(((s[8]&15)<<8)|s[9]);
 if(networkEnd+2>stop)throw Error('Truncated NIT');
 const descriptors=(start:number,end:number,accept:(tag:number,b:Buffer)=>void)=>{for(let p=start;p<end;){if(p+2>end||p+2+s[p+1]>end)throw Error('Invalid NIT descriptor');accept(s[p],s.subarray(p+2,p+2+s[p+1]));p+=2+s[p+1];}};
 descriptors(10,networkEnd,()=>{});
 const end=networkEnd+2+(((s[networkEnd]&15)<<8)|s[networkEnd+1]);if(end!==stop)throw Error('Invalid NIT loop');
 const rows:NitTransport[]=[];
 for(let p=networkEnd+2;p<end;){
  if(p+6>end)throw Error('Truncated NIT transport');const next=p+6+(((s[p+4]&15)<<8)|s[p+5]);if(next>end)throw Error('Invalid NIT transport');
  const row:NitTransport={networkId:s.readUInt16BE(3),transportStreamId:s.readUInt16BE(p),originalNetworkId:s.readUInt16BE(p+2),delivery:'unknown',services:[]};let terrestrial=false,satellite=false;
  descriptors(p+6,next,(tag,b)=>{
   if(tag===0x41){if(b.length%3)throw Error('Invalid NIT service list');for(let n=0;n<b.length;n+=3)row.services.push({serviceId:b.readUInt16BE(n),serviceType:b[n+2]});}
   if(tag===0xfa){if(b.length<4||b.length%2)throw Error('Invalid terrestrial delivery');terrestrial=true;}
   if(tag===0x43){if(b.length!==11)throw Error('Invalid satellite delivery');satellite=true;}
   if(tag===0xcd){
    if(b.length<2)throw Error('Invalid TS information');let n=2+(b[1]>>2);if(n>b.length)throw Error('Invalid TS name');const ids:number[]=[];
    for(let k=0;k<(b[1]&3);k++){if(n+2>b.length)throw Error('Invalid TS transmission');const count=b[n+1];n+=2;if(n+count*2>b.length)throw Error('Invalid TS services');for(let j=0;j<count;j++,n+=2)ids.push(b.readUInt16BE(n));}
    if(n!==b.length||row.remoteControlKeyId!==undefined)throw Error('Ambiguous TS information');row.remoteControlKeyId=b[0];row.remoteServices=ids;
   }
  });
  row.delivery=terrestrial&&satellite?'ambiguous':terrestrial?'terrestrial':satellite?'satellite':'unknown';rows.push(row);p=next;
 }return rows;
}
export interface BroadcastChannel {
 version:1;state:'identified'|'unavailable';objectType?:'ARIB_TB'|'ARIB_BS'|'ARIB_CS';channelNr?:number;reason?:string;
}
/** ARIB TR-B14/B15 channel encoding. No receiver-specific BS preset mapping. */
export function broadcastChannel(service:BroadcastService|undefined,networks:NitTransport[]):BroadcastChannel{
 const unavailable=(reason:string):BroadcastChannel=>({version:1,state:'unavailable',reason});if(!service)return unavailable('service-unconfirmed');
 const matches=[...new Map(networks.filter(n=>n.transportStreamId===service.transportStreamId&&n.originalNetworkId===service.originalNetworkId&&n.networkId===service.originalNetworkId).map(n=>[JSON.stringify(n),n])).values()];
 if(matches.length!==1)return unavailable('nit-missing-or-conflicting');const n=matches[0],entries=n.services.filter(s=>s.serviceId===service.serviceId);
 if(entries.length!==1||entries[0].serviceType!==1)return unavailable('nit-tv-service-unconfirmed');
 if(n.delivery==='terrestrial'){
  const result:BroadcastChannel={version:1,state:'identified',objectType:'ARIB_TB'},key=n.remoteControlKeyId;
  if(key===undefined||key<1||key>12||!n.remoteServices?.includes(service.serviceId))return {...result,reason:'remote-key-unconfirmed'};
  if(((service.serviceId>>7)&3)!==0)return unavailable('terrestrial-service-type-conflict');
  const digits=((service.serviceId>>7)&3)*200+key*10+(service.serviceId&7)+1;
  // This server has no tuner reassignment table: use the broadcast default key
  // and branch zero, not a claim about the receiving TV's local presets.
  return {...result,channelNr:key*10000+digits*10};
 }
 if(n.delivery==='satellite'&&[4,6,7].includes(n.originalNetworkId)){
  const result:BroadcastChannel={version:1,state:'identified',objectType:n.originalNetworkId===4?'ARIB_BS':'ARIB_CS'};
  return service.serviceId>=1&&service.serviceId<=999?{...result,channelNr:service.serviceId*10}:result;
 }
 return unavailable('broadcast-system-unconfirmed');
}

export interface BroadcastService {serviceId:number;transportStreamId:number;originalNetworkId:number;name:string;textSuspect:boolean}
/** Only current, actual-TS SDT identifies the service carried by this recording. */
export function parseSdt(section:Buffer):BroadcastService[]{
 if(section.length<15||section[0]!==0x42||!(section[5]&1))return [];
 if(section.length!==3+(((section[1]&15)<<8)|section[2])||sectionCrc(section)!==0)throw Error('Invalid SDT');
 const rows:BroadcastService[]=[];
 for(let n=11;n<section.length-4;){
  if(n+5>section.length-4)throw Error('Truncated SDT service');
  const serviceId=section.readUInt16BE(n),end=n+5+(((section[n+3]&15)<<8)|section[n+4]);
  if(end>section.length-4)throw Error('Invalid SDT loop');
  for(let d=n+5;d<end;){if(d+2>end||d+2+section[d+1]>end)throw Error('Invalid SDT descriptor');
   const tag=section[d],b=section.subarray(d+2,d+2+section[d+1]);
   if(tag===0x48){if(b.length<3||2+b[1]>=b.length||3+b[1]+b[2+b[1]]!==b.length)throw Error('Invalid service descriptor');
    const decoded=decodeArib(b.subarray(3+b[1]));
    if(decoded.text?.trim())rows.push({serviceId,transportStreamId:section.readUInt16BE(3),originalNetworkId:section.readUInt16BE(8),name:decoded.text.trim(),textSuspect:decoded.suspect});
   }d+=2+section[d+1];
  }n=end;
 }return rows;
}
export interface TimeAnchor {packet:number;seconds:number;timeMs:number}
export interface RecordingOrigin {
 version:1;basis:'tot-pcr-prefix';state:'estimated'|'unavailable';anchors:number;
 startTime?:string;firstSeconds?:number;lastSeconds?:number;spreadMs?:number;uncertaintySeconds?:1;reason?:string;
}
/** Only the initial transport clock origin, never a claim about the whole file. */
export function recordingOrigin(anchors:TimeAnchor[],eligible:boolean):RecordingOrigin{
 const common={version:1 as const,basis:'tot-pcr-prefix' as const};
 if(!eligible)return {...common,state:'unavailable',anchors:0,reason:'ambiguous-or-discontinuous-clock'};
 const local=anchors.filter(a=>a.seconds>=0&&a.seconds<=20&&Number.isFinite(a.timeMs)).sort((a,b)=>a.seconds-b.seconds);
 const count=local.length,firstSeconds=local[0]?.seconds,lastSeconds=local.at(-1)?.seconds;
 const offsets=local.map(a=>a.timeMs-a.seconds*1000).sort((a,b)=>a-b),spreadMs=count?offsets.at(-1)!-offsets[0]:undefined;
 const evidence={...common,anchors:count,firstSeconds,lastSeconds,spreadMs};
 if(count<3||firstSeconds!>10||lastSeconds!-firstSeconds!<5)return {...evidence,state:'unavailable',reason:'insufficient-initial-anchors'};
 if(spreadMs!>250)return {...evidence,state:'unavailable',reason:'unstable-initial-anchors'};
 return {...evidence,state:'estimated',startTime:new Date(offsets[Math.floor(count/2)]).toISOString(),uncertaintySeconds:1};
}
export interface RecordingRange {
 state:'consistent'|'missing'|'insufficient'|'discontinuous'|'inconsistent';
 basis:'tot-pcr-transport';segments:number;anchorCount:number;spreadMs?:number;
 startTime?:string;endTime?:string;durationSeconds?:number;
 /** Conservative resolution allowance, not calibrated broadcast UTC accuracy. */
 uncertaintySeconds?:number;
}
export function recordingRange(anchors:TimeAnchor[],duration:number|null,discontinuities:number):RecordingRange{
 const common={basis:'tot-pcr-transport' as const,segments:discontinuities+1,anchorCount:anchors.length};
 if(discontinuities)return {...common,state:'discontinuous'};
 if(duration===null)return {...common,state:'insufficient',segments:0};
 if(!anchors.length)return {...common,state:'missing'};
 const offsets=anchors.map(a=>a.timeMs-a.seconds*1000).sort((a,b)=>a-b),spreadMs=offsets.at(-1)!-offsets[0];
 if(spreadMs>250)return {...common,state:'inconsistent',spreadMs};
 const first=anchors[0],last=anchors.at(-1)!;
 // Do not extrapolate a lone prefix timestamp across an entire recording.
 if(anchors.length<3||last.seconds-first.seconds<5||first.seconds>30||duration-last.seconds>30||last.seconds-first.seconds<duration*.9)
  return {...common,state:'insufficient',spreadMs};
 const origin=offsets[Math.floor(offsets.length/2)];
 return {...common,state:'consistent',spreadMs,startTime:new Date(origin).toISOString(),endTime:new Date(origin+duration*1000).toISOString(),durationSeconds:duration,uncertaintySeconds:1};
}
