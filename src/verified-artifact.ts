import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PcrIndex } from './core.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DiagnosticLog } from './diagnostic-log.js';
import { createExperimentalHandler, experimentalFormat, type ExperimentalMediaConfig } from './experimental-media.js';
import { matchingFingerprint, snapshotHash, runShadow, type Fingerprint, type ShadowRecord, type ShadowRequest, type SourceSnapshot, type ShadowPolicy, type CapabilitySnapshot } from './playback-shadow.js';
import { readShadowJson, shadowDirectory, acquireCapability, type RegisteredDmp } from './playback-shadow-store.js';
import type { CachedExperimentalDecision, ExperimentalEntry } from './experimental-catalog.js';
import { planCadenceNormalization } from './cadence-plan.js';
export const cadencePlanFingerprint = (plan: ReturnType<typeof planCadenceNormalization>) => snapshotHash(JSON.stringify({ policy: plan.policy, minimum: plan.minimum, retained: plan.retained, dropped: plan.dropped, duplicated: plan.duplicated, normalizedTimestamps: plan.normalizedTimestamps }));
export interface ArtifactFingerprint extends Fingerprint { sha256: string }
export interface VerifiedArtifactAdapter {
  kind: 'verified-artifact'; sourceFingerprint: Fingerprint; decisionFingerprint: string;
  artifactFingerprint: ArtifactFingerprint; verificationRecord: ArtifactFingerprint;
  planFingerprint: string;
  cadenceFingerprint?: string;
  targetProfile: string; transport: import('./playback-decision.js').Transport;
  verificationStatus: 'experimentally-confirmed' | 'pc-validated'; deviceId: string; sinkHash: string;
  protocolInfo: string; size: number; durationSeconds: number;
}
export interface ArtifactVerification {
  version: 'verified-artifact-v1'; sourceFingerprint: Fingerprint; artifactFingerprint: ArtifactFingerprint;
  decisionFingerprint: string; targetProfile: string; verificationStatus: 'experimentally-confirmed' | 'pc-validated';
  sourceSnapshot: SourceSnapshot; policy: ShadowPolicy; capabilitySnapshot: CapabilitySnapshot;
  config: ExperimentalMediaConfig; index: PcrIndex; servedBytes: number;
  preparationFingerprint: ArtifactFingerprint; observationFingerprint?: ArtifactFingerprint;
  registryFingerprint?: ArtifactFingerprint;
  transformPlan: unknown; scope: string;
  planFingerprint: string;
  cadenceFingerprint?: string;
}
export const cachedPlanFingerprint = (plan: NonNullable<CachedExperimentalDecision['selected']>) => snapshotHash(JSON.stringify({ strategy: plan.strategy, targetProfileId: plan.targetProfileId, transport: plan.transport, transforms: plan.transforms, cadenceRequired: plan.cadenceRequired, cadenceFingerprint: plan.cadenceFingerprint }));
/** Excludes UUID/acquisition time, includes full deterministic decision and exact advertised Sink. */
export function decisionFingerprint(record: ShadowRecord) {
  return snapshotHash(JSON.stringify({ plannerVersion: record.plannerVersion, source: record.request.fingerprint,
    characteristics: record.sourceSnapshot?.characteristics, policy: record.policySnapshot, deviceId: record.capabilitySnapshot?.deviceId,
    sinkHash: record.capabilitySnapshot?.sinkHash, decision: record.shadowDecision }));
}
export function matchesArtifactDecision(entry: ExperimentalEntry, d: CachedExperimentalDecision | undefined, a: VerifiedArtifactAdapter) {
  const selected = d?.selected ?? d?.artifactCandidate;
  // A validated existing output may discharge source-only audit unknowns without promoting them to known source facts.
  const knownOutput = d?.disposition === 'diagnostic-only' && selected?.verification === 'diagnostic-only' && d.unknowns.every(u => /^source (dpbFrames|bitrate|cpbBits) unknown; output audit required$/.test(u) || u === 'named DLNA profile full conformance unconfirmed');
  return !!d && d.decisionStatus === 'complete' && (d.disposition === 'executable' && selected?.verification === 'supported-candidate' || knownOutput) &&
    ['experimentally-confirmed', 'pc-validated'].includes(a.verificationStatus) && matchingFingerprint(a.sourceFingerprint, entry.fingerprint) && matchingFingerprint(d.sourceFingerprint, entry.fingerprint) &&
    d.decisionFingerprint === a.decisionFingerprint && !!selected && cachedPlanFingerprint(selected) === a.planFingerprint && d.deviceId === a.deviceId && d.sinkHash === a.sinkHash && selected.targetProfileId === a.targetProfile &&
    (!selected.cadenceRequired || !!a.cadenceFingerprint && selected.cadenceFingerprint === a.cadenceFingerprint) &&
    JSON.stringify(selected?.transport) === JSON.stringify(a.transport) && a.protocolInfo === `http-get:*:${a.transport.mime}:DLNA.ORG_PN=${a.transport.profileName};DLNA.ORG_OP=10;DLNA.ORG_CI=1`;
}
async function statMatches(f: Fingerprint) { try { const s = await fs.stat(f.path); return s.isFile() && s.size === f.size && s.mtimeMs === f.mtimeMs; } catch { return false; } }
/** Lightweight runtime invalidation. Full artifact SHA-256 is established offline, not hashed per Browse. */
export async function validateArtifact(a: VerifiedArtifactAdapter): Promise<ArtifactVerification | undefined> {
  if (a.verificationRecord.size > 1024 * 1024) return;
  if (!await statMatches(a.sourceFingerprint) || !await statMatches(a.artifactFingerprint) || !await statMatches(a.verificationRecord)) return;
  try {
    const bytes = await fs.readFile(a.verificationRecord.path); if (bytes.length > 1024 * 1024 || snapshotHash(bytes.toString()) !== a.verificationRecord.sha256) return;
    const v: ArtifactVerification = JSON.parse(bytes.toString());
    if (v.version !== 'verified-artifact-v1' || v.verificationStatus !== a.verificationStatus || v.decisionFingerprint !== a.decisionFingerprint || v.planFingerprint !== a.planFingerprint || v.targetProfile !== a.targetProfile ||
      JSON.stringify(v.artifactFingerprint) !== JSON.stringify(a.artifactFingerprint) || !matchingFingerprint(v.sourceFingerprint, a.sourceFingerprint) ||
      v.config.file !== a.artifactFingerprint.path || v.servedBytes !== a.size || experimentalFormat(v.config).protocolInfo !== a.protocolInfo ||
      !await statMatches(v.preparationFingerprint)) return;
    if (v.verificationStatus === 'experimentally-confirmed') {
      if (!v.observationFingerprint || !await statMatches(v.observationFingerprint)) return;
    } else {
      // Opt-in generated outputs require the atomic registry commit, never a fabricated human observation.
      const f = v.registryFingerprint; if (!f || f.size > 8 * 1024 * 1024 || !await statMatches(f)) return;
      const bytes = await fs.readFile(f.path); if (snapshotHash(bytes.toString()) !== f.sha256) return;
      const record = JSON.parse(bytes.toString());
      if (record.state !== 'verified' || record.verificationStatus !== 'pc-validated' || record.validatorVersion !== 'prepare-validator-v2' ||
        record.transformPlanFingerprint !== a.planFingerprint || record.targetProfile !== a.targetProfile || record.capabilitySnapshotHash !== a.sinkHash ||
        !matchingFingerprint(record.sourceFingerprint, a.sourceFingerprint) || (a.cadenceFingerprint && record.cadencePlanFingerprint !== a.cadenceFingerprint) ||
        JSON.stringify(record.artifactFingerprint) !== JSON.stringify(a.artifactFingerprint) || !record.validationEvidence?.http?.bodyExact ||
        record.validationEvidence?.hrd?.violations !== 0 || record.validationEvidence?.duplicate !== 0 || !record.validationEvidence?.selectionEvidence?.retainedDecodedSourcePixelHashesExact) return;
    }
    if (a.cadenceFingerprint) {
      const timing = v.policy.profiles.find(p => p.id === v.targetProfile)?.video.value.timing;
      const ticks = v.sourceSnapshot.characteristics.video.displayTicks;
      if (!timing || !ticks || v.cadenceFingerprint !== a.cadenceFingerprint || cadencePlanFingerprint(planCadenceNormalization(ticks, timing)) !== a.cadenceFingerprint) return;
    }
    return v;
  } catch { return; }
}
export function createArtifactRuntime(directory: string, folders: () => string[], trace: (category: string, message: string, detail?: unknown) => void) {
  let log: DiagnosticLog | undefined;
  return {
    async decide(request: ShadowRequest, adapter: VerifiedArtifactAdapter) {
      const v = await validateArtifact(adapter); if (!v) return undefined;
      return runShadow(request, {
        source: async () => v.sourceSnapshot,
        policy: async () => v.policy,
        capability: async (_, signal) => {
          const devices = await readShadowJson<RegisteredDmp[]>(path.join(shadowDirectory(), 'devices.json')) ?? [];
          const device = devices.find(d => d.remoteIp === request.remoteIp.replace(/^::ffff:/, ''));
          if (!device) return undefined;
          // Current read; the bound recipe never substitutes historical Sink for this result.
          return acquireCapability(device, signal);
        },
        record: r => {
          if (!log) { log = new DiagnosticLog(path.join(directory, 'adapter-decisions')); log.open(folders()); }
          log.append(r);
        }
      });
    },
    async deliver(req: IncomingMessage, res: ServerResponse, a: VerifiedArtifactAdapter, decisionId?: string) {
      const v = await validateArtifact(a); if (!v) { res.writeHead(409, { 'Content-Length': 0 }); res.end(); return; }
      const handler = createExperimentalHandler(v.config, (category, message, detail) => trace(category, message, { decisionId, artifactFingerprint: a.artifactFingerprint, detail }), v.index);
      trace('EXPERIMENTAL_ADAPTER', 'Verified artifact delivery; no encoder', { decisionId, originalUrl: req.url, artifactFingerprint: a.artifactFingerprint, decisionFingerprint: a.decisionFingerprint });
      const original = req.url; req.url = '/media/sampleA.tts';
      try { await handler(req, res); } finally { req.url = original; }
    }
  };
}
