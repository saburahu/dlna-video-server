import assert from'node:assert/strict';
import fs from'node:fs/promises';
import {readShadowJson,saveShadowJson,type acquireCapability} from './playback-shadow-store.js';
import {snapshotHash} from './playback-shadow.js';
import type {CompatibilityPeer} from './receiver-compatibility.js';
import type {ExperimentalJitPolicy} from './experimental-jit.js';
import {MPEG2_TRIAL_TARGET,mpeg2TrialState,type ReceiverMpeg2Trial} from './receiver-mpeg2-trial.js';
const identity=(e:CompatibilityPeer['endpoint'])=>({deviceId:e.capability.deviceId,remoteIp:e.capability.remoteIp,controlUrl:e.capability.controlUrl,sinkHash:e.capability.sinkHash,implementation:e.capability.implementation});
/** Management operation only. Current request binding is supplied by normal
 * admission, never manufactured by this endpoint. No renderer commands. */
export function createMpeg2TrialSettings(file:string,peers:()=>CompatibilityPeer[],acquire:typeof acquireCapability,busy:()=>boolean){
 let tail:Promise<unknown>=Promise.resolve();
 async function inspect(){const p=await readShadowJson<ExperimentalJitPolicy>(file),records=p?.mpeg2ReceiverTrials??[],observed=peers(),rows:any[]=[];assert.ok(Array.isArray(records),'Invalid MPEG-2 trial list');
  for(const peer of observed){const e=peer.endpoint,related=records.filter(r=>r.deviceId===e.capability.deviceId),eligible=peer.eligible&&e.capability.origin==='current-read'&&e.capability.implementation?.family==='dixim-service-layout'&&observed.filter(v=>v.eligible&&v.endpoint.capability.deviceId===e.capability.deviceId).length===1;
   const state=mpeg2TrialState(records,e.capability,MPEG2_TRIAL_TARGET,eligible);
   rows.push({id:snapshotHash(JSON.stringify(identity(e))),revision:snapshotHash(JSON.stringify({identity:identity(e),eligible,related})),deviceId:e.capability.deviceId,remoteIp:e.capability.remoteIp,description:e.description,eligible,reason:eligible?state.reason:peer.eligible?'Ambiguous or incompatible current endpoint':peer.reason,configuredWmaProInput:related[0]?.wmaProInput===true,configuredDualAudio:related[0]?.dualAudio===true,wmaProInput:state.wmaProInput,dualAudio:state.dualAudio,configured:state.configured});}
  for(const r of records)if(!rows.some(row=>row.deviceId===r.deviceId))rows.push({id:'saved-'+snapshotHash(r.deviceId),revision:snapshotHash(JSON.stringify(records.filter(v=>v.deviceId===r.deviceId))),deviceId:r.deviceId,eligible:false,configured:true,configuredWmaProInput:r.wmaProInput===true,configuredDualAudio:r.dualAudio===true,wmaProInput:false,dualAudio:false,reason:'No current bound endpoint; disable only'});
  return {version:'receiver-mpeg2-trial-settings-v1',target:MPEG2_TRIAL_TARGET,legacyGlobalFlagIgnored:p?.mpeg2InputTrial===true,clients:rows};
 }
 async function change(input:any){assert.ok(input&&typeof input.id==='string'&&input.id.length<=100&&typeof input.revision==='string'&&typeof input.wmaProInput==='boolean'&&typeof input.dualAudio==='boolean','id/revision and both independent boolean settings required');assert.ok(!busy(),'Stop playback before changing receiver trial');
  let state=await inspect(),row=state.clients.find(r=>r.id===input.id);assert.ok(row&&row.revision===input.revision,'Receiver/settings changed; refresh list');
  let evidence:CompatibilityPeer['endpoint']|undefined;
  if(input.wmaProInput||input.dualAudio){assert.ok(row.eligible,'Current unambiguous bound MPEG-2 receiver required');evidence=peers().find(p=>p.eligible&&snapshotHash(JSON.stringify(identity(p.endpoint)))===row.id)?.endpoint;assert.ok(evidence);const current=await acquire(evidence.device,AbortSignal.timeout(10000));assert.ok(current.origin==='current-read'&&snapshotHash(current.sink)===current.sinkHash,'Fresh capability required');assert.deepEqual(identity({...evidence,capability:current}),identity(evidence),'Receiver identity changed during configuration');state=await inspect();row=state.clients.find(r=>r.id===input.id);assert.ok(row?.eligible&&row.revision===input.revision,'Receiver evidence expired or changed');}
  const original=await fs.readFile(file,'utf8'),p=JSON.parse(original) as ExperimentalJitPolicy;assert.equal(p.version,'experimental-jit-v1');assert.ok(Array.isArray(p.mpeg2ReceiverTrials??[]));const previous=p.mpeg2ReceiverTrials??[],related=previous.filter(r=>r.deviceId===row.deviceId);assert.ok(related.length<=1,'Ambiguous existing trial records; explicit review required');let updated:ReceiverMpeg2Trial[];
  if(evidence){const c=evidence.capability;updated=[...previous.filter(r=>r.deviceId!==c.deviceId),{version:'receiver-mpeg2-trial-v1',deviceId:c.deviceId,controlUrl:c.controlUrl,sinkHash:c.sinkHash,implementationFingerprint:c.implementation!.fingerprint,targetProfile:MPEG2_TRIAL_TARGET,wmaProInput:input.wmaProInput,dualAudio:input.dualAudio,reference:'Operator-selected current receiver trial; no source enrollment or TV success inferred',configuredAt:new Date().toISOString()}];}
  else updated=previous.map(r=>r.deviceId===row.deviceId?{...r,wmaProInput:false,dualAudio:false}:r);
  assert.ok(!busy(),'Playback began; retry after stop');assert.equal(await fs.readFile(file,'utf8'),original,'Policy changed concurrently; retry');await saveShadowJson(file,{...p,mpeg2InputTrial:false,mpeg2ReceiverTrials:updated});return inspect();
 }
 return {inspect,configure(input:unknown){const job=tail.catch(()=>{}).then(()=>change(input));tail=job;return job;}};
}
