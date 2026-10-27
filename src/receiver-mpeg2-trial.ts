import {snapshotHash,type CapabilitySnapshot} from './playback-shadow.js';
import {FAMILY_VERSION} from './client-family.js';
export const MPEG2_TRIAL_TARGET='mpeg2-jp-pcr-split-v1';
export interface ReceiverMpeg2Trial {
 version:'receiver-mpeg2-trial-v1'; deviceId:string;controlUrl:string;sinkHash:string;implementationFingerprint:string;targetProfile:typeof MPEG2_TRIAL_TARGET;
 wmaProInput:boolean;dualAudio:boolean;reference:string;configuredAt:string;
}
/** Only an explicitly selected, request-bound, currently corroborated endpoint.
 * Source eligibility and all existing opt-outs remain separate, mandatory gates. */
export function mpeg2TrialState(records:readonly ReceiverMpeg2Trial[]|undefined,cap:CapabilitySnapshot|undefined,target:string,bound:boolean){
 const related=Array.isArray(records)?records.filter(r=>r?.deviceId===cap?.deviceId):[];
 const base={configured:related.length>0,revision:snapshotHash(JSON.stringify(related)),wmaProInput:false,dualAudio:false};
 const no=(reason:string)=>({...base,reason});
 if(target!==MPEG2_TRIAL_TARGET)return no('not-mpeg2-target');
 if(records!==undefined&&!Array.isArray(records))return no('invalid-mpeg2-trial-list');
 if(!related.length)return no('mpeg2-trial-not-configured');
 if(related.length!==1)return no('ambiguous-mpeg2-trial');
 if(!bound||!cap||cap.origin!=='current-read'||cap.implementation?.version!==FAMILY_VERSION||cap.implementation.family!=='dixim-service-layout')return no('current-bound-mpeg2-client-required');
 const r=related[0];
 if(r.version!=='receiver-mpeg2-trial-v1'||r.targetProfile!==target||typeof r.wmaProInput!=='boolean'||typeof r.dualAudio!=='boolean'||typeof r.reference!=='string'||!r.reference.trim()||!Number.isFinite(Date.parse(r.configuredAt)))return no('invalid-mpeg2-trial-record');
 if(!r.deviceId||r.controlUrl!==cap.controlUrl||r.sinkHash!==cap.sinkHash||snapshotHash(cap.sink)!==cap.sinkHash||r.implementationFingerprint!==cap.implementation.fingerprint)return no('mpeg2-trial-identity-mismatch');
 return {...base,wmaProInput:r.wmaProInput,dualAudio:r.dualAudio,reason:r.wmaProInput||r.dualAudio?'explicit-bound-receiver-mpeg2-trial':'mpeg2-trial-disabled'};
}
