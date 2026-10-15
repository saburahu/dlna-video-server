import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createReceiverCompatibility,type CompatibilityPeer} from '../src/receiver-compatibility.js';
import {receiverCfrTrial,RECEIVER_CFR} from '../src/receiver-cfr-trial.js';
import {snapshotHash} from '../src/playback-shadow.js';
const peer=(id='uuid:any-individual',ip='192.0.2.10'):CompatibilityPeer=>({eligible:true,reason:'bound',endpoint:{device:{deviceId:id,remoteIp:ip,descriptionUrl:`http://${ip}/device`,controlUrl:`http://${ip}/cm`},features:{signals:[],services:[],roles:[],serverTokens:[],advertisedTypes:[],usnSuffixes:[]},capability:{deviceId:id,remoteIp:ip,controlUrl:`http://${ip}/cm`,sink:'',sinkHash:snapshotHash(''),origin:'current-read',acquiredAt:new Date().toISOString(),implementation:{version:'fixture',family:'intel-upnp-layout',fingerprint:'observed'}}}});
const probe={format:{format_name:'avi'},streams:[{codec_type:'video',codec_name:'msmpeg4v3',avg_frame_rate:'24000/1001',width:320,height:240}]};
async function fixture(t:any){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'receiver-compat-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'jit.json');await fs.writeFile(file,JSON.stringify({version:'experimental-jit-v1',enabled:true,unknownField:'preserve',capabilities:[],items:[]}));return file;}
test('operator setting defaults off, persists and follows UDN across IP changes without affecting other clients or inputs',async t=>{
 const file=await fixture(t);let peers=[peer(),peer('uuid:another','192.0.2.11')],reads=0;
 const acquire=async()=>{reads++;return peers[0].endpoint.capability;};const manager=createReceiverCompatibility(file,()=>peers,acquire);
 const initial=await manager.inspect();assert.equal(reads,0);assert.ok(initial.clients.every(c=>!c.enabled));
 const selected=initial.clients[0];await manager.configure({id:selected.id,revision:selected.revision,enabled:true});
 let p=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(p.unknownField,'preserve');assert.equal(p.receiverCfrTrials[0].configuredBy,'operator');assert.equal(reads,1);
 assert.equal(receiverCfrTrial(p.receiverCfrTrials,peers[0].endpoint.capability,probe,true),RECEIVER_CFR);assert.equal(receiverCfrTrial(p.receiverCfrTrials,peers[1].endpoint.capability,probe,true),undefined);
 peers[0]=peer('uuid:any-individual','192.0.2.99');const restarted=createReceiverCompatibility(file,()=>peers,acquire),state=await restarted.inspect();assert.ok(state.clients[0].enabled);assert.equal(receiverCfrTrial(p.receiverCfrTrials,peers[0].endpoint.capability,probe,true),RECEIVER_CFR);
 await assert.rejects(restarted.configure({id:selected.id,revision:selected.revision,enabled:true}));
 await restarted.configure({id:state.clients[0].id,revision:state.clients[0].revision,enabled:false});p=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(receiverCfrTrial(p.receiverCfrTrials,peers[0].endpoint.capability,probe,true),undefined);
});
test('stale, ambiguous and changed identities cannot enable correction; offline settings can be disabled safely',async t=>{
 const file=await fixture(t);let peers=[peer()],changed=false;
 const manager=createReceiverCompatibility(file,()=>peers,async()=>changed?{...peers[0].endpoint.capability,deviceId:'uuid:replacement'}:peers[0].endpoint.capability);
 let state=await manager.inspect();changed=true;await assert.rejects(manager.configure({...state.clients[0],enabled:true}),/identity/);changed=false;
 peers=[{...peer(),eligible:false}];state=await manager.inspect();await assert.rejects(manager.configure({...state.clients[0],enabled:true}));
 peers=[peer(),peer()];state=await manager.inspect();assert.ok(state.clients.every(c=>!c.eligible));await assert.rejects(manager.configure({...state.clients[0],enabled:true}));
 peers=[peer()];state=await manager.inspect();await manager.configure({...state.clients[0],enabled:true});peers=[];state=await manager.inspect();assert.equal(state.clients.length,1);assert.equal(state.clients[0].eligible,false);await assert.rejects(manager.configure({...state.clients[0],enabled:true}));await manager.configure({...state.clients[0],enabled:false});assert.equal((await manager.inspect()).clients[0].enabled,false);
});
test('concurrent settings serialize without losing unrelated records and reject a stale revision',async t=>{
 const file=await fixture(t),peers=[peer(),peer('uuid:other','192.0.2.11')],manager=createReceiverCompatibility(file,()=>peers,async d=>peers.find(p=>p.endpoint.device.deviceId===d.deviceId)!.endpoint.capability);
 const before=await manager.inspect();await Promise.all(before.clients.map(c=>manager.configure({...c,enabled:true})));assert.equal((await manager.inspect()).clients.filter(c=>c.enabled).length,2);
 await assert.rejects(manager.configure({...before.clients[0],enabled:false}),/changed/);
});
