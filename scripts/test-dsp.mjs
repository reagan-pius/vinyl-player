#!/usr/bin/env node
/**
 * DSP smoke test for public/vinyl-processor.js
 *
 * Runs the AudioWorkletProcessor OUTSIDE the browser by stubbing the
 * AudioWorkletGlobalScope, then asserts the signal path is actually sane:
 *
 *   1. effects off, deck live  -> near-transparent passthrough at READ_LAG
 *   2. effects on,  deck live  -> no throw, finite, audible
 *   3. silence in,  deck live  -> audible deck hiss (the cue lead-in)
 *   4. deck gate 0             -> silent (paused / stopped has NO noise)
 *   5. gate 1 -> 0 mid-stream  -> everything fades to silence (pause works)
 *
 * This is how you catch "uploaded a track but nothing plays" without a browser.
 *
 *   npm run test:dsp
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKLET = path.resolve(here, '../public/vinyl-processor.js');

// ---- stub the AudioWorklet global scope ----
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};
let Processor = null;
globalThis.registerProcessor = (_name, cls) => { Processor = cls; };

// Evaluated deliberately: the worklet source must run against the stubbed
// Web Audio globals above. This is a test harness, not app code.
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(WORKLET, 'utf8'));
if (!Processor) { console.error('FAIL: processor never registered'); process.exit(1); }

const SR = 48000, BLOCK = 128, N = SR * 2, NB = Math.floor(N / BLOCK);
const EXPECTED_LAG = 1024; // READ_LAG in the processor

// deterministic white noise (non-periodic -> unambiguous delay measurement)
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry(12345);
const SIG = new Float32Array(N);
for (let i = 0; i < N; i++) SIG[i] = (rng() * 2 - 1) * 0.35; // ~ -13 dBFS noise

function paramsFor(overrides) {
  const p = {};
  for (const d of Processor.parameterDescriptors) {
    p[d.name] = new Float32Array([overrides[d.name] !== undefined ? overrides[d.name] : d.defaultValue]);
  }
  return p;
}

/**
 * Run 2 s through the processor.
 * @param overrides  base param values
 * @param input      Float32Array input, or null for silence
 * @param gateFor    optional (blockIndex) => 0|1, to flip the deck gate mid-run
 */
function run(overrides, input, gateFor) {
  const proc = new Processor();
  const p = paramsFor(overrides);
  const oL = new Float32Array(N), oR = new Float32Array(N);
  let threw = null;
  for (let b = 0; b < NB; b++) {
    if (gateFor) p.deckActive = new Float32Array([gateFor(b)]);
    const from = b * BLOCK;
    const src = input ? [input.subarray(from, from + BLOCK), input.subarray(from, from + BLOCK)]
                      : [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const a = new Float32Array(BLOCK), c = new Float32Array(BLOCK);
    try {
      const keep = proc.process([src], [[a, c]], p);
      if (keep !== true) { threw = 'process() returned ' + keep; break; }
    } catch (e) { threw = e.message; break; }
    oL.set(a, from); oR.set(c, from);
  }
  return { oL, oR, threw };
}

const rms = (a, f = 0, t = a.length) => {
  let s = 0, n = 0;
  for (let i = f; i < t; i++) { s += a[i] * a[i]; n++; }
  return Math.sqrt(s / n);
};
const finite = (a) => {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
};

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const inRms = rms(SIG);
const LIVE = { deckActive: 1 };          // deck gate open
const OFF  = { crackleIntensity: 0, wowFlutterDepth: 0, rumbleLevel: 0, surfaceNoise: 0,
               wearLevel: 0, wetDry: 1, outputGain: 1, speed: 33 };

// ===== 1: effects OFF, deck live -> near-transparent passthrough =====
console.log('--- 1. effects OFF, deck live (expect ~unity gain at READ_LAG) ---');
const t1 = run({ ...OFF, ...LIVE }, SIG);
let bestLag = 0, best = -Infinity;
for (let lag = 0; lag <= 4000; lag++) {
  let c = 0;
  for (let i = SR; i < SR + 24000; i++) c += t1.oL[i] * SIG[i - lag];
  if (c > best) { best = c; bestLag = lag; }
}
const ratio = rms(t1.oL, SR) / inRms;
const headRms = rms(t1.oL, 0, SR / 10);
check('does not throw', !t1.threw, t1.threw || '');
check('output is finite', finite(t1.oL));
check('latency is READ_LAG', Math.abs(bestLag - EXPECTED_LAG) < 64, `${bestLag} samples (${(bestLag / SR * 1000).toFixed(1)} ms)`);
check('gain is near unity', ratio > 0.8 && ratio < 1.2, `out/in = ${ratio.toFixed(3)}`);
check('no leading silence', headRms > 0.5 * inRms, `first 100 ms RMS = ${headRms.toFixed(4)}`);

// ===== 2: effects ON (defaults), deck live -> audible =====
console.log('--- 2. effects ON (defaults), deck live ---');
const t2 = run({ deckActive: 1 }, SIG);
const onRms = rms(t2.oL, SR);
check('does not throw', !t2.threw, t2.threw || '');
check('output is finite', finite(t2.oL));
check('output is audible', onRms > 0.01, `RMS = ${onRms.toFixed(4)}`);

// ===== 3: silence in, deck live -> deck hiss =====
console.log('--- 3. silence in, deck live -> deck hiss (cue lead-in) ---');
const t3 = run({ deckActive: 1 }, null);
const hiss = rms(t3.oL, SR / 2);
check('deck hiss present', hiss > 0.001, `RMS = ${hiss.toFixed(4)}`);

// ===== 4: deck gate 0 -> totally silent (paused) =====
console.log('--- 4. deck gate 0 (paused/stopped) -> NO noise at all ---');
const t4 = run({ deckActive: 0 }, SIG);
const pausedRms = rms(t4.oL, SR);
check('does not throw', !t4.threw, t4.threw || '');
check('output is silent', pausedRms < 1e-6, `RMS = ${pausedRms.toExponential(2)}`);

// ===== 5: gate 1 -> 0 mid-stream -> everything fades out =====
console.log('--- 5. pause mid-play: gate goes 1 -> 0 ---');
const half = Math.floor(NB / 2);
const t5 = run({ deckActive: 1 }, SIG, (b) => (b < half ? 1 : 0));
const whilePlaying = rms(t5.oL, SR / 4, SR * 3 / 4);   // during the live half
const afterPause = rms(t5.oL, N - SR / 5);             // final 200 ms
check('audible while playing', whilePlaying > 0.01, `RMS = ${whilePlaying.toFixed(4)}`);
check('silent after pause (music AND noise)', afterPause < 1e-4, `RMS = ${afterPause.toExponential(2)}`);

console.log();
if (failures) { console.log(`=== ${failures} CHECK(S) FAILED ===`); process.exit(1); }
console.log('=== ALL DSP CHECKS PASS ===');
