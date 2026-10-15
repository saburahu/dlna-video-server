import test from 'node:test';
import assert from 'node:assert/strict';
import {initialShadowPolicy} from '../src/shadow-profile-policy.js';
import {mpeg2JitProfile} from '../src/mpeg2-jit-target.js';
import {snapshotHash} from '../src/playback-shadow.js';
import {endpointFamilyFeatures,requestFamilyFeatures,classifyClientFamily,FAMILY_VERSION} from '../src/client-family.js';
import {automaticClientSelection,AUTOMATIC_CLIENT_VERSION,type AutomaticClientResolution} from '../src/automatic-jit-client.js';
import {selectClientAdmission,admissionIdentity} from '../src/jit-client-admission.js';
import {jitRecipeFingerprint} from '../src/jit-client-trial.js';
import type {ExperimentalJitPolicy} from '../src/experimental-jit.js';

function fixture(bdr=false,tag='arbitrary'){
 const features=endpointFamilyFeatures(bdr?'<serviceType>urn:schemas-digion-com:service:X_AccessControl:1</serviceType><serviceType>urn:schemas-digion-com:service:X_DeviceConfiguration:1</serviceType>':'<serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/MediaServer/ConnectionManager/Control</controlURL><SCPDURL>/xml/ConnectionManager.xml</SCPDURL>',[bdr?'DiXiM/4.0':'Intel_SDK_for_UPnP_devices/1.2']),classification=classifyClientFamily(features.signals);
 const cap={remoteIp:'10.2.3.4',deviceId:'uuid:'+tag+'-'+bdr,controlUrl:'http://10.2.3.4/cm',sink:'',sinkHash:snapshotHash(''),acquiredAt:new Date().toISOString(),origin:'current-read' as const,implementation:{version:FAMILY_VERSION,fingerprint:classification.fingerprint,family:classification.family}};
 const endpoint={capability:cap,features,device:{remoteIp:cap.remoteIp,deviceId:cap.deviceId,descriptionUrl:'http://10.2.3.4/description',controlUrl:cap.controlUrl}};
 const policy=initialShadowPolicy();policy.profiles=[policy.profiles[0],mpeg2JitProfile()];const profile=policy.profiles[bdr?1:0];
 const trial={version:'jit-client-trial-v1' as const,enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,targetProfile:profile.id,recipeFingerprint:jitRecipeFingerprint(profile),containers:['mp4','matroska'],reference:'historical explicit trial'};
 const p:ExperimentalJitPolicy={version:'experimental-jit-v1',enabled:true,targetProfile:profile.id,policy,capabilities:[cap],items:[],clientTrials:[trial],automaticClients:{version:AUTOMATIC_CLIENT_VERSION,enabled:true,priority:'automatic-first'},clientAdmissions:{version:'client-admission-v1',legacySuccesses:[{deviceId:cap.deviceId,targetProfile:profile.id,recipeFingerprint:jitRecipeFingerprint(profile),identityFingerprint:admissionIdentity(cap),reference:'human playback result',confirmedAt:new Date().toISOString()}]}};
 const requests=requestFamilyFeatures({'user-agent':bdr?'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0':'Intel_SDK_for_UPnP_devices/1.2'},bdr?'<Browse><Filter>funai:dnUrl,res@dlna:cleartextSize</Filter></Browse>':'');
 const auto:AutomaticClientResolution={...automaticClientSelection([endpoint],requests,p),binding:'bound-automatic',observed:{fresh:true,endpoints:[endpoint],requests}};
 return {p,cap,endpoint,requests,auto,profile};
}

test('automatic-first uses empirical family target with registrations present or absent for both families and changed UDNs',()=>{
 for(let i=0;i<5;i++){const {p,cap,auto,profile}=fixture(i===4,'unknown-'+i);for(const registered of [true,false]){if(!registered){p.capabilities=[];p.clientTrials=[];}const r=selectClientAdmission(p,cap.remoteIp,auto);assert.equal(r.route,'automatic');assert.equal(r.policy?.targetProfile,profile.id);assert.equal(r.binding,'bound-automatic');assert.ok(r.policy?.clientTrials?.some(t=>t.automaticEvidence));}}
});
test('confirmed legacy fallback requires fresh matching identity; absent fingerprint is distinct from contradictory evidence',()=>{
 const {p,cap,endpoint}=fixture(),missing:AutomaticClientResolution={reason:'request-implementation-missing',observed:{fresh:true,endpoints:[endpoint],requests:[]}};
 const result=selectClientAdmission(p,cap.remoteIp,missing);assert.equal(result.route,'legacy-fallback');assert.ok(result.binding);
 for(const invalid of [{...missing,observed:{...missing.observed!,fresh:false}},{...missing,observed:{...missing.observed!,endpoints:[]}},{...missing,observed:{...missing.observed!,endpoints:[{...endpoint,capability:{...cap,deviceId:'uuid:replacement'}}]}},{...missing,observed:{...missing.observed!,requests:requestFamilyFeatures({'user-agent':'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0'})}},{...missing,reason:'no-matching-empirical-recipe'},{...missing,reason:'ambiguous-request-endpoints'}])assert.equal(selectClientAdmission(p,cap.remoteIp,invalid).route,'denied');
 p.clientAdmissions!.legacySuccesses=[];assert.equal(selectClientAdmission(p,cap.remoteIp,missing).route,'denied','a historical trial alone is not success evidence');
});
test('identity, Sink, endpoint implementation, request conflicts and target disagreement never fall back',()=>{
 const {p,cap,auto,endpoint}=fixture();
 for(const change of [{deviceId:'uuid:other'},{sinkHash:snapshotHash('different')},{controlUrl:'http://10.2.3.4/changed'},{implementation:{...cap.implementation,fingerprint:'changed'}}]){const bad={...auto,endpoint:{...endpoint,capability:{...cap,...change}},observed:{...auto.observed!,endpoints:[{...endpoint,capability:{...cap,...change}}]}};assert.equal(selectClientAdmission(p,cap.remoteIp,bad).route,'denied');}
 const conflict={...auto,observed:{...auto.observed!,requests:[...auto.observed!.requests,...requestFamilyFeatures({'user-agent':'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0'})]}};assert.equal(selectClientAdmission(p,cap.remoteIp,conflict).route,'denied');
 assert.equal(selectClientAdmission({...p,capabilities:[],clientTrials:[]},'10.2.3.5',auto).route,'denied','a selected endpoint cannot be reused for another peer');
 assert.equal(selectClientAdmission(p,cap.remoteIp,{reason:'no-corroborating-current-endpoint',observed:{fresh:true,endpoints:[{...endpoint,features:{...endpoint.features,signals:[...endpoint.features.signals,...requestFamilyFeatures({'user-agent':'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0'})]}}],requests:[]}}).route,'denied','new contradictory endpoint evidence cannot use legacy fallback');
 const other=p.policy.profiles[1];p.clientTrials![0]={...p.clientTrials![0],targetProfile:other.id,recipeFingerprint:jitRecipeFingerprint(other)};p.clientAdmissions!.legacySuccesses[0]={...p.clientAdmissions!.legacySuccesses[0],targetProfile:other.id,recipeFingerprint:jitRecipeFingerprint(other)};assert.equal(selectClientAdmission(p,cap.remoteIp,auto).reason,'automatic-and-registered-target-conflict');
 p.clientAdmissions!.forcedOverrides=[{...p.clientAdmissions!.legacySuccesses[0],reference:'operator-approved forced target',allowTargetDisagreement:true}];assert.equal(selectClientAdmission(p,cap.remoteIp,auto).route,'explicit-override');assert.equal(selectClientAdmission(p,cap.remoteIp,conflict).route,'denied','force is not permission to ignore identity/request conflicts');
});
test('invalid legacy records, duplicate registrations and unknown peers are rejected; rollback retains the old priority',()=>{
 const {p,cap,auto,endpoint}=fixture();p.clientAdmissions!.legacySuccesses[0].identityFingerprint='stale';assert.equal(selectClientAdmission(p,cap.remoteIp,auto).route,'denied');p.automaticClients!.priority='individual-first';assert.equal(selectClientAdmission(p,cap.remoteIp,auto).route,'individual-first');p.automaticClients!.priority='automatic-first';p.capabilities.push({...cap,deviceId:'uuid:duplicate'});assert.equal(selectClientAdmission(p,cap.remoteIp,auto).route,'denied');
 assert.equal(selectClientAdmission({...p,capabilities:[],clientTrials:[]},'10.2.3.5',{reason:'request-implementation-missing',observed:{fresh:true,endpoints:[endpoint],requests:[]}}).route,'denied');
});

test('historic registration lacking implementation metadata can use newly corroborated automatic evidence, never an unpinned fallback',()=>{
 const {p,cap,auto,endpoint}=fixture();const old={...cap};delete (old as {implementation?:unknown}).implementation;p.capabilities=[old];p.clientAdmissions!.legacySuccesses=[];const r=selectClientAdmission(p,cap.remoteIp,auto);assert.equal(r.route,'automatic');assert.ok(r.policy?.capabilities[0].implementation);
 const missing={reason:'request-implementation-missing',observed:{fresh:true,endpoints:[endpoint],requests:[]}};assert.equal(selectClientAdmission(p,cap.remoteIp,missing).route,'denied');
});
