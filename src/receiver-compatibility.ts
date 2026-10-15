import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {readShadowJson,saveShadowJson,type acquireCapability} from './playback-shadow-store.js';
import {snapshotHash} from './playback-shadow.js';
import type {DiscoveredClientEndpoint} from './client-family-discovery.js';
import type {ExperimentalJitPolicy} from './experimental-jit.js';
import type {ReceiverCfrTrial} from './receiver-cfr-trial.js';

export interface CompatibilityPeer {endpoint:DiscoveredClientEndpoint;eligible:boolean;reason:string}
const identity=(e:DiscoveredClientEndpoint)=>({deviceId:e.capability.deviceId,remoteIp:e.capability.remoteIp,controlUrl:e.capability.controlUrl,sinkHash:e.capability.sinkHash,implementation:e.capability.implementation?.fingerprint});
export const AVI_CFR_SCOPE='AVI / msmpeg4v3 / 23.976fps±0.002 / 最大720×576。対象入力だけ29.97fps CFRへ変換';
/** Operator settings reuse the old opt-in schema; existing trials need no destructive migration. */
export function createReceiverCompatibility(file:string,peers:()=>CompatibilityPeer[],acquire:typeof acquireCapability){
 let tail:Promise<unknown>=Promise.resolve();
 async function inspect(){
  const policy=await readShadowJson<ExperimentalJitPolicy>(file),records=policy?.receiverCfrTrials??[],observed=peers(),rows:any[]=[];
  for(const peer of observed){
   const e=peer.endpoint,id=snapshotHash(JSON.stringify(identity(e))),saved=records.filter(r=>r.deviceId===e.capability.deviceId),enabled=saved.some(r=>r.enabled);
   const unique=observed.filter(p=>p.endpoint.capability.deviceId===e.capability.deviceId&&p.eligible).length===1;
   const eligible=peer.eligible&&unique&&!!e.capability.implementation?.fingerprint;
   rows.push({id,revision:snapshotHash(JSON.stringify({identity:identity(e),eligible,saved})),deviceId:e.capability.deviceId,remoteIp:e.capability.remoteIp,description:e.description,family:e.capability.implementation?.family,enabled,eligible,reason:eligible?'現在の個体・要求・AVC targetを確認済み':unique?peer.reason:'同じUDNの対応が曖昧',configured:saved.length>0});
  }
  for(const r of records)if(!rows.some(row=>row.deviceId===r.deviceId))rows.push({id:'saved-'+snapshotHash(r.deviceId),revision:snapshotHash(JSON.stringify(records.filter(v=>v.deviceId===r.deviceId))),deviceId:r.deviceId,enabled:r.enabled,eligible:false,reason:'現在の要求元との対応なし。無効化のみ可能',configured:true});
  return {version:'receiver-compatibility-v1',scope:AVI_CFR_SCOPE,clients:rows};
 }
 async function change(input:any){
  assert.ok(input&&typeof input.id==='string'&&input.id.length<=100&&typeof input.revision==='string'&&typeof input.enabled==='boolean','Invalid compatibility setting');
  let state=await inspect(),row=state.clients.find(r=>r.id===input.id);assert.ok(row&&row.revision===input.revision,'Client changed; refresh client list');
  let evidence:DiscoveredClientEndpoint|undefined;
  if(input.enabled){
   assert.ok(row.eligible,'Current unambiguous AVC client evidence required');
   evidence=peers().find(p=>snapshotHash(JSON.stringify(identity(p.endpoint)))===row.id)?.endpoint;assert.ok(evidence);
   const current=await acquire(evidence.device,AbortSignal.timeout(10000));
   assert.deepEqual(identity({...evidence,capability:current}),identity(evidence),'Client identity or implementation changed during configuration');
   state=await inspect();row=state.clients.find(r=>r.id===input.id);assert.ok(row?.eligible&&row.revision===input.revision,'Client evidence expired or changed');
  }
  // Read at mutation time: preserve unrelated policy fields and registrations.
  const original=await fs.readFile(file,'utf8'),policy=JSON.parse(original) as ExperimentalJitPolicy;
  assert.equal(policy.version,'experimental-jit-v1');
  const previous=policy.receiverCfrTrials??[],updated=previous.filter(r=>r.deviceId!==row.deviceId);
  if(input.enabled){const c=evidence!.capability;updated.push({version:'receiver-cfr-trial-v1',enabled:true,deviceId:c.deviceId,sinkHash:c.sinkHash,implementationFingerprint:c.implementation!.fingerprint,reference:'Operator selected individual AVI CFR compatibility; RECEIVER_COMPATIBILITY.md',configuredBy:'operator',updatedAt:new Date().toISOString()} satisfies ReceiverCfrTrial);}
  else updated.push(...previous.filter(r=>r.deviceId===row.deviceId).map(r=>({...r,enabled:false,configuredBy:'operator' as const,updatedAt:new Date().toISOString()})));
  assert.equal(await fs.readFile(file,'utf8'),original,'Policy changed concurrently; retry');
  await saveShadowJson(file,{...policy,receiverCfrTrials:updated});
  return inspect();
 }
 return {inspect,configure(input:unknown){const job=tail.catch(()=>{}).then(()=>change(input));tail=job;return job;}};
}
