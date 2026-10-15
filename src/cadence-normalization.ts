/** Explicit compatibility policy, never inferred from a television name. */
export interface CadenceConstraint {codedWidth:number;codedHeight:number;maxMBPS:number;minimumFrameSeconds:number;timebase:number}
export function minimumRemovalTicks(c:CadenceConstraint){
  if(![c.codedWidth,c.codedHeight,c.maxMBPS,c.timebase].every(v=>Number.isSafeInteger(v)&&v>0)||!Number.isFinite(c.minimumFrameSeconds)||c.minimumFrameSeconds<=0)throw new Error('Invalid cadence constraint');
  const macroblocks=Math.ceil(c.codedWidth/16)*Math.ceil(c.codedHeight/16);
  return {macroblocks,minimumSeconds:Math.max(macroblocks/c.maxMBPS,c.minimumFrameSeconds),minimumTicks:Math.ceil(Math.max(macroblocks/c.maxMBPS,c.minimumFrameSeconds)*c.timebase)};
}
/** Maximum-cardinality ordered selection with the first picture retained.
 * Earliest admissible picture leaves at least as much space for every later picture.
 * Keeps original timestamps; zero duplication, no reference-AU deletion. Decode/re-encode
 * must follow selection. Assumes B0 so selected display cadence = target decode cadence. */
export function selectCompatiblePictures(pts:number[],minimumTicks:number){
  if(!pts.length||!Number.isSafeInteger(minimumTicks)||minimumTicks<=0||pts.some((p,i)=>!Number.isSafeInteger(p)||(i>0&&p<=pts[i-1])))throw new Error('Ordered integer timing and positive interval required');
  const retained:{index:number;pts:number}[]=[],dropped:{index:number;pts:number;previousRetainedIndex:number;gapTicks:number;reason:string}[]=[];
  for(let i=0;i<pts.length;i++){const previous=retained.at(-1);if(!previous||pts[i]-previous.pts>=minimumTicks)retained.push({index:i,pts:pts[i]});else dropped.push({index:i,pts:pts[i],previousRetainedIndex:previous.index,gapTicks:pts[i]-previous.pts,reason:'below-target-minimum-removal-interval'});}
  return {retained,dropped,duplicated:0};
}
