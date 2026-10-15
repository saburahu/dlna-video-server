import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessQuantizedTiming,type TimingEligibilityInput} from '../src/quantized-timing-eligibility.js';
const base:TimingEligibilityInput={enabled:true,sourceQuantumTicks:90,sourceFingerprint:'source-size-mtime',targetPolicyFingerprint:'target-main40',
 candidate:{version:'quantized-grid-experiment-v1',originTicks:0,gridNumerator:3003,gridDenominator:2,quantumTicks:90,evidence:'clock metadata + bounded timeline'},
 clockEvidence:['HEVC VUI 1001/60000 clock; this is supporting evidence only'],
 timestamps:Array.from({length:120},(_,i)=>Math.round(i*3003/90)*90),minimumSamplePictures:64,minimumSampleSpanTicks:180000};
test('eligibility is explicit, bounded and diagnostic; existing source/target constraints unchanged',()=>{
 const r=assessQuantizedTiming(base);assert.equal(r.status,'diagnostic-candidate');
 if(r.status==='diagnostic-candidate'){assert.equal(r.policy,base.candidate);assert.ok(r.maximumCorrectionTicks<=45);assert.equal(r.requiresRuntimeFitCheck,true);assert.equal(r.midStreamFallbackAllowed,false);}
 assert.equal(assessQuantizedTiming({...base,enabled:false}).status,'original');
});
test('unknown clock, nominal-only evidence, precision mismatch and absent identity preserve original contract',()=>{
 for(const override of [{candidate:undefined},{clockEvidence:[]},{sourceQuantumTicks:3},{sourceFingerprint:''},{targetPolicyFingerprint:''}])
  assert.equal(assessQuantizedTiming({...base,...override}).status,'original');
});
test('a short evidence window never becomes permission to correct an entire source',()=>{
 assert.equal(assessQuantizedTiming({...base,timestamps:base.timestamps.slice(0,10)}).status,'incomplete');
 assert.equal(assessQuantizedTiming({...base,minimumSampleSpanTicks:99999999}).status,'incomplete');
});
test('unexplained jitter, nonmonotonic timestamps and collapsed slots fail closed',()=>{
 for(const timestamps of [[...base.timestamps.slice(0,119),357000],[...base.timestamps.slice(0,119),base.timestamps[118]],
  [0,1,...base.timestamps.slice(2)]])assert.equal(assessQuantizedTiming({...base,timestamps}).status,'original');
});
test('real short burst is preserved in eligibility evidence, not silently turned into CFR',()=>{
 const timestamps=Array.from({length:180},(_,i)=>Math.round(i*1501.5/90)*90);
 const r=assessQuantizedTiming({...base,timestamps});assert.equal(r.status,'diagnostic-candidate');
 if(r.status==='diagnostic-candidate')assert.equal(r.samplePictures,180);
});
