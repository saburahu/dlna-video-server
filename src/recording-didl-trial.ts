/** Development-only presentation experiment. No catalogue or playback mutation.
 * Disabled unless explicitly enabled by the development launcher; resets to A.
 * Transform only legacy recording items originally advertised as videoBroadcast.
 * Keep encoded DIDL untouched outside the two experimental fields. */
export function recordingDidlTrial(enabled=false){
 let condition:'A'|'B'|'C'|'D'='A',revision=enabled?1:0;
 return {
  get revision(){return revision;},
  status:()=>({enabled,condition,revision}),
  select(value:unknown){
   if(!enabled||typeof value!=='string'||!['A','B','C','D'].includes(value))throw Error('Enabled development trial and A/B/C/D required');
   if(value!==condition){condition=value as typeof condition;revision++;}
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
    return item;
   })+close);
  }
 };
}
export function recordingDidlTrialAccess(address:string|undefined,host:string|undefined,origin:string|undefined,contentType:string|undefined,port:number){
 const ip=(address??'').replace(/^::ffff:/,'');
 return ['127.0.0.1','::1'].includes(ip)&&[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`].includes(host??'')&&(!origin||origin===`http://${host}`)&&/^application\/json(?:\s*;|$)/i.test(contentType??'');
}
