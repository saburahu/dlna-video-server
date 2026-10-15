import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {pipelineTrialIdentity,pipelineTrialUri,validatePipelineTrial,validTrialValidator,type PipelineTrialManifest} from '../src/pipeline-trial.js';
import {FULL_VALIDATOR_VERSION} from '../src/full-validator.js';
import {VALIDATOR_VERSION,type RegistryRecord} from '../src/artifact-registry.js';
test('full trial requires matching full validator and full validation scope; bounded trial unchanged',()=>{
 const r=(validatorVersion:string,validationEvidence:unknown)=>({validatorVersion,validationEvidence} as RegistryRecord);
 assert.equal(validTrialValidator(r(VALIDATOR_VERSION,{})),true);
 assert.equal(validTrialValidator(r(FULL_VALIDATOR_VERSION,{scope:'full-duration'})),true);
 assert.equal(validTrialValidator(r(FULL_VALIDATOR_VERSION,{scope:'bounded'})),false);
 assert.equal(validTrialValidator(r(FULL_VALIDATOR_VERSION,null)),false);
 assert.equal(validTrialValidator(r('obsolete',{scope:'full-duration'})),false);
});
const fixture=()=>({registryPath:'registry.json',revision:'isolated-new',record:{artifactId:'new-id',decisionFingerprint:'decision',transformPlanFingerprint:'transforms',cadencePlanFingerprint:'cadence',artifactFingerprint:{sha256:'hash'}},config:{address:'10.254.254.119',port:19111,mode:'remux',contentPacket:true,timeSeek:true},logDirectory:'logs'} as PipelineTrialManifest);
test('pipeline revision URL is separate and carries artifact identity without changing protocol',()=>{const m=fixture();const u=new URL(pipelineTrialUri(m));assert.equal(u.port,'19111');assert.equal(u.searchParams.get('artifactId'),'new-id');assert.equal(u.searchParams.get('revision'),'isolated-new');assert.equal(u.pathname,'/media/sampleA.tts');});
test('pipeline log identity binds decision, transform, cadence and artifact to revision',()=>{const i=pipelineTrialIdentity(fixture());assert.equal(i.revision,'isolated-new');assert.equal(i.decisionFingerprint,'decision');assert.equal(i.transformPlanFingerprint,'transforms');assert.equal(i.cadencePlanFingerprint,'cadence');assert.deepEqual(i.artifactFingerprint,{sha256:'hash'});});
test('changed registry fails closed without generation or normal-server fallback',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'pipeline-trial-'));try{const m=fixture();m.registryPath=path.join(dir,'registry.json');await writeFile(m.registryPath,JSON.stringify({...m.record,decisionFingerprint:'changed'}));await assert.rejects(validatePipelineTrial(m),/Registry changed/);}finally{await rm(dir,{recursive:true,force:true});}});
