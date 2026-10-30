/** Development-only presentation experiment. No catalogue or playback mutation.
 * Disabled unless explicitly enabled by the development launcher; resets to A.
 * Transform only legacy recording items originally advertised as videoBroadcast.
 * Keep encoded DIDL untouched outside the two experimental fields. */
import {validMetadata,metadataDisplay} from './recording-metadata.js';
/** Empirical REGZA terrestrial/BS representation, not a universal vendor spec.
 * identified channelInfo was derived with NIT network_id == SDT ONID; TSID is
 * deliberately NOT substituted. CS and uncertain identities lack wire evidence. */
export function regzaRecordingIdentity(value:unknown){
 if(!validMetadata(value)||value.state!=='confirmed'||value.textSuspect||value.channelInfo?.state!=='identified')return;
 const {originalNetworkId:onid,transportStreamId:tsid,serviceId:sid}=value,type=value.channelInfo.objectType;
 if([onid,tsid,sid].some(n=>!Number.isSafeInteger(n)||n!<=0||n!>65535))return;
 if(type==='ARIB_BS'?onid!==4:type==='ARIB_TB'?onid===4:true)return;
 return {network:onid!.toString(16),service:sid!.toString(16)};
}
export function recordingDidlTrial(enabled=false,metadata:(id:string)=>unknown=()=>undefined){
 let condition:'A'|'B'|'C'|'D'='A',revision=enabled?1:0,regzaIds=false,sceneProgramDate=false,recordedStartDate=false;
 return {
  get revision(){return revision;},
  status:()=>({enabled,condition,revision,regzaIds,sceneProgramDate,recordedStartDate}),
  select(value:unknown,ids:unknown=false,programDate:unknown=false,recordedStart:unknown=false){
   if(!enabled||typeof value!=='string'||!['A','B','C','D'].includes(value))throw Error('Enabled development trial and A/B/C/D required');
   if(typeof ids!=='boolean'||ids&&!['B','D'].includes(value))throw Error('REGZA IDs require videoItem presentation (B or D) and a boolean flag');
   if(typeof programDate!=='boolean'||programDate&&!ids)throw Error('Program date comparison requires explicit IDs and a boolean flag');
   if(typeof recordedStart!=='boolean'||recordedStart&&(!programDate||value!=='B'))throw Error('Recorded-start comparison requires successful B/IDs/program-date baseline and a boolean flag');
   if(value!==condition||ids!==regzaIds||programDate!==sceneProgramDate||recordedStart!==recordedStartDate){condition=value as typeof condition;regzaIds=ids;sceneProgramDate=programDate;recordedStartDate=recordedStart;revision++;}
   return this.status();
  },
  soap(xml:string,action:string){
   if(!enabled)return xml;
   const tag=action==='Browse'?'UpdateID':action==='GetSystemUpdateID'?'Id':undefined;
   if(tag)xml=xml.replace(new RegExp(`<${tag}>(\\d+)</${tag}>`),(_,n)=>`<${tag}>${(Number(n)+revision)>>>0}</${tag}>`);
   if(action!=='Browse'||condition==='A')return xml;
   return xml.replace(/(<Result>)([\s\S]*?)(<\/Result>)/,(_,open,didl,close)=>open+didl.replace(/&lt;item\b[\s\S]*?&lt;\/item&gt;/g,(item:string)=>{
    const original='&lt;upnp:class&gt;object.item.videoItem.videoBroadcast&lt;/upnp:class&gt;';
    if(!item.includes(original))return item;
    if(condition==='B'||condition==='D')item=item.replace(original,'&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;');
    // Truncate displayed precision (<1 s), never round into the next second.
    // Preserve explicit JST; cached UTC anchors and all res attributes are intact.
    if(condition==='C'||condition==='D')item=item.replace(/(&lt;(dc:date|upnp:scheduledStartTime|upnp:scheduledEndTime)&gt;\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.\d{3}(\+09:00&lt;\/\2&gt;)/g,'$1$3');
    if(regzaIds){
     const resource=/&lt;res\b[\s\S]*?&gt;([\s\S]*?)&lt;\/res&gt;/.exec(item)?.[1],id=resource&&/\/media\/([a-f0-9]+)\//.exec(resource)?.[1];
     const details=id?metadata(id):undefined,identity=regzaRecordingIdentity(details);
     if(identity&&!item.includes('xmlns:regza=')){
      item=item.replace(/^&lt;item\b[\s\S]*?&gt;/,tag=>tag.replace(/&gt;$/,' xmlns:regza=&quot;urn:schemas-toshiba-co-jp:regzadata-1-0&quot;&gt;'));
      item=item.replace('&lt;/item&gt;',`&lt;regza:network_id&gt;${identity.network}&lt;/regza:network_id&gt;&lt;regza:service_id&gt;${identity.service}&lt;/regza:service_id&gt;&lt;/item&gt;`);
     }
     // Diagnostic only: this changes the TV's displayed clock origin. It is
     // NOT a timestamp/Seek correction; source clock/cache/resource stay intact.
     // Must remain opt-in until the operator authorizes that presentation tradeoff.
     if(identity&&sceneProgramDate){
      const start=/&lt;upnp:scheduledStartTime&gt;([\s\S]*?)&lt;\/upnp:scheduledStartTime&gt;/.exec(item)?.[1];
      if(start&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?\+09:00$/.test(start)&&Number.isFinite(Date.parse(start)))item=item.replace(/(&lt;dc:date&gt;)[\s\S]*?(&lt;\/dc:date&gt;)/,(_,open,close)=>open+start+close);
     }
     // CDS:2 metadata experiment on the CDS:1 endpoint: opt-in only, not a
     // claim that a receiver requests/uses this field or offsets its NPT clock.
     if(identity&&recordedStartDate&&validMetadata(details)&&details.recordingRange?.state!=='discontinuous'&&(details.recordingRange?.segments??1)<=1){
      const origin=details.recordingOrigin?.state==='estimated'?details.recordingOrigin.startTime:details.recordingRange?.state==='consistent'?details.recordingRange.startTime:undefined;
      const date=origin?metadataDisplay({title:"",modified:"",metadata:details}).date:undefined;
      if(date&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+09:00$/.test(date)&&!item.includes('&lt;upnp:recordedStartDateTime'))item=item.replace('&lt;/item&gt;',`&lt;upnp:recordedStartDateTime&gt;${date}&lt;/upnp:recordedStartDateTime&gt;&lt;/item&gt;`);
     }
    }
    return item;
   })+close);
  }
 };
}
export function recordingDidlTrialAccess(address:string|undefined,host:string|undefined,origin:string|undefined,contentType:string|undefined,port:number){
 const ip=(address??'').replace(/^::ffff:/,'');
 return ['127.0.0.1','::1'].includes(ip)&&[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`].includes(host??'')&&(!origin||origin===`http://${host}`)&&/^application\/json(?:\s*;|$)/i.test(contentType??'');
}
