import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Capabilities, BackendPreference } from './transcode-capabilities.js';
import type { planCadenceNormalization } from './cadence-plan.js';
import { negativeControlVideoArguments, negativeControlAudioArguments, negativeControlAudioTsArguments } from './experimental-negative-control.js';
import { jpInterlacedArguments } from './experimental-jp-interlaced.js';
import { buildPcrIndex } from './pcr-index.js';
import { Tts192Transform } from './tts.js';
export const ENCODE_RECIPE = { version: 'main40-vfr-software-v1', codec: 'h264', profile: 'Main', level: 40,
  width: 1920, height: 1080, codedHeight: 1088, bFrames: 0, refs: 1, vbvRate: 10000000, vbvSize: 10000000,
  idrSeconds: 2.002, muxrate: 12500000, muxdelay: .7, pcrPeriod: 50, commonShiftTicks: 255003,
  audioPaddingSamples: 1024, audioRate: 48000, audioChannels: 2, leadMs: 1100, blockBytes: 5568 };
export const execute = promisify(execFile);
export const commandOptions = { windowsHide: true, timeout: 600000, maxBuffer: 96 * 1024 * 1024 };
export const ffmpeg = () => process.env.PT3_FFMPEG || 'ffmpeg';
export const ffprobe = () => process.env.PT3_FFPROBE || 'ffprobe';
export async function probePackets(file: string): Promise<any> {
  return JSON.parse((await execute(ffprobe(), ['-v', 'error', '-show_streams', '-show_format', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=stream_index,pts,dts,size,pos,flags,data_hash', '-of', 'json', file], commandOptions)).stdout);
}
/** Strategy is already fixed. Backend availability cannot rewrite a media decision. */
export function prepareBackend(c: Capabilities, requested: BackendPreference) {
  if (!c.candidates.software.available) throw new Error('No initialized backend certified for exact VFR/HRD recipe');
  return { backend: 'software', encoder: 'libx264', decoder: 'cpu', reason: requested === 'software' ? 'configured certified backend' : `${requested}: hardware exact retained-PTS/HRD contract not certified; software fallback` };
}
export interface EncodeInput { source: string; seconds: number; sourceAudioStart: number; sourceFrames: number; cadence: ReturnType<typeof planCadenceNormalization> }
export function plannedVideoArguments(input: EncodeInput, output: string) {
  const args = negativeControlVideoArguments(input.source, output, input.cadence.retained.length, input.seconds);
  const filter = args.indexOf('-vf') + 1;
  // Explicit source boundary plus the same greedy selection as the planner. No fps filter or duplicate.
  args[filter] = `select='lt(n,${input.sourceFrames})${input.cadence.required ? `*(isnan(prev_selected_t)+gte(round(t*90000)-round(prev_selected_t*90000),${input.cadence.minimum.minimumTicks}))` : ''}',` + args[filter];
  return args;
}
export async function generatePreparedArtifact(input: EncodeInput, directory: string) {
  const video = path.join(directory, 'video.ts'), adts = path.join(directory, 'audio.aac'), audio = path.join(directory, 'audio.ts');
  const raw = path.join(directory, 'media.ts'), file = path.join(directory, 'media.m2ts');
  const run = async (name: string, args: string[]) => { const r = await execute(ffmpeg(), args, commandOptions); await fs.writeFile(path.join(directory, name + '.log'), r.stderr); return args; };
  const videoArgs = await run('encode', plannedVideoArguments(input, video));
  const audioArgs = await run('audio-encode', negativeControlAudioArguments(input.source, adts, input.seconds));
  const audioMuxArgs = await run('audio-mux', negativeControlAudioTsArguments(adts, audio, input.sourceAudioStart, ENCODE_RECIPE.commonShiftTicks));
  const v = await probePackets(video), first = v.packets.find((p: any) => p.stream_index === 0);
  // Preserve source display origin; compensate only the standard muxer's uniform shift.
  const shift = ENCODE_RECIPE.commonShiftTicks + input.cadence.normalizedTimestamps[0] - first.pts;
  const muxArgs = await run('mux', jpInterlacedArguments(video, audio, shift, raw));
  const index = await buildPcrIndex(raw); assert.ok(index && !index.discontinuities && !index.invalidIntervals);
  await pipeline(createReadStream(raw), new Tts192Transform(0, index.averageBitrate, 0, index.packetCount * 192, index), createWriteStream(file, { flags: 'wx' }));
  await fs.writeFile(path.join(directory, 'execution.json'), JSON.stringify({ input, recipe: ENCODE_RECIPE, videoArgs, audioArgs, audioMuxArgs, muxArgs }));
  return file;
}
