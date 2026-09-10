/* ============================================================================
   Audio.

   Every sound in the game is synthesised at boot — no sample files, so the whole
   soundscape is CC0 by construction.

   A gunshot is not one waveform. It is four layers rendered together:

     1. transient crack   a few milliseconds of bandpassed noise — the part that
                          makes it read as a rifle rather than a firework
     2. low-end body      a pitch-swept sine that gives the shot weight
     3. mechanical action bolt/slide clicks a few tens of ms behind the shot
     4. outdoor tail      filtered noise with early reflections and an
                          exponential decay whose length and colour are per-weapon

   Six full variants are pre-rendered per weapon, each with its own noise seed and
   ±4% pitch/envelope jitter, then played in a shuffled rotation so you never hear
   the same waveform twice in a row. That is the difference between a firefight
   and a buzzsaw.
   ========================================================================== */
import { makeRng, clamp, lerp, yieldToBrowser } from './util.js';

const SR = 44100;

/* ---- tiny DSP ------------------------------------------------------------ */
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  lowpass(f, q) { this._set(f, q, 'lp'); return this; }
  highpass(f, q) { this._set(f, q, 'hp'); return this; }
  bandpass(f, q) { this._set(f, q, 'bp'); return this; }
  _set(f, q, kind) {
    const w = 2 * Math.PI * clamp(f, 20, SR * 0.48) / SR;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * Math.max(0.05, q));
    let b0, b1, b2;
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    if (kind === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else if (kind === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    else { b0 = alpha; b1 = 0; b2 = -alpha; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.z1 = this.z2 = 0;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

const softClip = (x) => x < -1.2 ? -1 : x > 1.2 ? 1 : x - (x * x * x) / 4.32;

/* ============================================================================
   Renderers — each returns a Float32Array of mono samples
   ========================================================================== */

function renderGunshot(prof, seed) {
  const r = makeRng(seed);
  const jitter = (a) => 1 + (r() - 0.5) * 2 * a;

  const tailLen = prof.tail * jitter(0.10);
  const N = Math.ceil((0.09 + tailLen) * SR);
  const out = new Float32Array(N);

  /* ---- 1. transient crack ---- */
  {
    const bp = new Biquad().bandpass(prof.crackHz * jitter(0.05), prof.crackQ);
    const hp = new Biquad().highpass(700, 0.7);
    const dec = 0.0042 * jitter(0.16);
    const atk = 0.00035;
    const n = Math.ceil(0.030 * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const env = t < atk ? t / atk : Math.exp(-(t - atk) / dec);
      out[i] += hp.run(bp.run(r() * 2 - 1)) * env * 1.35;
    }
  }
  /* ---- 1b. supersonic snap (very short, very bright) ---- */
  {
    const hp = new Biquad().highpass(4200, 0.8);
    const n = Math.ceil(0.010 * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const env = Math.exp(-t / 0.0016);
      out[i] += hp.run(r() * 2 - 1) * env * 0.85 * prof.punch;
    }
  }
  /* ---- 2. low-end body: pitch-swept sine + a touch of square ---- */
  {
    const f0 = prof.bodyHz * jitter(0.05);
    const dec = 0.062 * jitter(0.14);
    const n = Math.ceil(0.36 * SR);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = f0 * (1 + 2.6 * Math.exp(-t / 0.011));
      ph += 2 * Math.PI * f / SR;
      const env = (t < 0.0009 ? t / 0.0009 : 1) * Math.exp(-t / dec);
      out[i] += (Math.sin(ph) * 0.86 + Math.sin(ph * 2) * 0.14) * env * 1.15 * prof.punch;
    }
  }
  /* ---- 3. mechanical action ---- */
  {
    const clicks = [[0.024 * jitter(0.22), 0.55], [0.052 * jitter(0.20), 0.38]];
    for (const [tOff, amp] of clicks) {
      const bp = new Biquad().bandpass(2600 * jitter(0.18), 2.4);
      const start = Math.floor(tOff * SR);
      const n = Math.ceil(0.026 * SR);
      for (let i = 0; i < n && start + i < N; i++) {
        const t = i / SR;
        const env = Math.exp(-t / 0.0055);
        out[start + i] += bp.run(r() * 2 - 1) * env * amp * prof.mech * 0.6;
      }
    }
  }
  /* ---- 4. outdoor tail: filtered noise + discrete early reflections ---- */
  {
    const lp = new Biquad().lowpass(prof.tailHz * jitter(0.10), 0.62);
    const hp = new Biquad().highpass(110, 0.7);
    const n = N;
    const dec = tailLen * 0.34;
    const tail = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const env = Math.exp(-t / dec) * (1 - Math.exp(-t / 0.004));
      tail[i] = hp.run(lp.run(r() * 2 - 1)) * env;
    }
    // slapback reflections off nearby buildings
    const taps = [[0.028, 0.42], [0.047, 0.30], [0.081, 0.22], [0.134, 0.15], [0.210, 0.09]];
    for (let i = 0; i < n; i++) out[i] += tail[i] * 0.55;
    for (const [d, g] of taps) {
      const off = Math.floor(d * jitter(0.25) * SR);
      for (let i = 0; i + off < n; i++) out[i + off] += tail[i] * g * 0.5;
    }
  }

  // normalise + soft clip for that "pushed the preamp" character
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
  const k = (peak > 0 ? 0.92 / peak : 1) * prof.gain;
  for (let i = 0; i < N; i++) out[i] = softClip(out[i] * k);
  return out;
}

function renderFootstep(surface, seed, running) {
  const r = makeRng(seed);
  const N = Math.ceil(0.20 * SR);
  const out = new Float32Array(N);
  const cfg = {
    concrete: { f: 1500, q: 1.4, dec: 0.021, body: 190, bodyDec: 0.030, grit: 0.55, bright: 3200 },
    dirt:     { f: 700,  q: 0.8, dec: 0.036, body: 120, bodyDec: 0.040, grit: 0.95, bright: 1500 },
    metal:    { f: 2400, q: 2.6, dec: 0.055, body: 320, bodyDec: 0.075, grit: 0.30, bright: 5200 },
    wood:     { f: 1050, q: 1.8, dec: 0.030, body: 165, bodyDec: 0.055, grit: 0.42, bright: 2600 },
    glass:    { f: 3400, q: 3.0, dec: 0.045, body: 420, bodyDec: 0.030, grit: 0.30, bright: 6800 },
  }[surface] || { f: 1200, q: 1.2, dec: 0.028, body: 160, bodyDec: 0.035, grit: 0.6, bright: 2600 };

  const bp = new Biquad().bandpass(cfg.f * (1 + (r() - 0.5) * 0.24), cfg.q);
  const hp = new Biquad().highpass(cfg.bright * (1 + (r() - 0.5) * 0.3), 0.8);
  let ph = 0;
  const amp = running ? 1.0 : 0.62;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = Math.exp(-t / (cfg.dec * (running ? 1.25 : 1)));
    out[i] += bp.run(r() * 2 - 1) * env * 0.9;
    out[i] += hp.run(r() * 2 - 1) * Math.exp(-t / 0.006) * cfg.grit * 0.35;
    ph += 2 * Math.PI * cfg.body * (1 + 1.4 * Math.exp(-t / 0.008)) / SR;
    out[i] += Math.sin(ph) * Math.exp(-t / cfg.bodyDec) * 0.42;
    out[i] *= amp;
  }
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < N; i++) out[i] = softClip(out[i] * 0.55 / peak);
  return out;
}

function renderImpact(surface, seed) {
  const r = makeRng(seed);
  const N = Math.ceil(0.28 * SR);
  const out = new Float32Array(N);
  const cfg = {
    concrete: { f: 2600, q: 1.6, dec: 0.020, dust: 0.55, ring: 0 },
    dirt:     { f: 900,  q: 0.7, dec: 0.030, dust: 0.95, ring: 0 },
    metal:    { f: 3400, q: 2.4, dec: 0.030, dust: 0.20, ring: 1750 },
    wood:     { f: 1500, q: 1.4, dec: 0.024, dust: 0.42, ring: 0 },
    glass:    { f: 5200, q: 3.2, dec: 0.045, dust: 0.30, ring: 4200 },
    flesh:    { f: 480,  q: 0.9, dec: 0.038, dust: 0.85, ring: 0 },
  }[surface] || { f: 2200, q: 1.5, dec: 0.022, dust: 0.5, ring: 0 };

  const bp = new Biquad().bandpass(cfg.f * (1 + (r() - 0.5) * 0.3), cfg.q);
  const lp = new Biquad().lowpass(700, 0.8);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    out[i] += bp.run(r() * 2 - 1) * Math.exp(-t / cfg.dec) * 1.0;
    out[i] += lp.run(r() * 2 - 1) * Math.exp(-t / 0.055) * cfg.dust * 0.5;
    if (cfg.ring) {
      ph += 2 * Math.PI * cfg.ring * (1 + (r() - 0.5) * 0.001) / SR;
      out[i] += Math.sin(ph) * Math.exp(-t / 0.10) * 0.30;
    }
  }
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < N; i++) out[i] = softClip(out[i] * 0.75 / peak);
  return out;
}

function renderExplosion(seed, big) {
  const r = makeRng(seed);
  const L = big ? 2.6 : 1.7;
  const N = Math.ceil(L * SR);
  const out = new Float32Array(N);
  const lp = new Biquad().lowpass(big ? 260 : 380, 0.7);
  const bp = new Biquad().bandpass(1400, 0.8);
  const hp = new Biquad().highpass(2600, 0.7);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const f = (big ? 42 : 58) * (1 + 4.5 * Math.exp(-t / 0.045));
    ph += 2 * Math.PI * f / SR;
    out[i] += Math.sin(ph) * Math.exp(-t / (big ? 0.34 : 0.22)) * 1.30;
    out[i] += lp.run(r() * 2 - 1) * Math.exp(-t / (big ? 0.55 : 0.34)) * 1.1;
    out[i] += bp.run(r() * 2 - 1) * Math.exp(-t / 0.16) * 0.55;
    out[i] += hp.run(r() * 2 - 1) * Math.exp(-t / 0.012) * 0.85;
    // debris rattle
    if (t > 0.10 && r() < 0.0016) {
      const off = i, n2 = Math.min(N - off, Math.ceil(0.05 * SR));
      for (let k = 0; k < n2; k++) out[off + k] += (r() * 2 - 1) * Math.exp(-k / SR / 0.008) * 0.20;
    }
    // long tail
    out[i] += (r() * 2 - 1) * Math.exp(-t / (L * 0.30)) * 0.12;
  }
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < N; i++) out[i] = softClip(out[i] * 0.98 / peak);
  return out;
}

function renderBlip(freq, len, kind, seed) {
  const r = makeRng(seed || 7);
  const N = Math.ceil(len * SR);
  const out = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const f = kind === 'down' ? freq * (1 - 0.35 * t / len) : kind === 'up' ? freq * (1 + 0.5 * t / len) : freq;
    ph += 2 * Math.PI * f / SR;
    const env = Math.min(1, t / 0.0018) * Math.exp(-t / (len * 0.34));
    out[i] = (Math.sin(ph) * 0.75 + Math.sin(ph * 2.01) * 0.22 + Math.sin(ph * 3.03) * 0.08) * env * 0.55;
  }
  return out;
}

function renderMech(kind, seed) {
  const r = makeRng(seed);
  const N = Math.ceil(0.30 * SR);
  const out = new Float32Array(N);
  const events = {
    magout: [[0.00, 2100, 2.0, 0.010, 0.7], [0.055, 1500, 1.6, 0.020, 0.5]],
    magin:  [[0.00, 1700, 1.4, 0.014, 0.6], [0.048, 2600, 2.6, 0.008, 0.9], [0.062, 900, 1.0, 0.030, 0.5]],
    bolt:   [[0.00, 2900, 2.8, 0.009, 0.85], [0.070, 2200, 2.0, 0.016, 0.75]],
    shell:  [[0.00, 2400, 2.2, 0.010, 0.6], [0.030, 1200, 1.2, 0.022, 0.45]],
    swap:   [[0.00, 1400, 1.2, 0.020, 0.5], [0.090, 2000, 1.8, 0.014, 0.4]],
    pin:    [[0.00, 3200, 3.2, 0.006, 0.8]],
    dryfire:[[0.00, 3000, 3.0, 0.005, 0.9], [0.012, 1400, 1.4, 0.012, 0.4]],
  }[kind] || [[0, 2000, 2, 0.012, 0.6]];
  for (const [tOff, f, q, dec, amp] of events) {
    const bp = new Biquad().bandpass(f * (1 + (r() - 0.5) * 0.16), q);
    const start = Math.floor(tOff * SR);
    const n = Math.ceil(0.09 * SR);
    for (let i = 0; i < n && start + i < N; i++) {
      const t = i / SR;
      out[start + i] += bp.run(r() * 2 - 1) * Math.exp(-t / dec) * amp;
    }
  }
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < N; i++) out[i] *= 0.5 / peak;
  return out;
}

/* Melee swing: a rifle moved fast through air. Noise through a band-pass whose
   centre rises as the swing accelerates and falls away as it slows, over a low
   rustle of sling and cloth. No tone — a real whoosh has none. The Biquad
   resets its state when retuned, so the sweep uses a state-variable filter,
   which can be retuned every sample without clicking. */
function renderSwing(seed) {
  const r = makeRng(seed);
  const N = Math.ceil(0.26 * SR);
  const out = new Float32Array(N);
  const f0 = 320 * (1 + (r() - 0.5) * 0.2), f1 = 1900 * (1 + (r() - 0.5) * 0.25);
  const peakT = 0.095 + (r() - 0.5) * 0.02;
  const lp = new Biquad().lowpass(700, 0.7);
  let low = 0, band = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const v = t < peakT ? Math.sin((t / peakT) * Math.PI / 2) : Math.exp(-(t - peakT) / 0.05);
    const f = 2 * Math.sin(Math.PI * (f0 + (f1 - f0) * v) / SR);
    const damp = 1 / (1.2 + v * 1.4);
    low += f * band;
    const high = (r() * 2 - 1) - low - damp * band;
    band += f * high;
    out[i] = band * v * 0.9 + lp.run(r() * 2 - 1) * v * v * 0.25;
  }
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < N; i++) out[i] = softClip(out[i] * 0.6 / peak);
  return out;
}

/* Melee connect: a rifle butt into a plate carrier. A pitch-dropping chest
   thump, a short dull smack, the fabric-and-flesh body under it, and the kit
   rattling a beat later. */
function renderMeleeHit(seed) {
  const r = makeRng(seed);
  const N = Math.ceil(0.32 * SR);
  const out = new Float32Array(N);
  const body = 62 * (1 + (r() - 0.5) * 0.15);
  const smack = new Biquad().bandpass(1100 * (1 + (r() - 0.5) * 0.3), 0.9);
  const lp = new Biquad().lowpass(420, 0.8);
  const gear = new Biquad().bandpass(2600 * (1 + (r() - 0.5) * 0.2), 2.2);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    ph += 2 * Math.PI * body * (1 + 1.8 * Math.exp(-t / 0.012)) / SR;
    out[i] += Math.sin(ph) * Math.exp(-t / 0.075);
    out[i] += smack.run(r() * 2 - 1) * Math.exp(-t / 0.016) * 0.9;
    out[i] += lp.run(r() * 2 - 1) * Math.exp(-t / 0.045) * 0.6;
    const gt = t - 0.018;
    if (gt > 0) out[i] += gear.run(r() * 2 - 1) * Math.exp(-gt / 0.02) * 0.22;
  }
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < N; i++) out[i] = softClip(out[i] * 0.8 / peak);
  return out;
}

function renderWhizby(seed) {
  const r = makeRng(seed);
  const N = Math.ceil(0.22 * SR);
  const out = new Float32Array(N);
  const bp = new Biquad().bandpass(2200, 1.2);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const k = t / (N / SR);
    // doppler-ish sweep past the ear
    const f = 3200 * (1 - k * 0.72);
    ph += 2 * Math.PI * f / SR;
    const env = Math.exp(-Math.pow((k - 0.28) / 0.16, 2)) ;
    out[i] = (bp.run(r() * 2 - 1) * 0.7 + Math.sin(ph) * 0.3) * env * 0.5;
  }
  return out;
}

function renderRotor(seed) {
  // 2-second seamless loop
  const r = makeRng(seed);
  const N = Math.ceil(2.0 * SR);
  const out = new Float32Array(N);
  const lp = new Biquad().lowpass(900, 0.7);
  const bladeHz = 11.4;      // main-rotor blade slap
  const turbHz = 233;        // turbine whine
  let ph = 0, ph2 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const beat = Math.pow(Math.max(0, Math.sin(2 * Math.PI * bladeHz * t)), 6);
    ph += 2 * Math.PI * 47 / SR;
    ph2 += 2 * Math.PI * turbHz / SR;
    out[i] = lp.run(r() * 2 - 1) * (0.20 + beat * 0.85)
           + Math.sin(ph) * 0.18 * (0.4 + beat)
           + Math.sin(ph2) * 0.045 + Math.sin(ph2 * 1.5) * 0.02;
  }
  // crossfade the ends so the loop is seamless
  const xf = Math.ceil(0.08 * SR);
  for (let i = 0; i < xf; i++) {
    const k = i / xf;
    out[i] = out[i] * k + out[N - xf + i] * (1 - k);
  }
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < N; i++) out[i] *= 0.55 / peak;
  return out;
}

function renderJet(seed) {
  const r = makeRng(seed);
  const N = Math.ceil(3.2 * SR);
  const out = new Float32Array(N);
  const lp = new Biquad().lowpass(1400, 0.6);
  const bp = new Biquad().bandpass(320, 0.5);
  for (let i = 0; i < N; i++) {
    const t = i / SR, k = t / (N / SR);
    const env = Math.exp(-Math.pow((k - 0.55) / 0.30, 2));
    out[i] = (lp.run(r() * 2 - 1) * 0.8 + bp.run(r() * 2 - 1) * 0.9) * env;
  }
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < N; i++) out[i] *= 0.85 / peak;
  return out;
}

function renderAmbience(seed) {
  const r = makeRng(seed);
  const N = Math.ceil(6.0 * SR);
  const out = new Float32Array(N);
  const lp = new Biquad().lowpass(420, 0.5);
  const lp2 = new Biquad().lowpass(90, 0.6);
  let mod = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    mod = mod * 0.99995 + (r() - 0.5) * 0.0006;
    const gust = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.07 * t) * Math.sin(2 * Math.PI * 0.031 * t + 1.2);
    out[i] = lp.run(r() * 2 - 1) * (0.20 + gust * 0.30) + lp2.run(r() * 2 - 1) * 0.35;
  }
  const xf = Math.ceil(0.5 * SR);
  for (let i = 0; i < xf; i++) {
    const k = i / xf;
    out[i] = out[i] * k + out[N - xf + i] * (1 - k);
  }
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < N; i++) out[i] *= 0.30 / peak;
  return out;
}

function renderReverbIR(seed) {
  const r = makeRng(seed);
  const N = Math.ceil(1.15 * SR);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    out[i] = (r() * 2 - 1) * Math.pow(1 - t / (N / SR), 2.6) * Math.exp(-t / 0.42);
  }
  // a handful of discrete early reflections
  for (const [d, g] of [[0.011, 0.5], [0.019, 0.42], [0.031, 0.34], [0.052, 0.26], [0.077, 0.18]]) {
    const off = Math.floor(d * SR);
    if (off < N) out[off] += g;
  }
  return out;
}

/* ============================================================================
   Engine
   ========================================================================== */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.buffers = {};        // name -> AudioBuffer | AudioBuffer[]
    this.rotIdx = {};
    this.masterVol = 0.7;
    this._rng = makeRng(0xA0D10);
    this._voices = 0;
    this.MAX_VOICES = 32;
  }

  /** Build the context. Must be called from a user gesture. */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ sampleRate: SR, latencyHint: 'interactive' });

    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVol;
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 22;
    this.comp.ratio.value = 5; this.comp.attack.value = 0.002; this.comp.release.value = 0.19;
    this.master.connect(this.comp); this.comp.connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain(); this.sfxBus.gain.value = 1.0;
    this.sfxBus.connect(this.master);

    this.reverb = this.ctx.createConvolver();
    this.revSend = this.ctx.createGain(); this.revSend.gain.value = 0.30;
    this.revReturn = this.ctx.createGain(); this.revReturn.gain.value = 0.55;
    this.revSend.connect(this.reverb); this.reverb.connect(this.revReturn); this.revReturn.connect(this.master);

    this.listener = this.ctx.listener;
    this.ready = true;
  }

  _mk(name, data) {
    const buf = this.ctx.createBuffer(1, data.length, SR);
    buf.copyToChannel(data, 0);
    this.buffers[name] = buf;
    return buf;
  }
  _mkSet(name, arr) {
    this.buffers[name] = arr.map((d, i) => {
      const b = this.ctx.createBuffer(1, d.length, SR);
      b.copyToChannel(d, 0);
      return b;
    });
    this.rotIdx[name] = 0;
  }

  /**
   * Pre-render everything, yielding between jobs so the loader keeps painting.
   * `deferred` jobs run in the background after the menu is already up — the
   * distant-report variants and the aircraft loops are not needed until a match
   * starts, and keeping them out of the critical path halves the cold boot.
   */
  async bake(weapons, onProgress) {
    this.init();
    const jobs = [];
    const deferred = [];
    for (const w of weapons) {
      jobs.push(['gun_' + w.id, () => {
        const set = [];
        for (let v = 0; v < 5; v++) set.push(renderGunshot(w.audio, 0x1000 + w.id.charCodeAt(0) * 977 + v * 13));
        this._mkSet('gun_' + w.id, set);
      }]);
      deferred.push(() => {
        // duller, longer-tailed distant report
        const far = { ...w.audio, crackHz: w.audio.crackHz * 0.42, tailHz: w.audio.tailHz * 0.5,
                      tail: w.audio.tail * 1.9, punch: w.audio.punch * 0.5, mech: 0.05, gain: w.audio.gain * 0.9 };
        const fset = [];
        for (let v = 0; v < 3; v++) fset.push(renderGunshot(far, 0x9000 + w.id.charCodeAt(1) * 331 + v * 29));
        this._mkSet('gunfar_' + w.id, fset);
      });
    }

    jobs.push(['footsteps', () => {
      for (const s of ['concrete', 'dirt', 'metal', 'wood']) {
        this._mkSet('step_' + s, [0, 1, 2, 3, 4].map(i => renderFootstep(s, 0x200 + i * 71 + s.length * 13, false)));
        this._mkSet('run_' + s, [0, 1, 2, 3].map(i => renderFootstep(s, 0x400 + i * 91 + s.length * 17, true)));
      }
    }]);
    jobs.push(['impacts', () => {
      for (const s of ['concrete', 'dirt', 'metal', 'wood', 'glass', 'flesh']) {
        this._mkSet('imp_' + s, [0, 1, 2, 3].map(i => renderImpact(s, 0x600 + i * 53 + s.length * 29)));
      }
      this._mkSet('melee_swing', [0, 1, 2].map(i => renderSwing(0xA10 + i * 41)));
      this._mkSet('melee_hit', [0, 1, 2].map(i => renderMeleeHit(0xA40 + i * 47)));
    }]);
    jobs.push(['mech', () => {
      for (const k of ['magout', 'magin', 'bolt', 'shell', 'swap', 'pin', 'dryfire']) {
        this._mkSet('mech_' + k, [0, 1, 2].map(i => renderMech(k, 0x800 + i * 37 + k.length * 101)));
      }
    }]);
    jobs.push(['fx', () => {
      this._mkSet('explode', [0, 1].map(i => renderExplosion(0xE00 + i * 61, false)));
      this._mkSet('whizby', [0, 1, 2].map(i => renderWhizby(0xF00 + i * 43)));
      this._mk('hitmark', renderBlip(1180, 0.075, 'flat', 3));
      this._mk('hitmarkHS', renderBlip(1760, 0.085, 'down', 5));
      this._mk('hitmarkKill', renderBlip(880, 0.19, 'down', 9));
      this._mk('uiClick', renderBlip(660, 0.045, 'flat', 11));
      this._mk('uiSelect', renderBlip(980, 0.07, 'up', 13));
      this._mk('streak', renderBlip(520, 0.32, 'up', 17));
      this._mk('death', renderBlip(190, 0.55, 'down', 19));
      this.reverb.buffer = (() => {
        const ir = renderReverbIR(0x4444);
        const b = this.ctx.createBuffer(2, ir.length, SR);
        b.copyToChannel(ir, 0);
        b.copyToChannel(renderReverbIR(0x5555), 1);
        return b;
      })();
    }]);

    deferred.push(() => this._mkSet('explodeBig', [0, 1].map(i => renderExplosion(0xE80 + i * 67, true))));
    deferred.push(() => this._mk('rotor', renderRotor(0x1111)));
    deferred.push(() => this._mk('jet', renderJet(0x2222)));
    deferred.push(() => this._mk('ambience', renderAmbience(0x3333)));

    for (let i = 0; i < jobs.length; i++) {
      jobs[i][1]();
      onProgress && onProgress((i + 1) / jobs.length, jobs[i][0]);
      await yieldToBrowser();
    }
    this._deferred = deferred;
  }

  /** Finish the non-critical banks once the menu is interactive. */
  async bakeDeferred() {
    if (!this._deferred) return;
    const list = this._deferred;
    this._deferred = null;
    for (const job of list) {
      job();
      await yieldToBrowser();
    }
    this.deferredReady = true;
  }

  _pick(name) {
    const b = this.buffers[name];
    if (!b) return null;
    if (!Array.isArray(b)) return b;
    // shuffled rotation: advance by a coprime stride so consecutive picks differ
    const i = this.rotIdx[name] = (this.rotIdx[name] + 1 + (this._rng() < 0.35 ? 1 : 0)) % b.length;
    return b[i];
  }

  /**
   * Fire a one-shot.
   * @param opt { pos:[x,y,z], vol, rate, dist, lowpass, reverb, loop }
   */
  play(name, opt = {}) {
    if (!this.ready || this.ctx.state === 'suspended') return null;
    if (this._voices > this.MAX_VOICES && !opt.important) return null;
    const buf = this._pick(name);
    if (!buf) return null;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opt.rate ?? (1 + (this._rng() - 0.5) * 0.05);
    if (opt.loop) src.loop = true;

    const g = this.ctx.createGain();
    g.gain.value = (opt.vol ?? 1);

    let node = src;
    if (opt.lowpass) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = opt.lowpass; f.Q.value = 0.7;
      src.connect(f); node = f;
    }
    node.connect(g);

    let out = g;
    if (opt.pos) {
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
      p.refDistance = 3.5; p.maxDistance = 180; p.rolloffFactor = 1.05;
      p.positionX.value = opt.pos[0]; p.positionY.value = opt.pos[1]; p.positionZ.value = opt.pos[2];
      g.connect(p); out = p;
    }
    out.connect(this.sfxBus);
    if (opt.reverb !== 0) {
      const rs = this.ctx.createGain();
      rs.gain.value = (opt.reverb ?? 0.30);
      out.connect(rs); rs.connect(this.revSend);
    }
    this._voices++;
    src.onended = () => { this._voices--; try { out.disconnect(); g.disconnect(); } catch (e) {} };
    src.start();
    return { src, gain: g, panner: opt.pos ? out : null };
  }

  /** Weapon report, chosen by distance so far-off fights sound far off. */
  gunshot(weaponId, pos, listenerPos, isLocal) {
    const d = listenerPos ? Math.hypot(pos[0] - listenerPos.x, pos[1] - listenerPos.y, pos[2] - listenerPos.z) : 0;
    if (isLocal) {
      this.play('gun_' + weaponId, { vol: 0.92, reverb: 0.22, important: true });
      return;
    }
    if (d > 34 && this.buffers['gunfar_' + weaponId]) {
      this.play('gunfar_' + weaponId, { pos, vol: 1.35, lowpass: lerp(3600, 700, clamp((d - 34) / 60, 0, 1)),
        reverb: 0.55, important: d < 70 });
    } else {
      this.play('gun_' + weaponId, { pos, vol: 1.5, lowpass: lerp(18000, 4200, clamp(d / 34, 0, 1)),
        reverb: 0.34, important: true });
    }
  }

  startLoop(name, opt = {}) {
    const v = this.play(name, { ...opt, loop: true, important: true });
    return v;
  }
  stopLoop(v, fade = 0.25) {
    if (!v) return;
    try {
      v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
      setTimeout(() => { try { v.src.stop(); } catch (e) {} }, fade * 1000 + 60);
    } catch (e) {}
  }

  /** Move the listener with the camera. */
  setListener(pos, fwd, up) {
    if (!this.ready) return;
    const L = this.listener, t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(pos.x, t, 0.02);
      L.positionY.setTargetAtTime(pos.y, t, 0.02);
      L.positionZ.setTargetAtTime(pos.z, t, 0.02);
      L.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      L.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      L.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      L.upX.setTargetAtTime(up.x, t, 0.02);
      L.upY.setTargetAtTime(up.y, t, 0.02);
      L.upZ.setTargetAtTime(up.z, t, 0.02);
    } else {
      L.setPosition(pos.x, pos.y, pos.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  setVolume(v) {
    this.masterVol = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Muffle everything briefly — used for close explosions. */
  concuss(seconds = 2.2) {
    if (!this.ready) return;
    if (!this._duck) {
      this._duck = this.ctx.createBiquadFilter();
      this._duck.type = 'lowpass'; this._duck.frequency.value = 20000; this._duck.Q.value = 0.6;
      this.sfxBus.disconnect();
      this.sfxBus.connect(this._duck); this._duck.connect(this.master);
    }
    const t = this.ctx.currentTime;
    this._duck.frequency.cancelScheduledValues(t);
    this._duck.frequency.setValueAtTime(420, t);
    this._duck.frequency.exponentialRampToValueAtTime(20000, t + seconds);
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
}
