import {snapshotHash,type CapabilitySnapshot} from './playback-shadow.js';
import type {MediaProfileDefinition} from './playback-decision.js';
import {FAMILY_VERSION,classifyClientFamily,classifyRequestContext,type FamilyEndpoint,type FamilySignal} from './client-family.js';

export interface JitFamilyTrialEvidence {
  version:typeof FAMILY_VERSION; family:string; endpointFingerprint:string;
  requestFingerprint:string; observedAt:string; reference:string;
}

/** Explicit operator enrollment only. Host-wide multi-stack ambiguity is retained;
 * match the pinned UDN's endpoint to actual outbound requests, never Source. */
export function familyTrialEvidence(report:unknown,cap:CapabilitySnapshot,reference:string):JitFamilyTrialEvidence {
  const r=report as {version:string;clients:{remoteIp:string;identities:{deviceId:string}[];endpoints:FamilyEndpoint[];requestContext:{evidence:FamilySignal[]}}[]};
  if(r?.version!==FAMILY_VERSION||!Array.isArray(r.clients)||!reference.trim())throw Error('Invalid family observation report');
  const clients=r.clients.filter(c=>c.remoteIp===cap.remoteIp);
  if(clients.length!==1)throw Error('Need unique observed address binding');
  const c=clients[0],indices=c.identities.flatMap((v,i)=>v.deviceId===cap.deviceId?[i]:[]);
  if(indices.length!==1||!c.endpoints[indices[0]])throw Error('Pinned UDN endpoint not uniquely observed');
  const endpoint=c.endpoints[indices[0]],ep=classifyClientFamily(endpoint.signals);
  const requests=c.requestContext.evidence.filter(s=>s.dimension==='request-stack'||s.dimension==='browse-extension');
  const context=classifyRequestContext([endpoint],requests);
  if(ep.status!=='classified'||context.status!=='classified'||ep.family!==context.family||
    cap.implementation?.version!==FAMILY_VERSION||cap.implementation.fingerprint!==ep.fingerprint||cap.implementation.family!==ep.family)
    throw Error('Current endpoint and observed request implementation disagree or are unknown');
  return {version:FAMILY_VERSION,family:ep.family!,endpointFingerprint:ep.fingerprint,requestFingerprint:classifyClientFamily(requests).fingerprint,
    observedAt:cap.acquiredAt,reference};
}

/** Explicit trial permission is neither a Sink advertisement nor a playback success. */
export interface JitClientTrial {
  version:'jit-client-trial-v1'; enabled:boolean; deviceId:string; sinkHash:string;
  targetProfile:string; recipeFingerprint:string; containers:readonly string[];
  reference:string;
  familyEvidence?:JitFamilyTrialEvidence;
  automaticEvidence?:{version:'family-candidate-v1';evidenceId:string;family:string;confidence:string;requestFingerprint:string;endpointFingerprint:string;inputPolicy?:'jit-legacy-inputs-v1'};
}
export const jitRecipeFingerprint=(p:MediaProfileDefinition)=>snapshotHash(JSON.stringify({
  transport:p.transport.value,video:p.video.value,audio:p.audio.value
}));
export function matchingJitTrial(trials:readonly JitClientTrial[]|undefined,cap:CapabilitySnapshot,p:MediaProfileDefinition):JitClientTrial|undefined{
  const matches=(Array.isArray(trials)?trials:[]).filter(t=>t&&t.version==='jit-client-trial-v1'&&t.enabled===true&&
    t.deviceId===cap.deviceId&&t.sinkHash===cap.sinkHash&&cap.sinkHash===snapshotHash(cap.sink)&&
    t.targetProfile===p.id&&t.recipeFingerprint===jitRecipeFingerprint(p)&&typeof t.reference==='string'&&t.reference.trim().length>0&&
    Array.isArray(t.containers)&&t.containers.length>0&&t.containers.every((c:unknown)=>typeof c==='string'&&(['mp4','matroska'].includes(c)||t.automaticEvidence?.version==='family-candidate-v1'&&t.automaticEvidence.inputPolicy==='jit-legacy-inputs-v1'&&['avi','asf','ogg'].includes(c)))&&
    (!t.familyEvidence||(t.familyEvidence.version===FAMILY_VERSION&&['intel-upnp-layout','dixim-service-layout'].includes(t.familyEvidence.family)&&t.familyEvidence.family===cap.implementation?.family&&
      cap.implementation?.version===FAMILY_VERSION&&t.familyEvidence.endpointFingerprint===cap.implementation.fingerprint&&
      /^[a-f0-9]{64}$/.test(t.familyEvidence.endpointFingerprint)&&
      /^[a-f0-9]{64}$/.test(t.familyEvidence.requestFingerprint)&&Number.isFinite(Date.parse(t.familyEvidence.observedAt))&&
      typeof t.familyEvidence.reference==='string'&&t.familyEvidence.reference.trim().length>0)));
  return matches.length===1?matches[0]:undefined;
}
export function trialProfile(profile:MediaProfileDefinition,trial:JitClientTrial):MediaProfileDefinition {
  const evidence={status:trial.automaticEvidence?'inferred' as const:'unknown' as const,reference:trial.reference,scope:trial.automaticEvidence?'Empirical family recipe candidate; this individual receiver acceptance unconfirmed; not normative':'Explicit client-scoped diagnostic permission; receiver acceptance unconfirmed'};
  return {...profile,transport:{...profile.transport,evidence},video:{...profile.video,evidence},audio:{...profile.audio,evidence},conformance:trial.automaticEvidence?{status:'unknown',reference:trial.reference,scope:'Family experiment is not normative profile conformance proof'}:evidence};
}
