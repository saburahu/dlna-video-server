import test from 'node:test';
import assert from 'node:assert/strict';
import {FAMILY_VERSION,endpointFamilyFeatures,requestFamilyFeatures,classifyClientFamily,classifyRequestContext} from '../src/client-family.js';
import {familyTrialEvidence,matchingJitTrial,jitRecipeFingerprint} from '../src/jit-client-trial.js';
import {initialShadowPolicy} from '../src/shadow-profile-policy.js';
import {snapshotHash} from '../src/playback-shadow.js';

test('family enrollment binds actual requests to the individual endpoint, not a mixed host or model',()=>{
 const intel=endpointFamilyFeatures('<serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/MediaServer/ConnectionManager/Control</controlURL><SCPDURL>/xml/ConnectionManager.xml</SCPDURL>',['Intel_SDK_for_UPnP_devices/1.2']);
 const dixim=endpointFamilyFeatures('<serviceType>urn:schemas-digion-com:service:X_AccessControl:1</serviceType><serviceType>urn:schemas-digion-com:service:X_DeviceConfiguration:1</serviceType>',['DiXiM/9.0']);
 const requests=requestFamilyFeatures({'user-agent':'Intel_SDK_for_UPnP_devices/1.2'}),ep=classifyClientFamily(intel.signals);
 const cap={deviceId:'uuid:individual',remoteIp:'10.0.0.70',controlUrl:'http://10.0.0.70/cm',sink:'',sinkHash:snapshotHash(''),acquiredAt:new Date().toISOString(),origin:'current-read' as const,implementation:{version:FAMILY_VERSION,fingerprint:ep.fingerprint,family:ep.family}};
 const host={remoteIp:cap.remoteIp,identities:[{deviceId:cap.deviceId},{deviceId:'uuid:auxiliary'}],endpoints:[intel,dixim],requestContext:classifyRequestContext([intel,dixim],requests)};
 const report={version:FAMILY_VERSION,clients:[host]},evidence=familyTrialEvidence(report,cap,'passive observation; receiver unverified');
 assert.equal(evidence.family,'intel-upnp-layout');assert.equal(evidence.endpointFingerprint,ep.fingerprint);
 const profile=initialShadowPolicy().profiles[0],trial={version:'jit-client-trial-v1' as const,enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,targetProfile:profile.id,recipeFingerprint:jitRecipeFingerprint(profile),containers:['mp4','matroska'],reference:'operator trial',familyEvidence:evidence};
 assert.ok(matchingJitTrial([trial],cap,profile));
 for(const change of [{deviceId:'uuid:sibling'},{sink:'changed'},{implementation:undefined},{implementation:{...cap.implementation,fingerprint:'changed'}},{implementation:{...cap.implementation,version:'future'}}])assert.equal(matchingJitTrial([trial],{...cap,...change},profile),undefined);
 assert.equal(matchingJitTrial([trial,trial],cap,profile),undefined);
 for(const change of [{endpointFingerprint:''},{requestFingerprint:''},{family:'unclassified'},{reference:''},{observedAt:'invalid'}])assert.equal(matchingJitTrial([{...trial,familyEvidence:{...evidence,...change}}],cap,profile),undefined);
 assert.throws(()=>familyTrialEvidence(report,{...cap,deviceId:'uuid:auxiliary'},'test'),/disagree|unknown/);
 assert.throws(()=>familyTrialEvidence({...report,clients:[host,host]},cap,'test'),/unique observed/);
 assert.throws(()=>familyTrialEvidence({...report,clients:[{...host,requestContext:{evidence:[]}}]},cap,'test'),/disagree|unknown/);
 assert.throws(()=>familyTrialEvidence({...report,clients:[{...host,requestContext:{evidence:[...requests,...requestFamilyFeatures({'user-agent':'JLABSDOC/1.0 TOSHIBA_JP_BDR_V1.0'})]}}]},cap,'test'),/disagree|unknown/);
});
