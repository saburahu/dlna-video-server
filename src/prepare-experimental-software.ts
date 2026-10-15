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
import { auditVideoClock } from "./experimental-video-clock.js";
import type { ExperimentalMediaConfig } from "./experimental-media.js";

export function softwareVideoArguments(input: string, output: string, vfr: boolean) {
  return ["-hide_banner", "-nostdin", "-n", "-copyts", "-i", input, "-map", "0:v:0", "-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
    "-vf", vfr ? "format=yuv420p" : "fps=60000/1001:round=near,format=yuv420p", "-fps_mode", "passthrough", "-enc_time_base:v", "1:90000",
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-level:v", "4.2", "-g", "120", "-keyint_min", "1", "-bf", "0", "-refs", "1",
    "-force_key_frames", "expr:gte(t,n_forced*2.002)", "-forced-idr", "1", "-b:v", "8M", "-maxrate", "10M", "-bufsize", "10M",
    "-x264-params", `nal-hrd=vbr:force-cfr=${vfr ? 0 : 1}:aud=1:repeat-headers=1:scenecut=0:rc-lookahead=0`,
    "-c:a", "copy", "-mpegts_copyts", "1", "-avoid_negative_ts", "disabled", "-f", "mpegts", output];
}

/** Bounded offline comparison pair. TV sequencing is explicit in the renderer runner. */
export async function prepareExperimentalSoftware() {
  const json = async (f: string) => JSON.parse((await readFile(f, "utf8")).replace(/^\uFEFF/, ""));
  const baseline: ExperimentalMediaConfig = await json("data/experimental-remux-audio.json");
  assert.ok(baseline.mode === "remux" && baseline.contentPacket && baseline.audioTreatment === "mpeg2-aac-lc" && !baseline.videoTreatment);
  assert.ok(baseline.durationSeconds >= 120 && baseline.durationSeconds <= 160, "Bounded existing sample required");
  const before = await stat(baseline.file), directory = await mkdtemp(path.resolve("data/sampleA-software-"));
  const exec = promisify(execFile), opts = { windowsHide: true, timeout: 240000, maxBuffer: 64 * 1024 * 1024 };
  const probe = async (f: string, args: string[]) => JSON.parse((await exec(process.env.PT3_FFPROBE || "ffprobe", ["-v", "error", ...args, "-of", "json", f], opts)).stdout);
  const videoArgs = ["-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts,dts,flags"];
  const audioArgs = ["-select_streams", "a:0", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=pts,dts,size,data_hash"];
  const inputVideo = (await probe(baseline.file, videoArgs)).packets.sort((a: { pts: number }, b: { pts: number }) => a.pts - b.pts);
  const referenceCfr: ExperimentalMediaConfig = await json("data/experimental-remux-video.json");
  const cfrVideo = (await probe(referenceCfr.file, videoArgs)).packets;
  const evidence: unknown[] = [];
  for (const vfr of [false, true]) {
    const mode = vfr ? "vfr" : "cfr", ts = path.join(directory, mode + ".ts"), tts = path.join(directory, mode + ".m2ts"), args = softwareVideoArguments(baseline.file, ts, vfr);
    const encoded = await exec(process.env.PT3_FFMPEG || "ffmpeg", args, opts); await writeFile(path.join(directory, mode + "-encode.log"), encoded.stderr);
    const packets = (await probe(ts, videoArgs)).packets as { pts: number; dts: number; flags: string }[];
    assert.deepEqual(packets.map(p => p.pts), (vfr ? inputVideo : cfrVideo).map((p: { pts: number }) => p.pts));
    assert.ok(packets.every(p => p.pts === p.dts));
    assert.deepEqual(await probe(ts, audioArgs), await probe(baseline.file, audioArgs));
    const trace = (await exec(process.env.PT3_FFMPEG || "ffmpeg", ["-hide_banner", "-nostdin", "-i", ts, "-map", "0:v:0", "-c:v", "copy", "-bsf:v", "trace_headers", "-an", "-f", "null", "-"], opts)).stderr;
    await writeFile(path.join(directory, mode + "-trace.log"), trace);
    const clock = auditVideoClock(trace, packets.map(p => ({ pts: p.pts, key: p.flags.includes("K") })));
    assert.equal(clock.mismatchCount, 0, "HRD presentation clock must follow actual PTS"); assert.deepEqual(clock.fixedFrameRateValues, [vfr ? 0 : 1]);
    const index = await buildPcrIndex(ts); assert.ok(index && !index.discontinuities && !index.invalidIntervals && index.durationSeconds >= 120 && index.durationSeconds <= 160);
    const size = (await stat(ts)).size;
    await pipeline(createReadStream(ts), new Tts192Transform(0, index.averageBitrate, 0, size / 188 * 192, index), createWriteStream(tts, { flags: "wx" }));
    const decode = await exec(process.env.PT3_FFMPEG || "ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-i", tts, "-t", "120", "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], opts); assert.equal(decode.stderr.trim(), "");
    const output = await probe(tts, ["-show_format", "-show_streams"]);
    const config: ExperimentalMediaConfig = { ...baseline, file: tts, durationSeconds: Number(output.format.duration), videoTreatment: vfr ? "vfr-idr" : "cfr-idr", videoEncoder: "libx264", contentPacketBlockBytes: 5568 };
    evidence.push({ mode, file: tts, args, clock, output, frames: packets.length, audioIdentical: true, ptsMatchReference: true, decode120Seconds: true, pcrPid: index.pid });
    await writeFile(vfr ? "data/experimental-software-vfr.json" : "data/experimental-software-control.json", JSON.stringify(config, null, 2));
  }
  const after = await stat(baseline.file); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  await writeFile(path.join(directory, "preparation.json"), JSON.stringify({ directory, baseline, evidence, baselineUnchanged: true, noTvCommands: true }, null, 2));
  await writeFile("data/experimental-software-preparation.json", JSON.stringify({ directory, evidence }, null, 2));
  console.log(JSON.stringify({ directory, evidence }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("No options; bounded diagnostic pair only");
  await prepareExperimentalSoftware();
}
