/** Exact pixel conversion used by the receiver-tested normalized capture.
 * This is not a tag rewrite and is only selected for the validated MPEG-2 target. */
export const MPEG2_COLOR_FILTER='colorspace=iall=smpte240m:irange=pc:all=bt709:range=tv:format=yuv420p:fast=0:dither=fsb';
export function mpeg2ColorInput(p:any){
 const s=p?.streams??[],v=s.filter((x:any)=>x.codec_type==='video'),a=s.filter((x:any)=>x.codec_type==='audio'),x=v[0],duration=Number(p?.format?.duration);
 if(v.length!==1||a.length!==2||!s.every((x:any)=>Number.isSafeInteger(x.index)&&x.index>=0)||new Set(s.map((x:any)=>x.index)).size!==s.length||!Number.isFinite(duration)||duration<=0)return false;
 if(!String(p?.format?.format_name??'').split(',').includes('mp4')||x.codec_name!=='h264'||!['Main','High'].includes(x.profile)||!Number.isFinite(Number(x.level))||x.level<=0||x.level>41||x.field_order!=='progressive'||x.disposition?.attached_pic)return false;
 if(![x.width,x.height].every((n:number)=>Number.isSafeInteger(n)&&n>0&&n%2===0)||x.width>1920||x.height>1080||!['yuv420p','yuvj420p'].includes(x.pix_fmt)||x.color_range!=='pc'||![x.color_space,x.color_transfer,x.color_primaries].every(c=>c==='smpte240m'))return false;
 const [n,d]=String(x.avg_frame_rate).split('/').map(Number),[tn,td]=String(x.time_base).split('/').map(Number);if(!Number.isFinite(n/d)||Math.abs(n/d-24000/1001)>.001||!Number.isFinite(tn/td)||!(tn>0&&td>0)||!Number.isFinite(Number(x.start_time))||Math.abs(Number(x.start_time))>.003)return false;
 return a.every((s:any)=>s.codec_name==='aac'&&s.profile==='LC'&&s.channels===2&&s.channel_layout==='stereo'&&Number(s.sample_rate)===48000&&s.time_base==='1/48000'&&Number.isFinite(Number(s.start_time))&&Math.abs(Number(s.start_time))<=.003&&Number.isFinite(Number(s.duration))&&Number(s.duration)>0&&Math.abs(Number(s.duration)-duration)<=.064);
}
export function normalizedMpeg2Arguments(original:readonly string[]){
 const args=[...original],i=args.indexOf('-vf');if(i<0)throw Error('MPEG-2 video filter missing');args[i+1]=MPEG2_COLOR_FILTER+','+args[i+1];args.splice(args.indexOf('-c:v'),0,'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv');return ['-filter_threads','1',...args];
}
