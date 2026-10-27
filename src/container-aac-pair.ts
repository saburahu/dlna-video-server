import {mpeg2ColorInput} from './mpeg2-color-normalization.js';
import {sourceAudioEndpoint} from './jit-segment.js';

/** Limited branch-trial scope, not a receiver compatibility guarantee. The caller
 * still requires current identity, explicit receiver enrollment and URL binding. */
export function containerAacPair(probe:any,normalizedMpeg2=false){
 const color=normalizedMpeg2&&mpeg2ColorInput(probe);
 const streams=probe?.streams??[],a=streams.filter((s:any)=>s.codec_type==='audio'),v=streams.filter((s:any)=>s.codec_type==='video');
 if(a.length!==2||v.length!==1||new Set(streams.map((s:any)=>s.index)).size!==streams.length||!streams.every((s:any)=>Number.isSafeInteger(s.index)&&s.index>=0))return;
 const formats=String(probe.format?.format_name??'').split(','),video=v[0],duration=Number(probe.format?.duration),[n,d]=String(video.avg_frame_rate).split('/').map(Number);
 if(!(duration>0&&Number.isFinite(duration)&&video.width>0&&video.width<=1920&&video.height>0&&video.height<=1080&&(video.pix_fmt==='yuv420p'||color)))return;
 const mp4=formats.includes('mp4')&&video.codec_name==='h264'&&(video.profile==='High'||color&&video.profile==='Main')&&video.field_order==='progressive'&&Number.isFinite(n/d)&&Math.abs(n/d-24000/1001)<=.002;
 const frameSequence=video.field_order==='progressive'||['unknown',undefined].includes(video.field_order)&&probe.inputPictureStructure==='frame-sequence';
 const mkv=formats.includes('matroska')&&video.codec_name==='hevc'&&video.profile==='Main'&&frameSequence&&Number.isFinite(n/d)&&n/d>0&&n/d<=61;
 if(!mp4&&!mkv)return;
 if(!a.every((s:any)=>s.codec_name==='aac'&&s.profile==='LC'&&Number(s.sample_rate)===48000&&s.channels===2&&s.channel_layout==='stereo'&&s.time_base===(mp4?'1/48000':'1/1000')&&Number.isFinite(Number(s.start_time))&&Math.abs(Number(s.start_time))<=.003))return;
 const endpoints=[sourceAudioEndpoint(probe,0),sourceAudioEndpoint(probe,1)];
 if(!endpoints.every(e=>e!==undefined&&Number.isFinite(e)&&e>0&&e<=duration+.064)||Math.abs(endpoints[0]!-endpoints[1]!)>.064)return;
 if(!['aac',video.codec_name].every(c=>probe.executionDecoders?.includes(c)))return;
 return {version:mp4?'mp4-h264-two-aaclc-48k-stereo-v1' as const:'mkv-hevc-two-aaclc-48k-stereo-v1' as const,endpoints};
}
