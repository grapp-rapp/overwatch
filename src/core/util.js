/* Small shared helpers: deterministic RNG, math, pooling, timing. */

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (v - a) / (b - a);
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const deg = Math.PI / 180;
export const TAU = Math.PI * 2;

/** Wrap an angle into (-PI, PI]. */
export function wrapPi(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Angle-aware exponential damping. */
export function dampAngle(a, b, lambda, dt) {
  return a + wrapPi(b - a) * (1 - Math.exp(-lambda * dt));
}

/** Mulberry32 — small, fast, seedable. Deterministic across runs. */
export function makeRng(seed = 0x9e3779b9) {
  let s = seed >>> 0;
  const f = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (a, b) => a + f() * (b - a);
  f.int = (a, b) => Math.floor(a + f() * (b - a + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.sign = () => (f() < 0.5 ? -1 : 1);
  /** Box–Muller, cached. */
  let spare = null;
  f.gauss = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u, v, s2;
    do { u = f() * 2 - 1; v = f() * 2 - 1; s2 = u * u + v * v; } while (s2 >= 1 || s2 === 0);
    const m = Math.sqrt(-2 * Math.log(s2) / s2);
    spare = v * m;
    return u * m;
  };
  return f;
}

export const rng = makeRng(0x5eed1234);

/** Fixed-size ring buffer of plain objects; avoids GC churn in hot loops. */
export class Ring {
  constructor(size, factory) {
    this.size = size;
    this.buf = new Array(size);
    for (let i = 0; i < size; i++) this.buf[i] = factory();
    this.head = 0;
    this.count = 0;
  }
  push() {
    const o = this.buf[this.head];
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
    return o;
  }
  /** i = 0 is oldest retained entry. */
  at(i) {
    const start = (this.head - this.count + this.size * 2) % this.size;
    return this.buf[(start + i) % this.size];
  }
}

/** Generic object pool. */
export class Pool {
  constructor(factory, reset, initial = 0) {
    this.factory = factory; this.reset = reset;
    this.free = [];
    this.live = [];
    for (let i = 0; i < initial; i++) this.free.push(factory());
  }
  get() {
    const o = this.free.pop() || this.factory();
    this.live.push(o);
    return o;
  }
  release(o) {
    const i = this.live.indexOf(o);
    if (i >= 0) this.live.splice(i, 1);
    this.reset && this.reset(o);
    this.free.push(o);
  }
  releaseAll() {
    while (this.live.length) this.release(this.live[this.live.length - 1]);
  }
}

/**
 * Yield to the browser between chunks of boot work.
 *
 * Deliberately NOT setTimeout: a hidden or backgrounded tab clamps timers to
 * roughly one second, which turned an 11-step audio bake into a nine-second
 * stall. A MessageChannel round trip is a plain task, so it is never throttled,
 * and it still lets the loading bar paint.
 */
export const yieldToBrowser = (() => {
  let ch = null, pending = null;
  return function yieldToBrowser() {
    if (typeof MessageChannel === 'undefined') return new Promise(r => setTimeout(r, 0));
    if (!ch) {
      ch = new MessageChannel();
      ch.port1.onmessage = () => { const p = pending; pending = null; p && p(); };
      ch.port1.start();
    }
    return new Promise(r => { pending = r; ch.port2.postMessage(0); });
  };
})();

export function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

/** Rolling window statistics — used by the frame-time profiler. */
export class Stat {
  constructor(n = 180) { this.n = n; this.v = new Float64Array(n); this.i = 0; this.filled = 0; }
  push(x) { this.v[this.i] = x; this.i = (this.i + 1) % this.n; if (this.filled < this.n) this.filled++; }
  get mean() { let s = 0; for (let i = 0; i < this.filled; i++) s += this.v[i]; return s / (this.filled || 1); }
  percentile(p) {
    if (!this.filled) return 0;
    const a = Array.prototype.slice.call(this.v, 0, this.filled).sort((x, y) => x - y);
    return a[clamp(Math.round((a.length - 1) * p), 0, a.length - 1)];
  }
  get max() { let m = 0; for (let i = 0; i < this.filled; i++) if (this.v[i] > m) m = this.v[i]; return m; }
}

/** Callsign generator for AI operators. */
const FIRST = ['VIPER', 'GHOST', 'REAPER', 'HAVOC', 'NOMAD', 'BRAVO', 'KILO', 'ZULU', 'RAVEN', 'TALON',
  'SABRE', 'HUNTER', 'FROST', 'IRON', 'ECHO', 'DELTA', 'WOLF', 'CINDER', 'RIFT', 'ONYX', 'STORM', 'ASH'];
const SUFFIX = ['01', '02', '03', '06', '11', '7', 'X', 'ACTUAL', 'PRIME', '2-1', '9', '4'];
export function callsign(r) {
  return r.pick(FIRST) + '-' + r.pick(SUFFIX);
}
