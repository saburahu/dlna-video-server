import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { stat } from "node:fs/promises";
import type { DecodeBackend } from "./playback-strategy.js";

export const encoders = { nvenc: "h264_nvenc", amf: "h264_amf", qsv: "h264_qsv", software: "libx264" } as const;
export type Backend = keyof typeof encoders;
export type BackendPreference = Backend | "auto";
export interface CommandResult { success: boolean; stdout: string; stderr: string; elapsedSeconds: number }
export type Runner = (args: string[]) => Promise<CommandResult>;
export function ffmpegRunner(binary = process.env.PT3_FFMPEG || "ffmpeg", timeout = 120_000): Runner {
  return args => new Promise(resolve => {
    const start = performance.now();
    execFile(binary, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ success: !error, stdout, stderr: stderr || (error ? error.message : ""), elapsedSeconds: (performance.now() - start) / 1000 });
    });
  });
}
export interface Capability {
  encoder: string; present: boolean; available: boolean; reason?: string;
  initializationSeconds?: number; probeFramesPerSecond?: number;
}
export interface Capabilities { version: string; candidates: Record<Backend, Capability> }
export function encoderPresent(list: string, encoder: string): boolean {
  return list.split(/\r?\n/).some(line => /^\s*[VAS][A-Z.]{5}\s+(\S+)\s/.exec(line)?.[1] === encoder);
}
export async function detectCapabilities(run: Runner = ffmpegRunner()): Promise<Capabilities> {
  const version = await run(["-version"]);
  const list = await run(["-hide_banner", "-encoders"]);
  if (!version.success || !list.success) throw new Error(`FFmpeg detection failed: ${version.stderr || list.stderr}`);
  const candidates = {} as Record<Backend, Capability>;
  // Serial probes avoid competing for GPU sessions. Same input and frame count for every vendor.
  for (const backend of Object.keys(encoders) as Backend[]) {
    const encoder = encoders[backend];
    if (!encoderPresent(list.stdout, encoder)) {
      candidates[backend] = { encoder, present: false, available: false, reason: "encoder not present" }; continue;
    }
    const probe = await run(["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-frames:v", "30", "-an", "-c:v", encoder, "-pix_fmt", "yuv420p", "-f", "null", "-"]);
    candidates[backend] = { encoder, present: true, available: probe.success,
      initializationSeconds: probe.elapsedSeconds,
      probeFramesPerSecond: probe.success ? 30 / Math.max(probe.elapsedSeconds, .001) : undefined,
      reason: probe.success ? undefined : probe.stderr.trim().slice(-3000) || "initialization failed" };
  }
  return { version: version.stdout.split(/\r?\n/)[0], candidates };
}
export function selectBackend(capabilities: Capabilities, preference: BackendPreference = "auto") {
  if (preference !== "auto" && capabilities.candidates[preference].available) {
    return { backend: preference, encoder: encoders[preference], reason: "configured backend", provisional: true };
  }
  const hardware = (Object.keys(encoders) as Backend[]).filter(b => b !== "software" && capabilities.candidates[b].available);
  // No vendor priority. This initialization probe is provisional, not a realtime/quality guarantee.
  hardware.sort((a, b) => (capabilities.candidates[b].probeFramesPerSecond || 0) - (capabilities.candidates[a].probeFramesPerSecond || 0) || a.localeCompare(b));
  const backend = hardware[0] || (capabilities.candidates.software.available ? "software" : undefined);
  if (!backend) throw new Error("No initialized H.264 encoder available");
  return { backend, encoder: encoders[backend], reason: preference === "auto" ? "hardware probe performance, then software fallback" : `${preference} unavailable; fallback`, provisional: true };
}
export function decodeArguments(decoder: DecodeBackend): string[] {
  // Default FFmpeg output is software frames; don't couple decoder choice to encoder surfaces.
  return decoder === "cpu" ? [] : ["-hwaccel", decoder];
}
export async function benchmark(file: string, backend: Backend, decoder: DecodeBackend = "cpu", seconds = 20, run: Runner = ffmpegRunner()) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error("benchmark seconds must be 1..60");
  const before = await stat(file);
  const args = ["-hide_banner", "-nostdin", "-benchmark", "-progress", "pipe:1", ...decodeArguments(decoder), "-ss", "60", "-i", file,
    "-t", String(seconds), "-map", "0:v:0", "-an", "-c:v", encoders[backend], "-pix_fmt", "yuv420p",
    ...(backend === "software" ? ["-preset", "veryfast", "-crf", "20"] : ["-b:v", "6M"]), "-f", "null", "-"];
  const result = await run(args);
  const last = (name: string) => [...result.stdout.matchAll(new RegExp(`^${name}=(.+)$`, "gm"))].at(-1)?.[1].trim();
  const time = /utime=([\d.]+)s stime=([\d.]+)s/.exec(result.stderr);
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Input changed during readonly benchmark");
  const frames = last("frame");
  const success = result.success && Number(frames) > 0;
  return { backend, encoder: encoders[backend], decoder, success, speed: last("speed"), fps: last("fps"), frames,
    elapsedSeconds: result.elapsedSeconds, cpuPercentOfMachine: time ? (Number(time[1]) + Number(time[2])) / result.elapsedSeconds / cpus().length * 100 : null,
    settings: backend === "software" ? "veryfast CRF20; video only, null sink" : "6Mbps; video only, null sink",
    reason: success ? undefined : result.success ? "No frames encoded (sample may be shorter than the 60s start offset)" : result.stderr.slice(-3000) };
}
