import {hd60Arguments} from "./experimental-hd60.js";
import type {ExperimentalMediaConfig} from "./experimental-media.js";

/** Same x264/VBV/GOP settings as successful interlace, on the same decoded frames.
 * setfield changes scan metadata, not pixels or cadence (no deinterlace/fps filter). */
export function jpProgressiveArguments(input:string,output:string){
  if(input===output)throw new Error("Derived output required");
  const a=hd60Arguments(input,output);
  const set=(key:string,value:string)=>{a[a.indexOf(key)+1]=value;};
  const remove=(key:string)=>{const i=a.indexOf(key);if(i>=0)a.splice(i,2);};
  remove("-t");set("-vf","setfield=prog,format=yuv420p");set("-flags:v","-ilme-ildct");remove("-top");
  set("-x264-params","interlaced=0:nal-hrd=vbr:force-cfr=1:aud=1:repeat-headers=1:scenecut=0:rc-lookahead=0");
  set("-c:a","copy");for(const k of ["-b:a","-ar","-ac"])remove(k);
  set("-pcr_period","50");a.splice(a.indexOf("-i"),0,"-copyts","-itsoffset","-1.4");
  a.splice(a.indexOf("-f"),0,"-avoid_negative_ts","disabled");
  return a;
}
export function jpProgressiveConfig(baseline:ExperimentalMediaConfig,file:string,durationSeconds:number,udn:string):ExperimentalMediaConfig{
  if(baseline.mode!=="remux"||baseline.dlnaProfile!==undefined||!baseline.timeSeek||!baseline.contentPacket||baseline.contentPacketBlockBytes!==5568||baseline.audioTreatment!=="mpeg2-aac-lc"||baseline.videoTreatment!=="interlaced-reference"||(baseline.pcrLeadMs??1100)!==1100)throw new Error("Successful JP interlaced baseline required");
  return {...baseline,file,durationSeconds,udn,port:19100,title:"【JP scan対照】サンプル映像A・1080p29.97・150秒",videoTreatment:"progressive-reference"};
}
