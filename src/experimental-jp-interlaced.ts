import type {ExperimentalMediaConfig} from "./experimental-media.js";
import type {CopiedPacket} from "./experimental-cbr.js";

/** Reuse the already encoded HD60 video, but copy only the current JP AAC audio.
 * The input offsets cancel the standard muxer's uniform 1.4s shift. */
export function jpInterlacedArguments(video: string, audio: string, videoShiftTicks: number, output: string) {
  if (!Number.isSafeInteger(videoShiftTicks) || output === video || output === audio) throw new Error("Invalid isolated mux inputs");
  return ["-hide_banner","-nostdin","-n","-copyts",
    "-itsoffset",String(videoShiftTicks/90000-1.4),"-i",video,
    "-itsoffset","-1.4","-i",audio,"-map","0:v:0","-map","1:a:0",
    "-map_metadata","-1","-map_chapters","-1","-c","copy",
    "-mpegts_copyts","0","-muxdelay","0.7","-avoid_negative_ts","disabled",
    "-pcr_period","50","-muxrate","12500000","-f","mpegts",output];
}
export function validateJpInterlacedPackets(video: CopiedPacket[], audio: CopiedPacket[], output: CopiedPacket[], shift: number) {
  for(const [source,stream,offset] of [[video,0,shift],[audio,1,0]] as const){
    const a=source.filter(p=>p.stream_index===stream),b=output.filter(p=>p.stream_index===stream);
    if(!a.length || a.length!==b.length)throw new Error("Stream packet count changed");
    for(let i=0;i<a.length;i++){
      if(!a[i].data_hash || a[i].data_hash!==b[i].data_hash || Number(a[i].size)!==Number(b[i].size) || a[i].flags!==b[i].flags)throw new Error("Encoded stream changed");
      for(const f of ["pts","dts"] as const)if(!Number.isSafeInteger(Number(a[i][f])) || !Number.isSafeInteger(Number(b[i][f])) || Number(b[i][f])-Number(a[i][f])!==offset)throw new Error("Stream timestamp changed");
    }
  }
  const v=output.filter(p=>p.stream_index===0),keys=v.flatMap((p,i)=>p.flags.includes("K")?[i]:[]);
  if(keys[0]!==0 || keys.some((k,i)=>i>0&&k-keys[i-1]!==60))throw new Error("Irregular IDR cadence");
  if(v.some((p,i)=>Number(p.pts)!==Number(p.dts) || (i>0&&Number(p.pts)-Number(v[i-1].pts)!==3003)))throw new Error("Invalid interlaced frame clock");
  return {videoFrames:v.length,audioPackets:output.length-v.length,keyFrames:keys.length,gopSeconds:2.002,videoShiftTicks:shift,audioAbsolutePtsDtsExact:true,videoHd60EsExact:true};
}
export function jpInterlacedConfig(baseline: ExperimentalMediaConfig,file: string,durationSeconds: number,udn: string): ExperimentalMediaConfig {
  if(baseline.mode!=="remux" || baseline.dlnaProfile!==undefined || !baseline.timeSeek || !baseline.contentPacket || baseline.contentPacketBlockBytes!==5568 || baseline.audioTreatment!=="mpeg2-aac-lc" || baseline.videoTreatment!=="vfr-idr" || (baseline.pcrLeadMs??1100)!==1100)throw new Error("Current wrapped JP baseline required");
  return {...baseline,file,durationSeconds,udn,port:19099,title:"【JP映像条件対照】サンプル映像A・1080i AAC・150秒",videoTreatment:"interlaced-reference"};
}
