import type{IncomingMessage}from'node:http';
/** Admin is local-only. Device HTTP/SOAP traffic does not pass through this gate. */
export function managementAccess(req:Pick<IncomingMessage,'headers'|'method'|'socket'>,port:number):string|undefined{
 const peer=(req.socket.remoteAddress??'').replace(/^::ffff:/,'');if(!['127.0.0.1','::1'].includes(peer))return 'Management requires loopback';
 let host:URL;try{host=new URL('http://'+String(req.headers.host??''));}catch{return 'Invalid management Host';}
 if(!['localhost','127.0.0.1','[::1]'].includes(host.hostname)||Number(host.port||80)!==port||host.username||host.password||host.pathname!=='/')return 'Untrusted management Host';
 if(req.headers.origin!==undefined&&req.headers.origin!==host.origin)return 'Cross-origin management request';
 if(req.headers['sec-fetch-site']==='cross-site')return 'Cross-site management request';
 if(!['GET','HEAD','OPTIONS'].includes(req.method??'')&&req.headers['x-pt3-management']!=='1')return 'Management request header required';
}
export function redactHeaders(value:unknown):unknown{
 if(Array.isArray(value))return value.map(redactHeaders);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|password|access_token|refresh_token)$/i.test(k)?'[REDACTED]':redactHeaders(v)]));
 return value;
}
