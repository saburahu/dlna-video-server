/** Samples local queued data. No claim of TCP ACK, NIC transmission or decoder consumption. */
export class TransferStallSampler {
 private previous:{at:number;bytes:number;queued:number}|undefined;private run=0;
 readonly result={samples:0,maxSampleIntervalMs:0,maxObservedQueuedNoProgressMs:0,maxQueuedBytes:0};
 sample(at:number,bytes:number,queued:number){const p=this.previous;this.result.samples++;this.result.maxQueuedBytes=Math.max(this.result.maxQueuedBytes,queued);
  if(p){const delta=at-p.at;this.result.maxSampleIntervalMs=Math.max(this.result.maxSampleIntervalMs,delta);this.run=delta>=0&&bytes===p.bytes&&queued>0&&p.queued>0?this.run+delta:0;this.result.maxObservedQueuedNoProgressMs=Math.max(this.result.maxObservedQueuedNoProgressMs,this.run);}
  this.previous={at,bytes,queued};
 }
}
