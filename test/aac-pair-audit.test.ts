import test from 'node:test';import assert from 'node:assert/strict';
import {AacPipeAudit,aacPairAuditArguments} from '../src/aac-pair-audit.js';
import {jitArguments} from '../src/jit-stream.js';import {mpeg2JitArguments} from '../src/mpeg2-jit-target.js';
const header='#tb 0: 1/48000\n#codec_id 0: pcm_f32le\n';
const row=(pts:number,hash='a',samples=1024)=>`0, ${pts}, ${pts}, ${samples}, ${samples*8}, ${hash.repeat(64)}\n`;
test('dedicated audit pipes retain distinct clocks and hashes despite arbitrary inter-stream/chunk ordering',()=>{
 const a=new AacPipeAudit(2/48000),b=new AacPipeAudit(.002);
 const left=header+row(0,'a')+row(1024,'b'),right=header+row(480,'c')+row(1504,'d');
 for(let i=0;i<Math.max(left.length,right.length);i++){if(i<right.length)b.consume(right[i]);if(i<left.length)a.consume(left[i]);}
 assert.equal(a.finish().samples,2048);assert.equal(b.finish().samples,2048);assert.equal(a.firstHash,'a'.repeat(64));assert.equal(b.firstHash,'c'.repeat(64));assert.equal(a.lastHash,'b'.repeat(64));assert.equal(b.lastHash,'d'.repeat(64));
});
test('audit rejects dropped/duplicate/reordered samples, invalid format/size/timebase and partial records',()=>{
 for(const pts of [2048,0,-1024]){const a=new AacPipeAudit(2/48000);a.consume(header+row(0));assert.throws(()=>a.consume(row(pts)));}
 for(const text of [header+row(0).replace('8192','4096'),header.replace('48000','1000'),header.replace('pcm_f32le','pcm_s16le'),row(0)])assert.throws(()=>new AacPipeAudit(.002).consume(text));
 const partial=new AacPipeAudit(.002);partial.consume(header+row(0).trim());assert.throws(()=>partial.finish());
 const empty=new AacPipeAudit(.002);empty.consume(header);assert.equal(empty.finish().frames,0,'Caller must independently prove audio ended before request');
});
test('AAC audit branches preserve video and encoder/mux settings, separate pipes, and pre-canonical sample clocks',()=>{
 for(const original of [jitArguments('synthetic.mp4',2989,8),mpeg2JitArguments('synthetic.mp4',8)]){
  const saved=[...original],args=aacPairAuditArguments(original,original.includes('mpeg2video')?322:258);assert.deepEqual(original,saved);
  for(const flag of ['-vf','-c:v','-c:a','-muxrate','-pcr_period','-output_ts_offset'])assert.equal(args[args.indexOf(flag)+1],original[original.indexOf(flag)+1]);
  const graph=args[args.indexOf('-filter_complex')+1];assert.ok(!graph.includes('[0:v'));assert.ok(!graph.includes('ashowinfo'));assert.ok(graph.includes('asettb=1/48000,asplit=2'));assert.equal(args.filter(a=>a==='-filter_complex').length,2);assert.ok(graph.includes('asetpts=STARTPTS+N[jit_audio_0]'));
  assert.ok(args.includes('pipe:3')&&args.includes('pipe:4'));assert.equal(args.filter(v=>v==='framehash').length,2);assert.equal(args.filter(v=>v==='pcm_f32le').length,2);
 }
});
