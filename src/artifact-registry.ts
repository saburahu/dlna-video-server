import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileFingerprint } from './file-fingerprint.js';
import { matchingFingerprint, snapshotHash, type Fingerprint } from './playback-shadow.js';
import { readShadowJson, saveShadowJson } from './playback-shadow-store.js';
import type { ArtifactFingerprint } from './verified-artifact.js';

export const VALIDATOR_VERSION = 'prepare-validator-v2';
export interface ArtifactIdentity {
  sourceFingerprint: Fingerprint; capabilitySnapshotHash: string;
  decisionFingerprint: string; transformPlanFingerprint: string; cadencePlanFingerprint: string;
  targetProfile: string; targetPolicy: unknown; encoderCompatibility: unknown;
}
export interface RegistryRecord extends ArtifactIdentity {
  artifactId: string; executorBackend: string; artifactPath: string; artifactFingerprint: ArtifactFingerprint;
  createdAt: string; validatorVersion: string; verificationStatus: 'pc-validated' | 'experimentally-confirmed';
  state: 'verified'; validationEvidence: unknown;
}
/** No model-name key. Semantic policy/plan and exact advertised Sink participate. */
export function artifactKey(identity: ArtifactIdentity) { return snapshotHash(JSON.stringify(identity)); }
function recordedIdentity(r: RegistryRecord): ArtifactIdentity {
  return { sourceFingerprint: r.sourceFingerprint, capabilitySnapshotHash: r.capabilitySnapshotHash, decisionFingerprint: r.decisionFingerprint,
    transformPlanFingerprint: r.transformPlanFingerprint, cadencePlanFingerprint: r.cadencePlanFingerprint,
    targetProfile: r.targetProfile, targetPolicy: r.targetPolicy, encoderCompatibility: r.encoderCompatibility };
}
export interface RegistryJobs {
  generate(directory: string): Promise<string>;
  validate(file: string, directory: string): Promise<{ passed: true; evidence: unknown }>;
}
export async function prepareArtifact(directory: string, identity: ArtifactIdentity, backend: string, jobs: RegistryJobs, validatorVersion = VALIDATOR_VERSION) {
  const key = artifactKey(identity), records = path.join(directory, 'records'), locks = path.join(directory, 'locks');
  await fs.mkdir(records, { recursive: true }); await fs.mkdir(locks, { recursive: true });
  const recordFile = path.join(records, key + '.json'), lockFile = path.join(locks, key + '.lock');
  // Exclusive file creation also excludes a second CLI process. Never evict a live/stale lock automatically.
  const lock = await fs.open(lockFile, 'wx').catch(() => { throw new Error('Artifact is already preparing; inspect its lock before retrying'); });
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const revision = randomUUID(), temporary = path.join(directory, 'work', revision);
  const state = (s: string, detail?: unknown) => saveShadowJson(path.join(directory, 'states', key + '.json'), { key, state: s, updatedAt: new Date().toISOString(), detail });
  const unchanged = async () => { const f = identity.sourceFingerprint, s = await fs.stat(f.path); if (s.size !== f.size || s.mtimeMs !== f.mtimeMs) throw new Error('Source fingerprint changed'); };
  try {
    await state('preparing'); await unchanged();
    const previous = await readShadowJson<RegistryRecord>(recordFile);
    let intact = false;
    if (previous && previous.state === 'verified' && previous.artifactId === key && artifactKey(recordedIdentity(previous)) === key && ['pc-validated', 'experimentally-confirmed'].includes(previous.verificationStatus)) {
      try { const current = await fileFingerprint(previous.artifactPath); intact = matchingFingerprint(current, previous.artifactFingerprint) && current.sha256 === previous.artifactFingerprint.sha256; } catch { /* stale */ }
      if (intact && previous.validatorVersion === validatorVersion) { await unchanged(); await state('verified', 'cache-hit'); return { cacheHit: true, revalidated: false, record: previous }; }
    }
    await fs.mkdir(temporary, { recursive: true });
    let file: string, validation;
    if (previous && intact) {
      await state('validating', 'validator-version-changed'); file = previous.artifactPath;
      validation = await jobs.validate(file, temporary);
    } else {
      if (previous) await state('stale', 'artifact missing or fingerprint mismatch');
      await state('generating'); file = await jobs.generate(temporary);
      // A generator may only publish within this job's new workspace.
      const relative = path.relative(temporary, path.resolve(file));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Generator output escaped temporary workspace');
      await state('validating'); validation = await jobs.validate(file, temporary);
    }
    if (validation.passed !== true) throw new Error('Validator did not pass');
    await unchanged();
    const fingerprint = await fileFingerprint(file);
    if (!previous || !intact) {
      const published = path.join(directory, 'artifacts', revision); await fs.mkdir(path.dirname(published), { recursive: true });
      const relative = path.relative(temporary, file); await fs.rename(temporary, published); file = path.join(published, relative);
    }
    const record: RegistryRecord = { ...identity, artifactId: key, executorBackend: backend, artifactPath: file,
      artifactFingerprint: { ...fingerprint, path: file }, createdAt: new Date().toISOString(), validatorVersion,
      verificationStatus: 'pc-validated', state: 'verified', validationEvidence: validation.evidence };
    // One atomic record is the visibility gate. A failed revision leaves the previous record untouched.
    await saveShadowJson(recordFile, record); await state('verified');
    return { cacheHit: false, revalidated: !!previous && intact, record };
  } catch (error) { await state('failed', String(error)); throw error; }
  finally { await lock.close(); await fs.unlink(lockFile); }
}
