/** Video cadence eligibility for the measured container/decoder combinations.
 * This does not admit a source, enroll audio, or assert clean decoded pixels.
 * The normal JIT/source/receiver gates and pre-fps runtime audit remain required. */
export const COMPATIBLE_CONTAINER_CFR='receiver-compatible-container-cfr-30000-1001-v1' as const;
export function compatibleContainerCfrInput(p:any):'wmv3-matroska-sd-24'|'h264-mp4-1080p-24'|undefined {
 const videos=p?.streams?.filter((s:any)=>s.codec_type==='video')??[],v=videos[0],audio=p?.streams?.filter((s:any)=>s.codec_type==='audio')??[];
 if(videos.length!==1||v.disposition?.attached_pic||v.pix_fmt!=='yuv420p'||!Number.isSafeInteger(v.width)||!Number.isSafeInteger(v.height)||!audio.length||audio.length>2)return;
 const rate=v.avg_frame_rate&&v.avg_frame_rate!=='0/0'?v.avg_frame_rate:v.r_frame_rate;
 const [n,d]=String(rate).split('/').map(Number);if(!(n>0&&d>0)||Math.abs(n/d-24000/1001)>.002)return;
 const [tn,td]=String(v.time_base).split('/').map(Number);if(!(tn>0&&td>0&&Number.isFinite(tn/td)))return;
 const formats=String(p.format?.format_name).split(',');
 // Matroska WMV3 frequently omits field_order. Header absence is provisional:
 // the unchanged showinfo audit requires every decoded input picture to be progressive.
 if(formats.includes('matroska')&&v.codec_name==='wmv3'&&v.profile==='Main'&&v.width>0&&v.width<=720&&v.height>0&&v.height<=576&&[undefined,'unknown','progressive'].includes(v.field_order)&&
 audio.every((a:any)=>['ac3','vorbis','aac','mp3'].includes(a.codec_name)&&Number(a.sample_rate)===48000&&(a.channels===2||a.codec_name==='ac3'&&a.channels===6&&['5.1','5.1(side)'].includes(a.channel_layout))))return 'wmv3-matroska-sd-24';
 // Preserve the measured HD dimensions/scan/level. No automatic SD upscaling
 // policy is being extended to arbitrary HD/UHD/rates/interlaced H.264.
 if(formats.includes('mp4')&&v.codec_name==='h264'&&v.profile==='High'&&v.level>0&&v.level<=41&&v.width===1920&&v.height===1080&&v.field_order==='progressive'&&
 audio.every((a:any)=>a.codec_name==='aac'&&a.profile==='LC'&&a.channels===2&&Number(a.sample_rate)===48000))return 'h264-mp4-1080p-24';
}
