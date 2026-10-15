import assert from 'node:assert/strict';
import {execute,ffmpeg} from './prepare-executor.js';

export function initialPictureEvidence(source:Buffer,output:Buffer){
 const stats=(b:Buffer)=>{assert.ok(b.length>0);const mean=b.reduce((sum,v)=>sum+v,0)/b.length;
  return {mean,stddev:Math.sqrt(b.reduce((sum,v)=>sum+(v-mean)**2,0)/b.length)};};
 assert.equal(source.length,output.length);
 const a=stats(source),b=stats(output),collapsedToGray=a.stddev>10&&b.stddev<1;
 return {source:a,output:b,collapsedToGray,scope:'first selected picture only; not a general picture-quality guarantee'};
}
/** Explicit PC regression only. Never called by Browse or the streaming handler.
 * Compare against source: a genuinely flat scene is not an encoder failure. */
export async function validateInitialPicture(source:string,artifact:string,anchorSeconds:number,sourcePts:number){
 const run=async(args:string[])=>Buffer.from((await execute(ffmpeg(),['-nostdin','-v','error',...args,'-frames:v','1','-fps_mode','passthrough','-pix_fmt','gray','-f','rawvideo','pipe:1'],
  {encoding:'buffer',windowsHide:true,timeout:60000,maxBuffer:1048576})).stdout);
 const a=await run(['-copyts','-ss',String(Math.max(0,anchorSeconds-.001)),'-i',source,'-map','0:v:0','-vf',`select='gte(round(t*90000),${sourcePts})',scale=160:90`]);
 const b=await run(['-i',artifact,'-map','0:v:0','-vf','scale=160:90']);
 const evidence=initialPictureEvidence(a,b);assert.equal(evidence.collapsedToGray,false,'Encoder collapsed a detailed source picture to gray');return evidence;
}
