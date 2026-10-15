import {matchingJitTrial} from './jit-client-trial.js';
import {parseSinkProtocolInfo} from './playback-decision.js';
import {snapshotHash} from './playback-shadow.js';
import type {ExperimentalJitPolicy} from './experimental-jit.js';

export const clientAddress=(s:string)=>s.replace(/^::ffff:/,'');

/** Cached receive evidence only. Source advertisements, model and User-Agent are not inputs.
 * GET must revalidate this exact UDN/Sink binding against the registered endpoint.
 */
export function resolveJitClient(p:ExperimentalJitPolicy,remote:string){
 const matches=p.capabilities.filter(c=>clientAddress(c.remoteIp)===clientAddress(remote));
 if(matches.length!==1)return {reason:matches.length?'ambiguous-client-address':'unregistered-client',unknowns:['No unique cached UDN/Sink binding for this request address']};
 const capability=matches[0];
 if(!capability.deviceId||capability.sinkHash!==snapshotHash(capability.sink))return {reason:'invalid-capability-snapshot',unknowns:['Capability identity/hash invalid']};
 const trials=p.policy.profiles.filter(profile=>matchingJitTrial(p.clientTrials,capability,profile));
 if(trials.length>1)return {reason:'ambiguous-trial-target',unknowns:['Multiple authorized trial targets; explicit selection required']};
 if(trials.length===1)return {capability,profile:trials[0],reason:'explicit-client-trial',unknowns:['Trial permission is not an advertised or experimentally-confirmed receive capability']};
 const sinks=parseSinkProtocolInfo(capability.sink);
 const confirmed=p.policy.profiles.filter(profile=>sinks.some(s=>s.protocol==='http-get'&&s.mime===profile.transport.value.mime&&s.profileName===profile.transport.value.profileName)&&
  p.policy.observations.some(o=>o.deviceId===capability.deviceId&&o.sinkHash===capability.sinkHash&&o.observation.profileId===profile.id&&o.observation.outcome==='success'&&o.observation.framing===profile.transport.value.framing));
 const profile=confirmed.find(v=>v.id===p.targetProfile)??(confirmed.length===1?confirmed[0]:undefined);
 if(profile)return {capability,profile,reason:'advertised-and-observed-target',unknowns:['Named Sink profile does not establish all decoder constraints; runtime validation required']};
 return {capability,reason:confirmed.length?'ambiguous-confirmed-target':'receive-evidence-insufficient',unknowns:['No unique advertised/observed target or explicit client trial; Source is not Sink']};
}
