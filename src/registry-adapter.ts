import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readShadowJson, saveShadowJson } from './playback-shadow-store.js';
import { matchingFingerprint, type ShadowRecord } from './playback-shadow.js';
import { experimentalCatalogDirectory, cachedExperimentalDecision, type ExperimentalCatalog } from './experimental-catalog.js';
import { cachedPlanFingerprint, decisionFingerprint, validateArtifact, type ArtifactVerification, type VerifiedArtifactAdapter } from './verified-artifact.js';
import { fileFingerprint } from './file-fingerprint.js';
import { buildPcrIndex } from './pcr-index.js';
import { experimentalLayout } from './experimental-content-packet.js';
import { experimentalFormat } from './experimental-media.js';
import { VALIDATOR_VERSION, type RegistryRecord } from './artifact-registry.js';
import { ENCODE_RECIPE } from './prepare-executor.js';

/** Explicit opt-in bridge only. Existing successful bindings are never replaced. No encoding here. */
export async function publishPreparedResource(registryDirectory: string, record: RegistryRecord, decision: ShadowRecord, auditFile: string) {
  const publishLockFile = path.join(experimentalCatalogDirectory(), 'registry-publish.lock');
  const lock = await fs.open(publishLockFile, 'wx').catch(() => { throw new Error('Another explicit registry publication is in progress'); });
  try { return await publishLocked(registryDirectory, record, decision, auditFile); }
  finally { await lock.close(); await fs.unlink(publishLockFile); }
}
async function publishLocked(registryDirectory: string, record: RegistryRecord, decision: ShadowRecord, auditFile: string) {
  assert.ok(record.state === 'verified' && record.verificationStatus === 'pc-validated' && record.validatorVersion === VALIDATOR_VERSION);
  const evidence = record.validationEvidence as any;
  assert.ok(evidence?.http?.bodyExact && evidence.hrd.violations === 0 && evidence.duplicate === 0);
  const selected = cachedExperimentalDecision(decision)!;
  const plan = selected.selected ?? selected.artifactCandidate; assert.ok(plan && record.transformPlanFingerprint === cachedPlanFingerprint(plan));
  assert.equal(record.capabilitySnapshotHash, decision.capabilitySnapshot?.sinkHash);
  const artifact = await fileFingerprint(record.artifactPath); assert.deepEqual(artifact, record.artifactFingerprint);
  const recordFile = path.join(registryDirectory, 'records', record.artifactId + '.json');
  const stored = await readShadowJson<RegistryRecord>(recordFile); assert.deepEqual(stored, record);
  const catalogDirectory = experimentalCatalogDirectory(), catalogFile = path.join(catalogDirectory, 'catalog.json');
  const catalog = await readShadowJson<ExperimentalCatalog>(catalogFile); assert.ok(catalog?.enabled);
  const original = structuredClone(catalog);
  const entry = catalog.entries.find(e => matchingFingerprint(e.fingerprint, record.sourceFingerprint)); assert.ok(entry, 'Source must be explicitly registered in Experimental Media first');
  if (entry.adapter) return { published: false, reason: 'existing verified resource preserved; registry shadow only' };
  const index = await buildPcrIndex(record.artifactPath); assert.ok(index && !index.invalidIntervals && !index.discontinuities);
  const config = { file: record.artifactPath, title: entry.filename, durationSeconds: evidence.decodeSeconds, address: '127.0.0.1', port: 0, udn: 'uuid:00000000-0000-4000-8000-000000000000', mode: 'remux' as const,
    timeSeek: true, contentPacket: true, contentPacketBlockBytes: ENCODE_RECIPE.blockBytes, pcrLeadMs: ENCODE_RECIPE.leadMs, audioTreatment: 'mpeg2-aac-lc' as const, videoTreatment: 'vfr-idr' as const, videoEncoder: 'libx264' as const };
  const size = experimentalLayout(artifact.size, index.averageBitrate, true, ENCODE_RECIPE.blockBytes).servedBytes;
  const verification: ArtifactVerification = { version: 'verified-artifact-v1', sourceFingerprint: record.sourceFingerprint, artifactFingerprint: artifact,
    decisionFingerprint: decisionFingerprint(decision), planFingerprint: record.transformPlanFingerprint, cadenceFingerprint: plan.cadenceRequired ? record.cadencePlanFingerprint : undefined,
    targetProfile: record.targetProfile, verificationStatus: 'pc-validated', sourceSnapshot: decision.sourceSnapshot!, policy: decision.policySnapshot!, capabilitySnapshot: decision.capabilitySnapshot!,
    config, index, servedBytes: size, preparationFingerprint: await fileFingerprint(auditFile), registryFingerprint: await fileFingerprint(recordFile),
    transformPlan: plan.transforms, scope: 'Explicit PC-validated bounded generated output; television unconfirmed; complete JP conformity unknown' };
  const proofFile = path.join(catalogDirectory, 'registry-proofs', record.artifactId + '.json'); await saveShadowJson(proofFile, verification);
  const adapter: VerifiedArtifactAdapter = { kind: 'verified-artifact', sourceFingerprint: record.sourceFingerprint, decisionFingerprint: verification.decisionFingerprint,
    artifactFingerprint: artifact, verificationRecord: await fileFingerprint(proofFile), planFingerprint: record.transformPlanFingerprint, cadenceFingerprint: verification.cadenceFingerprint,
    targetProfile: record.targetProfile, transport: plan.transport, verificationStatus: 'pc-validated', deviceId: decision.capabilitySnapshot!.deviceId,
    sinkHash: record.capabilitySnapshotHash, protocolInfo: experimentalFormat(config).protocolInfo, size, durationSeconds: config.durationSeconds };
  assert.ok(await validateArtifact(adapter), 'Source/registry/proof changed before publication');
  entry.adapter = adapter; entry.decisions = [selected]; entry.sourceState = 'cached';
  // Re-read immediately before commit so another explicit prepare cannot silently replace a new binding.
  const latest = await readShadowJson<ExperimentalCatalog>(catalogFile); assert.deepEqual(latest, original, 'Catalogue changed while preparing publication');
  await saveShadowJson(catalogFile, catalog);
  return { published: true, objectId: entry.objectId, televisionVerification: 'not-tested' };
}
