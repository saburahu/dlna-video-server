import {snapshotHash,type CapabilitySnapshot} from './playback-shadow.js';
import {jitRecipeFingerprint,matchingJitTrial} from './jit-client-trial.js';
import {resolveJitClient,clientAddress} from './jit-client-policy.js';
import type {AutomaticClientResolution} from './automatic-jit-client.js';
import type {ExperimentalJitPolicy} from './experimental-jit.js';

export interface IndividualAdmission {
 deviceId:string;targetProfile:string;recipeFingerprint:string;identityFingerprint:string;
 reference:string;confirmedAt:string;allowTargetDisagreement?:boolean;
}
export interface ClientAdmissions {version:'client-admission-v1';legacySuccesses:IndividualAdmission[];forcedOverrides?:IndividualAdmission[]}
export interface ClientAdmission {route:'automatic'|'legacy-fallback'|'explicit-override'|'individual-first'|'denied';reason:string;binding?:string;policy?:ExperimentalJitPolicy}
export const admissionIdentity=(c:CapabilitySnapshot)=>snapshotHash(JSON.stringify({deviceId:c.deviceId,controlUrl:c.controlUrl,sinkHash:c.sinkHash,implementation:c.implementation}));

/** Identity and empirical records are separate from implementation classification.
 * A missing request feature may fall back; a contradictory feature never does. */
export function selectClientAdmission(p:ExperimentalJitPolicy,remote:string,auto:AutomaticClientResolution):ClientAdmission {
 const legacy=resolveJitClient(p,remote),deny=(reason:string):ClientAdmission=>({route:'denied',reason});
 const oldMode=p.automaticClients?.priority!=='automatic-first'||!p.automaticClients.enabled;
 if(oldMode){
  if(legacy.reason.startsWith('ambiguous')||legacy.reason==='invalid-capability-snapshot')return deny(legacy.reason);
  if(legacy.profile&&!matchingJitTrial(p.clientTrials,legacy.capability!,legacy.profile)?.automaticEvidence)return {route:'individual-first',reason:legacy.reason,policy:{...p,targetProfile:legacy.profile.id}};
 }
 const observed=auto.observed,requests=observed?.requests??[],requestFamilies=new Set(requests.map(s=>s.family));
 if(auto.endpoint&&clientAddress(auto.endpoint.capability.remoteIp)!==clientAddress(remote))return deny('automatic-endpoint-address-mismatch');
 if(requestFamilies.size>1||auto.reason==='conflicting-request-implementations')return deny('conflicting-request-implementations');
 if(legacy.reason.startsWith('ambiguous')||legacy.reason==='invalid-capability-snapshot')return deny(legacy.reason);
 const caps=p.capabilities.filter(c=>clientAddress(c.remoteIp)===clientAddress(remote)),stored=caps[0];
 const agrees=(a:CapabilitySnapshot,b:CapabilitySnapshot)=>a.deviceId===b.deviceId&&a.controlUrl===b.controlUrl&&a.sinkHash===b.sinkHash&&(!a.implementation||admissionIdentity(a)===admissionIdentity(b));
 if(stored&&observed?.endpoints.length&&(!observed.fresh||!observed.endpoints.some(e=>agrees(stored,e.capability))))return deny('current-identity-or-implementation-mismatch');
 if(stored?.implementation&&observed?.endpoints.some(e=>agrees(stored,e.capability)&&e.features.signals.some(s=>s.family!==stored.implementation?.family)))return deny('current-endpoint-features-conflict');
 if(stored?.implementation&&requests.some(s=>s.family!==stored.implementation?.family))return deny('request-family-conflicts-with-identity');
 const records=p.clientAdmissions?.version==='client-admission-v1'?p.clientAdmissions:undefined;
 const valid=(r:IndividualAdmission)=>!!stored&&r.deviceId===stored.deviceId&&r.identityFingerprint===admissionIdentity(stored)&&!!r.reference.trim()&&Number.isFinite(Date.parse(r.confirmedAt))&&p.policy.profiles.some(v=>v.id===r.targetProfile&&jitRecipeFingerprint(v)===r.recipeFingerprint);
 const force=(records?.forcedOverrides??[]).filter(r=>r.deviceId===stored?.deviceId),success=(records?.legacySuccesses??[]).filter(r=>r.deviceId===stored?.deviceId);
 if(force.length>1||success.length>1)return deny('ambiguous-individual-admission');
 if(force.length&&!valid(force[0]))return deny('invalid-explicit-override');
 if(success.length&&!valid(success[0]))return deny('stale-legacy-success-record');
 const selectedRecord=force[0]??success[0];
 if(auto.profile&&auto.endpoint&&auto.trial&&auto.binding){
  if(stored&&!agrees(stored,auto.endpoint.capability))return deny('automatic-identity-mismatch');
  const registeredTarget=selectedRecord?.targetProfile??legacy.profile?.id;
  if(registeredTarget&&registeredTarget!==auto.profile.id&&!(force[0]?.allowTargetDisagreement))return deny('automatic-and-registered-target-conflict');
  if(!force.length){const cap=auto.endpoint.capability;return {route:'automatic',reason:auto.reason,binding:auto.binding,policy:{...p,targetProfile:auto.profile.id,capabilities:[...p.capabilities.filter(c=>clientAddress(c.remoteIp)!==clientAddress(remote)),cap],clientTrials:[...(p.clientTrials??[]).filter(t=>t.deviceId!==cap.deviceId),auto.trial],policy:{...p.policy,observations:p.policy.observations.filter(o=>o.deviceId!==cap.deviceId)}}};}
 }
 if(!oldMode){
  const temporary=['automatic-binding-pending-or-expired','request-implementation-missing','request-structure-insufficient','no-corroborating-current-endpoint'].includes(auto.reason);
  if(!auto.profile&&!temporary)return deny(auto.reason);
  // Current same-peer corroboration is required even for a confirmed fallback.
  const same=observed?.fresh?observed.endpoints.filter(e=>stored&&agrees(stored,e.capability)):[];
  if(same.length!==1||!stored?.implementation)return deny('legacy-identity-not-currently-corroborated');
  if(!selectedRecord||!legacy.profile||legacy.profile.id!==selectedRecord.targetProfile)return deny('no-confirmed-individual-fallback');
  const route=force.length?'explicit-override':'legacy-fallback';
  const binding=snapshotHash(JSON.stringify({version:'individual-admission-v1',remote:clientAddress(remote),route,record:selectedRecord,requests}));
  return {route,reason:force.length?(auto.profile&&auto.profile.id!==selectedRecord.targetProfile?'explicit-target-disagreement-approved':'explicit-operator-override'):'temporary-fingerprint-insufficiency; current identity corroborated',binding,policy:{...p,targetProfile:selectedRecord.targetProfile}};
 }
 return deny(auto.reason);
}
