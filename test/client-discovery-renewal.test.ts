import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {addKnownClientLocations,readClientLocations} from '../src/client-family-discovery.js';
import {createAutomaticJitClients,AUTOMATIC_CLIENT_VERSION} from '../src/automatic-jit-client.js';
import {selectClientAdmission} from '../src/jit-client-admission.js';
import {initialShadowPolicy} from '../src/shadow-profile-policy.js';
import type {ExperimentalJitPolicy} from '../src/experimental-jit.js';

test('empty SSDP renews by current same-peer HTTP evidence, preserves Browse binding, changed identity fails closed',async t=>{
 let id='uuid:unknown-peer',unavailable=false,reads=0,now=Date.now();
 const server=createServer((req,res)=>{reads++;res.setHeader('Server','Intel_SDK_for_UPnP_devices/1.2');if(unavailable){res.writeHead(503);res.end();return;}
 res.end(req.url==='/description.xml'?`<root><device><UDN>${id}</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/MediaRenderer/ConnectionManager/Control</controlURL><SCPDURL>/xml/ConnectionManager.xml</SCPDURL></service></serviceList></device></root>`:'<Envelope><Source>untrusted-source-only</Source><Sink></Sink></Envelope>');});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const device={remoteIp:'127.0.0.1',descriptionUrl:base+'/description.xml',controlUrl:base+'/MediaRenderer/ConnectionManager/Control'};
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'renew-peer-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const p:ExperimentalJitPolicy={version:'experimental-jit-v1',enabled:true,targetProfile:'legacy-jp-observed',capabilities:[],items:[],policy:initialShadowPolicy(),automaticClients:{version:AUTOMATIC_CLIENT_VERSION,enabled:true,priority:'automatic-first'}};
 const m=createAutomaticJitClients(dir,()=>{},async(remote,known)=>{const locations=new Map<string,string[]>();addKnownClientLocations(remote,locations,[...(known??[]),device]);return readClientLocations(remote,locations);},()=>now);
 const ua={'user-agent':'Intel_SDK_for_UPnP_devices/1.2'};
 await m.observe(device.remoteIp,ua,'',true);await m.idle();const first=m.resolve(p,device.remoteIp);assert.ok(first.binding);assert.equal(first.endpoint?.discovery,'known-url-revalidated');assert.equal(first.endpoint?.capability.sink,'','Source never treated as Sink');
 p.capabilities=[first.endpoint!.capability];
 now+=300001;await m.observe(device.remoteIp,ua,'',true);await m.idle();const renewed=m.resolve(p,device.remoteIp);
 assert.equal(renewed.binding,first.binding);assert.equal(selectClientAdmission(p,device.remoteIp,renewed).route,'automatic');assert.ok(reads>=6,'Each renewal rereads description and ConnectionManager');
 id='uuid:replacement-at-same-ip';now+=300001;await m.observe(device.remoteIp,ua,'',true);await m.idle();assert.equal(selectClientAdmission(p,device.remoteIp,m.resolve(p,device.remoteIp)).route,'denied');
 unavailable=true;now+=300001;await m.observe(device.remoteIp,ua,'',true);await m.idle();assert.equal(m.resolve(p,device.remoteIp).binding,undefined);
});

test('known URL hints cannot authorize another host, external URL, credentials or unbounded locations',()=>{
 const locations=new Map<string,string[]>(),remote='192.168.1.4';
 for(const url of ['http://192.168.1.5/d','https://192.168.1.4/d','http://u:p@192.168.1.4/d'])addKnownClientLocations(remote,locations,[{remoteIp:remote,descriptionUrl:url,controlUrl:url}]);
 assert.equal(locations.size,0);
 addKnownClientLocations(remote,locations,Array.from({length:30},(_,i)=>({remoteIp:remote,descriptionUrl:`http://${remote}/${i}`,controlUrl:`http://${remote}/cm`})));assert.equal(locations.size,12);
});

test('known URL revalidation logs description, identity, CM and redirect failures without stale authorization',async t=>{
 let mode='ok',sink='';const events:any[]=[];
 const server=createServer((req,res)=>{
  res.setHeader('Server','Intel_SDK_for_UPnP_devices/1.2');
  if(req.url==='/description.xml'){
   if(mode==='redirect'){res.writeHead(302,{Location:'http://192.168.1.9/private'});res.end();return;}
   if(mode==='description'){res.writeHead(503);res.end();return;}
   res.end(`<root><UDN>${mode==='identity'?'uuid:replacement':'uuid:original'}</UDN><service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/MediaRenderer/ConnectionManager/Control</controlURL><SCPDURL>/xml/ConnectionManager.xml</SCPDURL></service></root>`);
  }else{if(mode==='cm'){res.writeHead(503);res.end();return;}res.end(`<Envelope><Source>not-sink</Source><Sink>${sink}</Sink></Envelope>`);}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port,location=base+'/description.xml',remote='127.0.0.1';
 const known=[{remoteIp:remote,deviceId:'uuid:original',descriptionUrl:location,controlUrl:base+'/MediaRenderer/ConnectionManager/Control'}];
 const read=()=>readClientLocations(remote,new Map([[location,[]]]),new Set(),known,(event,detail)=>events.push({event,detail}));
 const first=(await read())[0];assert.ok(first);assert.equal(first.discovery,'known-url-revalidated');
 for(const bad of ['identity','description','cm','redirect']){
  mode=bad;assert.deepEqual(await read(),[]);const last=events.at(-1).detail;
  assert.equal(last.reason,bad==='identity'?'identity-mismatch':bad==='description'?'http-503':'request-failed');
  assert.equal(last.stage,bad==='cm'?'connection-manager':'description');
 }
 mode='ok';sink='http-get:*:video/mpeg:*';const recovered=(await read())[0];assert.ok(recovered);assert.notEqual(recovered.capability.sinkHash,first.capability.sinkHash,'changed capability must produce a different binding, never reuse old evidence');
});
