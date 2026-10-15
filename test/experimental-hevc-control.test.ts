import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hevcControlVideoArguments } from '../src/experimental-hevc-control.js';
test('HEVC compatibility encode preserves display cadence unless target plan requires selection', () => {
  const plain = hevcControlVideoArguments('source.mkv', 'derived.ts', 100, 5, 2989, false);
  assert.doesNotMatch(plain[plain.indexOf('-vf') + 1], /fps=|select=|setpts=/);
  assert.equal(plain[plain.indexOf('-fps_mode') + 1], 'passthrough');
  const normalized = hevcControlVideoArguments('source.mkv', 'derived.ts', 70, 5, 2989, true);
  assert.match(normalized[normalized.indexOf('-vf') + 1], /prev_selected_t.*2989/);
  assert.doesNotMatch(normalized[normalized.indexOf('-vf') + 1], /fps=|setpts=/);
  assert.equal(normalized[normalized.indexOf('-frames:v') + 1], '70');
  assert.throws(() => hevcControlVideoArguments('source', 'derived', 70, 5, 0, true));
});
