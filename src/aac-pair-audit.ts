import assert from 'node:assert/strict';
import {JitAudioClock} from './jit-audio-clock.js';
import {createHash} from 'node:crypto';

/** Dedicated framehash pipe, before AAC timestamp canonicalization. Float PCM
 * hashing is a branch of the same decode, not a second source decode/process. */
export class AacPipeAudit {
 readonly clock:JitAudioClock; private carry=''; private timebase=false; private format=false;
 firstHash?:string;lastHash?:string;
 private readonly hashes=createHash('sha256'); private digest?:string;bytes=0;
 constructor(tolerance:number){this.clock=new JitAudioClock(48000,tolerance);}
 consume(chunk:Buffer|string){this.carry+=String(chunk);let newline:number;
  while((newline=this.carry.indexOf('\n'))>=0){const line=this.carry.slice(0,newline).trim();this.carry=this.carry.slice(newline+1);this.line(line);}
  assert.ok(this.carry.length<4096,'Oversize audio audit record');
 }
 private line(line:string){
  if(!line)return;
  if(line.startsWith('#')){if(line.startsWith('#tb ')){assert.equal(line,'#tb 0: 1/48000');this.timebase=true;}if(line.startsWith('#codec_id ')){assert.equal(line,'#codec_id 0: pcm_f32le');this.format=true;}return;}
  assert.ok(this.timebase&&this.format,'Audio audit headers missing');
  const m=/^0,\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+),\s*([a-f0-9]{64})$/.exec(line);assert.ok(m,'Invalid audio audit record');
  const [dts,pts,samples,size]=m.slice(1,5).map(Number);assert.ok([dts,pts,samples,size].every(Number.isSafeInteger));assert.equal(dts,pts);assert.ok(samples>0);assert.equal(size,samples*2*4,'Audit PCM must be float stereo');
  this.clock.push(pts/48000,samples,48000);this.firstHash??=m[5];this.lastHash=m[5];this.hashes.update(`${samples}:${m[5]}\n`);this.bytes+=size;
 }
 finish(){assert.equal(this.carry.trim(),'','Partial audio audit record');assert.ok(this.timebase&&this.format,'Audio audit stream missing');return this.clock;}
 summary(){this.finish();this.digest??=this.hashes.digest('hex');return {frames:this.clock.frames,samples:this.clock.samples,pcmBytes:this.bytes,firstHash:this.firstHash,lastHash:this.lastHash,contentDigest:this.digest};}
}

export function aacPairAuditArguments(original:readonly string[],secondPid:number){
 const args=[...original],af=args[args.indexOf('-af')+1];assert.ok(af.includes('ashowinfo,asetpts=STARTPTS+N'));
 args.splice(args.indexOf('-af'),2);args[args.indexOf('0:a:0')]='[jit_audio_0]';args.splice(args.indexOf('[jit_audio_0]')+1,0,'-map','[jit_audio_1]');
 const [before,after]=af.split('ashowinfo,');assert.equal(after,'asetpts=STARTPTS+N');
 const graphs=[0,1].map(i=>`[0:a:${i}]${before}asplit=2[encode_${i}][audit_${i}];[encode_${i}]${after}[jit_audio_${i}]`);
 args.splice(args.indexOf('-f'),0,'-filter_complex_threads','1',...graphs.flatMap(g=>['-filter_complex',g]),'-streamid',`2:${secondPid}`,'-metadata:s:a:0','language=und','-metadata:s:a:1','language=und');
 const limit=args[args.indexOf('-t')+1];assert.ok(Number(limit)>0);
 for(const i of [0,1])args.push('-map',`[audit_${i}]`,'-t',limit,'-c:a','pcm_f32le','-ar','48000','-ac','2','-enc_time_base:a','1/48000','-avoid_negative_ts','disabled','-f','framehash','-hash','sha256',`pipe:${i+3}`);
 return args;
}
