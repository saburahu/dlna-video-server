import {createRequire} from "node:module";
import {patchFixedFrameRateTts} from "./experimental-vui.js";
import type {ExperimentalMediaConfig} from "./experimental-media.js";
export function jpJitterConfig(b:ExperimentalMediaConfig,file:string,udn:string):ExperimentalMediaConfig{
 if(b.videoTreatment!=="progressive-reference"||b.videoEncoder!=="libx264"||!b.timeSeek||!b.contentPacket||b.contentPacketBlockBytes!==5568||b.dlnaProfile!==undefined||b.audioTreatment!=="mpeg2-aac-lc"||(b.pcrLeadMs??1100)!==1100)throw new Error("Audited CFR baseline required");
 return {...b,file,port:19103,udn,title:"【JP低密度人工VFR】サンプル映像A・150秒",videoTreatment:"vfr-idr"};
}
export function jpBurstConfig(b:ExperimentalMediaConfig,file:string,udn:string):ExperimentalMediaConfig{
 return {...jpJitterConfig(b,file,udn),port:19104,title:"【JP高密度人工VFR】サンプル映像A・150秒"};
}
export function jpClockControlConfig(b:ExperimentalMediaConfig,file:string,udn:string):ExperimentalMediaConfig{
 return {...jpJitterConfig(b,file,udn),port:19105,title:"【JP低密度HRD時計対照E】サンプル映像A・150秒"};
}
export function jpDistributedBurstConfig(b:ExperimentalMediaConfig,file:string,udn:string):ExperimentalMediaConfig{
 return {...jpJitterConfig(b,file,udn),port:19106,title:"【JP分散GOP burst D2】サンプル映像A・150秒"};
}
const Packet=createRequire(import.meta.url)("aribts/lib/packet") as new(b:Buffer)=>{decode():{PID:number;payload_unit_start_indicator:number;data_byte?:Buffer}};
/** Half-open moving windows, not calendar-second buckets. */
export function pictureWindows(pts:number[]){
 if(!pts.length||pts.some((p,i)=>!Number.isSafeInteger(p)||(i>0&&p<=pts[i-1])))throw new Error("Ordered PTS required");
 return Object.fromEntries([100,250,500,1000].map(ms=>{let left=0,max=0;for(let right=0;right<pts.length;right++){while(pts[right]-pts[left]>=ms*90)left++;max=Math.max(max,right-left+1);}return [ms,max];}));
}
export function jitterOffset(index:number,count:number){return index%2&&index!==count-1?-1502:0;}
function rbspMap(nal:Buffer){const offsets:number[]=[];for(let i=0;i<nal.length;i++){if(i>=2&&nal[i]===3&&nal[i-1]===0&&nal[i-2]===0)continue;offsets.push(i);}return offsets;}
function readBits(b:Buffer,offsets:number[],start:number,length:number){let n=0;for(let k=0;k<length;k++){const pos=start+k;if(offsets[pos>>3]===undefined)throw new Error("Truncated syntax");n=n*2+((b[offsets[pos>>3]]>>(7-pos%8))&1);}return n;}
function putBits(b:Buffer,offsets:number[],start:number,length:number,value:number){for(let k=0;k<length;k++){const pos=start+k,mask=1<<(7-pos%8),at=offsets[pos>>3];b[at]=(b[at]&~mask)|((Math.floor(value/2**(length-k-1))%2)?mask:0);}}
function ptsValue(b:Buffer){return (b[0]>>1&7)*2**30+b[1]*2**22+(b[2]>>1)*2**15+b[3]*2**7+(b[4]>>1);}
function setPts(b:Buffer,n:number){b[0]=(b[0]&0xf0)|((Math.floor(n/2**30)&7)<<1)|1;b[1]=Math.floor(n/2**22)&255;b[2]=((Math.floor(n/2**15)&127)<<1)|1;b[3]=Math.floor(n/2**7)&255;b[4]=((n&127)<<1)|1;}
export interface PictureRetimePlan{offsets:number[];removalDelays:number[];spsFields:{start:number;length:number;value:number}[]}
/** Re-escape RBSP, then use legal Annex-B trailing_zero_8bits only when shorter.
 * Refuse expansion: no adjacent NAL, AU length or TS placement is changed. */
function repackSameSize(nal:Buffer,plain:Buffer){const a:number[]=[];let zeros=0;for(const v of plain){if(zeros>=2&&v<=3){a.push(3);zeros=0;}a.push(v);zeros=v===0?zeros+1:0;}if(a.length>nal.length)throw new Error("Clock edit expands NAL; cannot preserve AU size");return Buffer.concat([Buffer.from(a),Buffer.alloc(nal.length-a.length)]);}
/** Audited A only: B0, one video PES/AUD/picture-timing per frame, fixed SPS clock.
 * In-place byte edits preserve slices, packet positions, PCR, TTS and every AU size.
 * C refuses escape-layout changes; the exact-clock plan permits shorter NALs
 * with Annex-B trailing zeros, but refuses expansion. */
export function patchLowDensityJitter(input:Buffer,pid:number,count:number,sps:Buffer,fixedBit:number,removalBits:number,plan?:PictureRetimePlan){
 if(count!==4496||removalBits!==15)throw new Error("Audited 4496-frame/15-bit A required");
 if(plan&&(plan.offsets.length!==count||plan.removalDelays.length!==count||plan.offsets.some(v=>!Number.isSafeInteger(v))||plan.removalDelays.some(v=>!Number.isInteger(v)||v<0||v>=2**19)))throw new Error("Invalid exact retime plan");
 const {output}=patchFixedFrameRateTts(input,pid,sps,fixedBit),units:{header:number;chunks:Buffer[];spans:{start:number;end:number;file:number}[];length:number}[]=[];let unit:typeof units[number]|undefined;
 for(let at=0;at<output.length;at+=192){const p=new Packet(output.subarray(at+4,at+192)).decode();if(p.PID!==pid||!p.data_byte?.length)continue;let d=p.data_byte,file=at+192-d.length;
  if(p.payload_unit_start_indicator){const flags=d[7]>>6;if(d.length<14||d[0]||d[1]||d[2]!==1||![2,3].includes(flags)||d[8]<(flags===3?10:5))throw new Error("Audited timestamped video PES required");unit={header:file,chunks:[],spans:[],length:0};units.push(unit);const skip=9+d[8];d=d.subarray(skip);file+=skip;}
  if(!unit)throw new Error("Partial video PES");unit.spans.push({start:unit.length,end:unit.length+d.length,file});unit.chunks.push(d);unit.length+=d.length;
 }
 if(units.length!==count)throw new Error("One PES per decoded picture required");let modified=0;
 for(const [i,u]of units.entries()){
  const delta=plan?plan.offsets[i]:jitterOffset(i,count),p=output.subarray(u.header+9,u.header+14),d=(output[u.header+7]>>6)===3?output.subarray(u.header+14,u.header+19):undefined;if(d&&ptsValue(p)!==ptsValue(d))throw new Error("B0 PTS=DTS required");if(delta){setPts(p,ptsValue(p)+delta);if(d)setPts(d,ptsValue(d)+delta);}
  const es=Buffer.concat(u.chunks),starts:{start:number;prefix:number}[]=[];
  for(let at=0;at<es.length-3;){const prefix=es[at]===0&&es[at+1]===0?(es[at+2]===1?3:es[at+2]===0&&es[at+3]===1?4:0):0;if(prefix){starts.push({start:at,prefix});at+=prefix+1;}else at++;}
  let aud=0,timing=0;
  const writeNal=(start:number,nal:Buffer,patched:Buffer)=>{for(let k=0;k<nal.length;k++)if(nal[k]!==patched[k]){const pos=start+k,s=u.spans.find(s=>s.start<=pos&&pos<s.end);if(!s)throw new Error("NAL mapping failed");output[s.file+pos-s.start]=patched[k];}};
  for(let j=0;j<starts.length;j++){const n=starts[j],start=n.start+n.prefix,end=starts[j+1]?.start??es.length,nal=es.subarray(start,end);if((nal[0]&31)===9)aud++;if(plan&&(nal[0]&31)===7){const map=rbspMap(nal),plain=Buffer.from(map.map(o=>nal[o])),identity=Array.from(plain,(_,k)=>k);for(const f of plan.spsFields)putBits(plain,identity,f.start,f.length,f.value);writeNal(start,nal,repackSameSize(nal,plain));}if((nal[0]&31)!==6)continue;
   const offsets=rbspMap(nal),plain=Buffer.from(offsets.map(o=>nal[o]));let cursor=1;
   while(cursor<plain.length&&plain[cursor]!==0x80){let type=0,size=0;while(plain[cursor]===255){type+=255;cursor++;}type+=plain[cursor++];while(plain[cursor]===255){size+=255;cursor++;}size+=plain[cursor++];if(cursor+size>plain.length)throw new Error("Broken SEI");
    if(type===1){timing++;const bit=cursor*8,old=readBits(nal,offsets,bit,removalBits);if(readBits(nal,offsets,bit+removalBits,5)!==0)throw new Error("DPB output delay must be zero");if(plan){const identity=Array.from(plain,(_,k)=>k);putBits(plain,identity,bit,19,plan.removalDelays[i]);putBits(plain,identity,bit+19,1,0);writeNal(start,nal,repackSameSize(nal,plain));modified++;}else if(delta){if(old<1)throw new Error("Invalid HRD decrement");const patched=Buffer.from(nal);putBits(patched,offsets,bit,removalBits,old-1);
      for(let k=2;k<patched.length;k++){if(patched[k-2]===0&&patched[k-1]===0&&patched[k]<=2)throw new Error("SEI patch needs emulation prevention rewrite");if(patched[k-2]===0&&patched[k-1]===0&&patched[k]===3&&(k+1>=patched.length||patched[k+1]>3))throw new Error("Invalid emulation prevention layout");}
      for(let k=0;k<nal.length;k++)if(nal[k]!==patched[k]){const pos=start+k,s=u.spans.find(s=>s.start<=pos&&pos<s.end);if(!s)throw new Error("SEI mapping failed");output[s.file+pos-s.start]=patched[k];}modified++;
    }}cursor+=size;
   }
  }if(aud!==1||timing!==1)throw new Error("One AUD and timing SEI per PES required");
 }
 return {output,frames:units.length,changedPictures:modified,encodedSlicesUnchanged:true,pcrTtsAndPacketPositionsUnchanged:true};
}
