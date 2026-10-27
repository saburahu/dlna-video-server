import assert from 'node:assert/strict';
import {SectionAssembler} from './psi-scanner.js';
import {readPcr} from './core.js';
const pts=(b:Buffer)=>((b[0]>>1)&7)*2**30+b[1]*2**22+(b[2]>>1)*2**15+b[3]*128+(b[4]>>1);
/** Offline capture inspector, not a receiver conformance or safety certificate. */
export function inspectMpeg2Startup(ts:Buffer){
 assert.ok(ts.length>0&&ts.length%188===0&&ts.length<=64*1024**2);
 const assembler=new SectionAssembler(),first:Record<number,number>={},counts:Record<number,number>={},pieces:Buffer[]=[],timestamps:{pts:number;dts:number}[]=[];let pmt:Buffer|undefined,pcr:number|undefined;
 for(let i=0;i<ts.length;i+=188){const b=ts.subarray(i,i+188);assert.equal(b[0],0x47);const pid=((b[1]&31)<<8)|b[2];first[pid]??=i/188;counts[pid]=(counts[pid]??0)+1;if(pid===256)pcr??=readPcr(b,0)??undefined;if(pid===257)for(const section of assembler.feed(b))pmt??=section;
  if(pid!==320||!(b[3]&16))continue;let o=4;if(b[3]&32)o+=1+b[4];if(o>=188)continue;if(b[1]&64){assert.equal(b.readUIntBE(o,3),1);if(b[o+7]&128){const p=pts(b.subarray(o+9,o+14)),d=b[o+7]&64?pts(b.subarray(o+14,o+19)):p;timestamps.push({pts:p,dts:d});}o+=9+b[o+8];}pieces.push(b.subarray(o));
 }
 const es=Buffer.concat(pieces),sequence:any[]=[],display:any[]=[],coding:any[]=[],gops:any[]=[],pictures:any[]=[];
 for(let i=0;i+12<=es.length;i++){if(es[i]||es[i+1]||es[i+2]!==1)continue;const b=es.subarray(i),code=b[3];
  if(code===0xb3)sequence.push({width:b[4]*16+(b[5]>>4),height:((b[5]&15)<<8)|b[6],aspectCode:b[7]>>4,frameRateCode:b[7]&15,bitRateValue:b[8]*1024+b[9]*4+(b[10]>>6),vbvSizeValue:((b[10]&31)<<5)|(b[11]>>3)});
  if(code===0xb5&&(b[4]>>4)===1)coding.push({kind:'sequence',profileLevel:((b[4]&15)<<4)|(b[5]>>4),progressive:(b[5]>>3)&1,chroma:(b[5]>>1)&3});
  if(code===0xb5&&(b[4]>>4)===2)display.push({colourDescription:!!(b[4]&1),colour:b[4]&1?[b[5],b[6],b[7]]:undefined});
  if(code===0xb5&&(b[4]>>4)===8)coding.push({kind:'picture',structure:b[6]&3,tff:(b[7]>>7)&1,framePredDct:(b[7]>>6)&1,repeatFirstField:(b[7]>>1)&1,progressive:(b[8]>>7)&1});
  if(code===0xb8)gops.push({closed:!!(b[7]&64),broken:!!(b[7]&32)});
  if(code===0)pictures.push({type:(b[5]>>3)&7,vbvDelay:((b[5]&7)<<13)|(b[6]<<5)|(b[7]>>3)});
 }
 const unique=(a:any[])=>[...new Map(a.map(v=>[JSON.stringify(v),v])).values()];
 let program:any;if(pmt){const info=((pmt[10]&15)<<8)|pmt[11],streams=[];for(let o=12+info;o<pmt.length-4;){const n=((pmt[o+3]&15)<<8)|pmt[o+4];streams.push({type:pmt[o],pid:((pmt[o+1]&31)<<8)|pmt[o+2],descriptors:pmt.subarray(o+5,o+5+n).toString('hex')});o+=5+n;}program={service:pmt.readUInt16BE(3),version:(pmt[5]>>1)&31,pcrPid:((pmt[8]&31)<<8)|pmt[9],streams};}
 const deltas=timestamps.slice(1).map((v,i)=>v.dts-timestamps[i].dts);
 return {firstPacket:first,packetCounts:counts,firstPcr:pcr,program,sequence:unique(sequence),coding:unique(coding),display:unique(display),gopCount:gops.length,firstGop:gops[0],gopVariants:unique(gops),pictureCount:pictures.length,pictureVariants:unique(pictures),firstVideo:timestamps[0],lastVideo:timestamps.at(-1),dts:{count:timestamps.length,min:deltas.length?Math.min(...deltas):undefined,max:deltas.length?Math.max(...deltas):undefined,reverse:deltas.filter(v=>v<=0).length},scope:'Bounded generated TS capture; not full T-STD or receiver acceptance'};
}

