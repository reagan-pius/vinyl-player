#!/usr/bin/env node
/**
 * DSP behavior probe for public/vinyl-processor.js — deeper than test-dsp.
 *
 * Where test-dsp.mjs checks the signal PATH (passthrough, gate, audibility),
 * this checks the CHARACTER of each artifact against its research backing
 * (docs/research-vinyl-dsp-improvements.md):
 *
 *   1. rumble  -> mono (corr 1.0), band-limited 25-55 Hz, modest level
 *   2. hiss    -> L/R balanced, decorrelated, |H| unity at 4.2 kHz
 *   3. crackle -> sharp ticks: attack-concentrated energy, peak <= 1.0
 *   4. wow     -> pitch deviation in real-record range (< 0.3 % at knob=1)
 *
 * Filter checks use the analytic |H(e^jw)| of the actual biquad coeffs
 * (stochastic single-bin measures are too noisy); the wow check uses
 * interpolated zero-crossings (integer crossings quantize to 1/48 = 2.1 %).
 *
 *   node scripts/probe-dsp.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKLET = path.resolve(here, '../public/vinyl-processor.js');

globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class { constructor(){ this.port = { onmessage:null, postMessage(){} }; } };
let Processor = null;
globalThis.registerProcessor = (_n, c) => { Processor = c; };
// Test harness: run the worklet source against the stubbed globals above.
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(WORKLET, 'utf8'));

const SR = 48000, BLOCK = 128;
function run(ov, input, secs) {
  const p = {};
  for (const d of Processor.parameterDescriptors)
    p[d.name] = new Float32Array([ov[d.name] !== undefined ? ov[d.name] : d.defaultValue]);
  const N = SR * secs, NB = N / BLOCK;
  const oL = new Float32Array(N), oR = new Float32Array(N);
  const proc = new Processor();
  for (let b = 0; b < NB; b++) {
    const from = b * BLOCK;
    const src = input ? [input.subarray(from % input.length, (from % input.length) + BLOCK),
                         input.subarray(from % input.length, (from % input.length) + BLOCK)]
                      : [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const a = new Float32Array(BLOCK), c = new Float32Array(BLOCK);
    proc.process([src], [[a, c]], p);
    oL.set(a, from); oR.set(c, from);
  }
  return { oL, oR };
}
const rms = (a, f = 0, t = a.length) => { let s = 0, n = 0; for (let i = f; i < t; i++){ s += a[i]*a[i]; n++; } return Math.sqrt(s/n); };
const corr = (a, b) => { let sa=0,sb=0,sab=0; for (let i=0;i<a.length;i++){ sa+=a[i]*a[i]; sb+=b[i]*b[i]; sab+=a[i]*b[i]; } return sab/Math.sqrt(sa*sb); };
function magH(bq, f) {
  const w = 2*Math.PI*f/SR, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2*w), s2 = Math.sin(2*w);
  const nr = bq.b0 + bq.b1*c1 + bq.b2*c2, ni = -(bq.b1*s1 + bq.b2*s2);
  const dr = 1 + bq.a1*c1 + bq.a2*c2, di = -(bq.a1*s1 + bq.a2*s2);
  return Math.hypot(nr, ni) / Math.hypot(dr, di);
}

let bad = 0;
const chk = (label, ok, detail) => { if (!ok) bad++; console.log(`  ${ok?'PASS':'FAIL'}  ${label}  ${detail||''}`); };

console.log('--- rumble: mono + band-limited 25-55 Hz ---');
const tR = run({ rumbleLevel:1, surfaceNoise:0, crackleIntensity:0, wearLevel:0, wowFlutterDepth:0, deckActive:1 }, null, 4);
const segL = tR.oL.slice(SR*2), segR = tR.oR.slice(SR*2);
chk('rumble is MONO (L/R corr > 0.9)', corr(segL, segR) > 0.9, `corr=${corr(segL,segR).toFixed(3)}`);
chk('rumble level modest at knob=1', rms(segL) < 0.05, `RMS=${rms(segL).toFixed(4)}`);
const probe = new Processor();
const hHP = (f) => magH(probe.rumbleHPF, f), hLP = (f) => magH(probe.rumbleBiquad, f);
chk('|H| peaks inside 25-55 Hz', hHP(40)*hLP(40) > hHP(14)*hLP(14)*3 && hHP(40)*hLP(40) > hHP(120)*hLP(120)*3,
    `40Hz=${(hHP(40)*hLP(40)).toFixed(3)} 14Hz=${(hHP(14)*hLP(14)).toFixed(4)} 120Hz=${(hHP(120)*hLP(120)).toFixed(4)}`);

console.log('--- hiss: balanced + decorrelated, HF-weighted band-pass ---');
const tS = run({ rumbleLevel:0, surfaceNoise:1, crackleIntensity:0, wearLevel:0, wowFlutterDepth:0, deckActive:1 }, null, 4);
const hsL = tS.oL.slice(SR*2), hsR = tS.oR.slice(SR*2);
const hRatio = rms(hsL)/rms(hsR);
chk('L/R hiss balanced', hRatio > 0.7 && hRatio < 1.4, `L/R RMS ratio=${hRatio.toFixed(3)}`);
chk('hiss decorrelated (corr < 0.6)', corr(hsL, hsR) < 0.6, `corr=${corr(hsL,hsR).toFixed(3)}`);
const mH = (f) => magH(probe.surfBiquadL, f);
chk('|H| unity at 4.2 kHz, skirted at 300 Hz / 60 Hz', Math.abs(mH(4200)-1) < 0.02 && mH(300) < 0.2 && mH(60) < 0.05,
    `4.2k=${mH(4200).toFixed(3)} 300=${mH(300).toFixed(3)} 60=${mH(60).toFixed(4)}`);

console.log('--- crackle: sharp broadband ticks, sane level ---');
const tC = run({ rumbleLevel:0, surfaceNoise:0, crackleIntensity:1, wearLevel:0.5, wowFlutterDepth:0, deckActive:1 }, null, 6);
const cs = tC.oL.slice(SR);
let peak = 0, peakIdx = 0;
for (let i = 0; i < cs.length; i++) if (Math.abs(cs[i]) > peak) { peak = Math.abs(cs[i]); peakIdx = i; }
chk('pops reach audible peaks', peak > 0.15 && peak <= 1.0, `peak=${peak.toFixed(3)} @${peakIdx}`);
const w0 = Math.max(0, peakIdx-500), w1 = Math.min(cs.length, peakIdx+500);
let eAll = 0, eCore = 0;
for (let i = w0; i < w1; i++) { const e = cs[i]*cs[i]; eAll += e; if (i > peakIdx-64 && i < peakIdx+192) eCore += e; }
chk('energy concentrated at attack (>60% in 3 ms)', eCore/eAll > 0.6, `core/window=${(eCore/eAll*100).toFixed(0)}%`);

console.log('--- wow: depth in real-record range (1 kHz tone, wfd=1) ---');
const tone = new Float32Array(SR*6);
for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2*Math.PI*1000*i/SR) * 0.5;
const tW = run({ rumbleLevel:0, surfaceNoise:0, crackleIntensity:0, wearLevel:0, wowFlutterDepth:1, deckActive:1 }, tone, 6);
const w = tW.oL.slice(SR*2);
const periods = [];
let lastX = -1;
for (let i = 1; i < w.length; i++) if (w[i-1] < 0 && w[i] >= 0) {
  const frac = w[i-1] / (w[i-1] - w[i]);           // fractional crossing position
  const x = i - 1 + frac;
  if (lastX >= 0) periods.push(x - lastX);
  lastX = x;
}
const mean = periods.reduce((a,b)=>a+b,0)/periods.length;
let maxDev = 0;
for (const p of periods) maxDev = Math.max(maxDev, Math.abs(p-mean)/mean);
chk('wow depth <= 0.3% pitch at wfd=1', maxDev < 0.003, `max period dev=${(maxDev*100).toFixed(3)}%`);
chk('wow actually present (>= 0.03%)', maxDev > 0.0003, `max period dev=${(maxDev*100).toFixed(3)}%`);

console.log(bad ? `=== ${bad} PROBE CHECK(S) FAILED ===` : '=== ALL PROBE CHECKS PASS ===');
process.exit(bad ? 1 : 0);
