export function mpeg2UnsafeInput(p:any){const v=p?.streams?.find((s:any)=>s.codec_type==='video');return v?.pix_fmt==='yuvj420p'||v?.color_range==='pc'||[v?.color_space,v?.color_transfer,v?.color_primaries].includes('smpte240m');}
/** Bounded input contract for the existing MPEG-2/AAC/dedicated-PCR recipe.
 * Metadata eligibility is not a receiver success or full-file decode certificate. */
export function mpeg2InputEligibility(p:any){
 const no=(reason:string)=>({eligible:false,reason,legacy:false});
 const streams=p?.streams??[],video=streams.filter((s:any)=>s.codec_type==='video'),audio=streams.filter((s:any)=>s.codec_type==='audio'),v=video[0],formats=String(p?.format?.format_name??'').split(','),duration=Number(p?.format?.duration);
 if(v?.pix_fmt==='yuvj420p'||v?.color_range==='pc'||[v?.color_space,v?.color_transfer,v?.color_primaries].includes('smpte240m'))return no('mpeg2-unsafe-full-range-or-240m-input');
 if(video.length!==1||!audio.length||audio.length>2||!Number.isFinite(duration)||duration<=0||streams.some((s:any)=>!Number.isSafeInteger(s.index)||s.index<0)||new Set(streams.map((s:any)=>s.index)).size!==streams.length)return no('mpeg2-stream-layout-or-duration-unverified');
 if(v.pix_fmt!=='yuv420p'||![v.width,v.height].every(Number.isSafeInteger)||v.width<=0||v.width>1920||v.height<=0||v.height>1080)return no('mpeg2-pixel-or-dimension-unverified');
 const start=Number(v.start_time??p.format.start_time),[tn,td]=String(v.time_base).split('/').map(Number);if(!Number.isFinite(start)||start<0||start>=duration||!(tn>0&&td>0))return no('mpeg2-video-timebase-or-start-unverified');
 const rate=v.avg_frame_rate==='0/0'||!v.avg_frame_rate?v.r_frame_rate:v.avg_frame_rate,[n,d]=String(rate).split('/').map(Number);if(!Number.isFinite(n/d)||n/d<1||n/d>60)return no('mpeg2-source-cadence-unverified');
 if(!audio.every((a:any)=>['aac','mp3','wmav2','wmapro','ac3'].includes(a.codec_name)&&[44100,48000].includes(Number(a.sample_rate))&&[1,2,6].includes(a.channels)&&Number.isFinite(Number(a.start_time))))return no('mpeg2-audio-input-unverified');
 const modern=(formats.includes('mp4')&&v.codec_name==='h264'&&['Main','High'].includes(v.profile)&&Number(v.level)>0&&Number(v.level)<=41||formats.includes('matroska')&&v.codec_name==='hevc'&&v.profile==='Main')&&(v.field_order==='progressive'||['unknown',undefined].includes(v.field_order)&&p.inputPictureStructure==='frame-sequence');
 if(modern&&audio.every((a:any)=>a.codec_name==='aac'&&a.channels===2&&Number(a.sample_rate)===48000))return {eligible:true,legacy:false,reason:'bounded-established-mpeg2-modern-input'};
 const cadence=[24000/1001,30000/1001].some(r=>Math.abs(n/d-r)<.002),sd=v.width<=720&&v.height<=576,scan=['progressive','unknown',undefined].includes(v.field_order);
 const wmv=formats.includes('asf')&&v.codec_name==='wmv3'&&v.profile==='Main'&&audio.every((a:any)=>['wmav2','wmapro'].includes(a.codec_name)&&a.channels===2&&(audio.length===1?[44100,48000].includes(Number(a.sample_rate)):Number(a.sample_rate)===48000));
 const avi=formats.includes('avi')&&(v.codec_name==='h264'&&['Main','High'].includes(v.profile)||v.codec_name==='msmpeg4v3')&&audio.every((a:any)=>a.codec_name==='mp3'&&a.channels===2);
 if(sd&&scan&&cadence&&(wmv||avi)){if(!audio.every((a:any)=>Math.abs(Number(a.start_time)-start)<=.003&&(a.duration===undefined&&avi||Number.isFinite(Number(a.duration))&&Math.abs(Number(a.duration)-duration)<=.064)))return no('mpeg2-legacy-stream-clock-inconsistent');return {eligible:true,legacy:true,reason:'bounded-mpeg2-legacy-input-runtime-audited'};}
 return no('mpeg2-container-codec-scan-combination-unverified');
}
