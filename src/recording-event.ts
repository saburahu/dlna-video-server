/** Metadata only: timestamps are epoch milliseconds; recording offsets are seconds. */
export interface EventIdentity {
  serviceId: number;
  eventId: number;
  transportStreamId?: number;
  originalNetworkId?: number;
}
export interface EitObservation extends EventIdentity {
  startTimeMs: number | null;
  durationSeconds: number | null;
  role: 'present' | 'following';
  recordingSeconds: number;
  observedTimeMs?: number;
}
export interface RecordingWindow {
  durationSeconds: number;
  startTimeMs?: number;
  serviceId?: number;
  transportStreamId?: number;
  originalNetworkId?: number;
}
export interface ReservationEvent extends EventIdentity { startTimeMs?: number; }
export interface EventCandidate extends EventIdentity {
  startTimeMs: number | null;
  durationSeconds: number | null;
  durationHistorySeconds: number[];
  present: { count: number; recordingSeconds: number[]; observedTimeMs: (number | null)[] };
  following: { count: number; recordingSeconds: number[]; observedTimeMs: (number | null)[] };
  presentIntervals: { startSeconds: number; endSeconds: number }[];
  observedPresentSeconds: number;
  overlapSeconds: number | null;
}
export interface RecordingEventResult {
  candidates: EventCandidate[];
  primary: EventCandidate | null;
  reason: 'reservation' | 'recording-overlap' | 'observed-present' | 'ambiguous' | 'insufficient-evidence';
  // EIT sampling never establishes that the recording's metadata is exhaustive.
  provisional: boolean;
}

function matchesScope(a: EventIdentity, b: Partial<EventIdentity>) {
  return (b.serviceId === undefined || a.serviceId === b.serviceId) &&
    (b.transportStreamId === undefined || a.transportStreamId === b.transportStreamId) &&
    (b.originalNetworkId === undefined || a.originalNetworkId === b.originalNetworkId);
}
function key(o: EitObservation) {
  // Include start time: event IDs may be reused on later broadcasts.
  return JSON.stringify([o.originalNetworkId ?? null, o.transportStreamId ?? null, o.serviceId, o.eventId, o.startTimeMs]);
}

/** Retains every decoded p/f candidate, including following-only and other services.
 * Present durations are estimates only between consecutive observations within
 * maxObservationGapSeconds. Gaps and unobserved file tails are never extrapolated.
 * Repeated sections count as observations, not extra broadcast duration.
 */
export function selectRecordingEvent(observations: readonly EitObservation[], window: RecordingWindow,
  reservation?: ReservationEvent, maxObservationGapSeconds = 30): RecordingEventResult {
  if (!Number.isFinite(window.durationSeconds) || window.durationSeconds <= 0 ||
      (window.startTimeMs !== undefined && !Number.isFinite(window.startTimeMs)) ||
      !Number.isFinite(maxObservationGapSeconds) || maxObservationGapSeconds <= 0)
    throw new RangeError('Invalid recording clock/window');
  const sorted = [...observations].sort((a, b) => a.recordingSeconds - b.recordingSeconds);
  const candidates = new Map<string, EventCandidate>();
  const previousPresent = new Map<string, { candidate: EventCandidate; seconds: number }>();
  for (const o of sorted) {
    if (![o.serviceId, o.eventId].every(n => Number.isInteger(n) && n >= 0 && n <= 65535) ||
        !Number.isFinite(o.recordingSeconds) || o.recordingSeconds < 0 || o.recordingSeconds > window.durationSeconds ||
        (o.startTimeMs !== null && !Number.isFinite(o.startTimeMs)) ||
        (o.durationSeconds !== null && (!Number.isFinite(o.durationSeconds) || o.durationSeconds < 0)) ||
        (o.observedTimeMs !== undefined && !Number.isFinite(o.observedTimeMs)) ||
        !['present', 'following'].includes(o.role)) throw new RangeError('Invalid EIT observation');
    const id = key(o);
    let c = candidates.get(id);
    if (!c) {
      c = { serviceId: o.serviceId, eventId: o.eventId, transportStreamId: o.transportStreamId,
        originalNetworkId: o.originalNetworkId, startTimeMs: o.startTimeMs, durationSeconds: null,
        durationHistorySeconds: [], present: {count: 0, recordingSeconds: [], observedTimeMs: []},
        following: {count: 0, recordingSeconds: [], observedTimeMs: []}, presentIntervals: [],
        observedPresentSeconds: 0, overlapSeconds: null };
      candidates.set(id, c);
    }
    if (o.durationSeconds !== null) {
      c.durationSeconds = o.durationSeconds; // latest observation, not maximum advertised duration
      if (!c.durationHistorySeconds.includes(o.durationSeconds)) c.durationHistorySeconds.push(o.durationSeconds);
    }
    const role = c[o.role];
    role.count++; role.recordingSeconds.push(o.recordingSeconds);
    // Keep aligned arrays so unknown wall clocks do not shift later observations.
    role.observedTimeMs.push(o.observedTimeMs ?? null);
    if (o.role === 'present') {
      const scope = JSON.stringify([o.originalNetworkId ?? null, o.transportStreamId ?? null, o.serviceId]);
      const prev = previousPresent.get(scope);
      if (prev && o.recordingSeconds > prev.seconds && o.recordingSeconds - prev.seconds <= maxObservationGapSeconds) {
        const intervals = prev.candidate.presentIntervals, last = intervals.at(-1);
        if (last && last.endSeconds === prev.seconds) last.endSeconds = o.recordingSeconds;
        else intervals.push({startSeconds: prev.seconds, endSeconds: o.recordingSeconds});
        prev.candidate.observedPresentSeconds += o.recordingSeconds - prev.seconds;
      }
      // Conflicting present events at exactly one offset are ambiguous, not an ordering signal.
      if (prev && o.recordingSeconds === prev.seconds && prev.candidate !== c)
        previousPresent.delete(scope);
      else previousPresent.set(scope, {candidate: c, seconds: o.recordingSeconds});
    }
  }
  const all = [...candidates.values()];
  for (const c of all) {
    if (window.startTimeMs !== undefined && c.startTimeMs !== null && c.durationSeconds !== null) {
      const eventEnd = c.startTimeMs + c.durationSeconds * 1000;
      c.overlapSeconds = Math.max(0, Math.min(eventEnd, window.startTimeMs + window.durationSeconds * 1000) -
        Math.max(c.startTimeMs, window.startTimeMs)) / 1000;
    }
  }
  const result = (primary: EventCandidate | null, reason: RecordingEventResult['reason']): RecordingEventResult =>
    ({candidates: all, primary, reason, provisional: reason !== 'reservation'});
  if (reservation) {
    const matched = all.filter(c => matchesScope(c, reservation) && c.eventId === reservation.eventId &&
      (reservation.startTimeMs === undefined || c.startTimeMs === reservation.startTimeMs));
    if (matched.length === 1) return result(matched[0], 'reservation');
    if (matched.length > 1) return result(null, 'ambiguous');
    // A known reservation must not silently become a different event.
    return result(null, 'insufficient-evidence');
  }
  const eligible = all.filter(c => matchesScope(c, window));
  const services = new Set(eligible.map(c => JSON.stringify([c.originalNetworkId ?? null, c.transportStreamId ?? null, c.serviceId])));
  if (services.size > 1) return result(null, 'ambiguous');
  const scored = eligible.map(c => ({c, score: window.startTimeMs === undefined ? c.observedPresentSeconds : c.overlapSeconds ?? 0}))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.c.observedPresentSeconds - a.c.observedPresentSeconds);
  if (!scored.length) return result(null, 'insufficient-evidence');
  // Prefer estimated present coverage only as a tie-breaker; never the repeat count.
  if (scored[1] && scored[0].score === scored[1].score &&
      scored[0].c.observedPresentSeconds === scored[1].c.observedPresentSeconds) return result(null, 'ambiguous');
  return result(scored[0].c, window.startTimeMs === undefined ? 'observed-present' : 'recording-overlap');
}
