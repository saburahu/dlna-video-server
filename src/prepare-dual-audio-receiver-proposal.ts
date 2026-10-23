import fs from'node:fs/promises';import path from'node:path';import assert from'node:assert/strict';import{pathToFileURL}from'node:url';
import{proposeReceiverDualAudio}from'./dual-audio-permission-proposal.js';
/** Explicit offline CLI. Reads a policy copy and capability, writes only a NEW
 * proposal. Does not contact a renderer, enroll a family, or change live data. */
export async function prepareDualAudioReceiverProposal(args:readonly string[]){
 assert.equal(args.length,5,'policy-copy.json capability.json target-profile evidence-reference NEW-proposal.json');
 const [input,capability,target,reference,output]=args;assert.notEqual(path.resolve(input),path.resolve(output),'Never overwrite the input policy');
 const read=async(p:string)=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,'')),policy=await read(input),observed=await read(capability),cap=observed.capability??observed;
 const proposed={...policy,dualAudioPermissions:proposeReceiverDualAudio(policy.dualAudioPermissions??[],cap,target,reference)};
 const handle=await fs.open(output,'wx');try{await handle.writeFile(JSON.stringify(proposed,null,2)+'\n');}finally{await handle.close();}
 return{proposal:output,existingRecords:policy.dualAudioPermissions?.length??0,proposedRecords:proposed.dualAudioPermissions.length,liveApplied:false,sourceFingerprintsAdded:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await prepareDualAudioReceiverProposal(process.argv.slice(2))));
