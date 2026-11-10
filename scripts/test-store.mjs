#!/usr/bin/env node
/**
 * Store-logic tests for the bugs that broke practical use:
 *
 *   1. compositeWear round-trips its input (the knob used to snap back to 56%)
 *   2. appending a second folder keeps the first one and de-dupes
 *   3. seek targets are clamped to the track
 *
 * Runs on plain Node (type stripping) — no test framework, no extra deps.
 *
 *   npm run test:store
 */
import assert from 'node:assert/strict';
import { appendTracks, clampSeek, compositeWear } from '../src/store/logic.ts';

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${label}\n        ${error.message.split('\n')[0]}`);
  }
}

console.log('--- composite wear knob ---');
check('recordAge is stored verbatim (0.5)', () => {
  assert.equal(compositeWear(0.5).recordAge, 0.5);
});
check('recordAge is stored verbatim at the top of the range (1.0)', () => {
  const wear = compositeWear(1);
  assert.equal(wear.recordAge, 1);
  // the old derived-average knob read back 0.562 here
  assert.ok(wear.recordAge > 0.99, `knob snapped back to ${wear.recordAge.toFixed(3)}`);
});
check('derived params stay inside 0..1', () => {
  for (const v of [-1, 0, 0.25, 0.5, 1, 2]) {
    const w = compositeWear(v);
    for (const key of ['vinylCondition', 'crackleIntensity', 'wowFlutterDepth', 'rumbleLevel', 'surfaceNoise']) {
      assert.ok(w[key] >= 0 && w[key] <= 1, `${key}=${w[key]} out of range at ${v}`);
    }
  }
});
check('worn records are noisier than clean ones', () => {
  assert.ok(compositeWear(1).crackleIntensity > compositeWear(0).crackleIntensity);
});

console.log('--- crate appending ---');
const track = (id, title) => ({ id, title, artist: 'A', fileUrl: `blob:${id}` });
check('a second import keeps the first crate', () => {
  const first = [track('a', 'One'), track('b', 'Two')];
  const merged = appendTracks(first, [track('c', 'Three')]);
  assert.deepEqual(merged.map((t) => t.id), ['a', 'b', 'c']);
});
check('re-importing the same files does not duplicate them', () => {
  const first = [track('a', 'One')];
  const merged = appendTracks(first, [track('a', 'One'), track('b', 'Two')]);
  assert.deepEqual(merged.map((t) => t.id), ['a', 'b']);
});
check('an empty import leaves the queue untouched', () => {
  const first = [track('a', 'One')];
  assert.equal(appendTracks(first, []), first);
});
check('importing into an empty crate preserves order', () => {
  const merged = appendTracks([], [track('x', 'X'), track('y', 'Y')]);
  assert.deepEqual(merged.map((t) => t.id), ['x', 'y']);
});

console.log('--- seek clamping ---');
check('negative seeks clamp to 0', () => assert.equal(clampSeek(-12, 100), 0));
check('seeks past the end clamp to duration', () => assert.equal(clampSeek(140, 100), 100));
check('unknown duration still clamps negatives', () => assert.equal(clampSeek(-5), 0));
check('a mid-track seek is untouched', () => assert.equal(clampSeek(42.5, 100), 42.5));

console.log();
if (failures) {
  console.log(`=== ${failures} CHECK(S) FAILED ===`);
  process.exit(1);
}
console.log('=== ALL STORE CHECKS PASS ===');
