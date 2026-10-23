import assert from'node:assert/strict';
import{snapshotHash,type CapabilitySnapshot}from'./playback-shadow.js';
import type{DualAudioPermission}from'./jit-dual-audio.js';

/** Pure explicit receiver-capability proposal, not source enrollment or live I/O.
 * Caller must possess individual switching evidence. Source layout/decoder/clock
 * checks remain mandatory at Browse and GET, and input/CFR grants are separate. */
export function proposeReceiverDualAudio(records:readonly DualAudioPermission[],cap:CapabilitySnapshot,target:string,reference:string){
 assert.ok(cap.deviceId&&cap.implementation?.fingerprint&&snapshotHash(cap.sink)===cap.sinkHash,'Current compound receiver evidence required');
 assert.ok(typeof reference==='string'&&reference.trim(),'Individual two-audio switching evidence reference required');
 assert.ok(typeof target==='string'&&target,'Explicit target profile required');
 const proposed=structuredClone([...records]),base=proposed.filter(p=>p.deviceId===cap.deviceId&&p.targetProfile===target&&p.sourceScope===undefined);
 assert.ok(base.length<=1,'Ambiguous receiver capability records; explicit review required');
 if(base.length){const p=base[0];assert.ok(p.enabled===true&&p.version==='jit-dual-audio-permission-v1'&&p.sinkHash===cap.sinkHash&&p.implementationFingerprint===cap.implementation.fingerprint&&typeof p.reference==='string'&&p.reference.trim(),'Existing capability is disabled or mismatched; explicit review required');return proposed;}
 proposed.push({version:'jit-dual-audio-permission-v1',enabled:true,deviceId:cap.deviceId,sinkHash:cap.sinkHash,implementationFingerprint:cap.implementation!.fingerprint,targetProfile:target,reference});
 // Existing source exceptions are deliberately retained with their restrictions.
 return proposed;
}
