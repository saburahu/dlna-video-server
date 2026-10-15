import test from 'node:test';import assert from 'node:assert/strict';
import {TsStabilityAudit} from '../src/ts-stability-audit.js';
import {TransferStallSampler} from '../src/transfer-stall-sampler.js';
const packet=(pid:number,cc:number,payload=Buffer.alloc(184,255))=>{const b=Buffer.alloc(188,255);b[0]=71;b[1]=(pid>>8)&31;b[2]=pid&255;b[3]=16|cc;payload.copy(b,4);return b;};
const audit=()=>new TsStabilityAudit({video:256,audio:320,pcr:256,pmt:100});
test('CC wrap, exact duplicates, independent PID counters, gaps and signalled resets',()=>{
 const a=audit();const p=packet(256,15);a.feed(p,0);a.feed(p,1);a.feed(packet(320,8),2);a.feed(packet(256,0),3);a.feed(packet(256,2),4);
 const reset=packet(256,7);reset[3]=55;reset[4]=1;reset[5]=128;a.feed(reset,5);a.feed(packet(256,8),6);
 const r=a.finish();assert.equal(r.counts.duplicates,1);assert.equal(r.counts.ccErrors,1);assert.equal(r.counts.signalledDiscontinuities,1);
});
test('MPEG-2 startup markers across packet boundary and malformed packets are diagnosed',()=>{
 const a=audit(),p=packet(256,0);p.set([0,0],186);const q=packet(256,1);q.set([1,179,0,0,0,0,1,184,0,0,0,0,1,0,0,8],4);a.feed(p,10);a.feed(q,11);a.feed(Buffer.alloc(188),12);const r=a.finish();assert.equal(r.first.sequence,11);assert.equal(r.first.gop,11);assert.equal(r.first.iPicture,11);assert.equal(r.counts.malformed,1);
});
test('Short stall sampling separates queued no-progress from producer idle and accounts for sample delay',()=>{
 const s=new TransferStallSampler();s.sample(0,0,0);s.sample(100,100,10);s.sample(200,100,10);s.sample(300,100,10);s.sample(400,200,0);s.sample(900,200,0);
 assert.equal(s.result.maxObservedQueuedNoProgressMs,200);assert.equal(s.result.maxSampleIntervalMs,500);assert.equal(s.result.maxQueuedBytes,10);
});
test('AAC ADTS spanning PES is not corruption; a genuine PTS gap is detected',()=>{
 const a=audit(),frame=Buffer.from([255,249,76,128,1,31,252,0]);
 const timestamp=(t:number)=>Buffer.from([0x21|((Math.floor(t/2**30)&7)<<1),Math.floor(t/2**22)&255,((Math.floor(t/2**15)&127)<<1)|1,Math.floor(t/128)&255,((t&127)<<1)|1]);
 const pes=(data:Buffer,time:number)=>{const h=Buffer.from([0,0,1,192,0,0,128,128,5]);h.writeUInt16BE(data.length+8,4);return Buffer.concat([h,timestamp(time),data]);};
 const feed=(data:Buffer,cc:number)=>{const p=packet(320,cc);p[1]|=64;p[3]|=32;p[4]=183-data.length;p[5]=0;data.copy(p,5+p[4]);a.feed(p,cc);};
 feed(pes(frame.subarray(0,4),0),0);feed(pes(Buffer.concat([frame.subarray(4),frame]),1920),1);feed(pes(frame,93840),2);feed(pes(frame,95760),3);
 const r=a.finish();assert.equal(r.counts.audioFrames,3);assert.equal(r.counts.audioInvalid,0);assert.equal(r.counts.audioPtsGaps,1);assert.equal(r.maxAudioPtsErrorMs,1000);
});
