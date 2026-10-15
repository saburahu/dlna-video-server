import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { REMUX_SAMPLE_SECONDS } from "./prepare-experimental-remux.js";
import { buildPcrIndex } from "./pcr-index.js";
import { Tts192Transform } from "./tts.js";
import { auditAdts, auditExperimentalAudio } from "./experimental-audio-audit.js";
import type { ExperimentalMediaConfig } from "./experimental-media.js";

// FFmpeg native AAC uses 1024 samples of initial padding. Compensate the ADTS
// intermediate's lost timestamps; verify unchanged video timestamps below.
export const EXPERIMENTAL_AAC_RATE = 48000;
export const EXPERIMENTAL_AAC_DELAY_SAMPLES = 1024;
export function experimentalAudioArguments(source: string, adts: string) {
  return ["-hide_banner", "-nostdin", "-n", "-i", source, "-t", String(REMUX_SAMPLE_SECONDS),
    "-map", "0:a:0", "-c:a", "aac", "-profile:a", "mpeg2_aac_low", "-aac_pns", "0",
    "-ar", String(EXPERIMENTAL_AAC_RATE), "-ac", "2", "-b:a", "192k",
    "-f", "adts", "-write_mpeg2", "1", adts];
}
export function experimentalAudioMuxArguments(source: string, adts: string, output: string) {
  return ["-hide_banner", "-nostdin", "-n", "-i", source,
    "-itsoffset", String(-EXPERIMENTAL_AAC_DELAY_SAMPLES / EXPERIMENTAL_AAC_RATE), "-i", adts,
    "-t", String(REMUX_SAMPLE_SECONDS), "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
    "-c:v", "copy", "-c:a", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "mpegts", output];
}

/** Isolated audio-only preparation: never writes the source or normal config. */
export async function prepareExperimentalAudio() {
  const json = async (file: string) => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  const source: ExperimentalMediaConfig = await json("data/experimental-media.json");
  const baseline: ExperimentalMediaConfig = await json("data/experimental-remux-wrapped.json");
  if (baseline.mode !== "remux" || !baseline.contentPacket) throw new Error("Wrapped successful baseline required");
  const before = await stat(source.file), baselineBefore = await stat(baseline.file);
  const exec = promisify(execFile), options = { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 };
  const probe = async (file: string, args: string[]) => JSON.parse((await exec(process.env.PT3_FFPROBE || "ffprobe", ["-v", "error", ...args, "-of", "json", file], options)).stdout);
  const sourceProbe = await probe(source.file, ["-show_streams"]);
  if (!sourceProbe.streams.some((s: { codec_type: string; codec_name: string }) => s.codec_type === "video" && s.codec_name === "h264")) throw new Error("H.264 source required");
  const directory = await mkdtemp(path.resolve("data/sampleA-audio-"));
  const adts = path.join(directory, "audio.aac"), ts = path.join(directory, "sampleA.ts"), tts = path.join(directory, "sampleA.m2ts");
  const encodeArgs = experimentalAudioArguments(source.file, adts);
  const encoded = await exec(process.env.PT3_FFMPEG || "ffmpeg", encodeArgs, options);
  await writeFile(path.join(directory, "audio-encode.log"), encoded.stderr);
  const adtsAudit = auditAdts(await readFile(adts));
  const expectedKind = JSON.stringify({ mpegId: 1, profile: 2, sampleFrequencyIndex: 3, channelConfiguration: 2 });
  if (adtsAudit.frames < 5600 || adtsAudit.invalidInterior || adtsAudit.leadingBytes || adtsAudit.trailingBytes || adtsAudit.kinds[expectedKind] !== adtsAudit.frames) throw new Error("MPEG-2 AAC-LC ADTS validation failed");
  const muxArgs = experimentalAudioMuxArguments(source.file, adts, ts);
  const muxed = await exec(process.env.PT3_FFMPEG || "ffmpeg", muxArgs, options);
  await writeFile(path.join(directory, "mux.log"), muxed.stderr);
  const audioAudit = auditExperimentalAudio(await readFile(ts));
  if (audioAudit.adts.frames < 5600 || audioAudit.adts.invalidInterior || audioAudit.adts.leadingBytes || audioAudit.adts.trailingBytes || audioAudit.adts.kinds[expectedKind] !== audioAudit.adts.frames || audioAudit.pes.ptsIntervalsMs?.negative || audioAudit.pes.incompleteExcluded || !audioAudit.pmts.length || !audioAudit.pmts.every(p => p.audio.length && p.audio.every(a => a.streamType === 15))) throw new Error("TS audio framing/timing validation failed");
  const packetArgs = ["-select_streams", "v:0", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=pts,dts,size,data_hash"];
  const originalVideo = await probe(baseline.file, packetArgs), generatedVideo = await probe(ts, packetArgs);
  assert.deepEqual(generatedVideo.packets, originalVideo.packets, "Video encoded packets AND PTS/DTS must remain identical");
  const index = await buildPcrIndex(ts);
  if (!index || index.discontinuities || index.invalidIntervals || index.durationSeconds < 120 || index.durationSeconds > 160) throw new Error("Continuous PCR required");
  const size = (await stat(ts)).size;
  await pipeline(createReadStream(ts), new Tts192Transform(0, index.averageBitrate, 0, size / 188 * 192, index), createWriteStream(tts, { flags: "wx" }));
  const output = await probe(tts, ["-show_streams", "-show_format"]);
  const sourceAfter = await stat(source.file), baselineAfter = await stat(baseline.file);
  assert.equal(sourceAfter.size, before.size); assert.equal(sourceAfter.mtimeMs, before.mtimeMs);
  assert.equal(baselineAfter.size, baselineBefore.size); assert.equal(baselineAfter.mtimeMs, baselineBefore.mtimeMs);
  const config: ExperimentalMediaConfig = { ...baseline, file: tts, durationSeconds: Number(output.format.duration), audioTreatment: "mpeg2-aac-lc" };
  const evidence = { source: source.file, sourceSize: before.size, sourceMtimeMs: before.mtimeMs, baseline: baseline.file, encodeArgs, muxArgs, adtsAudit, audioAudit, videoPacketsAndTimestampsIdentical: true, videoPackets: generatedVideo.packets.length, output, pcr: { pid: index.pid, durationSeconds: index.durationSeconds, discontinuities: index.discontinuities, invalidIntervals: index.invalidIntervals }, config, note: "Audio-only compatibility experiment, not proof of full ISO/DLNA conformance; no TV commands sent" };
  await writeFile(path.join(directory, "preparation.json"), JSON.stringify(evidence, null, 2));
  await writeFile("data/experimental-remux-audio.json", JSON.stringify(config, null, 2));
  console.log(JSON.stringify({ config: "data/experimental-remux-audio.json", evidence: path.join(directory, "preparation.json"), videoPackets: evidence.videoPackets, audio: audioAudit, pcr: evidence.pcr }, null, 2));
  return evidence;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareExperimentalAudio();
