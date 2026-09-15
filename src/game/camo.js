/* ============================================================================
   Camouflage: tileable procedural patterns, and the material that wears them.

   Weapon parts and the operator's body have UVs that were never laid out for
   a pattern - a box face runs 0..1 whatever its size, and the skinned body's
   UVs belong to its own cloth texture. So camo is projected instead: sampled
   on three planes from each mesh's own object-space position and blended by
   the normal. The pattern keeps one scale across every part, and on the
   skinned body it comes from the bind pose, so it moves with the cloth.
   ========================================================================== */
import * as THREE from 'three';

/* value noise that tiles: a P x P lattice sampled over [0, P) wraps exactly,
   and so does every octave above it */
function tileNoise(seed, P) {
  let s = (seed * 2654435761) >>> 0;
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const g = new Float32Array(P * P);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const at = (i, j) => g[(((j % P) + P) % P) * P + (((i % P) + P) % P)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
  };
}
const fbm = (n, x, y, oct) => { let a = 0, amp = 0.5, f = 1, t = 0; for (let o = 0; o < oct; o++) { a += n(x * f, y * f) * amp; t += amp; amp *= 0.5; f *= 2; } return a / t; };
const rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
/* tileable cells: K x K jittered points on a torus. (x, y) in [0, K) ->
   [nearest distance, second-nearest distance, a random id in [0,1) for the nearest] */
function tileCells(seed, K) {
  let s = (seed * 2654435761) >>> 0;
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pts = [];
  for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) pts.push([i + 0.1 + r() * 0.8, j + 0.1 + r() * 0.8, r()]);
  const out = [0, 0, 0];
  return (x, y) => {
    let d1 = 9, d2 = 9, id = 0;
    const ci = Math.floor(x), cj = Math.floor(y);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = ci + di, jj = cj + dj, wi = ((ii % K) + K) % K, wj = ((jj % K) + K) % K, p = pts[wj * K + wi];
      const d = Math.hypot(x - (p[0] + ii - wi), y - (p[1] + jj - wj));
      if (d < d1) { d2 = d1; d1 = d; id = p[2]; } else if (d < d2) d2 = d;
    }
    out[0] = d1; out[1] = d2; out[2] = id;
    return out;
  };
}
const hash2 = (a, b, seed) => {
  let h = (a * 374761393 + b * 668265263 + seed * 144269) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/* each returns (x, y) in [0,1) -> [r, g, b]; the brightest colours glow on skins with `glow` */
const PAT = {
  blotch(o) {        // layered blotches: each colour over the last where its own noise rises
    const pal = o.pal.map(rgb), C = o.cells || 5, ns = pal.map((_, i) => tileNoise(o.seed + i * 131, C));
    return (x, y) => { let c = pal[0];
      for (let i = 1; i < pal.length; i++) if (fbm(ns[i], x * C, y * C, 4) > 0.53 - i * 0.012) c = pal[i];
      return c; };
  },
  digital(o) {       // the same idea on a pixel grid
    const pal = o.pal.map(rgb), n = tileNoise(o.seed, 8), px = 48;
    return (x, y) => { const v = fbm(n, Math.floor(x * px) / px * 8, Math.floor(y * px) / px * 8, 4);
      return pal[Math.max(0, Math.min(pal.length - 1, Math.floor((v - 0.3) / 0.4 * pal.length)))]; };
  },
  stripes(o) {       // tiger: warped bands, black over the base with a dark fringe
    const pal = o.pal.map(rgb), n = tileNoise(o.seed, 4);
    return (x, y) => { const t = Math.sin((x * 5 + y + fbm(n, x * 4, y * 4, 3) * 1.8) * Math.PI * 2);
      return t > 0.62 ? pal[1] : t > 0.45 ? pal[2] : pal[0]; };
  },
  carbon(o) {        // woven carbon: alternating tows, each rounded across its width
    const [a, b] = o.pal.map(rgb), K = 24;
    return (x, y) => { const cx = Math.floor(x * K), cy = Math.floor(y * K);
      const t = ((cx + cy) & 1) ? x * K - cx : y * K - cy, s = 0.35 + 0.65 * Math.sin(t * Math.PI);
      return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]; };
  },
  scales(o) {        // dragon: rows of overlapping scales, each shaded toward its rim
    const [a, b] = o.pal.map(rgb), R = 12;
    return (x, y) => { const gy = y * R, row = Math.floor(gy), gx = x * R + (row & 1) * 0.5;
      const fx = gx - Math.floor(gx) - 0.5, fy = 1 - (gy - row);
      const d1 = Math.hypot(Math.abs(fx) - 0.5, fy - 1), d = d1 < 0.75 ? d1 : Math.hypot(fx, fy);
      if (d > 0.68) return b;
      const k = 1.1 - d * 0.75; return [a[0] * k, a[1] * k, a[2] * k]; };
  },
  cracks(o) {        // volcanic: black rock split by bright cracks
    const [a, hot] = o.pal.map(rgb), n = tileNoise(o.seed, 5), m = tileNoise(o.seed + 7, 10);
    return (x, y) => { const v = Math.abs(fbm(n, x * 5, y * 5, 4) - 0.5), g = v < 0.018 ? 1 - v / 0.018 : 0;
      const k = (0.6 + fbm(m, x * 10, y * 10, 3) * 0.5) * (1 - g);
      return [a[0] * k + hot[0] * g, a[1] * k + hot[1] * g, a[2] * k + hot[2] * g]; };
  },
  neon(o) {          // synthwave: a lit grid in two colours over near-black
    const [a, c1, c2] = o.pal.map(rgb), n = tileNoise(o.seed, 4), K = 8;
    return (x, y) => { const fx = x * K % 1, fy = y * K % 1;
      if (Math.min(fx, 1 - fx, fy, 1 - fy) >= 0.05) return a;
      return fbm(n, x * 4, y * 4, 2) > 0.5 ? c1 : c2; };
  },
  spots(o) {         // rosettes: a dark ring round a lighter heart, on a base
    const P = o.pal.map(rgb), K = o.cells || 6, c = tileCells(o.seed, K), n = tileNoise(o.seed + 3, 4);
    return (x, y) => {
      const w = (fbm(n, x * 4, y * 4, 3) - 0.5) * 0.5, d = c(x * K + w, y * K + w)[0];
      return d < 0.2 ? P[2] : d < 0.32 ? P[1] : P[0];
    };
  },
  hex(o) {           // hexagon plates, each its own shade, with a dark seam
    const P = o.pal.map(rgb), S3 = Math.sqrt(3);
    return (x, y) => {
      const u = x * 6 * S3, v = y * 12;              // 6 plates across, 8 rows down: repeats exactly
      const q = S3 / 3 * u - v / 3, r = 2 / 3 * v, yq = -q - r;
      let cx = Math.round(q), cy = Math.round(yq), cz = Math.round(r);
      const dx = Math.abs(cx - q), dy = Math.abs(cy - yq), dz = Math.abs(cz - r);
      if (dx > dy && dx > dz) cx = -cy - cz; else if (dy <= dz) cz = -cx - cy;
      const lu = Math.abs(u - S3 * (cx + cz / 2)), lv = Math.abs(v - 1.5 * cz);
      const e = Math.max(lu, 0.5 * lu + 0.866 * lv) / 0.866;
      const col = cx + Math.floor(cz / 2), id = hash2(((col % 6) + 6) % 6, ((cz % 8) + 8) % 8, o.seed);
      const base = P[Math.floor(id * P.length) % P.length];
      return e > 0.9 ? mixc(base, [8, 8, 10], 0.75) : mixc(base, [255, 255, 255], (0.9 - e) * 0.2);
    };
  },
  marble(o) {        // polished stone: soft clouds cut by dark veins
    const P = o.pal.map(rgb), n = tileNoise(o.seed, 4), m = tileNoise(o.seed + 9, 8);
    return (x, y) => {
      const t = fbm(n, x * 4, y * 4, 5), v = Math.abs(Math.sin((x * 2 + y * 3 + t * 3.2) * Math.PI));
      const base = mixc(P[0], P[1], fbm(m, x * 8, y * 8, 3));
      return v < 0.07 ? mixc(P[2], base, v / 0.07 * 0.5) : base;
    };
  },
  circuit(o) {       // a circuit board: traces between pads on a grid
    const P = o.pal.map(rgb), K = 10, w = 0.07;
    const on = (i, j, k) => hash2(((i % K) + K) % K, ((j % K) + K) % K, o.seed + k) > 0.48;
    return (x, y) => {
      const gx = x * K, gy = y * K, i = Math.floor(gx), j = Math.floor(gy), fx = gx - i - 0.5, fy = gy - j - 0.5;
      const h = hash2(i, j, o.seed);
      if (h > 0.72 && Math.hypot(fx, fy) < 0.16) return Math.hypot(fx, fy) < 0.08 ? P[0] : P[2];
      const t = (on(i, j, 1) && fx > -w && Math.abs(fy) < w) || (on(i - 1, j, 1) && fx < w && Math.abs(fy) < w) ||
                (on(i, j, 2) && fy > -w && Math.abs(fx) < w) || (on(i, j - 1, 2) && fy < w && Math.abs(fx) < w);
      return t ? P[1] : mixc(P[0], P[3] || P[0], h * 0.3);
    };
  },
  damascus(o) {      // folded steel: rippling layers
    const P = o.pal.map(rgb), n = tileNoise(o.seed, 4);
    return (x, y) => {
      const t = y * 14 + fbm(n, x * 4, y * 4, 4) * 5 + Math.sin(x * Math.PI * 4) * 0.8;
      const b = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
      return mixc(P[0], P[1], b * b * (3 - 2 * b));
    };
  },
  shard(o) {         // crystal: flat facets, each its own colour, bright where they meet
    const P = o.pal.map(rgb), K = o.cells || 5, c = tileCells(o.seed, K);
    return (x, y) => {
      const q = c(x * K, y * K), d1 = q[0], edge = q[1] - q[0], id = q[2];
      if (edge < 0.035) return P[P.length - 1];
      return mixc(P[Math.floor(id * (P.length - 1))], [255, 255, 255], 0.12 + id * 0.1 - d1 * 0.15);
    };
  },
  nebula(o) {        // deep space: gas clouds and stars
    const P = o.pal.map(rgb), n1 = tileNoise(o.seed, 4), n2 = tileNoise(o.seed + 5, 8), K = 40;
    const star = mixc(P[3] || [255, 255, 255], [255, 255, 255], 0.5);
    return (x, y) => {
      const a = fbm(n1, x * 4, y * 4, 5), b = fbm(n2, x * 8 + 3, y * 8 + 1, 4);
      let c = mixc(P[0], P[1], Math.min(1, Math.max(0, a - 0.35) * 2.2));
      c = mixc(c, P[2], Math.min(1, Math.max(0, b - 0.52) * 3.2));
      const gx = x * K, gy = y * K, i = Math.floor(gx), j = Math.floor(gy);
      if (hash2(i, j, o.seed) > 0.93 && Math.hypot(gx - i - hash2(i, j, o.seed + 3), gy - j - hash2(i, j, o.seed + 4)) < 0.12) return star;
      return c;
    };
  },
  aurora(o) {        // curtains of light
    const P = o.pal.map(rgb), n = tileNoise(o.seed, 4);
    return (x, y) => {
      const w = fbm(n, x * 4, y * 4, 4), v = Math.sin((y * 3 + w * 1.6) * Math.PI * 2), k = Math.max(0, v) ** 3;
      return mixc(P[0], mixc(P[1], P[2], 0.5 + 0.5 * Math.sin(x * Math.PI * 4 + w * 3)), k);
    };
  },
  brushed(o) {       // brushed metal: fine streaks along one axis, for chrome and gold
    const n = tileNoise(o.seed, 4);
    return (x, y) => { const v = 205 + n(x * 4, y * 64) * 50; return [v, v, v]; };
  },
};

const TEX = new Map();
const LIN = Array.from({ length: 256 }, (_, i) => Math.pow(i / 255, 2.2));
export function camoTexture(skin) {
  if (!skin || !skin.camo) return null;
  if (TEX.has(skin.id)) return TEX.get(skin.id);
  const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(N, N), f = PAT[skin.camo.pat](skin.camo);
  let lum = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = f(x / N, y / N), o = (y * N + x) * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    lum += LIN[Math.min(255, c[0] | 0)] * 0.2126 + LIN[Math.min(255, c[1] | 0)] * 0.7152 + LIN[Math.min(255, c[2] | 0)] * 0.0722;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  t.userData.meanLum = lum / (N * N);   // lets cloth lift a dark pattern to a readable brightness
  TEX.set(skin.id, t);
  return t;
}

/* A studio to reflect: chrome and gold are black without something to mirror,
   and neither the viewmodel scene nor the menu preview has a sky. */
let ENV = null;
export function studioEnv() {
  if (ENV) return ENV;
  const W = 256, H = 128, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d'), g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#f2f4f6'); g.addColorStop(0.42, '#9aa3aa'); g.addColorStop(0.5, '#5b6166'); g.addColorStop(1, '#141618');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(255,255,255,0.85)'; c.fillRect(0, 22, W, 7); c.fillRect(W * 0.1, 40, W * 0.3, 5);
  c.fillStyle = 'rgba(255,214,170,0.55)'; c.fillRect(W * 0.62, 30, W * 0.18, 16);
  ENV = new THREE.CanvasTexture(cv);
  ENV.mapping = THREE.EquirectangularReflectionMapping; ENV.colorSpace = THREE.SRGBColorSpace;
  return ENV;
}

/* one clock for every animated skin; main.js advances it every frame */
export const camoClock = { value: 0 };

/** A copy of `base` wearing `skin`: the pattern projected at `scale` repeats per
    object unit. look.flow drifts it (pattern units a second), look.pulse throbs
    its glow, look.hue turns its colours (radians a second). */
export function withCamo(base, skin, scale) {
  const m = base.clone(), L = skin.look || {};
  if (L.color !== undefined) m.color = new THREE.Color(L.color);
  if (L.metal !== undefined) m.metalness = L.metal;
  if (L.rough !== undefined) m.roughness = L.rough;
  if (L.env) { m.envMap = studioEnv(); m.envMapIntensity = L.env; }
  const tex = camoTexture(skin);
  if (!tex) return m;
  const fl = L.flow || [0, 0, 0];
  const uni = {
    uCamo: { value: tex }, uCamoScale: { value: scale }, uCamoGlow: { value: L.glow || 0 },
    uCamoGain: { value: L.norm ? Math.min(6, Math.max(1, L.norm / (tex.userData.meanLum || 0.2))) : (L.gain || 1) },
    uCamoTime: camoClock, uCamoFlow: { value: new THREE.Vector3(fl[0], fl[1], fl[2]) },
    uCamoPulse: { value: L.pulse || 0 }, uCamoHue: { value: L.hue || 0 },
  };
  m.userData.camoUniforms = uni;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vCamoP;
varying vec3 vCamoN;
uniform float uCamoScale;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vCamoP = position * uCamoScale;
vCamoN = normal;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vCamoP;
varying vec3 vCamoN;
uniform sampler2D uCamo;
uniform float uCamoGlow, uCamoGain, uCamoTime, uCamoPulse, uCamoHue;
uniform vec3 uCamoFlow;
vec3 camoCol;
vec3 camoHue(vec3 c, float a) {
  vec3 yiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c;
  float h = atan(yiq.z, yiq.y) + a, ch = length(yiq.yz);
  return mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * vec3(yiq.x, ch * cos(h), ch * sin(h));
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
vec3 cw = pow(abs(normalize(vCamoN)), vec3(4.0)); cw /= (cw.x + cw.y + cw.z);
vec3 cp = vCamoP + uCamoFlow * uCamoTime;
camoCol = texture2D(uCamo, cp.yz).rgb * cw.x + texture2D(uCamo, cp.xz).rgb * cw.y + texture2D(uCamo, cp.xy).rgb * cw.z;
if (uCamoHue != 0.0) camoCol = max(camoHue(camoCol, uCamoTime * uCamoHue), vec3(0.0));
diffuseColor.rgb *= camoCol * uCamoGain;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += camoCol * smoothstep(0.6, 0.9, max(camoCol.r, max(camoCol.g, camoCol.b))) * uCamoGlow * (1.0 + uCamoPulse * sin(uCamoTime * 2.4));`);
  };
  m.customProgramCacheKey = () => 'camo-v2';
  return m;
}

/** A card's swatch: the pattern itself at low resolution, straight into a
    canvas - no texture, so hundreds of cards cost a few milliseconds each. */
export function drawCamoThumb(skin, cv) {
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  if (!skin.camo) { ctx.fillStyle = skin.swatch || '#333'; ctx.fillRect(0, 0, W, H); return; }
  const sw = 72, sh = Math.max(8, Math.round(sw * H / W)), f = PAT[skin.camo.pat](skin.camo);
  const tmp = document.createElement('canvas'); tmp.width = sw; tmp.height = sh;
  const tc = tmp.getContext('2d'), img = tc.createImageData(sw, sh), d = img.data, k = 1.5 / sw;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const c = f((x * k) % 1, (y * k) % 1), o = (y * sw + x) * 4;
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
  }
  tc.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, 0, 0, W, H);
}
