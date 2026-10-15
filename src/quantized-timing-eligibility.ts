import {reconstructTimestamp,validateQuantizedPolicy,type QuantizedTimingPolicy} from './quantized-timing.js';

/** Proposal gate only. Does not change catalog, decision, decoder or DMS policy.
 * A supplied candidate grid must come from independent clock evidence, never
 * from filename, machine model, average fps or drop-rate optimization. */
export interface TimingEligibilityInput {
  enabled: boolean;
  sourceQuantumTicks: number;
  sourceFingerprint: string;
  targetPolicyFingerprint: string;
  candidate?: QuantizedTimingPolicy;
  clockEvidence: string[];
  timestamps: readonly number[];
  minimumSamplePictures: number;
  minimumSampleSpanTicks: number;
}
export function assessQuantizedTiming(input: TimingEligibilityInput) {
  const reasons:string[]=[],unknowns=['The inferred grid is not proof of the original mastering timestamps.'];
  const fallback='original-pts-greedy-v1' as const;
  const reject=(reason:string)=>({status:'original' as const,fallback,reasons:[reason],unknowns});
  if(!input.enabled)return reject('Quantization reconstruction is disabled; preserve existing timing policy.');
  if(!input.candidate)return reject('No independently evidenced candidate clock.');
  if(!input.sourceFingerprint||!input.targetPolicyFingerprint)return reject('Missing source or target identity.');
  if(!input.clockEvidence.length)return reject('Average or nominal fps alone cannot authorize reconstruction.');
  try{validateQuantizedPolicy(input.candidate);}catch{return reject('Invalid candidate policy.');}
  if(input.sourceQuantumTicks!==input.candidate.quantumTicks)return reject('Candidate quantum differs from source timestamp precision.');
  if(!Number.isSafeInteger(input.minimumSamplePictures)||input.minimumSamplePictures<2||
     !Number.isSafeInteger(input.minimumSampleSpanTicks)||input.minimumSampleSpanTicks<=0)return reject('Invalid bounded evidence window requirement.');
  if(input.timestamps.length<input.minimumSamplePictures||
     input.timestamps.at(-1)!-input.timestamps[0]<input.minimumSampleSpanTicks)
    return {status:'incomplete' as const,fallback,reasons:['Insufficient bounded timestamp evidence; do not enable reconstruction.'],unknowns};
  let previousOriginal:number|undefined,previousOutput:number|undefined,maximumCorrectionTicks=0;
  try{
    for(const pts of input.timestamps){
      const reconstructed=reconstructTimestamp(pts,input.candidate);
      if(previousOriginal!==undefined&&pts<=previousOriginal)throw new Error('Non-monotonic original timeline');
      if(previousOutput!==undefined&&reconstructed.pts<=previousOutput)throw new Error('Distinct pictures collapse onto one grid slot');
      previousOriginal=pts;previousOutput=reconstructed.pts;
      maximumCorrectionTicks=Math.max(maximumCorrectionTicks,Math.abs(reconstructed.correctionTicks));
    }
  }catch(e){return reject(`Quantization model rejected: ${String(e)}`);}
  reasons.push('All sampled original timestamps fit the independently supplied absolute clock within half the source quantum.');
  return {status:'diagnostic-candidate' as const,fallback,policy:input.candidate,
    sourceFingerprint:input.sourceFingerprint,targetPolicyFingerprint:input.targetPolicyFingerprint,
    evidence:[...input.clockEvidence],samplePictures:input.timestamps.length,
    sampleStartTicks:input.timestamps[0],sampleEndTicks:input.timestamps.at(-1)!,
    maximumCorrectionTicks,requiresRuntimeFitCheck:true as const,
    midStreamFallbackAllowed:false as const,reasons,unknowns};
}
