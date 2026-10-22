/** Diagnostic observations only; never an input-admission or CFR permission rule. */
export interface InspectedVideoFrame {pts_time?:string;best_effort_timestamp_time?:string;interlaced_frame?:number}
export function summarizeDecodedCadence(frames:InspectedVideoFrame[],expectedFps=24000/1001){
 const times=frames.map(f=>{const t=f.best_effort_timestamp_time??f.pts_time;return t===undefined?NaN:Number(t);});
 const intervals:number[]=[];let missing=0,duplicates=0,backwards=0;
 for(let i=0;i<times.length;i++){
  if(!Number.isFinite(times[i])){missing++;continue;}
  if(i&&!Number.isFinite(times[i-1]))continue;
  if(i){const d=times[i]-times[i-1];if(d===0)duplicates++;else if(d<0)backwards++;else intervals.push(d);}
 }
 const sorted=[...intervals].sort((a,b)=>a-b),histogram:Record<string,number>={};
 for(const d of intervals){const key=(Math.round(d*1e6)/1000).toFixed(3);histogram[key]=(histogram[key]??0)+1;}
 const fieldKnown=frames.filter(f=>f.interlaced_frame===0||f.interlaced_frame===1).length;
 const interlaced=frames.filter(f=>f.interlaced_frame===1).length;
 const cadence23976=intervals.filter(d=>Math.abs(d-1001/24000)<=.0012).length;
 const cadence2997=intervals.filter(d=>Math.abs(d-1001/30000)<=.0012).length;
 const cadence5994=intervals.filter(d=>Math.abs(d-1001/60000)<=.0012).length;
 return {frames:frames.length,first:times.find(Number.isFinite)??null,last:[...times].reverse().find(Number.isFinite)??null,
  missing,duplicates,backwards,intervals:intervals.length,medianSeconds:sorted.length?sorted[Math.floor(sorted.length/2)]:null,
  maxGapSeconds:sorted.at(-1)??null,intervalMilliseconds:histogram,fieldKnown,interlaced,cadence23976,cadence2997,cadence5994,otherBeyond5994:intervals.length-cadence23976-cadence2997-cadence5994,otherIntervals:intervals.length-cadence23976-cadence2997,
  approximately23976InWindow:intervals.length>=20&&!missing&&!duplicates&&!backwards&&intervals.every(d=>Math.abs(d-1/expectedFps)<=.0012),
  limitation:'A decoded window is not full-source CFR/progressive evidence, decoder integrity proof, receiver compatibility or permission to apply a correction'};
}
