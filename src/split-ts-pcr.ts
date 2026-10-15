import {readPcr} from './core.js';
import {sectionCrc} from './arib-metadata.js';

/** Bounded diagnostic transform, not a production remuxer. PES bytes and PCR values stay unchanged. */
export class PcrPidSplitter {
 clocks=0;pmts=0;
 constructor(private pmtPid:number,private pcrPid:number,private targetPid:number){
 if(![pmtPid,pcrPid,targetPid].every(p=>Number.isInteger(p)&&p>=32&&p<8191)||new Set([pmtPid,pcrPid,targetPid]).size!==3)throw Error('Distinct non-reserved PIDs required');
 }
 push(original:Buffer){
  if(original.length!==188)throw Error('Complete TS packet required');
  const {pmtPid,pcrPid,targetPid}=this,p=Buffer.from(original),output:Buffer[]=[];
  if(p[0]!==0x47||(p[1]&128)||(p[3]&192))throw Error('Invalid/scrambled TS');
  const pid=((p[1]&31)<<8)|p[2],af=(p[3]>>4)&3,start=af&2?5+p[4]:4;
  if(!af||start>188)throw Error('Invalid adaptation field');
  if(pid===targetPid)throw Error('Target PCR PID already used');
  if(pid===pmtPid){
   // This diagnostic deliberately rejects split/multiple PMT sections rather than rewriting blindly.
   if(!(p[1]&64)||!(af&1)||start>=188)throw Error('Single-packet PMT required');
   const offset=start+1+p[start],sectionBytes=offset+3<=188?3+((p[offset+1]&15)<<8)+p[offset+2]:0;
   if(!sectionBytes||offset+sectionBytes>188||p[offset]!==2)throw Error('Complete PMT required');
   const section=p.subarray(offset,offset+sectionBytes);
   if(sectionCrc(section)!==0||(((section[8]&31)<<8)|section[9])!==pcrPid)throw Error('Unexpected PMT PCR/CRC');
   section[5]=(section[5]&0xc1)|((((section[5]>>1)+1)&31)<<1);
   section[8]=0xe0|(targetPid>>8);section[9]=targetPid&255;
   section.writeUInt32BE(sectionCrc(section.subarray(0,-4)),section.length-4);
   if(sectionCrc(section)!==0)throw Error('PMT CRC rewrite failed');this.pmts++;
  }
  const clock=readPcr(p,0);
  if(clock!==null){
   if(pid!==pcrPid)throw Error('Unexpected second PCR source');
   const dedicated=Buffer.alloc(188,255);dedicated[0]=0x47;dedicated[1]=targetPid>>8;dedicated[2]=targetPid&255;
   dedicated[3]=0x20;dedicated[4]=183;dedicated[5]=0x10|(p[5]&0x80);
   p.copy(dedicated,6,6,12);output.push(dedicated);this.clocks++;
   // Keep payload offset, CC, RAI and any later adaptation fields; replace removed PCR with stuffing.
   p[5]&=~0x10;p.copyWithin(6,12,start);p.fill(255,start-6,start);
  }
  output.push(p);
  return output;
 }
 finish(){if(!this.clocks||!this.pmts)throw Error('Missing PCR/PMT');return {clocks:this.clocks,pmts:this.pmts,insertedPackets:this.clocks,oldPid:this.pcrPid,newPid:this.targetPid};}
}
export async function* splitPcrPackets(input:AsyncIterable<Buffer>,pmtPid:number,pcrPid:number,targetPid:number){
 const splitter=new PcrPidSplitter(pmtPid,pcrPid,targetPid);
 for await(const packet of input)yield* splitter.push(packet);
 splitter.finish();
}
export function splitTsPcr(input:Buffer,pmtPid:number,pcrPid:number,targetPid:number){
 if(!input.length||input.length%188||input.length>128*1024*1024)throw Error('Bounded aligned TS required');
 const splitter=new PcrPidSplitter(pmtPid,pcrPid,targetPid),output:Buffer[]=[];
 for(let at=0;at<input.length;at+=188)output.push(...splitter.push(input.subarray(at,at+188)));
 return {bytes:Buffer.concat(output),...splitter.finish()};
}
