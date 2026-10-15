import {selectCompatiblePictures} from './cadence-normalization.js';

/** Diagnostic attribution, not a timing-policy change. Counterfactual grid is only a hypothesis. */
export function auditCadenceQuantization(pts:number[],minimumTicks:number,trackTimebaseSeconds:number){
 const plan=selectCompatiblePictures(pts,minimumTicks),histogram:Record<string,number>={},drops={short16to17ms:0,quantized33ms:0,other:0};
 const category=(delta:number)=>delta>=1440&&delta<=1620?'short16to17ms':delta===2970?'quantized33ms':'other';
 for(let i=1;i<pts.length;i++){const delta=pts[i]-pts[i-1];histogram[String(delta)]=(histogram[String(delta)]??0)+1;}
 for(const d of plan.dropped)drops[category(pts[d.index]-pts[d.index-1])]++;
 const quantum=trackTimebaseSeconds*90000,grid=90000*1001/60000;
 // Establish whether all source PTS can be explained as a quantized 59.94 timing grid.
 const reconstructed=pts.map(t=>pts[0]+Math.round((t-pts[0])/grid)*grid);
 const errors=reconstructed.map((t,i)=>Math.abs(t-pts[i]));
 const maxError=Math.max(...errors),consistent=maxError<=quantum/2+1&&reconstructed.every((t,i)=>!i||t>reconstructed[i-1]);
 let hypothetical:unknown;
 if(consistent){const timing=reconstructed.map(Math.round),p=selectCompatiblePictures(timing,minimumTicks),kept=new Set(p.retained.map(v=>v.index));
  hypothetical={grid:'60000/1001 tick hypothesis; not validated source reconstruction',maxPtsErrorTicks:maxError,
   retained:p.retained.length,dropped:p.dropped.length,recoveredOriginalDrops:plan.dropped.filter(d=>kept.has(d.index)).length,
   newlyDropped:p.dropped.filter(d=>!plan.dropped.some(o=>o.index===d.index)).length};}
 return {sourceFrames:pts.length,retained:plan.retained.length,dropped:plan.dropped.length,minimumTicks,minimumMs:minimumTicks/90,
  trackTimebaseSeconds,sourceIntervalHistogramTicks:histogram,droppedByImmediateSourceInterval:drops,
  shortIntervalCount:Object.entries(histogram).filter(([d])=>category(Number(d))==='short16to17ms').reduce((n,[,c])=>n+c,0),
  quantized33msCount:histogram['2970']??0,quantized33msDeficitTicks:minimumTicks-2970,
  gridHypothesis:{consistent,maxPtsErrorTicks:maxError,halfQuantumTicks:quantum/2,counterfactual:hypothetical},
  caveat:'Drop attribution follows immediate source interval, not proof of underlying cadence. No source or output timestamps changed.'};
}
