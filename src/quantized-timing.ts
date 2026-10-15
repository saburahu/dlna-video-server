import assert from 'node:assert/strict';
import {selectCompatiblePictures} from './cadence-normalization.js';

/** Explicit inferred experiment, never inferred from codec, filename or average fps.
 * The grid permits skipped slots (real VFR/bursts); it does not generate pictures.
 * Original integer PTS remain the authoritative source/cache timestamps. */
export interface QuantizedTimingPolicy {
  version: 'quantized-grid-experiment-v1';
  originTicks: number;
  gridNumerator: number;
  gridDenominator: number;
  quantumTicks: number;
  evidence: string;
}
export function validateQuantizedPolicy(p: QuantizedTimingPolicy) {
  assert.equal(p.version, 'quantized-grid-experiment-v1');
  assert.ok(Number.isSafeInteger(p.originTicks));
  for (const n of [p.gridNumerator,p.gridDenominator,p.quantumTicks]) assert.ok(Number.isSafeInteger(n)&&n>0);
  assert.ok(p.gridNumerator/p.gridDenominator>p.quantumTicks*2&&p.evidence.length>0);
}
/** Absolute-grid rounding, not accumulation: correction cannot grow with duration.
 * Reject unexplained timestamps rather than switching timeline during a stream. */
export function reconstructTimestamp(original: number,p: QuantizedTimingPolicy) {
  validateQuantizedPolicy(p);assert.ok(Number.isSafeInteger(original));
  const slot=Math.round((original-p.originTicks)*p.gridDenominator/p.gridNumerator);
  const exact=p.originTicks+slot*p.gridNumerator/p.gridDenominator;
  assert.ok(Math.abs(exact-original)<=p.quantumTicks/2+1e-7,'Timestamp does not fit approved quantization model');
  const pts=Math.round(exact);assert.ok(Number.isSafeInteger(pts));
  return {original,pts,slot,correctionTicks:pts-original,exactCorrectionTicks:exact-original};
}
export interface QuantizedState {previousOriginal?:number;previousOutput?:number;lastRetained?:number;nextIndex:number}
/** O(1) state. Checkpoints must include policy identity and source fingerprint externally. */
export class QuantizedSelection {
  state: QuantizedState;
  constructor(public policy:QuantizedTimingPolicy,public minimumTicks:number,state?:QuantizedState){
    validateQuantizedPolicy(policy);assert.ok(Number.isSafeInteger(minimumTicks)&&minimumTicks>0);
    this.state={...(state??{nextIndex:0})};
    assert.ok(Number.isSafeInteger(this.state.nextIndex)&&this.state.nextIndex>=0);
    for(const t of [this.state.previousOriginal,this.state.previousOutput,this.state.lastRetained])assert.ok(t===undefined||Number.isSafeInteger(t));
    assert.ok(this.state.lastRetained===undefined||this.state.previousOutput!==undefined&&this.state.lastRetained<=this.state.previousOutput);
  }
  push(original:number){
    const t=reconstructTimestamp(original,this.policy),s=this.state;
    assert.ok(s.previousOriginal===undefined||original>s.previousOriginal);
    assert.ok(s.previousOutput===undefined||t.pts>s.previousOutput,'Grid collapses distinct pictures');
    const gap=s.lastRetained===undefined?undefined:t.pts-s.lastRetained;
    const retained=gap===undefined||gap>=this.minimumTicks;
    const result={...t,index:s.nextIndex++,retained,lastRetainedPTS:s.lastRetained,gapTicks:gap,
      deficitTicks:gap===undefined?0:Math.max(0,this.minimumTicks-gap)};
    s.previousOriginal=original;s.previousOutput=t.pts;if(retained)s.lastRetained=t.pts;
    return result;
  }
}
export function compareQuantizedTiming(original:number[],minimum:number,policy:QuantizedTimingPolicy){
  const a=selectCompatiblePictures(original,minimum),selector=new QuantizedSelection(policy,minimum);
  const rows=original.map(t=>selector.push(t)),b=selectCompatiblePictures(rows.map(r=>r.pts),minimum);
  const keptA=new Set(a.retained.map(r=>r.index)),keptB=new Set(b.retained.map(r=>r.index));
  const drops=a.dropped.map(d=>{
    const previous=original[d.previousRetainedIndex],immediate=d.index?original[d.index]-original[d.index-1]:0;
    const samePairGap=rows[d.index].pts-rows[d.previousRetainedIndex].pts;
    return {...d,lastRetainedPTS:previous,immediateIntervalTicks:immediate,deficitTicks:minimum-d.gapTicks,
      reconstructedSamePairGap:samePairGap,
      classification:samePairGap>=minimum?'model-resolves-same-pair-deficit':'short-removal-still-required-under-model',
      retainedByB:keptB.has(d.index)};
  });
  return {a,b,rows,drops,recovered:a.dropped.filter(d=>keptB.has(d.index)).length,
    newlyDropped:b.dropped.filter(d=>keptA.has(d.index)).length,
    maximumCorrectionTicks:rows.reduce((max,r)=>Math.max(max,Math.abs(r.correctionTicks)),0)};
}
/** No fps filter. Convert timebase before round to avoid re-quantizing to milliseconds. */
export function reconstructionFilter(p:QuantizedTimingPolicy){
  validateQuantizedPolicy(p);
  return `settb=1/90000,setpts='round(${p.originTicks}+round((PTS-${p.originTicks})*${p.gridDenominator}/${p.gridNumerator})*${p.gridNumerator}/${p.gridDenominator})'`;
}
/** Input timebase is explicitly gated to 1/1000 by the isolated executor.
 * Read integer PTS, not formatted pts_time, which may lose precision at long NPT.
 * Anchor the video tag to avoid mistaking interleaved ashowinfo audio for video. */
export function quantizedVideoTimestamp(line:string){
  const m=/\[Parsed_showinfo_\d+[^\]]*\]\s*n:\s*\d+\s+pts:\s*([-\d]+)\s+pts_time:/.exec(line);
  return m?Number(m[1])*90:undefined;
}
