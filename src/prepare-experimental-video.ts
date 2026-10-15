import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { buildPcrIndex } from "./pcr-index.js";
import { Tts192Transform } from "./tts.js";
import type { ExperimentalMediaConfig } from "./experimental-media.js";

export function experimentalVideoArguments(input: string, output: string, rate: "60000/1001" | "30000/1001", level?: "4.1" | "4.2") {
  const gop = rate === "60000/1001" ? 120 : 60;
  return ["-hide_banner", "-nostdin", "-n", "-copyts", "-i", input, "-map", "0:v:0", "-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
    "-vf", `fps=${rate}:round=near,format=yuv420p`, "-fps_mode", "passthrough", "-c:v", "h264_nvenc", "-preset", "p4", "-profile:v", "main", "-level:v", level ?? (rate === "60000/1001" ? "4.2" : "4.1"),
    "-g", String(gop), "-keyint_min", String(gop), "-bf", "0", "-refs", "1", "-rc-lookahead", "0", "-no-scenecut", "1", "-forced-idr", "1", "-force_key_frames", "expr:gte(t,n_forced*2.002)",
    "-aud", "1", "-rc", "vbr", "-b:v", "8M", "-maxrate", "10M", "-bufsize", "10M", "-bsf:v", "h264_metadata=fixed_frame_rate_flag=1,dump_extra=freq=keyframe",
    "-c:a", "copy", "-mpegts_copyts", "1", "-avoid_negative_ts", "disabled", "-f", "mpegts", output];
}

/** A bounded, pre-generated video-only compatibility experiment; no normal-store access. */
export async function prepareExperimentalVideo(cfr30 = false) {
  const json = async (file: string) => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  const baseline: ExperimentalMediaConfig = await json("data/experimental-remux-audio.json"), choice = await json("data/sampleA-cfr-choice.json");
  if (baseline.mode !== "remux" || !baseline.contentPacket || baseline.audioTreatment !== "mpeg2-aac-lc" || baseline.videoTreatment || baseline.durationSeconds < 120 || baseline.durationSeconds > 160) throw new Error("Bounded audio-success baseline required");
  const rate = cfr30 ? "30000/1001" : "60000/1001";
  if (!choice.results?.some((r: { rate: string; lostUniqueSourceFrames: number }) => r.rate === rate && (cfr30 || r.lostUniqueSourceFrames === 0)) || !choice.shortIntervalsDistinctPixels) throw new Error("Read-only CFR content evidence required");
  const previous: ExperimentalMediaConfig | undefined = cfr30 ? await json("data/experimental-remux-small-blocks.json") : undefined;
  if (previous && (previous.videoTreatment !== "cfr-idr" || previous.contentPacketMaxSeconds !== .5 || previous.audioTreatment !== baseline.audioTreatment || previous.port !== baseline.port || previous.udn !== baseline.udn)) throw new Error("Previous small-block trial required");
  const before = await stat(baseline.file), exec = promisify(execFile), opts = { windowsHide: true, timeout: 240000, maxBuffer: 32 * 1024 * 1024 };
  const probe = async (file: string, args: string[]) => JSON.parse((await exec(process.env.PT3_FFPROBE || "ffprobe", ["-v", "error", ...args, "-of", "json", file], opts)).stdout);
  const original = await probe(baseline.file, ["-show_streams"]);
  const video = original.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  if (video.width !== 1920 || video.height !== 1080 || video.pix_fmt !== "yuv420p") throw new Error("Audited 1080p 8bit420 baseline required");
  const directory = await mkdtemp(path.resolve("data/sampleA-video-")), ts = path.join(directory, "sampleA.ts"), tts = path.join(directory, "sampleA.m2ts");
  const args = experimentalVideoArguments(baseline.file, ts, rate, "4.2"), encoded = await exec(process.env.PT3_FFMPEG || "ffmpeg", args, opts);
  await writeFile(path.join(directory, "encode.log"), encoded.stderr);
  const audioArgs = ["-select_streams", "a:0", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=pts,dts,size,data_hash"];
  assert.deepEqual(await probe(ts, audioArgs), await probe(baseline.file, audioArgs), "Every compressed audio frame and PTS/DTS must be copied unchanged");
  const index = await buildPcrIndex(ts);
  if (!index || index.discontinuities || index.invalidIntervals || index.durationSeconds < 120 || index.durationSeconds > 160) throw new Error("Continuous PCR / bounded sample required");
  const outputSize = (await stat(ts)).size;
  await pipeline(createReadStream(ts), new Tts192Transform(0, index.averageBitrate, 0, outputSize / 188 * 192, index), createWriteStream(tts, { flags: "wx" }));
  const output = await probe(tts, ["-show_streams", "-show_format"]), outVideo = output.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  assert.equal(outVideo.codec_name, "h264"); assert.equal(outVideo.profile, "Main"); assert.equal(outVideo.level, 42); assert.equal(outVideo.width, 1920); assert.equal(outVideo.height, 1080); assert.equal(outVideo.pix_fmt, "yuv420p"); assert.equal(outVideo.has_b_frames, 0);
  // fps filter already produces CFR. A second output CFR synchronizer can pad
  // from zero under copyts and move video relative to the unchanged audio.
  assert.ok(Math.abs(Number(outVideo.start_time) - Number(video.start_time)) < 1001 / (cfr30 ? 30000 : 60000) / 2 + .001, "Video origin must stay within half a CFR frame of baseline");
  const after = await stat(baseline.file); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  const config: ExperimentalMediaConfig = { ...baseline, file: tts, durationSeconds: Number(output.format.duration), videoTreatment: "cfr-idr", ...(cfr30 ? { videoFrameRate: rate, contentPacketBlockBytes: 5568 } : {}) };
  const evidence = { baselineConfig: baseline, config, args, rate, choice, output, audioPacketsAndPtsDtsIdentical: true, baselineSize: before.size, baselineMtimeMs: before.mtimeMs, pcr: { pid: index.pid, samples: index.points.length, durationSeconds: index.durationSeconds, discontinuities: index.discontinuities, invalidIntervals: index.invalidIntervals }, note: "Video structural compatibility bundle (CFR/GOP/profile/references), not isolation of a single H.264 field. Audio content and timestamps unchanged. Not TV verified; no TV commands." };
  await writeFile(path.join(directory, "preparation.json"), JSON.stringify({ ...evidence, ...(cfr30 ? { previousConfig: previous, diagnosticFrameDroppingAllowed: true, frameSelection: "FFmpeg fps=30000/1001:round=near; timestamps rounded to output grid, frames duplicated/dropped on that grid; no motion interpolation", levelKeptAt42: true, blockBytesKeptAt5568: true } : {}) }, null, 2)); await writeFile(cfr30 ? "data/experimental-remux-cfr30.json" : "data/experimental-remux-video.json", JSON.stringify(config, null, 2));
  console.log(JSON.stringify({ config, evidence: path.join(directory, "preparation.json"), audioPacketsAndPtsDtsIdentical: true, outputVideo: outVideo, pcr: evidence.pcr }, null, 2)); return evidence;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== "--cfr30") || process.argv.length > 3) throw new Error("Use optional --cfr30");
  await prepareExperimentalVideo(process.argv[2] === "--cfr30");
}
