/* ===========================================================================
 * VinylProcessor — AudioWorketProcessor
 *
 * Emulates the sonic signature of vinyl playback:
 *   [1] Wow & Flutter       (variable-rate fractional resampler)
 *   [2] Sub-bass rumble     (band-limited ~25-55 Hz, mono)
 *   [3] Surface noise       (band-passed hiss, ~4.2 kHz, balanced L/R)
 *   [4] Clicks & Pops       (Poisson-scheduled impulse bank)
 *   [5] Gentle saturation   (soft-clip)
 *   [6] Stereo width        (subtle mid-side; wear narrows the image)
 *   [7] HF roll-off         (speed-dependent low-pass)
 *
 * Loaded as a classic script:
 *     ctx.audioWorklet.addModule('/vinyl-processor.js')
 *
 * Real-time safe: no allocation in process(); seeded PRNG (mulberry32),
 * never Math.random().
 * =========================================================================== */
const PI = Math.PI, TWO_PI = PI * 2;

// Fast seeded PRNG (mulberry32): deterministic + cheap, no GC churn.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2nd-order biquad, Direct Form II, stored coeffs.
function makeBiquad() {
  return { b0:1, b1:0, b2:0, a1:0, a2:0, x1:0, x2:0, y1:0, y2:0,
    reset: function(){ this.x1=this.x2=this.y1=this.y2=0; },
    process: function(v){
      var y = this.b0*v + this.b1*this.x1 + this.b2*this.x2 - this.a1*this.y1 - this.a2*this.y2;
      this.x2=this.x1; this.x1=v; this.y2=this.y1; this.y1=y; return y;
    }
  };
}
// Low-pass biquad (RBJ cookbook). fc in Hz.
function designLPF(bq, fc, sr, q){
  var w0 = TWO_PI*fc/sr, cos=Math.cos(w0), sin=Math.sin(w0);
  q = q===undefined ? 0.7072 : q;
  var alpha = sin/(2*q);
  var b0=(1-cos)/2, b1=1-cos, b2=(1-cos)/2;
  var a0=1+alpha;
  bq.b0=b0/a0; bq.b1=b1/a0; bq.b2=b2/a0; bq.a1=(-2*cos)/a0; bq.a2=(1-alpha)/a0;
}
// High-pass biquad (RBJ cookbook). fc in Hz.
function designHPF(bq, fc, sr, q){
  var w0 = TWO_PI*fc/sr, cos=Math.cos(w0), sin=Math.sin(w0);
  q = q===undefined ? 0.7072 : q;
  var alpha = sin/(2*q);
  var b0=(1+cos)/2, b1=-(1+cos), b2=(1+cos)/2;
  var a0=1+alpha;
  bq.b0=b0/a0; bq.b1=b1/a0; bq.b2=b2/a0; bq.a1=(-2*cos)/a0; bq.a2=(1-alpha)/a0;
}
// Band-pass biquad (RBJ cookbook, constant-skirt: gain at fc = Q). fc in Hz.
function designBPF(bq, fc, sr, q){
  var w0 = TWO_PI*fc/sr, cos=Math.cos(w0), sin=Math.sin(w0);
  var alpha = sin/(2*q);
  var a0=1+alpha;
  bq.b0=alpha/a0; bq.b1=0; bq.b2=-alpha/a0; bq.a1=(-2*cos)/a0; bq.a2=(1-alpha)/a0;
}
// 1024-sample sine table (interpolated) for LFOs.
function buildSineTable(n){ var t=new Float32Array(n+1); for(var i=0;i<=n;i++) t[i]=Math.sin(TWO_PI*i/n); return t; }
// Exponential (Poisson) intervals from mean events/sec.
function expoInterval(rng, lam){ var u=rng(); while(u<1e-6) u=rng(); return -Math.log(u)/lam; }

// Gentle soft-clip: exactly linear below the knee, smoothly compressed above.
// Adds analog warmth *without* the level loss of a full-wave saturator.
var SAT_KNEE = 0.7;
function softclip(x){
  if (x >  SAT_KNEE) return  SAT_KNEE + (1-SAT_KNEE)*Math.tanh(( x-SAT_KNEE)/(1-SAT_KNEE));
  if (x < -SAT_KNEE) return -SAT_KNEE - (1-SAT_KNEE)*Math.tanh((-x-SAT_KNEE)/(1-SAT_KNEE));
  return x;
}

// Bank of crackle impulses: sharp broadband TICKS, not muffled thuds.
// A pop's attack is near-instantaneous (grit leaving the groove), so each
// burst opens with a full-band single-sample spike and closes with a short
// bright noise tail — the sparse-impulse model (cf. SuperCollider Dust),
// not a low-filtered noise swell.
function buildCrackleBank(rng, sr, count, minLen, maxLen){
  var bank=[];
  for(var i=0;i<count;i++){
    var len=(minLen+rng()*(maxLen-minLen))|0, buf=new Float32Array(len);
    var fc=3000+rng()*7000;                        // bright tails (3-10 kHz)
    var amp=0.8+rng()*0.2, dk=0.996+rng()*0.003;   // 5-20 ms exponential tail
    var z=0, lpcoef=Math.exp(-TWO_PI*fc/sr);
    buf[0]=amp;                                    // sharp click attack
    for(var s=1;s<len;s++){
      var n=(rng()*2-1); z=n+lpcoef*(z-n);         // 1-pole LPF shapes the tail
      buf[s]=z*amp;
      amp*=dk;
    }
    bank.push(buf);
  }
  return bank;
}

class VinylProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'crackleIntensity', defaultValue: 0.30, minValue: 0, maxValue: 1 },
      { name: 'wowFlutterDepth',  defaultValue: 0.30, minValue: 0, maxValue: 1 },
      { name: 'rumbleLevel',      defaultValue: 0.12, minValue: 0, maxValue: 1 },
      { name: 'surfaceNoise',     defaultValue: 0.20, minValue: 0, maxValue: 1 },
      { name: 'wearLevel',        defaultValue: 0.50, minValue: 0, maxValue: 1 },
      { name: 'speed',            defaultValue: 33.33, minValue: 7, maxValue: 78 },
      { name: 'wetDry',           defaultValue: 1.0, minValue: 0, maxValue: 1 },
      { name: 'outputGain',       defaultValue: 1.0, minValue: 0, maxValue: 4 },
      // Deck gate: 1 = live (music + deck noise), 0 = silent. Pausing drops
      // this to 0 so the surface noise stops along with the music.
      { name: 'deckActive',       defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() {
    super();
    this.sr = sampleRate;
    this.bs = 128;
    this.invSr = 1 / this.sr;
    this.rng = mulberry32(0x871359);

    // --- [1] Wow & Flutter: variable-rate ring-buffer resampler ---
    this.RING = 96000;
    this.ring = new Float32Array(this.RING * 2);
    // Read head trails the write head by READ_LAG samples. Without this the
    // two pointers advance in lockstep and the resampler reads a full lap
    // (~2 s) behind -> silence, then everything delayed by 2 s.
    this.READ_LAG = 1024;
    this.ringWrite = this.READ_LAG;
    this.ringRead = 0;
    this.baseInc = 1.0;
    this.sinTab = buildSineTable(1024);
    this.wowPhase = 0; this.flutPhase = 0; this.driftPhase = 0;
    this._wowSpeed = -1;

    // --- [2] Rumble: band-limited ~25-55 Hz, MONO. RIAA playback boosts
    // LF (that's what makes drive-mechanism rumble audible) while the IEC
    // playback amendment floors everything below ~20 Hz — so rumble lives
    // in a narrow band just above 20 Hz, not at DC.
    this.rumbleHPF = makeBiquad(); designHPF(this.rumbleHPF, 25, this.sr, 0.7072);
    this.rumbleBiquad = makeBiquad(); designLPF(this.rumbleBiquad, 55, this.sr, 0.9);
    this.rumbleZ1 = [0,0];

    // --- [3] Surface noise: band-passed hiss (~4.2 kHz, Q 0.6). RIAA
    // treble cut means vinyl hiss is HF-weighted mid-high band, not a
    // low-passed mud roar.
    this.surfBiquadL = makeBiquad(); this.surfBiquadR = makeBiquad();
    designBPF(this.surfBiquadL, 4200, this.sr, 0.6);
    designBPF(this.surfBiquadR, 4200, this.sr, 0.6);
    this.surfZ1 = [0,0];

    // --- [7] HF roll-off (per channel) ---
    this.hfL = makeBiquad(); this.hfR = makeBiquad();
    designLPF(this.hfL, 16500, this.sr, 0.7); designLPF(this.hfR, 16500, this.sr, 0.7);

    // --- [4] Crackle / Pops ---
    this.crackleBank = buildCrackleBank(this.rng, this.sr, 48, 48, 500);
        this.crackleSlots = []; for (var k=0;k<4;k++) this.crackleSlots.push({buf:null,ptr:0,pan:0});
    this.samplesToNextPop = 192000; this.timeAcc = 0;
    this.satDrive = 1.6;   // gentle saturation drive
    this.gate = 0;         // deck gate (smoothed): 0 = silent, 1 = live
    this.port.onmessage = this._onMsg.bind(this);
  }
  _onMsg(ev) {
    var d = ev.data || {};
    if (d.type === 'seed') this.rng = mulberry32(d.seed >>> 0);
    if (d.type === 'reset') this._reset();
  }
  _reset() {
    for (var i=0;i<this.RING*2;i++) this.ring[i]=0;
    this.ringWrite=this.READ_LAG; this.ringRead=0;
    this.wowPhase=0; this.flutPhase=0; this.driftPhase=0;
    this.rumbleHPF.reset(); this.rumbleBiquad.reset();
    this.surfBiquadL.reset(); this.surfBiquadR.reset(); this.hfL.reset(); this.hfR.reset();
    this.rumbleZ1=[0,0]; this.surfZ1=[0,0];
    for (var k=0;k<4;k++){ this.crackleSlots[k].buf=null; this.crackleSlots[k].ptr=0; this.crackleSlots[k].pan=0; }
    this.samplesToNextPop = 192000; this.timeAcc = 0;
    this.gate = 0;
  }
  _sin(ph) {
    var n = ph >>> 0; var f = ph - n; n &= 1023;
    return this.sinTab[n] + f*(this.sinTab[n+1]-this.sinTab[n]);
  }

  // LFO rates from platter speed: slow dominant wow, ~4 Hz flutter (the
  // listening-weighting peak), plus an incommensurate drift LFO.
  _wowInit(speed) {
    if (speed === this._wowSpeed) return;
    this._wowSpeed = speed;
    var b = speed >= 77 ? 2.2 : (speed >= 44 ? 1.4 : 0.7);
    this.wowRate   = 0.6 + b*0.6;    // ~1.0-1.9 Hz: turntables suffer mainly SLOW wow
    this.flutRate  = 4.0 + b*0.6;    // ~4.4-5.3 Hz: weighted-flutter peak region
    this.driftRate = 0.27;           // incommensurate slow drift
  }

  process(inputs, outputs, parameters) {
    var inp = inputs[0], out = outputs[0];
    var chIn = inp ? inp.length : 0;
    var outL = out[0], outR = out.length > 1 ? out[1] : out[0], n = this.bs;
    var p = parameters;

    var crackle = p.crackleIntensity && p.crackleIntensity.length ? p.crackleIntensity[0] : 0.30;
    var wfd     = p.wowFlutterDepth      && p.wowFlutterDepth.length      ? p.wowFlutterDepth[0]   : 0.30;
    var rumble  = p.rumbleLevel          && p.rumbleLevel.length          ? p.rumbleLevel[0]       : 0.12;
    var surfN   = p.surfaceNoise         && p.surfaceNoise.length         ? p.surfaceNoise[0]      : 0.20;
    var wear    = p.wearLevel            && p.wearLevel.length            ? p.wearLevel[0]         : 0.50;
    var speed   = p.speed                && p.speed.length                ? p.speed[0]             : 33.33;
    var wet     = p.wetDry               && p.wetDry.length               ? p.wetDry[0]            : 1.0;
    var gain    = p.outputGain           && p.outputGain.length           ? p.outputGain[0]        : 1.0;
    var gateTarget = p.deckActive        && p.deckActive.length           ? p.deckActive[0]        : 0;

    // speed-dependent HF ceiling (78 loses most HF; 33 keeps full)
    var hfMult = (speed >= 77) ? 0.62 : (speed >= 44 ? 0.82 : 1.0);
    this._wowInit(speed); // sets this.wowRate / flutRate / driftRate
    // rephase HF biquads only when speed-driven cutoff changes appreciably
    var wantFc = 16500 * hfMult;
    // (coeffs stay constant for the block; cheap to re-design each block)
    designLPF(this.hfL, wantFc, this.sr, 0.7);
    designLPF(this.hfR, wantFc, this.sr, 0.7);

    // IEC/DIN-style wow & flutter: slow dominant wobble + a ~4 Hz flutter
    // component (where listening-weighted flutter peaks) + an
    // incommensurate drift, so it never reads as one periodic sine.
    // Total depth stays in the sub-0.2 %-of-pitch range of a decent deck.
    var slowW = this._sin(this.wowPhase), fastW = this._sin(this.flutPhase + 256),
        driftW = this._sin(this.driftPhase + 400);
    var wowD = 0.0012 * wfd, fluD = 0.0004 * wfd, drfD = 0.0003 * wfd;
    var srcL = chIn >= 1 ? inp[0] : null;
    var srcR = chIn >= 2 ? inp[1] : null;

    for (var i=0;i<n;i++) {
      // --- [1] wow/flutter variable-rate read ---
      var lfo = wowD * slowW + fluD * fastW + drfD * driftW;
      var inc = this.baseInc + lfo;
      this.ringRead += inc;
      if (this.ringRead < 0) this.ringRead += this.RING;
      else if (this.ringRead >= this.RING) this.ringRead -= this.RING;
      var rp = this.ringRead, idx = rp >>> 0, frac = rp - idx;
      var nxt = (idx + 1) % this.RING;
      var rl = this.ring[idx*2]   + frac*(this.ring[nxt*2]   - this.ring[idx*2]);
      var rr = this.ring[idx*2+1] + frac*(this.ring[nxt*2+1] - this.ring[idx*2+1]);

      // write incoming sample into ring (delay)
      var inL = srcL ? srcL[i] : 0, inR = srcR ? srcR[i] : inL;
      this.ring[this.ringWrite*2]   = inL;
      this.ring[this.ringWrite*2+1] = inR;
      this.ringWrite = (this.ringWrite + 1) % this.RING;

      // --- [2] rumble: mono, band-limited ~25-55 Hz (above the IEC ~20 Hz
      // playback floor, under the RIAA ~50 Hz bass-boost corner) ---
      var rn = (this.rng()*2-1); this.rumbleZ1[0]=rn+0.985*(this.rumbleZ1[0]-rn);
      var rb = this.rumbleBiquad.process(this.rumbleHPF.process(this.rumbleZ1[0]*rumble*0.35));

      // --- [3] surface noise: two decorrelated streams through the same
      // hiss band-pass, near-equal level (hiss is wide but balanced) ---
      var sn = (this.rng()*2-1); this.surfZ1[0]=sn+0.98*(this.surfZ1[0]-sn);
      var sn2 = (this.rng()*2-1); this.surfZ1[1]=sn2+0.98*(this.surfZ1[1]-sn2);
      var surfL = this.surfBiquadL.process(this.surfZ1[0]*surfN*0.55);
      var surfR = this.surfBiquadR.process(this.surfZ1[1]*surfN*0.55);

      // --- [4] crackle ---
      var cx = 0, cxR = 0, cs;
      for (cs=0;cs<4;cs++){ var sl=this.crackleSlots[cs]; if (sl.buf){
        var sv = sl.buf[sl.ptr]*0.85;
        cx  += sv*(1-sl.pan); cxR += sv*(1+sl.pan);   // pops land off-center
        sl.ptr++; if (sl.ptr>=sl.buf.length){sl.buf=null;sl.ptr=0;} } }
      this.samplesToNextPop -= 1;
      if (this.samplesToNextPop <= 0) {
        var lam = 0.6 + crackle*4.5 + wear*3.0; // events/sec
        this.samplesToNextPop = (expoInterval(this.rng, lam)*this.sr) >>> 0;
        for (cs=0;cs<4;cs++){ if (!this.crackleSlots[cs].buf){
          var b=this.crackleBank[(this.rng()*this.crackleBank.length)>>>0];
          this.crackleSlots[cs].buf=b; this.crackleSlots[cs].ptr=0;
          this.crackleSlots[cs].pan=(this.rng()*2-1)*0.3; break; } }
      }
      cx *= (crackle + wear*0.6) * 1.4; // ticks carry real broadband energy

      // --- assemble: rumble is MONO (chassis vibration, not ambience);
      // hiss decorrelated but balanced; pops land on one side ---
      var L = rl + rb + surfL + cx;
      var R = rr + rb + surfR + cxR;

      // --- [5]/[6] mid-side width: wear NARROWS the image (stylus wear and
      // crosstalk shrink separation) — the iZotope "Year" model ---
      var mid=(L+R)*0.5, side=(L-R)*0.5; side *= (1.0 - wear*0.25);
      var sL = mid+side, sR = mid-side;

      // --- [7] HF roll-off, then saturation LAST: the soft-clip is the
      // final stage so no downstream filter transient can overshoot it
      // (a Q~0.7 lowpass has transient gain >1 and would exceed 0 dBFS).
      sL=softclip(this.hfL.process(sL)); sR=softclip(this.hfR.process(sR));

      // --- deck gate: smooth (~40 ms) fade to silence when paused/stopped ---
      this.gate += (gateTarget - this.gate) * 0.0005;
      var g = this.gate;
      outL[i] = (sL*wet + (srcL?srcL[i]:0)*(1-wet)) * gain * g;
      outR[i] = (sR*wet + (srcR?srcR[i]:(srcL?srcL[i]:0))*(1-wet)) * gain * g;

      this.wowPhase = (this.wowPhase + this.wowRate*this.invSr*1024) % 1024;
      this.flutPhase = (this.flutPhase + this.flutRate*this.invSr*1024) % 1024;
      this.driftPhase = (this.driftPhase + this.driftRate*this.invSr*1024) % 1024;
    }
    return true;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('vinyl-processor', VinylProcessor);
}
