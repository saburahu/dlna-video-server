import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {fileFingerprint} from './file-fingerprint.js';
import {VALIDATOR_VERSION, type RegistryRecord} from './artifact-registry.js';
import {FULL_VALIDATOR_VERSION} from './full-validator.js';
import {experimentalFormat, type ExperimentalMediaConfig} from './experimental-media.js';
export interface PipelineTrialManifest {registryPath:string; revision:string; record:RegistryRecord; config:ExperimentalMediaConfig; logDirectory:string; observeSeconds?:number}
export function validTrialValidator(record:RegistryRecord){return record.validatorVersion===VALIDATOR_VERSION||(record.validatorVersion===FULL_VALIDATOR_VERSION&&typeof record.validationEvidence==='object'&&record.validationEvidence!==null&&'scope' in record.validationEvidence&&record.validationEvidence.scope==='full-duration');}
export function pipelineTrialIdentity(m:PipelineTrialManifest){const r=m.record;return {artifactId:r.artifactId,revision:m.revision,registryEntry:m.registryPath,sourceFingerprint:r.sourceFingerprint,capabilitySnapshotHash:r.capabilitySnapshotHash,decisionFingerprint:r.decisionFingerprint,transformPlanFingerprint:r.transformPlanFingerprint,cadencePlanFingerprint:r.cadencePlanFingerprint,artifactFingerprint:r.artifactFingerprint,verificationStatus:r.verificationStatus};}
export function pipelineTrialUri(m:PipelineTrialManifest){return experimentalFormat(m.config).uri+`?artifactId=${encodeURIComponent(m.record.artifactId)}&revision=${encodeURIComponent(m.revision)}`;}
export async function validatePipelineTrial(m:PipelineTrialManifest){
 const current=JSON.parse(await readFile(m.registryPath,'utf8'));
 assert.deepEqual(current,m.record,'Registry changed since trial preparation');
 assert.equal(current.state,'verified');assert.ok(validTrialValidator(current),'Unsupported validator/scope');
 assert.ok(['pc-validated','experimentally-confirmed'].includes(current.verificationStatus));
 assert.notEqual(m.config.port,19090);assert.notEqual(m.config.port,19091);assert.equal(m.config.ssdp,false);
 assert.equal(m.config.file,current.artifactPath);assert.equal(m.config.mode,'remux');
 assert.equal(m.config.timeSeek,true);assert.equal(m.config.contentPacket,true);assert.equal(m.config.contentPacketBlockBytes,5568);assert.equal(m.config.pcrLeadMs,1100);
 const s=await stat(current.sourceFingerprint.path);assert.equal(s.size,current.sourceFingerprint.size);assert.equal(s.mtimeMs,current.sourceFingerprint.mtimeMs);
 assert.deepEqual(await fileFingerprint(m.config.file),current.artifactFingerprint,'Artifact changed');
}
