import { randomUUID, createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { decidePlayback, type MediaCharacteristics, type MediaProfileDefinition, type CompatibilityObservation, type ExecutionCapabilities } from './playback-decision.js';

export const SHADOW_VERSION = 'playback-shadow-v1';
export const PLANNER_VERSION = 'c89e8ff-decision-v1';
export interface Fingerprint { path: string; size: number; mtimeMs: number }
export const snapshotHash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface SourceSnapshot {
  version: string; fingerprint: Fingerprint; analyzedAt: string;
  scanScope: string; characteristics: MediaCharacteristics;
}
export interface CapabilitySnapshot {
  deviceId: string; remoteIp: string; controlUrl: string; sink: string; sinkHash: string;
  acquiredAt: string; origin: 'current-read' | 'cached-read';
  implementation?: {version:string; fingerprint:string; family?:string};
  compatibilityAxes?: ReturnType<typeof import('./receiver-compatibility-axes.js').receiverCompatibilityAxes>;
  playbackProfile?: import('./receiver-playback-profile.js').ReceiverPlaybackProfile;
}
export interface ScopedObservation {
  deviceId: string; sinkHash: string; observation: CompatibilityObservation;
  testedMediaCharacteristics: unknown;
}
export interface ShadowPolicy {
  version: string; profiles: MediaProfileDefinition[]; observations: ScopedObservation[];
  capabilities: ExecutionCapabilities;
  executionCapabilitiesStatus?: 'verified' | 'unknown';
}
export interface ShadowRequest {
  decisionId?: string; requestedAt?: string;
  fingerprint: Fingerprint; remoteIp: string; requestId?: string; trialId?: string; method: string;
  headers: Record<string, unknown>; actualPlaybackPath: unknown;
}
export interface ShadowRecord {
  decisionId: string; timestamp: string; requestedAt: string; plannerVersion: string; shadowVersion: string;
  request: ShadowRequest; decisionStatus: 'complete' | 'incomplete' | 'error' | 'timeout';
  disposition: 'executable' | 'diagnostic-only' | 'unsupported' | 'incomplete';
  applied: false; actualPlaybackPath: unknown; shadowDecision?: ReturnType<typeof decidePlayback>;
  sourceSnapshot?: SourceSnapshot; capabilitySnapshot?: CapabilitySnapshot; policySnapshot?: ShadowPolicy;
  unknowns: string[];
}
export interface ShadowDependencies {
  source(request: ShadowRequest, signal: AbortSignal): Promise<SourceSnapshot | undefined>;
  capability(request: ShadowRequest, signal: AbortSignal): Promise<CapabilitySnapshot | undefined>;
  policy(signal: AbortSignal): Promise<ShadowPolicy>;
  record(record: ShadowRecord): void | Promise<void>;
}
export function matchingFingerprint(a: Fingerprint, b: Fingerprint) {
  return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
/** Never feeds a result back to an HTTP handler. Called only after that response settles. */
export async function runShadow(request: ShadowRequest, deps: ShadowDependencies, timeoutMs = 4000): Promise<ShadowRecord> {
  const requestedAt = request.requestedAt ?? new Date().toISOString(), decisionId = request.decisionId ?? randomUUID(), abort = new AbortController();
  const base = { decisionId, requestedAt, plannerVersion: PLANNER_VERSION, shadowVersion: SHADOW_VERSION,
    request: structuredClone(request), applied: false as const, actualPlaybackPath: structuredClone(request.actualPlaybackPath) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: ShadowRecord;
  const work = async (): Promise<ShadowRecord> => {
    const [source, capability, policy] = await Promise.all([deps.source(request, abort.signal), deps.capability(request, abort.signal), deps.policy(abort.signal)]);
    const unknowns: string[] = [];
    if (!source || source.version !== SHADOW_VERSION || !matchingFingerprint(source.fingerprint, request.fingerprint)) unknowns.push('source-cache-missing-stale-or-version-mismatch; offline analysis required');
    if (!capability) unknowns.push('current capability unavailable or DMP not registered');
    else if (snapshotHash(capability.sink) !== capability.sinkHash) unknowns.push('capability snapshot hash mismatch');
    if (policy.version === 'unconfigured') unknowns.push('shadow policy not configured');
    if (unknowns.length) return { ...base, timestamp: new Date().toISOString(), decisionStatus: 'incomplete', disposition: 'incomplete', sourceSnapshot: source, capabilitySnapshot: capability, policySnapshot: policy, unknowns };
    const scoped = policy.observations.filter(o => o.deviceId === capability!.deviceId && o.sinkHash === capability!.sinkHash);
    // Recipes are experimental only for the matching device + exact advertised snapshot.
    const profiles = policy.profiles.map(p => {
      const success = scoped.find(o => o.observation.profileId === p.id && o.observation.outcome === 'success' && o.observation.framing === p.transport.value.framing);
      return success ? { ...p, transport: { ...p.transport, evidence: success.observation.evidence }, video: { ...p.video, evidence: success.observation.evidence }, audio: { ...p.audio, evidence: success.observation.evidence } } : p;
    });
    const shadowDecision = decidePlayback({ source: source!.characteristics, sinkProtocolInfo: capability!.sink,
      profiles, observations: scoped.map(o => o.observation), capabilities: policy.capabilities });
    const diagnostic = shadowDecision.candidates.some(c => c.verification === 'diagnostic-only') || (shadowDecision.candidates.length > 0 && policy.executionCapabilitiesStatus === 'unknown');
    return { ...base, timestamp: new Date().toISOString(), decisionStatus: 'complete', disposition: shadowDecision.selected ? 'executable' : diagnostic ? 'diagnostic-only' : 'unsupported',
      sourceSnapshot: source, capabilitySnapshot: capability, policySnapshot: { ...policy, profiles, observations: scoped }, shadowDecision,
      unknowns: [...(shadowDecision.selected?.unknowns ?? shadowDecision.candidates.flatMap(c => c.unknowns)),
        ...(policy.executionCapabilitiesStatus === 'unknown' ? ['executor capabilities not yet verified; unavailable is not established'] : [])] };
  };
  try {
    result = await Promise.race([work(), new Promise<ShadowRecord>(resolve => {
      timer = setTimeout(() => { abort.abort(); resolve({ ...base, timestamp: new Date().toISOString(), decisionStatus: 'timeout', disposition: 'incomplete', unknowns: ['shadow-timeout; actual path unaffected'] }); }, timeoutMs);
    })]);
  } catch (error) {
    result = { ...base, timestamp: new Date().toISOString(), decisionStatus: 'error', disposition: 'incomplete', unknowns: [String(error)] };
  } finally { if (timer) clearTimeout(timer); }
  // A log storage failure is isolated too; never rejects into playback.
  try { await deps.record(result); } catch { /* independent shadow storage failure */ }
  return result;
}

/** finish and close may both fire. Snapshot now; execute once, after actual playback. */
export function attachShadow(response: ServerResponse, request: ShadowRequest, execute: (r: ShadowRequest) => Promise<unknown>): void {
  try {
    const snapshot = structuredClone({ ...request, decisionId: request.decisionId ?? randomUUID(), requestedAt: request.requestedAt ?? new Date().toISOString() }); let scheduled = false;
    const settled = () => { if (scheduled) return; scheduled = true;
      setImmediate(() => { try { void execute(snapshot).catch(() => {}); } catch {} });
    };
    response.once('finish', settled); response.once('close', settled);
  } catch { /* shadow initialization cannot fail playback */ }
}

export function summarizeShadow(records: readonly ShadowRecord[]) {
  const result = { decisions: records.length, status: {} as Record<string, number>, strategies: {} as Record<string, number>,
    cadenceRequired: 0, cadenceNotRequired: 0, cadenceUnknown: 0, candidateCadenceRequired: 0, candidateCadenceNotRequired: 0, candidateCadenceUnknown: 0,
    candidateStrategies: {} as Record<string, number> };
  const count = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };
  for (const record of records) {
    count(result.status, record.disposition); const selected = record.shadowDecision?.selected;
    if (selected) count(result.strategies, selected.strategy);
    for (const mode of new Set(record.shadowDecision?.candidates.map(c => c.strategy))) count(result.candidateStrategies, mode);
    const cadence = selected?.cadence;
    if (!cadence) result.cadenceUnknown++; else if (cadence.required) result.cadenceRequired++; else result.cadenceNotRequired++;
    const candidateCadence = record.shadowDecision?.candidates.map(c => c.cadence).filter(c => c !== undefined);
    if (!candidateCadence?.length) result.candidateCadenceUnknown++; else if (candidateCadence.some(c => c.required)) result.candidateCadenceRequired++; else result.candidateCadenceNotRequired++;
  }
  return result;
}
