/** Offline display-clock density. Half-open windows at every picture, not second bins. */
export function densitySeries(pts:number[]){
 if(!pts.length||pts.some((p,i)=>!Number.isSafeInteger(p)||(i>0&&p<=pts[i-1])))throw new Error("Strict ordered PTS required");
 const origin=pts[0],windows=Object.fromEntries([100,250,500,1000].map(ms=>{let end=0;const rows=pts.map((p,i)=>{end=Math.max(end,i);while(end<pts.length&&pts[end]-p<ms*90)end++;return {index:i,seconds:(p-origin)/90000,count:end-i};});const max=Math.max(...rows.map(r=>r.count));return [ms,{max,firstMaximumSeconds:rows.find(r=>r.count===max)!.seconds,rows}];}));
 const runs:{firstIndex:number;lastIndex:number;startSeconds:number;endSeconds:number;intervals:number;pictures:number;durationMs:number}[]=[];let first=-1;
 for(let i=1;i<=pts.length;i++){const short=i<pts.length&&pts[i]-pts[i-1]>=1490&&pts[i]-pts[i-1]<=1515;
  if(short&&first<0)first=i-1;if(!short&&first>=0){const last=i-1;runs.push({firstIndex:first,lastIndex:last,startSeconds:(pts[first]-origin)/90000,endSeconds:(pts[last]-origin)/90000,intervals:last-first,pictures:last-first+1,durationMs:(pts[last]-pts[first])/90});first=-1;}
 }
 const dense=windows[1000].rows.filter(r=>r.count>=50);const periods:{startSeconds:number;endSeconds:number;spanMs:number;maxCount:number}[]=[];
 for(const r of dense){const previous=periods.at(-1);if(previous&&r.seconds-previous.endSeconds<.06){previous.endSeconds=r.seconds;previous.spanMs=(previous.endSeconds-previous.startSeconds)*1000;previous.maxCount=Math.max(previous.maxCount,r.count);}else periods.push({startSeconds:r.seconds,endSeconds:r.seconds,spanMs:0,maxCount:r.count});}
 return {windows,shortRuns:runs,longestShortRun:[...runs].sort((a,b)=>b.intervals-a.intervals)[0],dense50WindowStartPeriods:periods};
}
/** Permute exact C deltas inside one block. No values or counts are added. */
export function clusteredTimeline(pts:number[],startInterval:number,shortCount:number,longFirst:boolean){
 if(!Number.isInteger(startInterval)||startInterval<0||!Number.isInteger(shortCount)||shortCount<1||startInterval+2*shortCount>pts.length-1)throw new Error("Invalid cluster bounds");
 const deltas=pts.slice(1).map((p,i)=>p-pts[i]),block=deltas.slice(startInterval,startInterval+2*shortCount);
 if(block.filter(v=>v===1501).length!==shortCount||block.filter(v=>v===4505).length!==shortCount)throw new Error("Balanced C interval multiset required");
 deltas.splice(startInterval,block.length,...Array(shortCount).fill(longFirst?4505:1501),...Array(shortCount).fill(longFirst?1501:4505));
 const output=[pts[0]];for(const d of deltas)output.push(output.at(-1)!+d);return output;
}
/** Audited D2: retain D's 90-short run and its PTS, spread preceding compensation.
 * 44 short->long exchanges in 15 GOPs plus the immediate boundary exchange.
 * No new frame or interval value; the complete short-run endpoints are D-exact. */
export function distributedBurstTimeline(pts:number[]){
 if(pts.length!==4496)throw new Error("Audited C frame count required");
 const deltas=pts.slice(1).map((p,i)=>p-pts[i]),start=2657,count=90;
 if(deltas.some((v,i)=>v!==(i===4494?3003:i%2?4505:1501)))throw new Error("Audited C interval order required");
 for(let i=start;i<start+count;i++)deltas[i]=1501;
 // Prevent C's preceding short interval from extending the run to 91.
 deltas[start-1]=4505;
 let exchanges=0;
 for(let gop=1740;gop<2640&&exchanges<44;gop+=60)for(const j of [10,30,50]){
  if(exchanges===44)break;deltas[gop+j]=4505;exchanges++;
 }
 const output=[pts[0]];for(const delta of deltas)output.push(output.at(-1)!+delta);return output;
}
