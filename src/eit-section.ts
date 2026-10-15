import {aribDate,decodeArib,durationBcd,sectionCrc} from './arib-metadata.js';
export interface EitEvent {
  eventId: number; startTimeMs: number|null; durationSeconds: number|null; runningStatus: number;
  descriptors: {tag:number;dataHex:string}[]; title: string|null; description: string|null;
  textSuspect: boolean; genres: number[];
}
export function parseEitSection(s: Buffer) {
  if(s.length<18 || s.length!==3+((s[1]&15)<<8)+s[2] || !(s[1]&128) ||
    s[0]<0x4e || s[0]>0x6f || sectionCrc(s)!==0)throw new Error('Invalid EIT length/table/CRC');
  const events: EitEvent[]=[];
  for(let pos=14;pos<s.length-4;){
    if(pos+12>s.length-4)throw new Error('Truncated EIT event');
    const length=((s[pos+10]&15)<<8)+s[pos+11],end=pos+12+length;
    if(end>s.length-4)throw new Error('Truncated EIT descriptors');
    const e:EitEvent={eventId:s.readUInt16BE(pos),startTimeMs:aribDate(s.subarray(pos+2,pos+7)),
      durationSeconds:durationBcd(s.subarray(pos+7,pos+10)),runningStatus:s[pos+10]>>5,
      descriptors:[],title:null,description:null,textSuspect:false,genres:[]};
    for(let d=pos+12;d<end;){
      if(d+2>end || d+2+s[d+1]>end)throw new Error('Malformed descriptor loop');
      const tag=s[d],b=s.subarray(d+2,d+2+s[d+1]);e.descriptors.push({tag,dataHex:b.toString('hex')});
      if(tag===0x4d){
        if(b.length<5 || 4+b[3]>=b.length || 5+b[3]+b[4+b[3]]!==b.length)throw new Error('Malformed short event descriptor');
        const name=decodeArib(b.subarray(4,4+b[3])),text=decodeArib(b.subarray(5+b[3]));
        if(b.subarray(0,3).toString('ascii')==='jpn' || e.title===null){e.title=name.text;e.description=text.text;e.textSuspect=name.suspect||text.suspect;}
      }
      if(tag===0x54){if(b.length%2)throw new Error('Malformed content descriptor');for(let n=0;n<b.length;n+=2)e.genres.push(b[n]);}
      d+=2+b.length;
    }
    events.push(e);pos=end;
  }
  return {tableId:s[0],serviceId:s.readUInt16BE(3),version:(s[5]>>1)&31,current:Boolean(s[5]&1),
    sectionNumber:s[6],lastSectionNumber:s[7],transportStreamId:s.readUInt16BE(8),originalNetworkId:s.readUInt16BE(10),events};
}
