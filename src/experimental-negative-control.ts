import { jpCadenceArguments } from './experimental-jp-cadence.js';
import { experimentalAudioArguments, EXPERIMENTAL_AAC_DELAY_SAMPLES, EXPERIMENTAL_AAC_RATE } from './prepare-experimental-audio.js';

/** Offline negative control: preserve every analyzed display picture, no fps/select filter. */
export function negativeControlVideoArguments(source: string, output: string, frames: number, seconds: number) {
  if (source === output || !Number.isSafeInteger(frames) || frames <= 0 || !Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid negative control inputs');
  const args = jpCadenceArguments(source, output, 'vfr');
  args[args.indexOf('-vf') + 1] = 'scale=1920:1080:flags=lanczos,setfield=prog,format=yuv420p';
  args[args.indexOf('-t') + 1] = String(seconds);
  args[args.indexOf('-enc_time_base:v') + 1] = '1/90000';
  args.splice(args.indexOf('-f'), 0, '-frames:v', String(frames));
  return args;
}

export function negativeControlAudioArguments(source: string, output: string, seconds: number) {
  const args = experimentalAudioArguments(source, output);
  args[args.indexOf('-t') + 1] = String(seconds);
  return args;
}

/** ADTS loses timestamps; restore the source start and compensate encoder padding. */
export function negativeControlAudioTsArguments(adts: string, output: string, sourceStartSeconds: number, commonShiftTicks: number) {
  if (adts === output || !Number.isFinite(sourceStartSeconds) || !Number.isSafeInteger(commonShiftTicks)) throw new Error('Invalid audio timeline');
  const offset = sourceStartSeconds + commonShiftTicks / 90000 - EXPERIMENTAL_AAC_DELAY_SAMPLES / EXPERIMENTAL_AAC_RATE;
  return ['-hide_banner', '-nostdin', '-n', '-copyts', '-itsoffset', String(offset), '-i', adts,
    '-map', '0:a:0', '-c:a', 'copy', '-mpegts_copyts', '1', '-muxdelay', '0', '-avoid_negative_ts', 'disabled', '-f', 'mpegts', output];
}
