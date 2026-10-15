import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCadenceNormalization, pictureDensity, type TargetTimingPolicy } from '../src/cadence-plan.js';
const policy: TargetTimingPolicy = { id: 'explicit-test-policy', mediaProfile: 'test-profile', evidence: 'compatibility-experiment', maxFrameMacroblocks: 8192, constraint: { codedWidth: 1920, codedHeight: 1088, maxMBPS: 245760, minimumFrameSeconds: 1 / 172, timebase: 90000 } };
test('target size and processing limit select local pictures without moving retained timestamps', () => {
  const source = [0, 4505, 7508, 9009, 10511, 13514, 18019];
  const result = planCadenceNormalization(source, policy);
  assert.equal(result.required, true);
  assert.deepEqual(result.normalizedTimestamps, [0, 4505, 7508, 10511, 13514, 18019]);
  assert.equal(result.dropped[0].reason, 'below-target-minimum-removal-interval');
  assert.equal(result.diagnostics.output.violations.count, 0);
  assert.equal(result.diagnostics.dropsOutsideSourceShortIntervals, 0);
  assert.equal(result.diagnostics.maximumConsecutiveDrops, 1);
  assert.deepEqual(source, [0, 4505, 7508, 9009, 10511, 13514, 18019]);
});
test('same cadence needs no conversion under a sufficiently capable target', () => {
  const source = [0, 1502, 3003, 4505];
  const result = planCadenceNormalization(source, { ...policy, constraint: { ...policy.constraint, maxMBPS: 522240 } });
  assert.equal(result.required, false); assert.deepEqual(result.normalizedTimestamps, source);
  assert.equal(planCadenceNormalization(source, policy).required, true);
});
test('sparse irregular cadence is unchanged and final-frame loss is reported rather than hidden', () => {
  assert.equal(planCadenceNormalization([0, 3003, 7508, 10511], policy).required, false);
  const result = planCadenceNormalization([0, 3003, 4504], policy);
  assert.equal(result.diagnostics.lastPictureRetained, false);
  assert.equal(result.duplicated, 0);
});
test('density excludes right boundary and policy cannot repair excessive frame size by dropping', () => {
  assert.equal(pictureDensity([0, 9000, 18000], 90000)[0].maximum, 1);
  assert.throws(() => planCadenceNormalization([0, 3003], { ...policy, constraint: { ...policy.constraint, codedWidth: 3840, codedHeight: 2160 } }), /MaxFS/);
  assert.throws(() => planCadenceNormalization([0, 0], policy));
});
