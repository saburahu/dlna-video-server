import assert from 'node:assert/strict';
/** Exact pixel conversion used by the receiver-tested normalized capture.
 * This is not a tag rewrite and is only selected for the validated MPEG-2 target. */
export const MPEG2_COLOR_FILTER='colorspace=iall=smpte240m:irange=pc:all=bt709:range=tv:format=yuv420p:fast=0:dither=fsb';
const knownNumber=(v:unknown)=> (typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v));
export function mpeg2ColorInput(p:any){
 const s=p?.streams??[],v=s.filter((x:any)=>x.codec_type==='video'),a=s.filter((x:any)=>x.codec_type==='audio'),x=v[0],duration=Number(p?.format?.duration);
 if(v.length!==1||a.length!==2||!s.every((x:any)=>Number.isSafeInteger(x.index)&&x.index>=0)||new Set(s.map((x:any)=>x.index)).size!==s.length||!Number.isFinite(duration)||duration<=0)return false;
 if(!String(p?.format?.format_name??'').split(',').includes('mp4')||x.codec_name!=='h264'||!['Main','High'].includes(x.profile)||!Number.isFinite(Number(x.level))||x.level<=0||x.level>41||x.field_order!=='progressive'||x.disposition?.attached_pic)return false;
 if(![x.width,x.height].every((n:number)=>Number.isSafeInteger(n)&&n>0&&n%2===0)||x.width>1920||x.height>1080||!['yuv420p','yuvj420p'].includes(x.pix_fmt)||x.color_range!=='pc'||![x.color_space,x.color_transfer,x.color_primaries].every(c=>c==='smpte240m'))return false;
 if((x.bits_per_raw_sample!==undefined&&Number(x.bits_per_raw_sample)!==8)||(x.side_data_list!==undefined&&(!Array.isArray(x.side_data_list)||x.side_data_list.length!==0)))return false;
 const [n,d]=String(x.avg_frame_rate).split('/').map(Number),[tn,td]=String(x.time_base).split('/').map(Number);if(!Number.isFinite(n/d)||Math.abs(n/d-24000/1001)>.001||!Number.isFinite(tn/td)||!(tn>0&&td>0)||!knownNumber(x.start_time)||Math.abs(Number(x.start_time))>.003)return false;
 return a.every((s:any)=>s.codec_name==='aac'&&s.profile==='LC'&&s.channels===2&&s.channel_layout==='stereo'&&Number(s.sample_rate)===48000&&s.time_base==='1/48000'&&knownNumber(s.start_time)&&Math.abs(Number(s.start_time))<=.003&&Number.isFinite(Number(s.duration))&&Number(s.duration)>0&&Math.abs(Number(s.duration)-duration)<=.064);
}
export function normalizedMpeg2Arguments(original:readonly string[]){
 const args=[...original],i=args.indexOf('-vf');if(i<0)throw Error('MPEG-2 video filter missing');assert.ok(args[i+1].startsWith('showinfo=checksum=0,'),'Expected pre-CFR input observer');args[i+1]=args[i+1].replace('showinfo=checksum=0,','showinfo=checksum=0,'+MPEG2_COLOR_FILTER+',');args.splice(args.indexOf('-c:v'),0,'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv');return ['-nostats','-filter_threads','1',...args];
}

/** Observe actual decoder output before the conversion can override its tags/format. */
export class Mpeg2ColorDecodedAudit {
 frames=0;colors=0;
 constructor(private readonly width:number,private readonly height:number){}
 push(line:string){
  if(/\bn:\s*\d+\s+pts:/.test(line)&&/\bs:\d+x\d+\b/.test(line)){
   assert.equal(this.frames,this.colors,'Missing decoded colour record');
   const m=/\bfmt:(\S+).*?\bs:(\d+)x(\d+)\s+i:([PTB])/.exec(line);
   assert.ok(m&&['yuvj420p','yuv420p'].includes(m[1])&&Number(m[2])===this.width&&Number(m[3])===this.height&&m[4]==='P','Decoded normalized input disagrees with inspected geometry/format');this.frames++;
  }
  if(/\bcolor_range:/.test(line)){
   assert.equal(this.frames,this.colors+1,'Unexpected decoded colour record');
   for(const [key,value] of Object.entries({color_range:'pc',color_space:'smpte240m',color_primaries:'smpte240m',color_trc:'smpte240m'}))assert.equal(new RegExp('\\b'+key+':(\\S+)').exec(line)?.[1],value,'Decoded normalized input disagrees with inspected '+key);
   this.colors++;
  }
 }
 finish(){assert.ok(this.frames>0&&this.frames===this.colors,'Incomplete decoded colour audit');}
}
