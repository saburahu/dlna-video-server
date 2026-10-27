import {classifyClientFamily,classifyRequestContext,type FamilyEndpoint,type FamilySignal}from'./client-family.js';
import type{ReceiverPlaybackProfile}from'./receiver-playback-profile.js';
/** These are empirical candidates, never a DMS Source -> DMP capability conversion. */
export function receiverCompatibilityAxes(endpoint:FamilyEndpoint,sink:string,playback?:ReceiverPlaybackProfile,requests:readonly FamilySignal[]=[],host:readonly FamilyEndpoint[]=[endpoint]){
 const implementation=classifyClientFamily(endpoint.signals),context=requests.length?classifyRequestContext([endpoint],requests):undefined;
 const family=context?.family??implementation.family;
 const target=family==='intel-upnp-layout'?'legacy-jp-observed':family==='dixim-service-layout'?'mpeg2-jp-pcr-split-v1':undefined;
 return {version:'receiver-compatibility-axes-v1' as const,receive:{recipeCandidate:target,sinkAdvertised:sink.trim().length>0,evidence:target?'empirical-output-recipe; source and current request binding required':'insufficient',decoderGuarantee:false,sourceAdvertisementUsed:false},software:{implementationFamily:family,requestCorroborated:!!context?.family,cadence:playback?.id==='regza-intel-server-cfr-v1'?'cfr-inferred-not-proven-for-every-receiver':playback?.id==='regza-intel-renderer-vfr-v1'?'vfr-observed-profile':'not-established',roleEvidence:endpoint.roles,coResidentFamilies:[...new Set(host.flatMap(e=>e.signals.map(s=>s.family)).filter(f=>f!==family))]},unknowns:['Shared chipset or product category does not establish playback software compatibility','No per-model/individual acceptance inferred','No source-advertised codecs used as receive proof']};
}
