import {decodeArib,sectionCrc} from './arib-metadata.js';

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
