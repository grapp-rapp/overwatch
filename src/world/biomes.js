/* ============================================================================
   Surfaces for the maps beyond Dustline.

   Same pipeline as textures.js - one height field per surface, albedo and
   roughness shaded from it, normals from the height by Sobel - but built only
   when a map that needs them is loaded, so none of it costs anything at boot.
   ========================================================================== */
import * as THREE from 'three';
import { bake, materialFrom, fbm } from './textures.js';
import { clamp } from '../core/util.js';

const GEN = {
  /* forest floor: dark soil, drifts of dead leaves, patches of moss and grass */
  forest: () => bake(256, 0xF0E, (x, y, n, noise, rnd, o) => {
    const u = x / 32, v = y / 32;
    const soil = fbm(noise, u * 2, v * 2, 5), litter = fbm(noise, u * 9 + 7, v * 9 + 3, 3);
    const grass = clamp((fbm(noise, u * 1.3 + 11, v * 1.3 + 5, 4) - 0.46) * 3.2, 0, 1);
    const blade = Math.sin(x * 2.3 + litter * 9) * Math.sin(y * 3.1) > 0.35 ? 1 : 0;
    let r = 58 + soil * 30, g = 46 + soil * 24, b = 32 + soil * 14;
    const lk = clamp((litter - 0.5) * 2.4, 0, 1);
    r += (96 + litter * 50 - r) * lk; g += (66 + litter * 30 - g) * lk; b += (34 + litter * 12 - b) * lk;
    const gk = grass * (0.55 + blade * 0.45);
    r += (58 + litter * 26 - r) * gk; g += (84 + litter * 34 - g) * gk; b += (38 + litter * 10 - b) * gk;
    o.r = r; o.g = g; o.b = b;
    o.h = soil * 0.5 + litter * 0.35 + gk * 0.4;
    o.rough = 0.88 + litter * 0.1;
  }),
  /* granite: a broad tone, fine grain, hairline cracks and lichen */
  rock: () => bake(256, 0x80C, (x, y, n, noise, rnd, o) => {
    const u = x / 40, v = y / 40;
    const base = fbm(noise, u * 3, v * 3, 5), grain = fbm(noise, u * 16, v * 16, 3);
    const crack = Math.abs(fbm(noise, u * 2.4 + 5, v * 2.4 + 9, 4) - 0.5) < 0.018 ? 1 : 0;
    const lichen = clamp((fbm(noise, u * 1.6 + 3, v * 1.6 + 1, 4) - 0.56) * 4, 0, 1);
    const c = 96 + base * 60 + grain * 22 - crack * 50;
    o.r = c + (118 - c) * lichen * 0.6; o.g = c + (128 - c) * lichen * 0.6; o.b = c * 1.03 + (84 - c) * lichen * 0.6;
    o.h = base * 1.2 + grain * 0.35 - crack * 0.8;
    o.rough = 0.82 + grain * 0.12;
  }),
  /* wind-packed snow: soft drifts, faint ripples, the odd glint */
  snow: () => bake(256, 0x5A0, (x, y, n, noise, rnd, o) => {
    const u = x / 36, v = y / 36;
    const drift = fbm(noise, u * 1.6, v * 1.6, 5), grain = fbm(noise, u * 20, v * 20, 2);
    const ripple = Math.sin((x + drift * 60) * 0.18) * 0.5 + 0.5;
    const glint = rnd() > 0.9965 ? 1 : 0;
    const c = 214 + drift * 28 + grain * 8;
    o.r = c * 0.95; o.g = c * 0.98; o.b = Math.min(255, c * 1.05);
    o.h = drift + ripple * 0.18 + grain * 0.12;
    o.rough = 0.64 - glint * 0.5 + grain * 0.14;
  }),
  /* bark: vertical furrows, ridges catching light, moss low on the trunk */
  bark: () => bake(256, 0xBA4, (x, y, n, noise, rnd, o) => {
    const u = x / 18, v = y / 60;
    const furrow = fbm(noise, u * 4, v * 1.2, 4);
    const ridge = Math.pow(Math.abs(Math.sin((x / 256) * Math.PI * 14 + furrow * 5)), 0.6);
    const moss = clamp((fbm(noise, u + 4, v * 3 + 2, 3) - 0.6) * 3, 0, 1);
    const c = 52 + ridge * 44 + furrow * 18;
    o.r = c + (62 - c) * moss; o.g = c * 0.84 + (82 - c * 0.84) * moss; o.b = c * 0.66 + (40 - c * 0.66) * moss;
    o.h = ridge * 1.3 + furrow * 0.3;
    o.rough = 0.9;
  }),
  foliage: () => bake(256, 0xF01, (x, y, n, noise, rnd, o) => {
    const clump = fbm(noise, x / 10, y / 10, 4), leaf = fbm(noise, x / 1.8, y / 1.8, 3);
    const c = 0.55 + clump * 0.5 + leaf * 0.25;
    o.r = 52 * c; o.g = 86 * c; o.b = 36 * c;
    o.h = clump * 0.8 + leaf * 0.6; o.rough = 0.78;
  }),
  pine: () => bake(256, 0x914, (x, y, n, noise, rnd, o) => {
    const needle = fbm(noise, x / 2.3, y / 10, 3), band = fbm(noise, x / 14, y / 8, 3);
    const c = 0.5 + needle * 0.55 + band * 0.2;
    o.r = 30 * c; o.g = 62 * c; o.b = 44 * c;
    o.h = needle * 0.9; o.rough = 0.8;
  }),
  /* log-cabin wall: rounded horizontal logs with chinking between them */
  logwall: () => bake(256, 0x106, (x, y, n, noise, rnd, o) => {
    const row = Math.floor(y / 32), f = (y % 32) / 32, round = Math.sin(f * Math.PI);
    const grain = fbm(noise, x / 7 + row * 13, y / 40, 3);
    let c = 70 + round * 58 + grain * 22 + ((row * 37) % 11) - 5;
    if (f < 0.07 || f > 0.93) c -= 46;
    o.r = c * 1.12; o.g = c * 0.86; o.b = c * 0.6;
    o.h = round * 1.2 + grain * 0.2; o.rough = 0.86;
  }),
  /* heavily rusted plate: seams, run-off streaks, bare steel where it has worn */
  rust: () => bake(256, 0x2A5, (x, y, n, noise, rnd, o) => {
    const u = x / 30, v = y / 30;
    const r0 = fbm(noise, u * 2.4, v * 2.4, 5), pit = fbm(noise, u * 14, v * 14, 3), streak = fbm(noise, u * 0.8, v * 5, 3);
    const seam = (x % 128) < 2 || (y % 128) < 2 ? 1 : 0, bare = clamp((r0 - 0.62) * 3.5, 0, 1);
    let r = 112 + r0 * 60 + streak * 20, g = 60 + r0 * 26 + streak * 6, b = 34 + r0 * 12;
    r += (120 - r) * bare; g += (118 - g) * bare; b += (116 - b) * bare;
    o.r = r - seam * 40; o.g = g - seam * 26; o.b = b - seam * 16;
    o.h = r0 * 0.6 + pit * 0.4 - seam * 0.6;
    o.rough = 0.62 + (1 - bare) * 0.3; o.metal = 0.35 + bare * 0.6;
  }, { metalMap: true }),
  /* catwalk grating: bright bars over a dark void */
  grate: () => bake(256, 0x6A7, (x, y, n, noise, rnd, o) => {
    const bar = (x % 16) < 3 || (y % 64) < 4 ? 1 : 0, grime = fbm(noise, x / 40, y / 40, 4);
    const c = bar ? 120 + grime * 40 : 22 + grime * 14;
    o.r = c; o.g = c * 0.98; o.b = c * 0.95;
    o.h = bar + grime * 0.1; o.rough = bar ? 0.45 : 0.9; o.metal = bar ? 0.9 : 0.2;
  }, { metalMap: true }),
  /* factory brick: staggered courses, per-brick tone, soot */
  brick: () => bake(256, 0xB1C, (x, y, n, noise, rnd, o) => {
    const row = Math.floor(y / 16), xs = x + (row % 2) * 24, xo = xs % 48, yo = y % 16;
    const mortar = xo < 3 || yo < 3, tone = ((Math.floor(xs / 48) * 31 + row * 17) * 97 % 23) / 23;
    const grime = fbm(noise, x / 50, y / 50, 4);
    if (mortar) { o.r = 132 - grime * 50; o.g = 124 - grime * 46; o.b = 112 - grime * 40; }
    else { o.r = 128 + tone * 36 - grime * 40; o.g = 58 + tone * 14 - grime * 20; o.b = 44 + tone * 10 - grime * 14; }
    o.h = mortar ? -0.6 : 0.3 + grime * 0.2; o.rough = 0.9;
  }),
  /* dry-stone wall: rough limestone blocks fitted without mortar, soil in the
     gaps. Cellular, on a grid that wraps, so the wall tiles without a seam. */
  stonewall: () => {
    const CX = 6, CY = 9, cw = 256 / CX, ch = 256 / CY;
    const hsh = (i, j, k) => { let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1274126177); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    return bake(256, 0x57E, (x, y, n, noise, rnd, o) => {
      const gi = Math.floor(x / cw), gj = Math.floor(y / ch);
      let d1 = 1e9, d2 = 1e9, id = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ci = gi + di, cj = gj + dj, wi = ((ci % CX) + CX) % CX, wj = ((cj % CY) + CY) % CY;
        const dx = (x - (ci + 0.2 + 0.6 * hsh(wi, wj, 1)) * cw) / cw, dy = (y - (cj + 0.2 + 0.6 * hsh(wi, wj, 2)) * ch) / ch;
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; id = wj * CX + wi; } else if (d < d2) d2 = d;
      }
      const edge = Math.sqrt(d2) - Math.sqrt(d1), gap = edge < 0.07;
      const t = hsh(id, 3, 7), grey = hsh(id, 5, 9), grain = fbm(noise, x / 6, y / 6, 3);
      const lichen = clamp((fbm(noise, x / 40 + 3, y / 40 + 7, 4) - 0.58) * 4, 0, 1);
      if (gap) { const k = 30 + grain * 26; o.r = k * 1.2; o.g = k; o.b = k * 0.8; o.h = -0.9; o.rough = 0.95; return; }
      const c = 128 + t * 58 + grain * 26;
      o.r = c * (1.04 - grey * 0.1); o.g = c * (0.97 - grey * 0.05); o.b = c * (0.82 + grey * 0.1);
      o.r += (104 - o.r) * lichen * 0.5; o.g += (112 - o.g) * lichen * 0.5; o.b += (80 - o.b) * lichen * 0.5;
      o.h = Math.sqrt(clamp(edge * 5, 0, 1)) * 0.9 + grain * 0.3; o.rough = 0.88;
    });
  },
  /* the rounded cap along the trench walls: pale lime mortar, pitted and streaked */
  capstone: () => bake(256, 0xCA9, (x, y, n, noise, rnd, o) => {
    const u = x / 36, v = y / 36;
    const base = fbm(noise, u * 2, v * 2, 5), pit = fbm(noise, u * 18, v * 18, 2), streak = fbm(noise, u * 0.7, v * 6, 3);
    const lich = clamp((fbm(noise, u * 1.4 + 9, v * 1.4 + 4, 4) - 0.6) * 4, 0, 1), hole = pit > 0.72 ? 1 : 0;
    const c = 172 + base * 42 - hole * 34 - streak * 20;
    o.r = c + (118 - c) * lich * 0.5; o.g = c * 0.97 + (124 - c * 0.97) * lich * 0.5; o.b = c * 0.88 + (90 - c * 0.88) * lich * 0.5;
    o.h = base * 0.6 + pit * 0.3 - hole * 0.4; o.rough = 0.86;
  }),
  /* the hill: short grass worn through to pale soil and pebbles */
  hillside: () => bake(256, 0x417, (x, y, n, noise, rnd, o) => {
    const u = x / 32, v = y / 32;
    const soil = fbm(noise, u * 2.2, v * 2.2, 5), wear = clamp((fbm(noise, u * 1.1 + 5, v * 1.1 + 8, 4) - 0.48) * 3, 0, 1);
    const blade = fbm(noise, x / 1.6, y / 5, 2), peb = rnd() > 0.985 ? 1 : 0, gk = (1 - wear) * (0.6 + blade * 0.5);
    let r = 150 + soil * 40, g = 132 + soil * 34, b = 100 + soil * 26;
    r += (70 + blade * 40 - r) * gk; g += (104 + blade * 44 - g) * gk; b += (48 + blade * 16 - b) * gk;
    if (peb) { r = 188; g = 184; b = 172; }
    o.r = r; o.g = g; o.b = b; o.h = soil * 0.4 + gk * blade * 0.6 + peb * 0.5; o.rough = 0.9;
  }),
};

const OPTS = {
  forest: { normalScale: 1.1 }, rock: { normalScale: 1.3 }, snow: { normalScale: 0.6 },
  bark: { normalScale: 1.4 }, foliage: {}, pine: {}, logwall: { normalScale: 1.2 },
  rust: { metalness: 0.8, normalScale: 1.1 }, grate: { metalness: 0.9, normalScale: 1.2 },
  brick: { normalScale: 1.2 },
  stonewall: { normalScale: 1.5 }, capstone: { normalScale: 0.9 }, hillside: { normalScale: 1.0 },
};
/* not baked: a surface that is its own light source */
const SPECIAL = {
  glow: () => new THREE.MeshStandardMaterial({ color: 0x331100, emissive: 0xff6a1a, emissiveIntensity: 2.2, roughness: 0.6 }),
};

const BAKES = {}, MATS = {};
/** The baked canvases for a surface, shared by every material made from it. */
export function extraBake(key) { return BAKES[key] || (BAKES[key] = GEN[key]()); }

/** Box materials for these surfaces: world-scaled UVs, so repeat stays 1. */
export function buildExtraMaterials(keys) {
  const out = {};
  for (const k of keys) {
    if (!MATS[k]) MATS[k] = SPECIAL[k] ? SPECIAL[k]() : materialFrom(extraBake(k), 1, OPTS[k] || {});
    out[k] = MATS[k];
  }
  return out;
}
