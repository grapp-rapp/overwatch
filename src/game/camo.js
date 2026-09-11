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

/** A copy of `base` wearing `skin`: the pattern projected at `scale` repeats per object unit. */
export function withCamo(base, skin, scale) {
  const m = base.clone(), L = skin.look || {};
  if (L.color !== undefined) m.color = new THREE.Color(L.color);
  if (L.metal !== undefined) m.metalness = L.metal;
  if (L.rough !== undefined) m.roughness = L.rough;
  if (L.env) { m.envMap = studioEnv(); m.envMapIntensity = L.env; }
  const tex = camoTexture(skin);
  if (!tex) return m;
  const uni = { uCamo: { value: tex }, uCamoScale: { value: scale }, uCamoGlow: { value: L.glow || 0 }, uCamoGain: { value: L.norm ? Math.min(6, Math.max(1, L.norm / (tex.userData.meanLum || 0.2))) : (L.gain || 1) } };
  m.userData.camoUniforms = uni;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCamoP;\nvarying vec3 vCamoN;\nuniform float uCamoScale;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCamoP = position * uCamoScale;\nvCamoN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCamoP;\nvarying vec3 vCamoN;\nuniform sampler2D uCamo;\nuniform float uCamoGlow; uniform float uCamoGain;\nvec3 camoCol;')
      .replace('#include <map_fragment>', '#include <map_fragment>\nvec3 cw = pow(abs(normalize(vCamoN)), vec3(4.0)); cw /= (cw.x + cw.y + cw.z);\n' +
        'camoCol = texture2D(uCamo, vCamoP.yz).rgb * cw.x + texture2D(uCamo, vCamoP.xz).rgb * cw.y + texture2D(uCamo, vCamoP.xy).rgb * cw.z;\n' +
        'diffuseColor.rgb *= camoCol * uCamoGain;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' +
        'totalEmissiveRadiance += camoCol * smoothstep(0.6, 0.9, max(camoCol.r, max(camoCol.g, camoCol.b))) * uCamoGlow;');
  };
  m.customProgramCacheKey = () => 'camo-v1';
  return m;
}
