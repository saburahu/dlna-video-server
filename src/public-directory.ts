/** Virtual development nodes only. Real folders use opaque folder IDs, so a
 * directory named "Experimental Media" is not affected. HTTP tools stay intact. */
export const DEVELOPMENT_DIRECTORY_ROOTS=['experimental','client-diagnostics','avc-http-control','mpeg-ts-trial'] as const;
// Advance wire UpdateID for TS-derived channel numbers and ARIB broadcast types.
export const PUBLIC_MENU_REVISION=4;
export const developmentDirectory=(id:string)=>DEVELOPMENT_DIRECTORY_ROOTS.some(root=>id===root||id.startsWith(root+'/'));
export function menuRevisionSoap(xml:string,action:string){
 const tag=action==='Browse'?'UpdateID':action==='GetSystemUpdateID'?'Id':undefined;
 return tag?xml.replace(new RegExp(`<${tag}>(\\d+)</${tag}>`),(_,n)=>`<${tag}>${(Number(n)+PUBLIC_MENU_REVISION)>>>0}</${tag}>`):xml;
}
