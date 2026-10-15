import assert from 'node:assert/strict';

/** Container timestamp quantization is not an audio sample-rate change.
 * Reject real gaps/drift before placing continuous decoded samples on their clock. */
export class JitAudioClock {
  private first?:number;
  samples=0;frames=0;maxErrorSeconds=0;
  constructor(readonly sampleRate:number,readonly toleranceSeconds:number){assert.ok(sampleRate>0&&toleranceSeconds>0&&toleranceSeconds<=.003);}
  push(seconds:number,samples:number,rate:number){
    assert.ok(Number.isFinite(seconds)&&Number.isSafeInteger(samples)&&samples>0&&rate===this.sampleRate,'Invalid source audio clock');
    this.first??=seconds;
    const error=Math.abs(seconds-(this.first+this.samples/this.sampleRate));
    this.maxErrorSeconds=Math.max(this.maxErrorSeconds,error);
    assert.ok(error<=this.toleranceSeconds+1e-6,'Source audio gap/drift exceeds timestamp quantization tolerance');
    this.samples+=samples;this.frames++;
  }
}
