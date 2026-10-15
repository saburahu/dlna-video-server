import { negativeControlVideoArguments } from './experimental-negative-control.js';

/** Uses an explicit target selection plan, never the HEVC level or nominal fps. */
export function hevcControlVideoArguments(source: string, output: string, retainedFrames: number, seconds: number, minimumTicks: number, normalizationRequired: boolean) {
  if (!Number.isSafeInteger(minimumTicks) || minimumTicks <= 0) throw new Error('Explicit target minimum required');
  const args = negativeControlVideoArguments(source, output, retainedFrames, seconds);
  if (normalizationRequired) {
    const filter = args.indexOf('-vf') + 1;
    args[filter] = `select='isnan(prev_selected_t)+gte(round(t*90000)-round(prev_selected_t*90000),${minimumTicks})',` + args[filter];
  }
  return args;
}
