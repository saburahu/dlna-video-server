import {receiverCfrFirstTick,type ReceiverCfr} from './receiver-cfr-trial.js';
import assert from 'node:assert/strict';
import type {JitSeekPlan} from './jit-seek.js';
import {createRequire} from 'node:module';
import {PCR_WRAP,readPcr} from './core.js';
import {negativeControlVideoArguments} from './experimental-negative-control.js';
import {ENCODE_RECIPE} from './prepare-executor.js';
import {modularDelta,TTS_MODULUS} from './full-clocks.js';
import {reconstructionFilter,type QuantizedTimingPolicy} from './quantized-timing.js';
const require=createRequire(import.meta.url);
const Packet=require('aribts/lib/packet') as new(b:Buffer)=>{decode():{PID:number;payload_unit_start_indicator:number;data_byte?:Buffer}};
export interface JitStats {packets:number;audioFrames:number;videoPictures:number;pcrIntervals:number;maxPcrMs:number;ttsWraps:number;firstPcr?:number;lastPcr?:number;firstVideoPts?:number;lastVideoPts?:number;firstAudioPts?:number;lastAudioPts?:number;lastAudioFramePts?:number;minVideoDelta?:number;maxHeldBytes:number}
export const newJitStats=():JitStats=>({packets:0,audioFrames:0,videoPictures:0,pcrIntervals:0,maxPcrMs:0,ttsWraps:0,maxHeldBytes:0});
export interface JitSourceTransforms {deinterlace?:boolean;resample?:boolean;channelMix?:boolean;aspectFit?:boolean;fullRange?:boolean;reconcileAudioTimeline?:boolean;receiverCfr?:ReceiverCfr}
export function jitArguments(source:string,minimumTicks:number,seconds:number,seek?:JitSeekPlan,clock?:QuantizedTimingPolicy,encoderNominalRate?:string,transforms:JitSourceTransforms={}){
 assert.ok(Number.isSafeInteger(minimumTicks)&&minimumTicks>0&&seconds>0&&Number.isFinite(seconds));
 const a=negativeControlVideoArguments(source,'pipe:1',1,seconds);a.splice(a.indexOf('-frames:v'),2);a.splice(a.indexOf('-an'),1);
 a[a.indexOf('-vf')+1]=`select='isnan(prev_selected_t)+gte(round(t*90000)-round(prev_selected_t*90000),${minimumTicks})',`+a[a.indexOf('-vf')+1];
 a[a.indexOf('-mpegts_copyts')+1]='0';a[a.indexOf('-muxdelay')+1]=String(ENCODE_RECIPE.muxdelay);
 a.splice(a.indexOf('-f'),0,'-map','0:a:0','-c:a','aac','-profile:a','mpeg2_aac_low','-aac_pns','0','-ar','48000','-ac','2','-b:a','192k','-streamid','0:256','-streamid','1:257','-muxrate',String(ENCODE_RECIPE.muxrate),'-output_ts_offset',String(ENCODE_RECIPE.commonShiftTicks/90000-2*ENCODE_RECIPE.muxdelay),'-flush_packets','1');
 if(seek){
  a.splice(a.indexOf('-i'),0,'-ss',String(Math.max(0,seek.anchor.pts/90000-.001)));
  const seed=seek.anchor.lastRetainedTimestamp,original=a[a.indexOf('-vf')+1];
  a[a.indexOf('-vf')+1]=`select='gte(round(t*90000),${seek.anchor.pts})*if(isnan(prev_selected_t),${seed===undefined?'1':`gte(round(t*90000)-${seed},${minimumTicks})`},gte(round(t*90000)-round(prev_selected_t*90000),${minimumTicks}))',select='gte(round(t*90000),${seek.firstVideoTicks})',`+original.slice(original.indexOf("',")+2);
  a.splice(a.indexOf('-f'),0,'-af',`atrim=start=${seek.audioTrimTicks/90000}`);
  a[a.indexOf('-force_key_frames')+1]='expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+2.002))';
 }
 // Same decoded samples and start time; remove bounded container-PTS rounding jitter.
 // Runtime checks ashowinfo before canonicalization and rejects real gaps/drift.
 const audioClock=transforms.reconcileAudioTimeline?'aresample=48000:async=1,aformat=channel_layouts=stereo,asettb=1/48000,ashowinfo,asetpts=STARTPTS+N':(transforms.resample||transforms.channelMix?'aresample=48000,aformat=channel_layouts=stereo,':'')+'asettb=1/48000,ashowinfo,asetpts=STARTPTS+N';
 if(a.includes('-af'))a[a.indexOf('-af')+1]+=','+audioClock;
 else a.splice(a.indexOf('-f'),0,'-af',audioClock);
 if(clock){
  // Anchor gate uses original source PTS; selection/seed uses reconstructed PTS.
  // trim closes the VIDEO branch on the original endpoint; select alone would
  // keep reading the remainder looking for an output picture. Do not bound
  // the input: that would also change AAC end-padding/sample handling.
  const prefix=`trim=end=${seconds},`+(seek?`select='gte(round(t*90000),${seek.anchor.pts})',`:'');
  let filter=a[a.indexOf('-vf')+1];
  if(seek)filter=filter.replace(`gte(round(t*90000),${seek.anchor.pts})*`,'');
  a[a.indexOf('-vf')+1]=prefix+reconstructionFilter(clock)+','+filter;
  if(encoderNominalRate){
   assert.ok(/^\d+\/\d+$/.test(encoderNominalRate));const [n,d]=encoderNominalRate.split('/').map(Number);assert.ok(n>0&&d>0&&n/d<=120);
   // FFmpeg 7.1 setpts clears link frame_rate. libx264 otherwise falls back
   // to inverse encoder timebase (90000fps), starving initial ABR pictures.
   // Restore only the nominal initialization hint; passthrough PTS, selection,
   // 1/90000 timebase, VFR HRD and audio are unchanged.
   a[a.indexOf('-x264-params')+1]+=`:fps=${encoderNominalRate}`;
  }
 }
 if(transforms.aspectFit)a[a.indexOf('-vf')+1]=a[a.indexOf('-vf')+1].replace('scale=1920:1080:flags=lanczos',"scale=w='if(gt(dar,16/9),1920,trunc(1080*dar/2)*2)':h='if(gt(dar,16/9),trunc(1920/dar/2)*2,1080)':flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1");
 if(transforms.fullRange){a[a.indexOf('-vf')+1]=a[a.indexOf('-vf')+1].replace('flags=lanczos','flags=lanczos:in_range=pc:out_range=tv');a.splice(a.indexOf('-f'),0,'-color_range','tv');}
 a[a.indexOf('-vf')+1]='showinfo=checksum=0,'+(transforms.deinterlace?'bwdif=mode=send_frame:parity=auto:deint=all,':'')+a[a.indexOf('-vf')+1];
 if(transforms.receiverCfr){
  assert.equal(transforms.receiverCfr,'receiver-cfr-30000-1001-v1');
  assert.ok(!clock,'Receiver CFR and source clock reconstruction are distinct policies');
  const start=receiverCfrFirstTick(seek?.firstVideoTicks??0)/90000;
  a[a.indexOf('-vf')+1]+=(seek?`,fps=30000/1001:round=near:start_time=${start}`:',fps=30000/1001:round=near')+`,trim=end=${seconds}`;
 }
 return a;
}
export async function* tsPackets(input:AsyncIterable<Buffer>){let carry:Buffer=Buffer.alloc(0);for await(const c of input){const b=Buffer.concat([carry,c]);let i=0;for(;i+188<=b.length;i+=188){assert.equal(b[i],0x47);assert.equal(b[i+1]&128,0);yield Buffer.from(b.subarray(i,i+188));}carry=Buffer.from(b.subarray(i));}assert.equal(carry.length,0,'Partial TS packet');}
const pts=(b:Buffer)=>((b[0]>>1)&7)*2**30+b[1]*2**22+(b[2]>>1)*2**15+b[3]*2**7+(b[4]>>1);
/** Keep at most one AAC PES plus intervening TS packets. Reuse aribts payload parsing.
 * MPEG-TS muxer rewrites the ADTS MPEG ID to zero despite MPEG-2 AAC encoder mode.
 * Only the ID bit changes; encoded LC payload, timestamps and packet positions do not. */
export async function* normalizeJitAudio(input:AsyncIterable<Buffer>,stats:JitStats,minimum:number,options:{videoPid?:number;audioPid?:number;reordered?:boolean;exactVideoDelta?:number}={}){
 const videoPid=options.videoPid??256,audioPid=options.audioPid??257;
 let queue:Buffer[]=[],parts:{packet:Buffer;offset:number;length:number}[]=[],size=0,expected=0,lastVideo:number|undefined,lastAudio:number|undefined;
 const counters=new Map<number,number>();
 const finish=()=>{const pes=Buffer.concat(parts.map(p=>p.packet.subarray(p.offset,p.offset+p.length)));assert.ok(expected&&size>=expected);assert.equal(pes.readUIntBE(0,3),1);assert.equal(pes[3],0xc0);let at=9+pes[8];assert.ok(at<expected);let frames=0;while(at<expected){assert.ok(at+7<=expected);assert.equal(pes[at],255);assert.equal(pes[at+1]&0xf6,0xf0);assert.equal(pes[at+2]>>6,1);assert.equal((pes[at+2]>>2)&15,3);assert.equal(((pes[at+2]&1)<<2)|(pes[at+3]>>6),2);const n=((pes[at+3]&3)<<11)|(pes[at+4]<<3)|(pes[at+5]>>5);assert.ok(n>=7&&at+n<=expected);let pos=at+1;for(const p of parts){if(pos<p.length){p.packet[p.offset+pos]|=8;break;}pos-=p.length;}at+=n;frames++;}assert.equal(at,expected);stats.audioFrames+=frames;stats.lastAudioFramePts=(lastAudio!+(frames-1)*1920)%2**33;parts=[];size=0;expected=0;};
 for await(const packet of input){const p=new Packet(packet).decode(),payload=p.data_byte;
  if(payload?.length&&[videoPid,audioPid].includes(p.PID)){const cc=packet[3]&15,prev=counters.get(p.PID);if(prev!==undefined)assert.equal(cc,(prev+1)&15,'Generated ES continuity error');counters.set(p.PID,cc);
   if(p.payload_unit_start_indicator){assert.ok(payload.length>=14&&payload.readUIntBE(0,3)===1);assert.ok(payload[7]&128);const t=pts(payload.subarray(9,14));if(p.PID===videoPid){const d=payload[7]&64?pts(payload.subarray(14,19)):t;if(!options.reordered)assert.equal(d,t,'B0 expected');else assert.ok(modularDelta(t,d,2**33)<=9009,'MPEG-2 reorder exceeds recipe');if(lastVideo!==undefined){const delta=modularDelta(d,lastVideo,2**33);assert.ok(delta>=minimum&&delta<180000,'Video timing invalid');if(options.exactVideoDelta!==undefined)assert.equal(delta,options.exactVideoDelta,'Receiver CFR output grid');stats.minVideoDelta=Math.min(stats.minVideoDelta??Infinity,delta);}stats.firstVideoPts??=t;if(!options.reordered||stats.lastVideoPts===undefined||modularDelta(t,stats.lastVideoPts,2**33)<2**32)stats.lastVideoPts=t;lastVideo=d;stats.videoPictures++;}else{if(lastAudio!==undefined)assert.ok(modularDelta(t,lastAudio,2**33)>0);stats.firstAudioPts??=t;stats.lastAudioPts=t;lastAudio=t;}}
  }
  if(p.PID===audioPid&&payload?.length){if(p.payload_unit_start_indicator){assert.equal(parts.length,0,'Incomplete audio PES');expected=payload.readUInt16BE(4)+6;assert.ok(expected>6&&expected<=65541);}assert.ok(expected,'Orphan AAC payload');parts.push({packet,offset:188-payload.length,length:payload.length});size+=payload.length;}
  if(parts.length){queue.push(packet);assert.ok(queue.length*188<=2*1024*1024,'AAC PES buffering limit');stats.maxHeldBytes=Math.max(stats.maxHeldBytes,queue.length*188);if(size>=expected){finish();yield* queue;queue=[];}}
  else yield packet;
 }
 assert.equal(parts.length,0,'Audio PES truncated');assert.equal(queue.length,0);
}
/** One-PCR lookahead; no complete index or complete output is required. */
export async function* liveTts(input:AsyncIterable<Buffer>,stats:JitStats,offsetTicks=0){
 let held:{packet:Buffer;index:number}[]=[],index=0,prev:{index:number;ticks:number}|undefined,lastRaw:number|undefined,lastSlope:number|undefined,lastTts:number|undefined;
 const convert=(items:typeof held,a:{index:number;ticks:number},slope:number)=>items.map(p=>{const ticks=Math.round(a.ticks+(p.index-a.index)*slope),value=(((ticks+offsetTicks)%TTS_MODULUS)+TTS_MODULUS)%TTS_MODULUS,b=Buffer.alloc(192);b.writeUInt32BE(value);p.packet.copy(b,4);if(lastTts!==undefined){assert.ok(modularDelta(value,lastTts,TTS_MODULUS)>0&&modularDelta(value,lastTts,TTS_MODULUS)<2700000);if(value<lastTts)stats.ttsWraps++;}lastTts=value;return b;});
 for await(const packet of input){const raw=readPcr(packet,0);if(raw!==null){assert.equal(packet[5]&128,0,'Unexpected PCR discontinuity');assert.equal(((packet[1]&31)<<8)|packet[2],256,'Unexpected PCR PID');const ticks=prev?prev.ticks+modularDelta(raw,lastRaw!,PCR_WRAP):raw;stats.firstPcr??=ticks;stats.lastPcr=ticks;if(prev){const d=ticks-prev.ticks;assert.ok(d>0&&d<=51*27000,'PCR interval invalid');stats.pcrIntervals++;stats.maxPcrMs=Math.max(stats.maxPcrMs,d/27000);lastSlope=d/(index-prev.index);yield* convert(held,prev,lastSlope);held=[];}prev={index,ticks};lastRaw=raw;}held.push({packet,index:index++});assert.ok(held.length*188<2*1024*1024,'PCR lookahead exceeds limit');stats.packets++;}
 assert.ok(prev&&lastSlope,'Insufficient PCR');yield* convert(held,prev,lastSlope);
}
export interface JitBlock {bytes:Buffer;mediaSeconds:number}
/** Profile-specific JP framing. EOF length is known only for the final buffered block. */
export async function* jpBlocks(input:AsyncIterable<Buffer>,packetsPerBlock=29){assert.ok(Number.isSafeInteger(packetsPerBlock)&&packetsPerBlock>0&&packetsPerBlock<=8192);let parts:Buffer[]=[],origin:number|undefined,last:number|undefined,ticks=0;for await(const packet of input){assert.equal(packet.length,192);const raw=packet.readUInt32BE(0);if(last!==undefined)ticks+=modularDelta(raw,last,TTS_MODULUS);else origin=raw;last=raw;parts.push(packet);if(parts.length===packetsPerBlock){const header=Buffer.alloc(14);header.writeUInt32BE(parts.length*192,10);yield {bytes:Buffer.concat([header,...parts]),mediaSeconds:ticks/27000000};parts=[];}}if(parts.length){const header=Buffer.alloc(14);header.writeUInt32BE(parts.length*192,10);yield {bytes:Buffer.concat([header,...parts]),mediaSeconds:ticks/27000000};}assert.ok(origin!==undefined);}
/** Finite EOF releases startup data only after independent endpoint validation. */
export async function* startupBlocks(input:AsyncIterable<JitBlock>,seconds:number,onReady:(seconds:number,bytes:number,reason:'buffer-target'|'validated-segment-end')=>void,validateFiniteEnd?:()=>Promise<void>){
 let buffered:JitBlock[]=[],bytes=0,ready=false;
 for await(const block of input){if(!ready){buffered.push(block);bytes+=block.bytes.length;assert.ok(bytes<=8*1024*1024,'Startup buffer cap');if(block.mediaSeconds>=seconds){onReady(block.mediaSeconds,bytes,'buffer-target');ready=true;yield* buffered;buffered=[];}}else yield block;}
 if(!ready&&validateFiniteEnd){assert.ok(buffered.length&&bytes,'Empty finite JIT segment');await validateFiniteEnd();onReady(buffered.at(-1)!.mediaSeconds,bytes,'validated-segment-end');ready=true;yield* buffered;}
 assert.ok(ready,'Source ended before startup buffer was ready');
}
