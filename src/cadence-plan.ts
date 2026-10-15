import { minimumRemovalTicks, selectCompatiblePictures, type CadenceConstraint } from './cadence-normalization.js';

/** Evidence is explicit: an advertised PN alone does not prove its timing limits. */
export interface TargetTimingPolicy {
  id: string;
  mediaProfile: string;
  evidence: 'normative' | 'compatibility-experiment';
  constraint: CadenceConstraint;
  maxFrameMacroblocks: number;
}

function validateTimes(times: readonly number[]) {
  if (!times.length || times.some((t, i) => !Number.isSafeInteger(t) || (i > 0 && t <= times[i - 1]))) {
    throw new Error('Strictly increasing integer picture timestamps required');
  }
}

/** Half-open moving windows [t, t+window); integer ticks avoid rounded fps assumptions. */
export function pictureDensity(times: readonly number[], timebase: number) {
  validateTimes(times);
  if (!Number.isSafeInteger(timebase) || timebase <= 0) throw new Error('Invalid timebase');
  return [100, 250, 500, 1000].map(milliseconds => {
    let end = 0, maximum = 0, firstMaximumTick = times[0];
    for (let start = 0; start < times.length; start++) {
      while (end < times.length && (times[end] - times[start]) * 1000 < milliseconds * timebase) end++;
      if (end - start > maximum) { maximum = end - start; firstMaximumTick = times[start]; }
    }
    return { milliseconds, maximum, firstMaximumTick };
  });
}

export function timingViolations(times: readonly number[], minimumTicks: number) {
  validateTimes(times);
  if (!Number.isSafeInteger(minimumTicks) || minimumTicks <= 0) throw new Error('Invalid minimum interval');
  let count = 0, consecutive = 0, maximumConsecutive = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] < minimumTicks) {
      count++; consecutive++; maximumConsecutive = Math.max(maximumConsecutive, consecutive);
    } else consecutive = 0;
  }
  return { count, maximumConsecutive };
}

/** Selection plan for a future B0 encode. Presentation times are not asserted to be
 * source HRD removal times. Reordered input requires independent HRD/decode analysis;
 * output HRD must be verified after encoding. Never delete compressed reference AUs. */
export function planCadenceNormalization(sourcePictureTimestamps: readonly number[], policy: TargetTimingPolicy) {
  validateTimes(sourcePictureTimestamps);
  if (!policy.id || !policy.mediaProfile || !Number.isSafeInteger(policy.maxFrameMacroblocks) || policy.maxFrameMacroblocks <= 0) {
    throw new Error('Explicit target policy required');
  }
  const minimum = minimumRemovalTicks(policy.constraint);
  if (minimum.macroblocks > policy.maxFrameMacroblocks) throw new Error('Target coded size exceeds profile/level MaxFS');
  const selection = selectCompatiblePictures([...sourcePictureTimestamps], minimum.minimumTicks);
  const normalizedTimestamps = selection.retained.map(p => p.pts);
  const dropIndices = new Set(selection.dropped.map(p => p.index));
  let run = 0, maximumConsecutiveDrops = 0, dropsOutsideSourceShortIntervals = 0;
  for (let i = 0; i < sourcePictureTimestamps.length; i++) {
    if (dropIndices.has(i)) {
      run++; maximumConsecutiveDrops = Math.max(run, maximumConsecutiveDrops);
      if (i && sourcePictureTimestamps[i] - sourcePictureTimestamps[i - 1] >= minimum.minimumTicks) dropsOutsideSourceShortIntervals++;
    } else run = 0;
  }
  return {
    policy, minimum, required: selection.dropped.length > 0,
    retained: selection.retained, dropped: selection.dropped, duplicated: 0,
    normalizedTimestamps,
    diagnostics: {
      timingBasis: 'source-display-selection-for-planned-B0-output',
      sourceFrames: sourcePictureTimestamps.length,
      retainedRatio: selection.retained.length / sourcePictureTimestamps.length,
      retainedPtsUnchanged: true, maximumConsecutiveDrops, dropsOutsideSourceShortIntervals,
      lastPictureRetained: selection.retained.at(-1)!.index === sourcePictureTimestamps.length - 1,
      source: { density: pictureDensity(sourcePictureTimestamps, policy.constraint.timebase), violations: timingViolations(sourcePictureTimestamps, minimum.minimumTicks) },
      output: { density: pictureDensity(normalizedTimestamps, policy.constraint.timebase), violations: timingViolations(normalizedTimestamps, minimum.minimumTicks) },
      requiresDecodeSelectionAndReencode: selection.dropped.length > 0,
      encodedHrdAndCpbValidationPending: true
    }
  };
}
