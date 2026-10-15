/** Bounded diagnostic parser, not a complete ISO/IEC 13818-1 conformance checker. */
export function auditProgramStream(data:Buffer){
 let pos=0;const errors:string[]=[],packs:{offset:number;syntax:string;scr:number;muxBitsPerSecond:number}[]=[],systems:any[]=[],streams=new Map<number,any>();let ends=0;
 function bits(offset:number){let bit=offset*8;return (n:number)=>{let value=0;for(let i=0;i<n;i++){if(bit>=data.length*8)throw Error('Truncated bit field');value=value*2+((data[bit>>3]>>(7-(bit&7)))&1);bit++;}return value;};}
 function timestamp(offset:number){const b=bits(offset);b(4);const a=b(3);if(b(1)!==1)errors.push(`PTS marker at ${offset}`);const c=b(15);if(b(1)!==1)errors.push(`PTS marker at ${offset}`);const d=b(15);if(b(1)!==1)errors.push(`PTS marker at ${offset}`);return a*2**30+c*2**15+d;}
 while(pos<data.length){
  if(pos+4>data.length||data.readUIntBE(pos,3)!==1){errors.push(`No system start code at ${pos}`);break;}
  const id=data[pos+3];
  if(id===0xb9){ends++;pos+=4;continue;}
  if(id===0xba){const b=bits(pos+4),mpeg2=(data[pos+4]&0xc0)===0x40;let prefix=b(mpeg2?2:4);if(prefix!==(mpeg2?1:2)){errors.push(`Invalid pack prefix at ${pos}`);break;}const a=b(3);if(b(1)!==1)errors.push(`SCR marker at ${pos}`);const c=b(15);if(b(1)!==1)errors.push(`SCR marker at ${pos}`);const d=b(15);if(b(1)!==1)errors.push(`SCR marker at ${pos}`);let extension=0;if(mpeg2){extension=b(9);if(b(1)!==1)errors.push(`SCR extension marker at ${pos}`);}else if(b(1)!==1)errors.push(`Mux marker at ${pos}`);const mux=b(22);if(b(1)!==1)errors.push(`Mux marker at ${pos}`);let stuffing=0;if(mpeg2){if(b(1)!==1)errors.push(`Mux marker at ${pos}`);b(5);stuffing=b(3);}packs.push({offset:pos,syntax:mpeg2?'mpeg2':'mpeg1',scr:(a*2**30+c*2**15+d)/90000+extension/27000000,muxBitsPerSecond:mux*400});pos+=(mpeg2?14+stuffing:12);continue;}
  if(pos+6>data.length){errors.push(`Truncated packet at ${pos}`);break;}const length=data.readUInt16BE(pos+4),end=pos+6+length;if(end>data.length||!length){errors.push(`Invalid bounded packet length at ${pos}`);break;}
  if(id===0xbb){if(length<6){errors.push(`Short system header at ${pos}`);}else {const b=bits(pos+6);if(b(1)!==1)errors.push(`System marker at ${pos}`);const rateBound=b(22);if(b(1)!==1)errors.push(`System marker at ${pos}`);const audioBound=b(6),fixed=b(1),csps=b(1),audioLock=b(1),videoLock=b(1);if(b(1)!==1)errors.push(`System marker at ${pos}`);const videoBound=b(5);b(8);const bounds=[];for(let i=pos+12;i+2<end;i+=3){const scale=(data[i+1]>>5)&1,size=((data[i+1]&31)<<8)|data[i+2];bounds.push({streamId:'0x'+data[i].toString(16),scale,bufferBytes:size*(scale?1024:128)});}systems.push({offset:pos,length,rateBoundBitsPerSecond:rateBound*400,audioBound,videoBound,fixed,csps,audioLock,videoLock,bounds,hex:data.subarray(pos+6,end).toString('hex')});}}
  else if(id>=0xc0&&id<=0xef){let p=pos+6,pts:number|undefined,dts:number|undefined;const mpeg2=(data[p]&0xc0)===0x80;
   if(mpeg2){const flags=data[p+1],n=data[p+2];if(flags&0x80)pts=timestamp(p+3);if((flags&0xc0)===0xc0)dts=timestamp(p+8);p+=3+n;}
   else {while(p<end&&data[p]===0xff)p++;if((data[p]&0xc0)===0x40)p+=2;const tag=data[p]>>4;if(tag===2){pts=timestamp(p);p+=5;}else if(tag===3){pts=timestamp(p);dts=timestamp(p+5);p+=10;}else if(data[p]===0x0f)p++;else errors.push(`Invalid PES timestamp prefix at ${pos}`);}
   if(p>end)errors.push(`PES header exceeds packet at ${pos}`);
   let s=streams.get(id);if(!s){s={id:'0x'+id.toString(16),firstPacket:pos,firstPayload:p,packets:0,payloadBytes:0,pesSyntax:{mpeg1:0,mpeg2:0},firstPts:pts,lastPts:pts,minPts:pts,maxPts:pts,firstDts:dts,lastDts:dts,dtsBackwards:0,sequenceHeaders:0,gops:0};streams.set(id,s);}
   s.packets++;s.pesSyntax[mpeg2?'mpeg2':'mpeg1']++;s.payloadBytes+=end-p;
   if(pts!==undefined){s.firstPts??=pts;s.lastPts=pts;s.minPts=Math.min(s.minPts??pts,pts);s.maxPts=Math.max(s.maxPts??pts,pts);}if(dts!==undefined){if(s.lastDts!==undefined&&dts<s.lastDts)s.dtsBackwards++;s.firstDts??=dts;s.lastDts=dts;}
   if(id>=0xe0)for(let i=p;i+4<end;i++)if(data[i]===0&&data[i+1]===0&&data[i+2]===1){if(data[i+3]===0xb3)s.sequenceHeaders++;if(data[i+3]===0xb8)s.gops++;}
  }
  pos=end;
 }
 return {bytes:data.length,parsedBytes:pos,errors,packCount:packs.length,packSyntax:{mpeg1:packs.filter(p=>p.syntax==='mpeg1').length,mpeg2:packs.filter(p=>p.syntax==='mpeg2').length},firstPack:packs[0],lastPack:packs.at(-1),scrBackwards:packs.filter((p,i)=>i>0&&p.scr<packs[i-1].scr).length,muxRates:[...new Set(packs.map(p=>p.muxBitsPerSecond))],systemHeaders:systems.length,firstSystemHeader:systems[0],programEndCodes:ends,streams:[...streams.values()],limits:['No complete STD/VBV or DLNA profile validation','Sequence/GOP counts omit start codes split across PES payloads','SCR wrap not unwrapped; intended for short diagnostic samples']};
}
