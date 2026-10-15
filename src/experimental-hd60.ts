/** Offline diagnostic reference, not a certified DLNA profile or a device-name policy. */
export const HD60_PROFILE = "AVC_TS_HD_60_AC3_T";
import type {ExperimentalMediaConfig} from "./experimental-media.js";
/** Same validated file and clock; only omit the outer ARIB Content Packet framing. */
export function rawHd60Config(baseline: ExperimentalMediaConfig, udn: string): ExperimentalMediaConfig {
  if (baseline.dlnaProfile !== HD60_PROFILE || baseline.mode !== "remux" || !baseline.contentPacket || baseline.contentPacketBlockBytes !== 5568 || baseline.contentPacketMaxSeconds !== undefined || baseline.pcrLeadMs !== 1100 || baseline.audioTreatment !== "ac3-reference" || baseline.videoTreatment !== "interlaced-reference") throw new Error("Validated wrapped HD60 baseline required");
  const {contentPacketBlockBytes: unused, ...rest}=baseline;
  return {...rest,port:19096,udn,title:"【HD60包みなし対照】サンプル映像A・1080i AC-3・150秒",contentPacket:false};
}
export function hd60Arguments(input: string, output: string) {
  return ["-hide_banner", "-nostdin", "-n", "-i", input, "-t", "150", "-map", "0:v:0", "-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
    "-vf", "fps=60000/1001:round=near,tinterlace=interleave_top,format=yuv420p", "-fps_mode", "passthrough",
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-level:v", "4.0", "-flags:v", "+ilme+ildct", "-top", "1",
    "-g", "60", "-keyint_min", "60", "-bf", "0", "-refs", "1", "-b:v", "8M", "-maxrate", "10M", "-bufsize", "10M",
    "-x264-params", "interlaced=1:tff=1:nal-hrd=vbr:force-cfr=1:aud=1:repeat-headers=1:scenecut=0:rc-lookahead=0",
    "-c:a", "ac3", "-b:a", "384k", "-ar", "48000", "-ac", "2", "-mpegts_copyts", "0", "-muxdelay", "0.7",
    "-muxrate", "12500000", "-pcr_period", "40", "-f", "mpegts", output];
}
export function checkHd60Packets(packets: {stream_index: number; pts: number; dts: number; flags: string}[]) {
  const video = packets.filter(p => p.stream_index === 0), audio = packets.filter(p => p.stream_index === 1);
  if (video.length < 3600 || audio.length < 3750) throw new Error("At least 120 seconds of AV packets required");
  for (const [stream, step] of [[video, 3003], [audio, 2880]] as const) {
    for (let i=0; i<stream.length; i++) {
      if (!Number.isSafeInteger(stream[i].pts) || stream[i].pts !== stream[i].dts || (i && stream[i].pts-stream[i-1].pts !== step)) throw new Error("Invalid reference AV clock");
    }
  }
  const keys = video.flatMap((p,i) => p.flags.includes("K") ? [i] : []);
  if (keys[0] !== 0 || keys.some((v,i) => i>0 && v-keys[i-1] !== 60)) throw new Error("Regular initial random access required");
  return {videoFrames:video.length,audioPackets:audio.length,videoStepTicks:3003,audioStepTicks:2880,keyFrames:keys.length,gopSeconds:60060/30000,firstVideoPts:video[0].pts,firstAudioPts:audio[0].pts,avFirstDifferenceMs:(video[0].pts-audio[0].pts)/90};
}
