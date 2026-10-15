import { test } from 'node:test';
import assert from 'node:assert/strict';
import { negativeControlVideoArguments, negativeControlAudioArguments, negativeControlAudioTsArguments } from '../src/experimental-negative-control.js';
test('negative control resizes without frame rate conversion or frame selection', () => {
  const a = negativeControlVideoArguments('source.mp4', 'output.ts', 4497, 150.05);
  assert.ok(!a.includes('-r'));
  assert.doesNotMatch(a[a.indexOf('-vf') + 1], /fps=|select=|setpts=/);
  assert.equal(a[a.indexOf('-frames:v') + 1], '4497');
  assert.equal(a[a.indexOf('-fps_mode') + 1], 'passthrough');
  assert.equal(a[a.indexOf('-bf') + 1], '0');
  assert.equal(a[a.indexOf('-level:v') + 1], '4.0');
  assert.throws(() => negativeControlVideoArguments('same', 'same', 1, 1));
});
test('AAC padding is compensated while one common mux shift preserves the audio origin', () => {
  const a = negativeControlAudioArguments('source.mp4', 'audio.aac', 150.05);
  assert.equal(a[a.indexOf('-write_mpeg2') + 1], '1');
  assert.equal(a[a.indexOf('-ar') + 1], '48000');
  const mux = negativeControlAudioTsArguments('audio.aac', 'audio.ts', 0, 255003);
  assert.ok(Math.abs(Number(mux[mux.indexOf('-itsoffset') + 1]) - (255003 - 1920) / 90000) < 1e-9);
});
