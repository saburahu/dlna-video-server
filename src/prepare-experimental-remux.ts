import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { buildPcrIndex } from "./pcr-index.js";
import { Tts192Transform } from "./tts.js";
import type { ExperimentalMediaConfig } from "./experimental-media.js";

export const REMUX_SAMPLE_SECONDS = 150;
export function remuxArguments(source: string, output: string) {
  return ["-hide_banner", "-nostdin", "-n", "-i", source, "-t", String(REMUX_SAMPLE_SECONDS),
    "-map", "0:v:0", "-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
    "-c:v", "copy", "-c:a", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "mpegts", output];
}

export async function prepareExperimentalRemux() {
  const config: ExperimentalMediaConfig = JSON.parse((await readFile("data/experimental-media.json", "utf8")).replace(/^\uFEFF/, ""));
  const sourceBefore = await stat(config.file);
  const exec = promisify(execFile);
  const sourceProbe = await exec(process.env.PT3_FFPROBE || "ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", config.file], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const media = JSON.parse(sourceProbe.stdout);
  const video = media.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const audio = media.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  if (video?.codec_name !== "h264" || audio?.codec_name !== "aac") throw new Error("This experiment requires H.264/AAC; no encoder fallback permitted");
  await mkdir("data", { recursive: true });
  const directory = await mkdtemp(path.resolve("data/sampleA-remux-"));
  const ts = path.join(directory, "sampleA.ts"), tts = path.join(directory, "sampleA.m2ts");
  const args = remuxArguments(config.file, ts);
  const result = await exec(process.env.PT3_FFMPEG || "ffmpeg", args, { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(path.join(directory, "ffmpeg.log"), result.stderr);
  const index = await buildPcrIndex(ts);
  if (!index || index.discontinuities || index.invalidIntervals || index.durationSeconds < 120 || index.durationSeconds > 160) throw new Error("Generated sample lacks valid continuous PCR/120s coverage");
  const size = (await stat(ts)).size;
  if (size % 188) throw new Error("Generated TS not packet aligned");
  await pipeline(createReadStream(ts), new Tts192Transform(0, index.averageBitrate, 0, size / 188 * 192, index), createWriteStream(tts, { flags: "wx" }));
  const outputProbe = await exec(process.env.PT3_FFPROBE || "ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", tts], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const output = JSON.parse(outputProbe.stdout);
  const outVideo = output.streams.find((s: { codec_type: string }) => s.codec_type === "video"), outAudio = output.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  for (const key of ["codec_name", "profile", "level", "width", "height", "pix_fmt"]) if (video[key] !== outVideo?.[key]) throw new Error(`Video property changed: ${key}`);
  for (const key of ["codec_name", "profile", "sample_rate", "channels"]) if (audio[key] !== outAudio?.[key]) throw new Error(`Audio property changed: ${key}`);
  const sourceAfter = await stat(config.file);
  if (sourceAfter.size !== sourceBefore.size || sourceAfter.mtimeMs !== sourceBefore.mtimeMs) throw new Error("Source changed during preparation");
  const prepared: ExperimentalMediaConfig = { ...config, file: tts, title: "【Remux実験】サンプル映像A「サンプル章」先頭150秒", mode: "remux", ssdp: false, port: 19093, udn: `uuid:${randomUUID()}`, durationSeconds: Number(output.format.duration) };
  const evidence = { source: config.file, sourceSize: sourceBefore.size, sourceMtimeMs: sourceBefore.mtimeMs, args, sourceVideo: video, sourceAudio: audio, outputVideo: outVideo, outputAudio: outAudio, outputFile: tts, outputSize: (await stat(tts)).size, pcr: { pid: index.pid, samples: index.points.length, durationSeconds: index.durationSeconds, discontinuities: index.discontinuities, invalidIntervals: index.invalidIntervals, averageBitsPerSecond188: index.averageBitrate }, tts: "full32bit/27MHz/big-endian/PCR-interpolated/offset0; not FFmpeg M2TS30bit", declaration: "AVC_TS_JP_AAC_T experimental, not certified profile compliance" };
  await writeFile(path.join(directory, "preparation.json"), JSON.stringify(evidence, null, 2));
  await writeFile("data/experimental-remux.json", JSON.stringify(prepared, null, 2));
  console.log(JSON.stringify({ config: "data/experimental-remux.json", evidence: path.join(directory, "preparation.json"), ...evidence.pcr }, null, 2));
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareExperimentalRemux();
}
