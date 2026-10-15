import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DiagnosticLog } from "../src/diagnostic-log.js";
import { summarize } from "../src/log-summary.js";

test("JSONLはdetailを保持し、再起動後追記し、容量・世代数を制限する", async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pt3-log-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = new DiagnosticLog(path.join(dir, "logs"), 180, 2); log.open([]);
  const first = { category: "TEST", detail: { text: "日本語", nested: [1, 2, 3] } };
  log.append(first);
  const reopened = new DiagnosticLog(log.directory, 180, 2); reopened.open([]); reopened.append(first);
  assert.deepEqual((await fs.readFile(log.file, "utf8")).trim().split("\n").map(line => JSON.parse(line)), [first, first]);
  for (let i = 0; i < 20; i++) reopened.append({ sequence: i, detail: "x".repeat(80) });
  const files = await fs.readdir(log.directory); assert.equal(files.length, 3);
  for (const file of files) { assert.ok((await fs.stat(path.join(log.directory, file))).size <= 180); JSON.parse((await fs.readFile(path.join(log.directory, file), "utf8")).trim()); }
  assert.throws(() => reopened.assertSeparate([dir]), /録画フォルダー/);
  assert.throws(() => reopened.assertSeparate([log.directory]), /録画フォルダー/);
  reopened.assertSeparate([path.join(dir, "recordings")]);
});

test("GETなしの試行と人の観測を集計し、再生成功を推測しない", () => {
  const result = summarize([
    { sessionId: "s", trialId: "a", savedProfile: "no-pn", category: "TRIAL_START", at: "now", detail: {} },
    { sessionId: "s", trialId: "b", savedProfile: "188", category: "TRIAL_START", at: "later", detail: {} },
    { sessionId: "s", trialId: "b", category: "TRIAL_OBSERVATION", detail: { source: "human", video: false, audio: null } }
  ]);
  assert.equal(result[0].getCount, 0); assert.equal(result[0].observation, null);
  assert.deepEqual(result[1].observation, { source: "human", video: false, audio: null });
});

test("途中で切れたJSONLの末尾と再起動後のログを混ぜない", async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pt3-torn-log-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "diagnostics.jsonl"), '{"old":true}\n{"partial":');
  const log = new DiagnosticLog(dir); log.open([]); log.append({ new: true });
  assert.deepEqual(JSON.parse((await fs.readFile(log.file, "utf8")).trim()), { new: true });
  assert.equal(await fs.readFile(log.file + ".1", "utf8"), '{"old":true}\n{"partial":');
});
