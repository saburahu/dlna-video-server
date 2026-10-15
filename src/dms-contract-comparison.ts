import {declaredObjects} from './dms-contract-snapshot.js';

export interface ContractSnapshot {
 acquiredAt:string;
 inspection:{device:{deviceId:string;friendlyName?:string;model?:string}};
 browse:{responseXml:string;sha256:string};
}
export interface HttpContractEvidence {
 /** Explicit provenance: a packet trace or response log, never inferred from DIDL. */
 reference:string;observedAt:string;resourceUrl:string;method:'GET'|'HEAD';status:number;
 requestHeaders:Record<string,string>;responseHeaders:Record<string,string>;
 framing?:string;
}
const decode=(s:string)=>s.replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
export function snapshotObjects(snapshot:ContractSnapshot){
 const result=/<(?:\w+:)?Result\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Result>/.exec(snapshot.browse.responseXml)?.[1];
 if(result===undefined)throw Error('Snapshot has no Browse Result');
 return declaredObjects(decode(result));
}
function side(snapshot:ContractSnapshot,objectId:string,http?:HttpContractEvidence){
 const object=snapshotObjects(snapshot).find(x=>x.attributes.id===objectId);
 if(!object)throw Error(`Object absent from captured page: ${objectId}`);
 if(http&&(!http.reference||!http.observedAt||!object.resources.some(r=>r.url===http.resourceUrl)))throw Error('HTTP evidence must cite a trace and match a captured resource URL');
 return {device:snapshot.inspection.device,acquiredAt:snapshot.acquiredAt,browseSha256:snapshot.browse.sha256,object,
  declaration:object.resources.map(r=>({mime:r.mime,parameters:r.parameters,protection:r.protection,
   attributeNames:Object.keys(r.attributes).sort(),duration:r.attributes.duration??null,
   durationHourDigits:r.attributes.duration?.split(':')[0].length??null,size:r.attributes.size??null,bitrate:r.attributes.bitrate??null})),
  http:http??null,httpStatus:http?'observed-response-not-receiver-success':'unobserved',framing:http?.framing??'unknown'};
}
/** Offline only. Receiver observations and transport observations stay independent. */
export function compareDmsContracts(left:ContractSnapshot,leftId:string,right:ContractSnapshot,rightId:string,http?:{left?:HttpContractEvidence;right?:HttpContractEvidence}){
 return {version:'dms-contract-comparison-v1',left:side(left,leftId,http?.left),right:side(right,rightId,http?.right),
  limitations:['Different source programmes are not a controlled media comparison; numeric duration/size/bitrate differences are source-dependent',
   'Browse acquisition does not prove this resource was selected or decoded by DBR',
   'User-reported server success does not identify the selected PN/fallback resource or actual HTTP contract',
   'DTCP-signalled resources cannot establish the required contract for unprotected PT3 media',
   'DIDL PN/ARIB declarations do not prove actual TS/TTS packet framing; no delivery change is recommended automatically']};
}
