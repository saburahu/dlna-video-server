import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAutomaticJitClients,AUTOMATIC_CLIENT_VERSION} from '../src/automatic-jit-client.js';
import {endpointFamilyFeatures,classifyClientFamily,FAMILY_VERSION} from '../src/client-family.js';
import {snapshotHash} from '../src/playback-shadow.js';
import {initialShadowPolicy} from '../src/shadow-profile-policy.js';
import type {ExperimentalJitPolicy} from '../src/experimental-jit.js';
const ua={'user-agent':'Intel_SDK_for_UPnP_devices/1.2'};
function endpoint(ip:string){
 const features=endpointFamilyFeatures('<serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/MediaRenderer/ConnectionManager/Control</controlURL><SCPDURL>/xml/ConnectionManager.xml</SCPDURL>',['Intel_SDK_for_UPnP_devices/1.2']);
 const family=classifyClientFamily(features.signals),device={remoteIp:ip,deviceId:'uuid:synthetic-'+ip,descriptionUrl:`http://${ip}/description.xml`,controlUrl:`http://${ip}/cm`,allowEmptySink:true};
 return {device,features,capability:{...device,sink:'',sinkHash:snapshotHash(''),acquiredAt:new Date().toISOString(),origin:'current-read' as const,implementation:{version:FAMILY_VERSION,family:family.family,fingerprint:family.fingerprint}}};
}
const policy=():ExperimentalJitPolicy=>({version:'experimental-jit-v1',enabled:true,targetProfile:'legacy-jp-observed',items:[],capabilities:[],policy:initialShadowPolicy(),automaticClients:{version:AUTOMATIC_CLIENT_VERSION,enabled:true}});

test('empty discovery recovers autonomously in five seconds; burst Browse does not wait or duplicate jobs',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=Date.now(),calls=0,up=false;
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'discovery-retry-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const events:any[]=[],m=createAutomaticJitClients(dir,(event,detail)=>events.push({event,detail}),async()=>{calls++;return up?[endpoint('10.1.2.3')]:[];},()=>now);t.after(()=>m.close());
 await Promise.all(Array.from({length:100},()=>m.observe('10.1.2.3',ua,'',true)));await m.idle();assert.equal(calls,1);assert.equal(m.resolve(policy(),'10.1.2.3').binding,undefined);
 await Promise.all(Array.from({length:100},()=>m.observe('10.1.2.3',ua,'',true)));await m.idle();assert.equal(calls,1);assert.equal(m.status().retries,1);
 up=true;now+=5000;t.mock.timers.tick(5000);await Promise.resolve();await m.idle();assert.equal(calls,2);assert.ok(m.resolve(policy(),'10.1.2.3').binding);assert.equal(m.status().retries,0);
 assert.ok(events.some(e=>e.event==='AUTO_CLIENT_RETRY_WAIT'));assert.equal(events.filter(e=>e.event==='AUTO_CLIENT_RETRY_SCHEDULED').length,1);
});

test('failure backoff is bounded, old capability never renews, locators survive empty results and restart',async t=>{
 let now=Date.now(),up=true,calls=0;const ep=endpoint('10.1.2.3'),hints:any[]=[],events:any[]=[];
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'discovery-hints-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const discover=async(_ip:string,known:readonly any[]=[])=>{calls++;hints.push(known);return up?[ep]:[];};
 const m=createAutomaticJitClients(dir,(event,detail)=>events.push({event,detail}),discover,()=>now);
 await m.observe(ep.device.remoteIp,ua,'',true);await m.idle();const first=m.resolve(policy(),ep.device.remoteIp).binding;assert.ok(first);
 up=false;now+=300001;
 for(const delay of [5000,15000,30000,60000,60000]){
  await m.observe(ep.device.remoteIp,ua,'',true);await m.idle();assert.equal(m.resolve(policy(),ep.device.remoteIp).binding,undefined);
  assert.equal(events.at(-2).event,'AUTO_CLIENT_RETRY_SCHEDULED');assert.equal(events.at(-2).detail.delayMs,delay);
  assert.equal(hints.at(-1)[0].deviceId,ep.device.deviceId);now+=delay;
 }
 await m.close();
 const restarted=createAutomaticJitClients(dir,()=>{},discover,()=>now);t.after(()=>restarted.close());
 await restarted.observe(ep.device.remoteIp,ua,'',true);await restarted.idle();assert.equal(restarted.resolve(policy(),ep.device.remoteIp).binding,undefined);assert.equal(hints.at(-1)[0].deviceId,ep.device.deviceId);
 up=true;now+=5000;await restarted.observe(ep.device.remoteIp,ua,'',true);await restarted.idle();assert.equal(restarted.resolve(policy(),ep.device.remoteIp).binding,first);
 assert.equal(calls,8);
});

test('multiple peers serialize blocked discovery; Browse returns first and pending jobs remain bounded',async t=>{
 let release!:()=>void,active=0,peak=0,calls=0;
 const gate=new Promise<void>(r=>release=r),dir=await fs.mkdtemp(path.join(os.tmpdir(),'discovery-bounded-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const m=createAutomaticJitClients(dir,()=>{},async ip=>{calls++;active++;peak=Math.max(peak,active);await gate;active--;return [endpoint(ip)];});t.after(()=>m.close());
 await Promise.all(Array.from({length:40},(_,i)=>m.observe('10.1.2.'+(i+1),ua,'',true)));
 assert.ok(m.status().pending<=16);assert.equal(active,1,'network job is running while Browse already returned');release();await m.idle();assert.equal(peak,1);assert.ok(calls<=16);
});
