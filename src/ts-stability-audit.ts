import {readPcr,PCR_WRAP} from './core.js';
import {SectionAssembler} from './psi-scanner.js';
import {sectionCrc} from './arib-metadata.js';
const signed=(n:number,wrap:number)=>((n+wrap/2)%wrap+wrap)%wrap-wrap/2;
const pts=(b:Buffer)=>((b[0]>>1)&7)*2**30+b[1]*2**22+(b[2]>>1)*2**15+b[3]*128+(b[4]>>1);
/** Bounded packet/PES diagnostics, never a decoder or a DLNA conformance assertion. */
export class TsStabilityAudit {
 private previous=new Map<number,Buffer>();private psi=new Map<number,SectionAssembler>();
 private audio:Buffer[]=[];private audioBytes=0;private expectedAudioPts:number|undefined;private tail=Buffer.alloc(0);
 private lastPcr:number|undefined;private audioStarted=false;
 private adts=Buffer.alloc(0);private adtsOffset=0;private audioTotal=0;
 private markers:{offset:number;pts:number}[]=[];private locked=false;
 readonly counts={packets:0,malformed:0,tei:0,scrambled:0,ccErrors:0,duplicates:0,signalledDiscontinuities:0,crcErrors:0,pcrBackwards:0,audioPes:0,audioFrames:0,audioPtsCompared:0,audioPtsGaps:0,audioInvalid:0,audioBoundaryExcluded:0};
 readonly events:{kind:string;packet:number;pid:number;value?:number}[]=[];
 readonly first:Record<string,number>={};maxPcrGapMs=0;maxAudioPtsErrorMs=0;private position=0;
 constructor(readonly pids:{pmt:number;video:number;audio:number;pcr:number}){}
 private event(kind:string,pid:number,value?:number){if(this.events.length<2000)this.events.push({kind,packet:this.position,pid,value});}
 private mark(kind:string){this.first[kind]??=this.position;}
 private resetAudio(){this.audio=[];this.audioBytes=0;this.audioStarted=false;this.adts=Buffer.alloc(0);this.adtsOffset=0;this.audioTotal=0;this.markers=[];this.locked=false;this.expectedAudioPts=undefined;}
 private flushAudio(boundary=false){
  if(!this.audioBytes)return;const b=Buffer.concat(this.audio);this.audio=[];this.audioBytes=0;
  if(boundary||b.length<14||!b.subarray(0,3).equals(Buffer.from([0,0,1]))){this.counts.audioBoundaryExcluded++;return;}
  const length=b.readUInt16BE(4),end=6+length,start=9+b[8];
  if(!length||end>b.length||start>end){this.counts.audioBoundaryExcluded++;return;}
  this.counts.audioPes++;
  // ADTS frames can straddle PES boundaries. PTS refers to the first AU commencing in this PES.
  if((b[7]&128)&&b[8]>=5){if(this.markers.length>=64){this.counts.audioInvalid++;this.markers=[];this.expectedAudioPts=undefined;}this.markers.push({offset:this.audioTotal,pts:pts(b.subarray(9,14))});}
  this.audioTotal+=end-start;this.adts=Buffer.concat([this.adts,b.subarray(start,end)]);
  const rates=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];let i=0;
  while(i+7<=this.adts.length){const h=this.adts.subarray(i),length=((h[3]&3)<<11)|(h[4]<<3)|(h[5]>>5),rate=rates[(h[2]>>2)&15];
   if(h[0]!==255||(h[1]&0xf6)!==0xf0||length<(h[1]&1?7:9)||!rate){if(this.locked){this.counts.audioInvalid++;this.event('adts-resync',this.pids.audio);this.locked=false;this.expectedAudioPts=undefined;}i++;continue;}
   if(i+length>this.adts.length)break;this.locked=true;
   let time:number|undefined;while(this.markers[0]&&this.markers[0].offset<=this.adtsOffset+i)time=this.markers.shift()!.pts;
   if(time!==undefined&&this.expectedAudioPts!==undefined){this.counts.audioPtsCompared++;const error=signed(time-this.expectedAudioPts,2**33)/90;this.maxAudioPtsErrorMs=Math.max(this.maxAudioPtsErrorMs,Math.abs(error));if(Math.abs(error)>1/90+1e-6){this.counts.audioPtsGaps++;this.event('audio-pts-vs-adts-duration',this.pids.audio,error);}}
   const base=time??this.expectedAudioPts;this.expectedAudioPts=base===undefined?undefined:(base+1024*((h[6]&3)+1)*90000/rate)%(2**33);this.counts.audioFrames++;i+=length;
  }
  this.adts=Buffer.from(this.adts.subarray(i));this.adtsOffset+=i;
 }
 feed(p:Buffer,packet:number){
  this.position=packet;this.counts.packets++;
  if(p.length!==188||p[0]!==71){this.counts.malformed++;return;}
  const pid=((p[1]&31)<<8)|p[2],af=(p[3]>>4)&3,offset=af&2?5+p[4]:4;
  if(!af||offset>188){this.counts.malformed++;return;}
  if(p[1]&128){this.counts.tei++;this.event('tei',pid);}
  if(p[3]&192){this.counts.scrambled++;return;}
  const disc=!!(af&2)&&p[4]>0&&!!(p[5]&128);if(disc){this.counts.signalledDiscontinuities++;this.previous.delete(pid);this.event('discontinuity',pid);if(pid===this.pids.audio)this.resetAudio();}
  if(pid===this.pids.pcr){const clock=readPcr(p,0);if(clock!==null){this.mark('pcr');if(this.lastPcr!==undefined&&!disc){const delta=signed(clock-this.lastPcr,PCR_WRAP)/27000;this.maxPcrGapMs=Math.max(this.maxPcrGapMs,delta);if(delta<0){this.counts.pcrBackwards++;this.event('pcr-backwards',pid,delta);}}this.lastPcr=clock;}}
  if(!(af&1)||offset===188||pid===8191)return;
  const prev=this.previous.get(pid);if(prev){if((prev[3]&15)===(p[3]&15)&&prev.equals(p)){this.counts.duplicates++;return;}if(((prev[3]+1)&15)!==(p[3]&15)){this.counts.ccErrors++;this.event('cc-error',pid);if(pid===this.pids.audio){this.flushAudio(true);this.resetAudio();}}}this.previous.set(pid,Buffer.from(p));
  if(pid===0||pid===this.pids.pmt){let a=this.psi.get(pid);if(!a){a=new SectionAssembler();this.psi.set(pid,a);}for(const section of a.feed(p)){if(sectionCrc(section)!==0)this.counts.crcErrors++;else this.mark(pid===0?'pat':'pmt');}}
  let payload=p.subarray(offset);const start=!!(p[1]&64);
  if(pid===this.pids.audio){if(start){this.flushAudio();this.audioStarted=true;this.mark('audioPes');}if(this.audioStarted){this.audio.push(Buffer.from(payload));this.audioBytes+=payload.length;if(this.audioBytes>65542){this.flushAudio(true);this.audioStarted=false;}}}
  if(pid===this.pids.video){if(start&&payload.subarray(0,3).equals(Buffer.from([0,0,1]))){this.mark('videoPes');payload=payload.subarray(Math.min(payload.length,9+payload[8]));}const data=Buffer.concat([this.tail,payload]);for(let i=0;i+6<=data.length;i++){if(data[i]||data[i+1]||data[i+2]!==1)continue;if(data[i+3]===179)this.mark('sequence');if(data[i+3]===184)this.mark('gop');if(data[i+3]===0&&((data[i+5]>>3)&7)===1)this.mark('iPicture');}this.tail=Buffer.from(data.subarray(-8));}
 }
 finish(){this.flushAudio(true);return {counts:this.counts,first:this.first,maxPcrGapMs:this.maxPcrGapMs,maxAudioPtsErrorMs:this.maxAudioPtsErrorMs,events:this.events,eventsTruncated:this.events.length===2000,scope:'Selected interval; audio boundary PES excluded; I-picture alone does not prove a decodable random access point; not receiver evidence'};}
}
