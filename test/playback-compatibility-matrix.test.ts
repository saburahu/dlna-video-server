import test from'node:test';import assert from'node:assert/strict';
import{selectDualAudio,withDualAudioArguments,type DualAudioPermission}from'../src/jit-dual-audio.js';
import{proposeReceiverDualAudio}from'../src/dual-audio-permission-proposal.js';
import{snapshotHash,type CapabilitySnapshot}from'../src/playback-shadow.js';
import{catalogJitCandidate}from'../src/catalog-jit-candidate.js';
import{initialShadowPolicy}from'../src/shadow-profile-policy.js';
import{automaticClientSelection,AUTOMATIC_CLIENT_VERSION}from'../src/automatic-jit-client.js';
import{endpointFamilyFeatures,classifyClientFamily,FAMILY_VERSION,requestFamilyFeatures}from'../src/client-family.js';
import{jitArguments}from'../src/jit-stream.js';
import{prepareDualAudioReceiverProposal}from'../src/prepare-dual-audio-receiver-proposal.js';
import fs from'node:fs/promises';import os from'node:os';import path from'node:path';
const features=endpointFamilyFeatures('<serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/MediaServer/ConnectionManager/Control</controlURL><SCPDURL>/xml/ConnectionManager.xml</SCPDURL>',['Intel_SDK_for_UPnP_devices/1.2']);
const c=classifyClientFamily(features.signals),cap:CapabilitySnapshot={deviceId:'uuid:synthetic-receiver-a',remoteIp:'127.0.0.1',controlUrl:'http://127.0.0.1/cm',sink:'',sinkHash:snapshotHash(''),origin:'current-read',acquiredAt:new Date().toISOString(),implementation:{version:FAMILY_VERSION,fingerprint:c.fingerprint,family:c.family}};
const target='legacy-jp-observed',f=(name:string)=>({path:'X:/synthetic/'+name,size:100,mtimeMs:1}),sourceA=f('previous-pro.wmv'),sourceB=f('previous-v2.wmv'),sourceC=f('additional-v2.wmv');
const grant:DualAudioPermission={version:'jit-dual-audio-permission-v1',enabled:true,deviceId:cap.deviceId!,sinkHash:cap.sinkHash,implementationFingerprint:cap.implementation!.fingerprint,targetProfile:target,reference:'Synthetic matrix for previously observed receiver paths',sourceScope:{version:'jit-dual-audio-source-scope-v1',fingerprints:[sourceA,sourceB]}};
function wmv(codec='wmav2',average='24000/1001'){return{format:{format_name:'asf',duration:'100'},executionDecoders:['wmv3',codec],streams:[0,1].map(index=>({index,codec_type:'audio',codec_name:codec,sample_rate:'48000',channels:2,...(codec==='wmapro'?{channel_layout:'stereo'}:{}),start_time:'0',duration:'100',time_base:'1/1000'})).concat([{index:2,codec_type:'video',codec_name:'wmv3',profile:'Main',width:704,height:396,pix_fmt:'yuv420p',avg_frame_rate:average,r_frame_rate:'24000/1001'}] as any)}}
test('receiver capability covers newly added eligible sources without fingerprint enrollment and preserves old exceptions',()=>{
 const before=structuredClone(grant),proposal=proposeReceiverDualAudio([grant],cap,target,'Independently observed switching on this receiver/target');assert.deepEqual(grant,before);assert.equal(proposal.length,2);assert.deepEqual(proposal[0],grant);assert.equal(proposal[1].sourceScope,undefined);
 for(const [source,codec]of [[sourceA,'wmapro'],[sourceB,'wmav2'],[sourceC,'wmav2'],[f('newly-added-pro.wmv'),'wmapro']] as const){const probe=wmv(codec,'0/0'),plan=selectDualAudio(proposal,cap,probe,target,false,true,source).plan;assert.ok(plan);assert.deepEqual(plan.audioPids,[257,258]);assert.equal(plan.targetProfile,target);
  for(const change of[{receiver:{...cap,deviceId:'uuid:another-receiver'}},{receiver:{...cap,sinkHash:'stale'}},{receiver:{...cap,implementation:{...cap.implementation!,fingerprint:'changed'}}},{profile:'unapproved-target'},{bound:false}])assert.equal(selectDualAudio(proposal,change.receiver??cap,probe,change.profile??target,false,change.bound??true,source).plan,undefined);
 }
 assert.equal(selectDualAudio([grant],cap,wmv(),target,false,true,sourceC).plan,undefined,'Old scoped-only settings retain their narrow meaning');
 assert.deepEqual(proposeReceiverDualAudio(proposal,cap,target,'same capability'),proposal);
 const legacy={...grant,sourceScope:undefined};assert.deepEqual(proposeReceiverDualAudio([legacy],cap,target,'existing capability'),[legacy]);
 assert.throws(()=>proposeReceiverDualAudio([legacy,legacy],cap,target,'ambiguous'));
 assert.throws(()=>proposeReceiverDualAudio([{...legacy,enabled:false}],cap,target,'inactive'));
 const unsupported=wmv();(unsupported.streams[0] as any).codec_name='wmavoice';assert.equal(selectDualAudio(proposal,cap,unsupported,target,false,true,sourceC).plan,undefined);
 assert.equal(selectDualAudio(proposal,cap,wmv(),target,false,true,{...sourceA,size:101}).reason,'dual-audio-source-scope-mismatch','Same-path stale exception cannot fall through to receiver capability');
 assert.equal(selectDualAudio([{...grant,enabled:false},proposal[1]],cap,wmv(),target,false,true,sourceA).plan,undefined,'Explicit inactive exception wins');
 assert.equal(selectDualAudio([grant,grant,proposal[1]],cap,wmv(),target,false,true,sourceA).plan,undefined,'Overlapping exceptions are ambiguous');
 assert.equal(selectDualAudio([grant,proposal[1]],cap,wmv(),target,false,true).plan,undefined,'Cannot bypass exceptions by omitting the source fingerprint');
});
test('receiver capability applies to a new eligible AVI while a source-specific CFR requirement cannot be bypassed',()=>{
 const source=f('new-pair.avi'),probe={format:{format_name:'avi',duration:'30'},executionDecoders:['h264','mp3'],streams:[{index:0,codec_type:'video',codec_name:'h264',profile:'High',pix_fmt:'yuv420p',field_order:'progressive',width:704,height:396,avg_frame_rate:'2997/125'},...[1,2].map(index=>({index,codec_type:'audio',codec_name:'mp3',channels:2,channel_layout:'stereo',sample_rate:'48000',start_time:'0',time_base:'1/24000'}))]};
 const general=proposeReceiverDualAudio([],cap,target,'Receiver switching proof'),choose=(records=general,s=source,cfr?:string)=>selectDualAudio(records,cap,probe,target,false,true,s,cfr);
 assert.equal(choose().plan?.version,'avi-h264-two-mp3-48k-stereo-v1');assert.ok(choose(general,f('another-new-pair.avi')).plan);
 const exception={...grant,sourceScope:{version:'jit-dual-audio-source-scope-v1',fingerprints:[source],h264AviCfrRequired:[source]}} as DualAudioPermission;
 assert.equal(choose([...general,exception]).reason,'dual-audio-source-requires-validated-h264-avi-cfr');assert.ok(choose([...general,exception],source,'receiver-h264-avi-cfr-30000-1001-trial-v1').plan);assert.ok(choose([...general,exception],f('another-new-pair.avi')).plan);
 const damaged={...exception,sourceScope:{...exception.sourceScope!,h264AviCfrRequired:[f('outside-scope.avi')]}};assert.equal(choose([...general,damaged]).plan,undefined);
 for(const mkv of[false,true]){const aac={format:{format_name:mkv?'matroska,webm':'mov,mp4,m4a,3gp,3g2,mj2',duration:'30'},executionDecoders:['aac',mkv?'hevc':'h264'],streams:[{...probe.streams[0],codec_name:mkv?'hevc':'h264',profile:mkv?'Main':'High',avg_frame_rate:'24000/1001'},...[1,2].map(index=>({index,codec_type:'audio',codec_name:'aac',profile:'LC',channels:2,channel_layout:'stereo',sample_rate:'48000',start_time:'0',duration:'30',time_base:mkv?'1/1000':'1/48000'}))]};assert.equal(selectDualAudio([...general,exception],cap,aac,target,false,true,f(mkv?'new.mkv':'new.mp4')).plan?.version,mkv?'mkv-hevc-two-aaclc-48k-stereo-v1':'mp4-h264-two-aaclc-48k-stereo-v1');}
});
test('ASF unknown average 0/0 uses supported nominal evidence without hiding invalid/other cadence or changing VFR video',()=>{
 const p={...grant,sourceScope:undefined};const missing=wmv();delete(missing.streams[2] as any).avg_frame_rate;
 const plan=selectDualAudio([p],cap,wmv('wmav2','0/0'),target,false,true,sourceB).plan!;assert.ok(plan);assert.deepEqual(plan,selectDualAudio([p],cap,missing,target,false,true,sourceB).plan);
 for(const average of ['30000/1001','0/1','broken','-24000/1001'])assert.equal(selectDualAudio([p],cap,wmv('wmav2',average),target,false,true,sourceB).plan,undefined);
 for(const nominal of['60000/1001','0/0',undefined]){const probe=wmv('wmav2','0/0');(probe.streams[2] as any).r_frame_rate=nominal;assert.equal(selectDualAudio([p],cap,probe,target,false,true,sourceB).plan,undefined);}
 for(const reference of[7,{},null])assert.equal(selectDualAudio([{...p,reference} as any],cap,wmv(),target,false,true,sourceB).plan,undefined);
 const single=jitArguments('synthetic.wmv',2989,3),dual=withDualAudioArguments(single,plan);assert.equal(dual[dual.indexOf('-fps_mode')+1],'passthrough');assert.ok(dual[dual.indexOf('-filter_complex')+1].startsWith('[0:v:0]'+single[single.indexOf('-vf')+1]+'[jit_video];'));assert.ok(!dual[dual.indexOf('-filter_complex')+1].includes('fps='));
});
test('input permission remains additive and independent from source-specific two-audio enrollment',()=>{
 const profiles=initialShadowPolicy();profiles.capabilities={encoders:[{codec:'h264',available:true},{codec:'aac',available:true}],decoders:[{codec:'wmv3',available:true},{codec:'wmapro',available:true},{codec:'wmav2',available:true}]};
 const ep={capability:cap,features,device:{deviceId:cap.deviceId,remoteIp:cap.remoteIp,controlUrl:cap.controlUrl,descriptionUrl:'http://127.0.0.1/device',allowEmptySink:true}},p:any={version:'experimental-jit-v1',enabled:true,targetProfile:target,policy:profiles,capabilities:[cap],items:[],catalogMetadataResources:true,automaticClients:{version:AUTOMATIC_CLIENT_VERSION,enabled:true,legacyInputs:true,wmaInputs:'source-clock-v1'}};
 const selection=automaticClientSelection([ep as any],requestFamilyFeatures({'user-agent':'UPnP/1.0 Intel_SDK_for_UPnP_devices/1.2'},''),p);assert.ok(selection.trial);p.clientTrials=[selection.trial];
 const entry=(source=sourceA,probe=wmv('wmapro'))=>({objectId:'experimental/catalog-item/'+'a'.repeat(32),filename:'synthetic.wmv',fingerprint:source,sourceState:'unanalysed' as const,decisions:[],lightweightProbe:probe});
 assert.equal(catalogJitCandidate(entry(),p,cap),undefined);assert.ok(catalogJitCandidate(entry(sourceB,wmv()),p,cap));p.dualAudioPermissions=[grant];assert.equal(catalogJitCandidate(entry(),p,cap),undefined);
 p.wmaInputPermissions=[{version:'wma-input-permission-v1',enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,implementationFingerprint:cap.implementation!.fingerprint,targetProfile:target,sourceFingerprint:sourceA,inputPolicy:'source-clock-v2',reference:'Explicit generated input proof'}];assert.ok(catalogJitCandidate(entry(),p,cap));assert.ok(catalogJitCandidate(entry(sourceB,wmv()),p,cap));assert.equal(catalogJitCandidate(entry(sourceC),p,cap),undefined);assert.equal(p.automaticClients.wmaInputs,'source-clock-v1');
});
test('offline receiver enrollment CLI adds no source fingerprints and never rewrites input/WMA/CFR policy',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'receiver-permission-proposal-'));
 try{const input=path.join(dir,'policy.json'),endpoint=path.join(dir,'cap.json'),output=path.join(dir,'proposal.json'),p={version:'fixture',dualAudioPermissions:[grant],wmaInputPermissions:[{unchanged:true}],automaticClients:{wmaInputs:'source-clock-v1'},receiverH264AviCfrTrials:[{unchanged:true}]},text=JSON.stringify(p);
  await fs.writeFile(input,text);await fs.writeFile(endpoint,JSON.stringify({capability:cap}));const result=await prepareDualAudioReceiverProposal([input,endpoint,target,'Receiver/target switching observation',output]);assert.equal(result.sourceFingerprintsAdded,0);assert.equal(result.liveApplied,false);assert.equal(await fs.readFile(input,'utf8'),text);
  const q=JSON.parse(await fs.readFile(output,'utf8'));assert.deepEqual({...q,dualAudioPermissions:p.dualAudioPermissions},p);assert.equal(q.dualAudioPermissions.length,2);assert.equal(q.dualAudioPermissions[1].sourceScope,undefined);assert.deepEqual(q.dualAudioPermissions[0],grant);
  await assert.rejects(prepareDualAudioReceiverProposal([input,endpoint,target,'proof',output]));await assert.rejects(prepareDualAudioReceiverProposal([input,endpoint,target,'proof',input]));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
