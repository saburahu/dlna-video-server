import assert from 'node:assert/strict';
import type {MediaProfileDefinition,DecisionCandidate,MediaCharacteristics} from './playback-decision.js';
import {assertJitSource} from './jit-source-support.js';
import type {JitSeekPlan} from './jit-seek.js';
export const MPEG2_MEDIA_SHIFT=129003; // FFmpeg B2/muxdelay .7: initial video PTS 1.4333667s.
export const MPEG2_BLOCK_PACKETS=4166; // Accepted ~0.5s Content Packet; fixed bounded block, not total output size.
export const MPEG2_JIT_FEATURES='DLNA.ORG_PN=MPEG_TS_JP_T;DLNA.ORG_OP=10;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000';
export const MPEG2_JIT_PROTOCOL=`http-get:*:video/vnd.dlna.mpeg-tts:${MPEG2_JIT_FEATURES}`;
/** Fit the decoded display aspect, not coded width/height. Normalize SAR before
 * padding; the final 1440x1080/SAR4:3 transport remains a 16:9 canvas. Existing
 * pillarbox/letterbox pixels are part of the source and must not be cropped. */
export const MPEG2_DISPLAY_FIT="scale=w='if(gt(dar,16/9),1920,max(2,trunc(1080*dar/2)*2))':h='if(gt(dar,16/9),max(2,trunc(1920/dar/2)*2),1080)',setsar=1,pad=1920:1080:(ow-iw)/2:(oh-ih)/2";
export function isMpeg2JitTarget(p:MediaProfileDefinition){
 const v=p.video.value,a=p.audio.value,t=p.transport.value;
 return v.codec==='mpeg2video'&&v.profile==='Main'&&v.level===4&&v.codedWidth===1440&&v.codedHeight===1088&&v.scan==='interlaced'&&v.bitDepth===8&&v.chroma==='420'&&v.maxBitrate>=10e6&&v.maxCpbBits>=9781248&&a.codec==='aac'&&a.format==='mpeg2-aac-lc'&&a.maxChannels===2&&a.sampleRates.includes(48000)&&t.profileName==='MPEG_TS_JP_T'&&t.mime==='video/vnd.dlna.mpeg-tts'&&t.framing==='jp-content-packet'&&t.seek==='time'&&v.timing.constraint.minimumFrameSeconds===1001/30000;
}
/** Dedicated diagnostic target. CFR here reproduces the accepted MPEG-2 recipe;
 * it does not replace the AVC VFR/quantization policies or claim a receiver fps limit. */
export function mpeg2JitProfile():MediaProfileDefinition {
 const evidence={status:'inferred' as const,reference:'DBR_DEDICATED_PCR_TRIAL.md / DBR_MPEG_TS_CHUNKED_CONTROL.md',scope:'Fixed and chunked 40s generated MPEG-2 accepted; live JIT/seek unconfirmed'};
 return {id:'mpeg2-jp-pcr-split-v1',transport:{evidence,value:{container:'mpegts',framing:'jp-content-packet',mime:'video/vnd.dlna.mpeg-tts',profileName:'MPEG_TS_JP_T',seek:'time'}},video:{evidence,value:{codec:'mpeg2video',profile:'Main',level:4,codedWidth:1440,codedHeight:1088,scan:'interlaced',bitDepth:8,chroma:'420',maxDpbFrames:3,maxBitrate:10e6,maxCpbBits:9781248,timing:{id:'mpeg2-receiver-cfr-v1',mediaProfile:'MPEG_TS_JP_T',evidence:'compatibility-experiment',maxFrameMacroblocks:6120,constraint:{codedWidth:1440,codedHeight:1088,maxMBPS:184320,minimumFrameSeconds:1001/30000,timebase:90000}}}},audio:{evidence,value:{codec:'aac',format:'mpeg2-aac-lc',maxChannels:2,sampleRates:[48000],allowAbsent:false}},conformance:{status:'unknown',reference:evidence.reference,scope:'Full MPEG_TS_JP_T normative conformance not established'}};
}
export function planMpeg2Jit(source:MediaCharacteristics,candidate:DecisionCandidate){
 assertJitSource(source);assert.ok(isMpeg2JitTarget(candidate.target)&&!candidate.blockers.length&&candidate.strategy==='full-transcode','MPEG-2 target/decision not executable');
 assert.ok(candidate.transforms.some(t=>t.kind==='audio-format-normalization'));
 return {strategy:candidate.strategy,transforms:[...candidate.transforms,{kind:'cadence-normalization' as const,reason:'Explicit MPEG-2 receiver CFR recipe 30000/1001; may drop/duplicate, separate from AVC retained-PTS policy'}],sourceVideoCodec:source.video.codec,sourceAudioCodec:source.audio!.codec,minimumTicks:3003,deinterlace:source.video.scan==='interlaced',aspectFit:true,resample:source.audio!.sampleRate!==48000,channelMix:source.audio!.channels!==2,reconcileAudioTimeline:candidate.transforms.some(t=>t.kind==='audio-timeline-reconciliation'),resize:true,fullRange:!!source.video.fullRange,cadence:'mpeg2-receiver-cfr-v1',video:{codec:'mpeg2video',profile:'Main',level:4,width:1440,height:1080,bFrames:2},audio:{codec:'aac',format:'mpeg2-aac-lc',rate:48000,channels:2},transport:candidate.target.transport.value};
}
export function mpeg2Seek(requested:number):JitSeekPlan {const first=Math.ceil(requested*90000/3003)*3003;return {requested,anchor:{pts:first,index:0},firstVideoTicks:first,audioTrimTicks:first,minimumTicks:3003,policyFingerprint:'mpeg2-receiver-cfr-v1',preRollSeconds:0,indexFallback:'FFmpeg accurate input seek decodes keyframe pre-roll internally; CFR output grid aligned globally'};}
export function mpeg2JitArguments(source:string,end:number,transforms:{deinterlace?:boolean;reconcileAudioTimeline?:boolean;sourceAudioCodec?:string}={},seek?:JitSeekPlan){
 assert.ok(Number.isFinite(end)&&end>0);
 const start=seek?seek.firstVideoTicks/90000:0;assert.ok(end>start);
 const preroll=!!seek&&/^wma/.test(transforms.sourceAudioCodec??''),inputStart=preroll?Math.max(0,seek!.anchor.pts/90000-.001):start;
 return ['-hide_banner','-nostdin','-v','info',...(preroll?['-copyts']:[]),...(seek?['-ss',String(inputStart)]:[]),'-i',source,'-t',String(end-start),'-map','0:v:0','-map','0:a:0','-map_metadata','-1','-map_chapters','-1',
 '-vf','showinfo=checksum=0,'+(preroll?`trim=start=${start},setpts=PTS-${seek!.firstVideoTicks}/(90000*TB),`:'')+(transforms.deinterlace?'bwdif=mode=send_frame:parity=auto:deint=all,':'')+MPEG2_DISPLAY_FIT+',scale=1440:1080,setsar=4/3,fps=30000/1001'+(seek?':start_time=0':'')+',setfield=tff,format=yuv420p',
 '-c:v','mpeg2video','-profile:v','4','-level:v','4','-flags','+ilme+ildct','-top','1','-b:v','8000000','-maxrate:v','10000000','-bufsize:v','9781248','-g','15','-bf','2','-sc_threshold','1000000000','-threads','4',
 '-af',(preroll?`atrim=start=${start},asetpts=PTS-${seek!.firstVideoTicks}/(90000*TB),`:'')+`aresample=48000${transforms.reconcileAudioTimeline?':async=1':''},aformat=channel_layouts=stereo,asettb=1/48000,ashowinfo,asetpts=STARTPTS+N`,'-c:a','aac','-profile:a','mpeg2_aac_low','-aac_pns','0','-ar','48000','-ac','2','-b:a','192k',
 '-mpegts_service_id','141','-mpegts_pmt_start_pid','257','-streamid','0:320','-streamid','1:321','-mpegts_flags','+resend_headers','-pat_period','0.1','-pcr_period','50','-muxrate','12500000','-muxdelay','0.7','-avoid_negative_ts','disabled','-output_ts_offset',String(start+3003/90000),'-flush_packets','1','-f','mpegts','pipe:1'];
}

/** showinfo is before output PTS restoration; accurate input -ss resets it unless -copyts is used. */
export function mpeg2AuditPresentationStart(args:readonly string[],seek?:JitSeekPlan){return args.includes('-copyts')?(seek?.firstVideoTicks??0)/90000:0;}
