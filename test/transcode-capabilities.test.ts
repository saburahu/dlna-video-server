import test from "node:test";
import assert from "node:assert/strict";
import { detectCapabilities, encoderPresent, encoders, selectBackend, decodeArguments, benchmark, type Runner } from "../src/transcode-capabilities.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mp4DirectExperiment } from "../src/playback-strategy.js";

const list = Object.values(encoders).map(name => ` V....D ${name} encoder`).join("\n");
function fake(failed: string[] = [], absent: string[] = []): Runner {
  return async args => {
    const encoder = args[args.indexOf("-c:v") + 1];
    return { success: !failed.includes(encoder), stdout: args[0] === "-version" ? "ffmpeg test" : args.includes("-encoders") ? list.split("\n").filter(line => !absent.some(x => line.includes(x))).join("\n") : "",
      stderr: failed.includes(encoder) ? "initialization failed" : "", elapsedSeconds: encoder === "h264_amf" ? .2 : encoder === "h264_qsv" ? .3 : .5 };
  };
}
test("encoder listing uses complete token, not substring/description", () => {
  for (const name of Object.values(encoders)) assert.equal(encoderPresent(list, name), true);
  assert.equal(encoderPresent(" V....D h264_nvenc_extra describes h264_nvenc", "h264_nvenc"), false);
});
test("initialization failure is unavailable even when listed; all four candidates retained", async () => {
  const c = await detectCapabilities(fake(["h264_amf", "h264_qsv"]));
  assert.deepEqual(Object.keys(c.candidates), Object.keys(encoders));
  assert.equal(c.candidates.amf.present, true); assert.equal(c.candidates.amf.available, false);
  assert.match(c.candidates.qsv.reason!, /failed/); assert.equal(c.candidates.nvenc.available, true);
});
test("missing encoders are never probed", async () => {
  let calls = 0; const run = fake([], ["h264_amf"]);
  const c = await detectCapabilities(async args => { calls++; return run(args); });
  assert.equal(c.candidates.amf.present, false); assert.equal(calls, 5);
});
test("auto ranks available hardware by measured probe, no NVIDIA fixed preference", async () => {
  const c = await detectCapabilities(fake()); assert.equal(selectBackend(c).backend, "amf");
  c.candidates.qsv.probeFramesPerSecond = 999; assert.equal(selectBackend(c).backend, "qsv");
});
test("configured available backend wins, including explicit software", async () => {
  const c = await detectCapabilities(fake());
  for (const backend of Object.keys(encoders) as (keyof typeof encoders)[]) assert.equal(selectBackend(c, backend).backend, backend);
});
test("configured unavailable falls back; software only if no hardware initializes", async () => {
  const c = await detectCapabilities(fake(["h264_amf", "h264_qsv"]));
  assert.equal(selectBackend(c, "amf").backend, "nvenc");
  c.candidates.nvenc.available = false; assert.equal(selectBackend(c).backend, "software");
  c.candidates.software.available = false; assert.throws(() => selectBackend(c), /No initialized/);
});
test("FFmpeg command failures do not create fictitious capabilities", async () => {
  await assert.rejects(detectCapabilities(async () => ({ success: false, stdout: "", stderr: "not found", elapsedSeconds: 0 })), /detection failed/);
});
test("decoder and playback strategy do not depend on selected encoder", () => {
  assert.deepEqual(decodeArguments("cpu"), []); assert.deepEqual(decodeArguments("cuda"), ["-hwaccel", "cuda"]);
  assert.deepEqual(decodeArguments("qsv"), ["-hwaccel", "qsv"]); assert.deepEqual(decodeArguments("d3d11va"), ["-hwaccel", "d3d11va"]);
  assert.equal(mp4DirectExperiment.mode, "direct"); assert.equal(mp4DirectExperiment.copyVideo, true);
});
test("benchmark measures actual progress/CPU independently of encoder and writes only null output", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pt3-benchmark-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fixture.mkv"); await writeFile(file, "readonly fixture");
  const result = await benchmark(file, "amf", "cpu", 20, async args => {
    assert.equal(args[args.indexOf("-i") + 1], file); assert.equal(args[args.indexOf("-c:v") + 1], "h264_amf");
    assert.equal(args.includes("-hwaccel"), false); assert.deepEqual(args.slice(-3), ["-f", "null", "-"]);
    return { success: true, stdout: "frame=30\nfps=100.0\nspeed=3.2x\n", stderr: "bench: utime=0.3s stime=0.2s rtime=1s", elapsedSeconds: 1 };
  });
  assert.equal(result.success, true); assert.equal(result.speed, "3.2x"); assert.equal(result.fps, "100.0"); assert.ok(result.cpuPercentOfMachine! > 0);
  const empty = await benchmark(file, "nvenc", "cuda", 20, async args => {
    assert.deepEqual(args.slice(5, 7), ["-hwaccel", "cuda"]);
    return { success: true, stdout: "frame=0\n", stderr: "", elapsedSeconds: 1 };
  });
  assert.equal(empty.success, false); assert.match(empty.reason!, /No frames/);
  await assert.rejects(benchmark(file, "nvenc", "cpu", 100), /seconds/);
});
