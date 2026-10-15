import test from 'node:test';
import assert from 'node:assert/strict';
import { EitObservation, selectRecordingEvent } from '../src/recording-event.js';

const start = Date.parse('2026-08-21T20:59:00+09:00');
const window = {startTimeMs: start, durationSeconds: 3390, serviceId: 101};
function o(eventId: number, offset: number, seconds: number, durationSeconds: number,
  role: EitObservation['role'] = 'present', serviceId = 101): EitObservation {
  return {serviceId, eventId, recordingSeconds: seconds, startTimeMs: start + offset * 1000, durationSeconds, role,
    observedTimeMs: start + seconds * 1000};
}
function margins() {
  const rows = [o(1, -3540, 0, 3600), o(2, 60, 0, 3240, 'following')];
  for (let seconds = 10; seconds < 3390; seconds += 10)
    rows.push(seconds < 60 ? o(1, -3540, seconds, 3600) : seconds < 3300 ? o(2, 60, seconds, 3240) : o(3, 3300, seconds, 1800));
  rows.push(o(3, 3300, 3390, 1800)); return rows;
}
test('前1分・主番組54分・後1分30秒: 最初と最後のpresentを採用しない', () => {
  const r = selectRecordingEvent(margins(), window);
  assert.equal(r.primary?.eventId, 2); assert.equal(r.reason, 'recording-overlap'); assert.equal(r.provisional, true);
  assert.deepEqual(r.candidates.map(c => c.overlapSeconds), [60, 3240, 90]);
  assert.deepEqual(r.candidates.map(c => c.observedPresentSeconds), [60, 3240, 90]);
  const c = r.primary!; assert.equal(c.following.count, 1); assert.deepEqual(c.following.recordingSeconds, [0]);
  assert.equal(c.following.observedTimeMs[0], start); assert.equal(c.present.count, 324);
});
test('followingのみの対象も、放送時間の重なりが最大なら主候補', () => {
  const r = selectRecordingEvent([o(1, -3540, 0, 3600), o(2, 60, 0, 3240, 'following')], window);
  assert.equal(r.primary?.eventId, 2); assert.equal(r.primary?.present.count, 0);
  assert.equal(r.primary?.observedPresentSeconds, 0);
});
test('予約service/event一致は重なりより優先、不一致を別番組へ代替しない', () => {
  const rows = margins(); rows.push(o(1, -3540, 2, 3600, 'following', 202));
  assert.equal(selectRecordingEvent(rows, window, {serviceId: 101, eventId: 1}).primary?.serviceId, 101);
  assert.equal(selectRecordingEvent(rows, window, {serviceId: 101, eventId: 1}).reason, 'reservation');
  assert.equal(selectRecordingEvent(rows, window, {serviceId: 101, eventId: 99}).primary, null);
});
test('event ID再利用は開始時刻で区別し、予約が曖昧なら確定しない', () => {
  const rows = [o(2, 60, 0, 3240, 'following'), o(2, 86460, 1, 3240, 'following')];
  assert.equal(selectRecordingEvent(rows, window, {serviceId: 101, eventId: 2}).reason, 'ambiguous');
  const r = selectRecordingEvent(rows, window, {serviceId: 101, eventId: 2, startTimeMs: start + 60000});
  assert.equal(r.primary?.startTimeMs, start + 60000); assert.equal(r.candidates.length, 2);
});
test('リピート回数を放送時間と混同せず、観測欠落と未観測終端を延長しない', () => {
  const rows = Array.from({length: 100}, () => o(1, -3540, 0, 3600));
  rows.push(o(2, 60, 60, 3240), o(2, 60, 70, 3240), o(2, 60, 200, 3240), o(3, 3300, 3300, 1800));
  const r = selectRecordingEvent(rows, {durationSeconds: 3390, serviceId: 101});
  assert.equal(r.primary?.eventId, 2); assert.equal(r.reason, 'observed-present');
  assert.equal(r.primary?.observedPresentSeconds, 10); assert.equal(r.candidates[0].observedPresentSeconds, 0);
  assert.equal(r.candidates[0].present.count, 100); assert.equal(r.candidates.at(-1)?.observedPresentSeconds, 0);
});
test('放送延長でduration更新を保持し、最新値を選定に使用', () => {
  const r = selectRecordingEvent([o(2, 60, 0, 3000, 'following'), o(2, 60, 65, 3240)], window);
  assert.deepEqual(r.primary?.durationHistorySeconds, [3000, 3240]); assert.equal(r.primary?.overlapSeconds, 3240);
});
test('時刻未定・followingのみ・同点・別serviceは推測で確定しない', () => {
  const unknown = {...o(2, 60, 0, 3240, 'following'), startTimeMs: null, durationSeconds: null};
  assert.equal(selectRecordingEvent([unknown], window).primary, null);
  assert.equal(selectRecordingEvent([o(2, 60, 0, 3240, 'following')], {durationSeconds: 3390}).primary, null);
  assert.equal(selectRecordingEvent([o(2, 60, 0, 3240), o(3, 60, 0, 3240)], window).reason, 'ambiguous');
  const r = selectRecordingEvent([o(2, 60, 0, 3240), o(8, 0, 0, 5000, 'present', 202)], window);
  assert.equal(r.primary?.eventId, 2); assert.equal(r.candidates.length, 2);
  assert.equal(selectRecordingEvent([o(2, 60, 0, 3240), o(8, 0, 0, 5000, 'present', 202)],
    {startTimeMs: start, durationSeconds: 3390}).reason, 'ambiguous');
});
test('入力を変更せず、JST日付跨ぎもepochで重なりを計算、不正値は拒否', () => {
  const midnight = Date.parse('2026-08-22T00:00:00+09:00');
  const rows = [{...o(7, 0, 0, 3600), startTimeMs: midnight}]; const before = structuredClone(rows);
  assert.equal(selectRecordingEvent(rows, {startTimeMs: midnight - 60000, durationSeconds: 3720}).primary?.overlapSeconds, 3600);
  assert.deepEqual(rows, before);
  assert.throws(() => selectRecordingEvent(rows, {durationSeconds: -1}), RangeError);
  assert.throws(() => selectRecordingEvent([{...rows[0], recordingSeconds: NaN}], window), RangeError);
});
test('実時刻が未取得の観測も録画内時刻との対応を保持する', () => {
  const unknownClock = {...o(2, 60, 0, 3240), observedTimeMs: undefined};
  const r = selectRecordingEvent([unknownClock, o(2, 60, 10, 3240)], window);
  assert.deepEqual(r.primary?.present.recordingSeconds, [0, 10]);
  assert.deepEqual(r.primary?.present.observedTimeMs, [null, start + 10000]);
});
