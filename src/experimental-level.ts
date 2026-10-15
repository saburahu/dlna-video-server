import {replaceSpsByteTts} from './experimental-vui.js';
/** Diagnostic only: no re-encoding, no remux, no change to HRD or transport. */
export function patchMainLevel42(input:Buffer,pid:number,sps:Buffer){
  if(sps.length<4||sps[0]!==0x67||sps[1]!==77||sps[3]!==40)throw new Error('Audited Main Level 4.0 SPS required');
  const patched=Buffer.from(sps);patched[3]=42;
  return replaceSpsByteTts(input,pid,sps,patched,3);
}
