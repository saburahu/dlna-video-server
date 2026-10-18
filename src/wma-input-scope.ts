/** Input execution evidence, independent of receiver/output compatibility.
 * v1 retains its published WMA v2 scope. v2 is explicit opt-in after real
 * ASF source-clock/Seek/EOF checks; wmav1 has no real-source evidence yet. */
export type WmaInputPolicy='source-clock-v1'|'source-clock-v2';
export function wmaInputAllowed(codec:string,rate:number,channels:number,layout:string|undefined,policy:WmaInputPolicy|undefined,videoCodec:string){
 if(!/^wma/.test(codec))return true;
 if(!policy)return false;
 if(codec==='wmav2')return policy==='source-clock-v1'||policy==='source-clock-v2';
 if(policy!=='source-clock-v2')return false;
 // Lossless sample decodes but its source PTS regress; endpoint validation
 // cannot certify tail Seek. Do not hide this by rewriting its source clock.
 // A real 5.1 sample has no retained video at its advertised tail Seek.
 // Keep that configuration excluded until the source endpoint contract is resolved.
 // VC-1/WMA Pro passes finite segments but fails full EOF coverage (71 ms).
 if(codec==='wmapro')return videoCodec==='wmv3'&&[44100,48000].includes(rate)&&channels===2;
 return false;
}
