import {jpProgressiveArguments} from "./experimental-jp-progressive.js";
import type {ExperimentalMediaConfig} from "./experimental-media.js";
export type CadenceMode="cfr"|"vfr";
/** Same source/settings; only display cadence and its required VUI/timebase differ. */
export function jpCadenceArguments(input:string,output:string,mode:CadenceMode){
 const a=jpProgressiveArguments(input,output),set=(k:string,v:string)=>{a[a.indexOf(k)+1]=v;},remove=(k:string)=>{const i=a.indexOf(k);if(i>=0)a.splice(i,2);};
 remove("-itsoffset");const audioMap=a.findIndex((v,i)=>v==="-map"&&a[i+1]==="0:a:0");a.splice(audioMap,2);remove("-c:a");
 set("-vf",mode==="cfr"?"fps=30000/1001:round=near,format=yuv420p":"format=yuv420p");
 set("-x264-params",a[a.indexOf("-x264-params")+1].replace("force-cfr=1",`force-cfr=${mode==="cfr"?1:0}`));
 set("-mpegts_copyts","1");set("-muxdelay","0");remove("-muxrate");
 // A frame-count ceiling of 60 inserts extra IDRs in dense VFR intervals.
 // Both arms use the same generous ceiling; the shared time expression owns GOPs.
 set("-g","600");
 a.splice(a.indexOf("-f"),0,"-t","150","-an","-enc_time_base:v",mode==="cfr"?"1001/30000":"1/120000","-force_key_frames","expr:gte(t,n_forced*2.002)","-forced-idr","1");
 return a;
}
export function jpCadenceConfig(b:ExperimentalMediaConfig,file:string,durationSeconds:number,udn:string,mode:CadenceMode):ExperimentalMediaConfig{
 if(b.videoTreatment!=="progressive-reference"||b.videoEncoder!=="libx264"||b.audioTreatment!=="mpeg2-aac-lc"||!b.timeSeek||!b.contentPacket||b.contentPacketBlockBytes!==5568||b.dlnaProfile!==undefined||(b.pcrLeadMs??1100)!==1100)throw new Error("Successful progressive JP baseline required");
 return {...b,file,durationSeconds,udn,port:mode==="cfr"?19101:19102,title:`【JP同一stack ${mode.toUpperCase()}】サンプル映像A・150秒`,videoTreatment:mode==="cfr"?"progressive-reference":"vfr-idr"};
}
export interface CadencePacket{pts:number;dts:number;size:number;flags:string;data_hash?:string;stream_index:number}
export function cadenceStats(p:CadencePacket[]){
 if(!p.length||p.some((q,i)=>q.pts!==q.dts||!Number.isSafeInteger(q.pts)||(i>0&&q.pts<=p[i-1].pts)))throw new Error("Monotonic B0 display/decode clock required");
 const origin=p[0].pts,intervals:Record<string,number>={},pictures:Record<string,number>={},bits:Record<string,number>={};
 for(let i=0;i<p.length;i++){const second=String(Math.floor((p[i].pts-origin)/90000));pictures[second]=(pictures[second]??0)+1;bits[second]=(bits[second]??0)+Number(p[i].size)*8;if(i){const delta=String(p[i].pts-p[i-1].pts);intervals[delta]=(intervals[delta]??0)+1;}}
 const keys=p.flatMap((q,i)=>q.flags.includes("K")?[{index:i,seconds:(q.pts-origin)/90000}]:[]),sizes=p.map(q=>Number(q.size));
 const peak=(window:number)=>{let left=0,sum=0,max=0;for(let right=0;right<p.length;right++){sum+=Number(p[right].size)*8;while(p[right].pts-p[left].pts>=window*90000)sum-=Number(p[left++].size)*8;max=Math.max(max,sum);}return max/window;};
 return {frames:p.length,intervalTicks:intervals,picturesPerSecond:pictures,bitsPerSecond:bits,peakAuBitsPerSecond:{ms100:peak(.1),ms500:peak(.5),ms1000:peak(1)},maxPicturesInSecond:Math.max(...Object.values(pictures)),maxAuBytes:Math.max(...sizes),meanAuBytes:sizes.reduce((a,b)=>a+b,0)/sizes.length,keys,gopIntervalsSeconds:keys.slice(1).map((k,i)=>k.seconds-keys[i].seconds)};
}
