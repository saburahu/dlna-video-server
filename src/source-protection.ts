/** Positive container-header evidence only. A filename such as NoDRM is irrelevant. */
export function sourceProtection(probe:any):string|undefined{
 if(typeof probe.protection==='string'&&probe.protection)return probe.protection;
 for(const tags of [probe.format?.tags,...(probe.streams??[]).map((s:any)=>s.tags)]){
  for(const [key,value] of Object.entries(tags??{})){
   if(/^encryption$/i.test(key)&&typeof value==='string'&&value.trim())return `Container encryption: ${value}`;
   if(/^ASF_Protection_Type$/i.test(key)&&/DRM/i.test(String(value)))return 'ASF header declares DRM protection';
  }
 }
}
