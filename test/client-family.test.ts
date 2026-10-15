import test from 'node:test';import assert from 'node:assert/strict';
import {endpointFamilyFeatures,requestFamilyFeatures,classifyClientFamily,classifyRequestContext,createFamilyShadow} from '../src/client-family.js';
const intelXml='<device><modelName>arbitrary</modelName><UDN>uuid:ignored</UDN><service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/MediaRenderer/ConnectionManager/Control</controlURL><SCPDURL>/xml/ConnectionManager.xml</SCPDURL></service></device>';
const diximXml='<serviceType>urn:schemas-digion-com:service:X_AccessControl:1</serviceType><serviceType>urn:schemas-digion-com:service:X_DeviceConfiguration:1</serviceType>';
const intel=()=>endpointFamilyFeatures(intelXml,['Linux/x Intel_SDK_for_UPnP_devices/1.2']);
const dixim=()=>endpointFamilyFeatures(diximXml,['Linux/y DiXiM/4.0']);
const ua={'User-Agent':'UPnP/1.0 Intel_SDK_for_UPnP_devices/1.2'};
test('implementation classification excludes model, name, UUID, serial, address, manufacturer and Source/Sink',()=>{
 const baseline=intel();const changed=endpointFamilyFeatures(intelXml.replace('arbitrary','DBR-T1010').replace('uuid:ignored','uuid:another')+'<manufacturer>different</manufacturer><friendlyName>secret</friendlyName><serialNumber>SECRET</serialNumber><Source>DiXiM/4.0</Source><Sink>AVC_TS_JP_AAC_T</Sink>',['Linux/x Intel_SDK_for_UPnP_devices/1.2']);assert.deepEqual(changed,baseline);assert.equal(classifyClientFamily(baseline.signals).family,'intel-upnp-layout');assert.doesNotMatch(JSON.stringify(changed),/SECRET|DBR-T1010|AVC_TS/);
});
test('multiple independent dimensions required; repeated SERVER/UA alone never sufficient',()=>{
 assert.equal(classifyClientFamily(endpointFamilyFeatures('',Array(10).fill('DiXiM/4.0')).signals).status,'unknown');const r=requestFamilyFeatures(ua);assert.equal(classifyClientFamily([...r,...r]).status,'unknown');assert.equal(classifyClientFamily([...intel().signals,...r]).confidence,'strong-observation');
 assert.equal(classifyClientFamily([...endpointFamilyFeatures('',['Intel_SDK_for_UPnP_devices/1.2']).signals,...r]).status,'unknown','SERVER and UA repeat a library token; structural corroboration required');
});
test('software versions and device role variation do not become model rules',()=>{
 assert.equal(classifyClientFamily(endpointFamilyFeatures(intelXml.replaceAll('MediaRenderer','MediaServer'),['Intel_SDK_for_UPnP_devices/2.5']).signals).family,'intel-upnp-layout');assert.equal(classifyClientFamily(dixim().signals).family,'dixim-service-layout');assert.equal(classifyClientFamily(endpointFamilyFeatures(diximXml,['DiXiM/9.0']).signals).family,'dixim-service-layout');
});
test('two recorder identities remain separate; mixed Intel/DiXiM host needs actual request context',()=>{
 const host=classifyClientFamily([...intel().signals,...dixim().signals]);assert.equal(host.status,'ambiguous');assert.equal(host.family,undefined);assert.equal(classifyRequestContext([intel(),dixim()],requestFamilyFeatures(ua)).family,'intel-upnp-layout');assert.equal(classifyRequestContext([intel(),dixim()],[]).status,'unknown');assert.equal(classifyRequestContext([dixim()],requestFamilyFeatures({'user-agent':'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0'})).family,'dixim-service-layout');
});
test('mixed-service host gets only provisional request attribution without Browse evidence',()=>{
 const result=classifyRequestContext([intel(),dixim()],requestFamilyFeatures(ua));assert.equal(result.family,'intel-upnp-layout');assert.equal(result.confidence,'supporting-observation');assert.deepEqual(result.otherEndpointFamilies,['dixim-service-layout']);
 const contrary=requestFamilyFeatures({'user-agent':'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0'});assert.equal(classifyRequestContext([intel(),dixim()],[...requestFamilyFeatures(ua),...contrary]).status,'ambiguous');
});
test('SSDP service suffixes retained while UUID identity bytes never affect feature fingerprint',()=>{
 const a=endpointFamilyFeatures(intelXml,['Intel_SDK_for_UPnP_devices/1.2'],[{st:'urn:schemas-upnp-org:device:MediaRenderer:1',usn:'uuid:alpha::urn:schemas-upnp-org:device:MediaRenderer:1'}]);
 const b=endpointFamilyFeatures(intelXml,['Intel_SDK_for_UPnP_devices/1.2'],[{st:'urn:schemas-upnp-org:device:MediaRenderer:1',usn:'uuid:beta::urn:schemas-upnp-org:device:MediaRenderer:1'}]);assert.deepEqual(a,b);assert.doesNotMatch(JSON.stringify(a),/uuid:/);
});
test('duplicate address discovery fails closed; isolated identity labels cannot classify peers',()=>{
 const now=Date.now(),bindings=[intel(),dixim()].map(e=>({remoteIp:'10.0.0.1',collectedAt:new Date(now).toISOString(),endpoints:[e]}));const s=createFamilyShadow(bindings,()=>now);const r=s.observe('10.0.0.1',{});assert.equal(r?.status,'unknown');assert.equal(r?.bindingStatus,'ambiguous-address-discovery');
});
test('Browse extension evidence is optional for older clients; generic SOAP/TimeSeek is not discriminative',()=>{
 assert.equal(requestFamilyFeatures({'TimeSeekRange.dlna.org':'npt=37-','transferMode.dlna.org':'Streaming'},'<Browse><Filter>*</Filter></Browse>').length,0);
 const r=requestFamilyFeatures({},'<u:Browse><Filter>funai:dnUrl,res@dlna:cleartextSize</Filter></u:Browse>');assert.equal(classifyClientFamily([...dixim().signals,...r]).confidence,'strong-observation');
 assert.equal(requestFamilyFeatures({},'<Browse><Filter>upnp:class,dc:date,res,res@size,upnp:rating</Filter></Browse>').length,0);
});
test('shadow evidence bounded, deduplicated, source/context isolated and stale discovery expires',()=>{
 let now=1000000000;const shadow=createFamilyShadow([{remoteIp:'10.0.0.1',collectedAt:new Date(now).toISOString(),endpoints:[intel()]}],()=>now);
 assert.equal(shadow.observe('::ffff:10.0.0.1',ua)?.family,'intel-upnp-layout');assert.equal(shadow.observe('10.0.0.1',ua),undefined);assert.equal(shadow.observe('10.0.0.2',{})?.status,'unknown');now+=86400001;assert.equal(shadow.observe('10.0.0.1',ua)?.status,'unknown');
 for(let i=0;i<5000;i++)shadow.observe('10.1.'+Math.floor(i/256)+'.'+i%256,{});assert.equal(shadow.observe('10.0.0.1',{})?.status,'unknown');
});
test('family output cannot grant targets, trials, receive capabilities or alter PlaybackDecision',()=>{
 const result=classifyClientFamily([...dixim().signals,...requestFamilyFeatures({'user-agent':'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0'})]);assert.equal(result.mode,'shadow-only');assert.match(result.playbackAuthorization,/unchanged/);assert.equal('targetProfile' in result,false);assert.equal('sink' in result,false);assert.equal('authorized' in result,false);
});
