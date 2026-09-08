/* ============================================================================
   Procedural surface textures.

   Everything here is synthesised on a 2D canvas at boot — no image files, so the
   whole material set is CC0 by construction. Each generator returns a height
   field alongside the albedo, and we derive a normal map from it with a Sobel
   filter so surfaces catch the sun properly instead of reading as flat paint.
   ========================================================================== */
import * as THREE from 'three';
import { makeRng, clamp } from '../core/util.js';

/* ---- value noise ---------------------------------------------------------- */
function makeNoise(seed, size = 256) {
  const r = makeRng(seed);
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const S = size;
  const smooth = (t) => t * t * (3 - 2 * t);
  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const i0 = ((xi % S) + S) % S, j0 = ((yi % S) + S) % S;
    const i1 = (i0 + 1) % S, j1 = (j0 + 1) % S;
    const a = g[j0 * S + i0], b = g[j0 * S + i1], c = g[j1 * S + i0], d = g[j1 * S + i1];
    const u = smooth(xf), v = smooth(yf);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

function fbm(noise, x, y, oct = 5, lac = 2.0, gain = 0.5) {
  let s = 0, a = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += a * noise(x * f, y * f); norm += a; a *= gain; f *= lac; }
  return s / norm;
}

/* ---- Sobel height -> tangent-space normal map ----------------------------- */
function normalFromHeight(height, N, strength = 2.4) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(N, N);
  const H = (x, y) => height[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const tl = H(x - 1, y - 1), t = H(x, y - 1), tr = H(x + 1, y - 1);
      const l = H(x - 1, y), rr = H(x + 1, y);
      const bl = H(x - 1, y + 1), b = H(x, y + 1), br = H(x + 1, y + 1);
      const dx = (tr + 2 * rr + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const o = (y * N + x) * 4;
      img.data[o] = (nx * 0.5 + 0.5) * 255;
      img.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[o + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function toTexture(canvas, repeat, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Build an albedo+normal+roughness set from a per-pixel shader function. */
function bake(N, seed, shade, bakeOpts = {}) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(N, N);
  const rcv = document.createElement('canvas');
  rcv.width = rcv.height = N;
  const rctx = rcv.getContext('2d');
  const rimg = rctx.createImageData(N, N);
  const height = new Float32Array(N * N);
  const noise = makeNoise(seed);
  const rnd = makeRng(seed ^ 0x1234);
  const out = { r: 0, g: 0, b: 0, h: 0, rough: 0.8, metal: 0 };
  /* Rust and worn paint are dielectric; bare and painted steel are not. Without
     a metalness map the whole panel answers light identically and corrosion
     reads as a printed decal rather than as corrosion. */
  const wantMetal = !!bakeOpts.metalMap;
  let mcv = null, mctx = null, mimg = null;
  if (wantMetal) {
    mcv = document.createElement('canvas');
    mcv.width = mcv.height = N;
    mctx = mcv.getContext('2d');
    mimg = mctx.createImageData(N, N);
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      shade(x, y, N, noise, rnd, out);
      const o = (y * N + x) * 4;
      img.data[o] = clamp(out.r, 0, 255); img.data[o + 1] = clamp(out.g, 0, 255);
      img.data[o + 2] = clamp(out.b, 0, 255); img.data[o + 3] = 255;
      const rv = clamp(out.rough * 255, 0, 255);
      rimg.data[o] = rv; rimg.data[o + 1] = rv; rimg.data[o + 2] = rv; rimg.data[o + 3] = 255;
      height[y * N + x] = out.h;
      if (wantMetal) {
        const mv = clamp(out.metal * 255, 0, 255);
        mimg.data[o] = mv; mimg.data[o + 1] = mv; mimg.data[o + 2] = mv; mimg.data[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  if (wantMetal) mctx.putImageData(mimg, 0, 0);
  return { albedo: cv, rough: rcv, metal: mcv, height, N };
}

function materialFrom(baked, repeat, opts = {}) {
  /* Several materials share one bake — the container panel is reused tinted three
     ways, and again rotated for drums. The Sobel pass is the expensive part, so
     cache the normal canvas on the bake instead of recomputing it per tint. */
  const strength = opts.normalStrength ?? 2.4;
  baked._nrm = baked._nrm || {};
  const nrm = baked._nrm[strength] ||
    (baked._nrm[strength] = normalFromHeight(baked.height, baked.N, strength));
  const m = new THREE.MeshStandardMaterial({
    map: toTexture(baked.albedo, repeat, true),
    normalMap: toTexture(nrm, repeat, false),
    roughnessMap: toTexture(baked.rough, repeat, false),
    metalnessMap: baked.metal ? toTexture(baked.metal, repeat, false) : null,
    roughness: 1.0,
    metalness: opts.metalness ?? 0.0,
    color: opts.color ?? 0xffffff,
  });
  m.normalScale.set(opts.normalScale ?? 1.0, opts.normalScale ?? 1.0);
  /* Drums are the same corrugated panel turned a quarter turn, so the ribs run
     round the barrel rather than down it. */
  if (opts.rotate) {
    for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap]) {
      if (!t) continue;
      t.center.set(0.5, 0.5);
      t.rotation = opts.rotate;
    }
  }
  return m;
}

/* ---- individual surfaces -------------------------------------------------- */

function asphalt(N = 256) {
  return bake(N, 0xA5F, (x, y, n, noise, rnd, o) => {
    const u = x / 16, v = y / 16;
    const grain = fbm(noise, u * 3.2, v * 3.2, 5);
    const patch = fbm(noise, u * 0.35, v * 0.35, 3);
    const spec = noise(x * 0.9, y * 0.9);
    let base = 40 + grain * 34 + patch * 16;
    // aggregate stones
    const stone = noise(x * 0.55 + 11, y * 0.55 + 7);
    if (stone > 0.86) base += 46 * (stone - 0.86) / 0.14;
    // cracks: thin dark ridges from a warped fbm
    const cr = Math.abs(fbm(noise, u * 1.1 + 30, v * 1.1 + 12, 4) - 0.5);
    const crack = cr < 0.018 ? (1 - cr / 0.018) : 0;
    base -= crack * 26;
    o.r = base * 1.00; o.g = base * 1.02; o.b = base * 1.00;
    o.h = grain * 0.5 + (stone > 0.86 ? 0.4 : 0) - crack * 0.9;
    o.rough = 0.82 + spec * 0.14 - crack * 0.1;
  });
}

function concrete(N = 256) {
  return bake(N, 0xC0C, (x, y, n, noise, rnd, o) => {
    const u = x / 20, v = y / 20;
    const grain = fbm(noise, u * 4.0, v * 4.0, 5);
    const blotch = fbm(noise, u * 0.5, v * 0.5, 3);
    const stain = fbm(noise, u * 0.22 + 5, v * 1.4 + 3, 3);
    let base = 96 + grain * 30 + blotch * 26 - Math.max(0, stain - 0.55) * 46;
    // form-board seams every 64px
    const seam = (y % 64 < 1.6) || (x % 128 < 1.4) ? 1 : 0;
    base -= seam * 22;
    // pinholes
    const ph = noise(x * 1.7 + 3, y * 1.7 + 9);
    if (ph > 0.93) base -= 30;
    o.r = base * 1.00; o.g = base * 0.995; o.b = base * 0.96;
    o.h = grain * 0.42 - seam * 0.8 - (ph > 0.93 ? 0.6 : 0);
    o.rough = 0.88 + grain * 0.10;
  });
}

function plasterWall(N = 256) {
  return bake(N, 0x9B7, (x, y, n, noise, rnd, o) => {
    const u = x / 22, v = y / 22;
    const grain = fbm(noise, u * 5.0, v * 5.0, 5);
    const wear = fbm(noise, u * 0.6, v * 0.6, 4);
    const chip = noise(x * 0.35 + 21, y * 0.35 + 4);
    let base = 138 + grain * 26 + wear * 22;
    let tint = 1.0;
    if (chip > 0.72) { base -= (chip - 0.72) * 190; tint = 0.90; } // exposed brick/block
    const drip = Math.max(0, fbm(noise, u * 0.4 + 8, v * 3.5, 3) - 0.58);
    base -= drip * 60;
    o.r = base * 1.02 * tint; o.g = base * 0.97 * tint; o.b = base * 0.86 * tint;
    o.h = grain * 0.4 - (chip > 0.72 ? 0.7 : 0) - drip * 0.3;
    o.rough = 0.90 + grain * 0.08;
  });
}

function dirt(N = 256) {
  return bake(N, 0xD17, (x, y, n, noise, rnd, o) => {
    const u = x / 14, v = y / 14;
    const grain = fbm(noise, u * 5.5, v * 5.5, 5);
    const dune = fbm(noise, u * 0.6, v * 0.6, 3);
    const peb = noise(x * 0.8 + 17, y * 0.8 + 2);
    let base = 96 + grain * 42 + dune * 30;
    if (peb > 0.88) base += 34;
    o.r = base * 1.14; o.g = base * 0.98; o.b = base * 0.72;
    o.h = grain * 0.5 + dune * 0.3 + (peb > 0.88 ? 0.5 : 0);
    o.rough = 0.94 + grain * 0.05;
  });
}

function metalPanel(N = 256) {
  return bake(N, 0x3E7, (x, y, n, noise, rnd, o) => {
    const u = x / 24, v = y / 24;
    const grain = fbm(noise, u * 6, v * 6, 4);
    const rust = fbm(noise, u * 0.9 + 4, v * 0.9 + 9, 4);
    let base = 92 + grain * 20;
    let r = base, g = base, b = base;
    const rustAmt = Math.max(0, rust - 0.52) / 0.48;
    r = base + rustAmt * 86; g = base + rustAmt * 22; b = base - rustAmt * 34;
    // rivets on a grid
    const gx = (x % 32) - 16, gy = (y % 32) - 16;
    const d = Math.hypot(gx, gy);
    const rivet = d < 3 ? 1 - d / 3 : 0;
    r += rivet * 26; g += rivet * 26; b += rivet * 26;
    o.r = r; o.g = g; o.b = b;
    o.h = grain * 0.25 + rivet * 1.2 - rustAmt * 0.3;
    o.rough = 0.40 + rustAmt * 0.52 + grain * 0.06;
  });
}

function woodPlank(N = 256) {
  return bake(N, 0x77D, (x, y, n, noise, rnd, o) => {
    const plankH = 32;
    const pi = Math.floor(y / plankH);
    const off = (pi * 97) % 256;
    const u = (x + off) / 10, v = y / 40;
    const rings = fbm(noise, u * 1.1, v * 9.0, 4);
    const grain = fbm(noise, u * 8, v * 26, 3);
    let base = 92 + rings * 52 + grain * 16 + ((pi * 53) % 17) - 8;
    const gap = (y % plankH) < 1.5 ? 1 : 0;
    base -= gap * 52;
    o.r = base * 1.16; o.g = base * 0.90; o.b = base * 0.62;
    o.h = rings * 0.4 + grain * 0.2 - gap * 1.0;
    o.rough = 0.86 + grain * 0.10;
  });
}

function roofTile(N = 256) {
  return bake(N, 0x4B2, (x, y, n, noise, rnd, o) => {
    const u = x / 18, v = y / 18;
    const grain = fbm(noise, u * 5, v * 5, 4);
    const seam = ((x + (Math.floor(y / 24) % 2) * 24) % 48) < 2 || (y % 24) < 2 ? 1 : 0;
    let base = 68 + grain * 26 - seam * 20;
    o.r = base * 1.05; o.g = base * 0.98; o.b = base * 0.92;
    o.h = grain * 0.3 - seam * 0.9;
    o.rough = 0.90;
  });
}

/* ---- sky + environment ---------------------------------------------------- */
export function makeSkyTexture() {
  const N = 512;
  const cv = document.createElement('canvas');
  cv.width = N; cv.height = N;
  const ctx = cv.getContext('2d');
  const noise = makeNoise(0x5C1);
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    // equirect: y=0 is up
    const th = (y / N) * Math.PI;
    const up = Math.cos(th);
    for (let x = 0; x < N; x++) {
      const t = clamp(up * 0.5 + 0.5, 0, 1);
      // hazy desert dusk gradient
      let r = 120 + (1 - t) * 96, g = 138 + (1 - t) * 66, b = 158 + (1 - t) * 18;
      if (up < 0) { const k = clamp(-up * 2.2, 0, 1); r = r * (1 - k) + 62 * k; g = g * (1 - k) + 56 * k; b = b * (1 - k) + 48 * k; }
      const cl = fbm(noise, x / N * 6, y / N * 6, 4);
      const cloud = clamp((cl - 0.48) * 3.2, 0, 1) * clamp(up * 2.4, 0, 1);
      r = r * (1 - cloud) + 214 * cloud; g = g * (1 - cloud) + 206 * cloud; b = b * (1 - cloud) + 196 * cloud;
      const o = (y * N + x) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft radial blob used for muzzle flash, blood mist and the contact shadow. */
export function makeBlobTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', N = 128) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  g.addColorStop(0, inner); g.addColorStop(0.45, inner.replace(/[\d.]+\)$/, '0.55)')); g.addColorStop(1, outer);
  ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Star-shaped muzzle flash sprite. */
export function makeFlashTexture(N = 128) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d');
  ctx.translate(N / 2, N / 2);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, N * 0.34);
  g.addColorStop(0, 'rgba(255,250,220,1)');
  g.addColorStop(0.35, 'rgba(255,196,90,0.85)');
  g.addColorStop(1, 'rgba(255,120,30,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, N * 0.34, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.4;
    const len = N * (0.30 + (i % 3) * 0.09);
    ctx.save(); ctx.rotate(a);
    const lg = ctx.createLinearGradient(0, 0, len, 0);
    lg.addColorStop(0, 'rgba(255,240,200,0.95)');
    lg.addColorStop(1, 'rgba(255,150,40,0)');
    ctx.fillStyle = lg;
    ctx.beginPath(); ctx.moveTo(0, -N * 0.035); ctx.lineTo(len, 0); ctx.lineTo(0, N * 0.035); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Bullet-hole decal with a bright rim and radial cracks. */
export function makeImpactTexture(N = 64) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d');
  ctx.translate(N / 2, N / 2);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, N / 2);
  g.addColorStop(0, 'rgba(8,8,8,0.95)');
  g.addColorStop(0.30, 'rgba(20,18,16,0.80)');
  g.addColorStop(0.55, 'rgba(120,112,100,0.35)');
  g.addColorStop(1, 'rgba(140,130,116,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, N / 2, 0, Math.PI * 2); ctx.fill();
  const r = makeRng(0x1e2);
  ctx.strokeStyle = 'rgba(190,180,166,0.35)';
  for (let i = 0; i < 9; i++) {
    ctx.lineWidth = r.range(0.5, 1.4);
    const a = r() * Math.PI * 2, L = r.range(N * 0.16, N * 0.44);
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * N * 0.10, Math.sin(a) * N * 0.10);
    ctx.lineTo(Math.cos(a) * L, Math.sin(a) * L); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* Corrugated shipping-container / vehicle panel.

   The map's crates, containers, barrels and the wrecked truck used to be flat
   untextured colour, which put half a dozen plastic-looking blocks next to
   walls that had real surface detail. This is the same family of steel as the
   warehouse cladding: trapezoidal ribs, rivet lines, paint worn through on the
   crest of every rib because that is what everything scrapes against, and rust
   blooming out of the wear. Baked bright and near-neutral so the per-crate
   colour tint multiplies over it cleanly. */
function containerSteel(N = 256) {
  return bake(N, 0x5C1, (x, y, n, noise, rnd, o) => {
    const u = x / 24, v = y / 24;
    /* Trapezoidal corrugation on a 32 px pitch — 0.25 m at the 2 m tile, which
       is close to the real thing. The profile is what sells it: a wide flat
       crest, short steep flanks, a wide valley. Shading the valley down and the
       crest up gives the panel its read at a distance, where the normal map is
       already mip-filtered away. */
    const p = (x % 32) / 32;
    const rib = p < 0.10 ? 0.5 - 0.5 * Math.cos(Math.PI * (p / 0.10))
              : p < 0.44 ? 1
              : p < 0.56 ? 0.5 + 0.5 * Math.cos(Math.PI * ((p - 0.44) / 0.12))
              : 0;
    const grain = fbm(noise, u * 7, v * 7, 4);
    const wear = fbm(noise, u * 1.2 + 3, v * 1.2 + 7, 4);
    const rustN = fbm(noise, u * 0.6 + 11, v * 0.6 + 2, 4);
    // paint goes first on the crests, because that is what everything scrapes
    const bare = clamp(Math.max(0, wear - 0.64) / 0.36 * (0.25 + rib * 0.95), 0, 1);
    const rust = clamp(Math.max(0, rustN - 0.66) / 0.34, 0, 1) * (0.30 + bare * 0.80);
    /* One rail per 128 px (1 m). An earlier pass put a riveted seam every 0.5 m
       and the whole container read as wire mesh rather than as steel. */
    const sy = Math.abs((y % 128) - 64);
    const seam = sy < 1.2 ? 1 : 0;
    const rv = sy < 2.4 && Math.hypot((x % 32) - 16, sy) < 1.7 ? 1 : 0;

    /* Only a hint of the corrugation goes into the albedo; the normal map does
       the shading. Baking the full crest-to-valley contrast in made the panel
       read as a grille, and it stayed a grille when the sun moved. */
    let base = 178 + grain * 24 - (1 - rib) * 15 + rv * 8;
    let r = base, g = base, b = base;
    const steel = 162 + grain * 22;
    r += (steel - r) * bare; g += (steel + 2 - g) * bare; b += (steel + 6 - b) * bare;
    r += (116 - r) * rust; g += (62 - g) * rust; b += (36 - b) * rust;
    o.r = r; o.g = g; o.b = b;
    o.h = rib * 1.55 + grain * 0.14 + rv * 0.40 - seam * 0.22 - rust * 0.18;
    /* Matched to the warehouse cladding (which already reads right) rather than
       to a showroom finish: at 0.32 the rib crests threw a hard sparkle that
       crawled across the panel as the sun moved. */
    o.rough = 0.44 + rust * 0.44 + (1 - rib) * 0.05 + grain * 0.05;
    o.metal = 0.96 - rust * 0.84;
  }, { metalMap: true });
}

/* Sandbags. Deliberately not metal — but it was flat colour, which is what made
   it read as plastic. Woven hessian over lumpy, overfilled bags with the seam
   between them pressed in. */
function burlap(N = 256) {
  return bake(N, 0x8B4, (x, y, n, noise, rnd, o) => {
    const u = x / 24, v = y / 24;
    // one bag per 64 x 32 cell, courses offset like real stacking
    const row = Math.floor(y / 32);
    const xo = x + (row % 2) * 32;
    const bag = Math.floor(xo / 64) * 31 + row * 17;
    const lx = ((xo % 64) / 64) * 2 - 1, ly = ((y % 32) / 32) * 2 - 1;
    const bulge = Math.max(0, 1 - (lx * lx * 0.88 + ly * ly * 1.0));
    const seam = Math.max(Math.abs(lx) > 0.94 ? 1 : 0, Math.abs(ly) > 0.92 ? 1 : 0);
    const weave = (Math.sin(x * 1.55) * 0.5 + 0.5) * (Math.sin(y * 1.55) * 0.5 + 0.5);
    const grain = fbm(noise, u * 9, v * 9, 4);
    const dust = fbm(noise, u * 1.4 + 5, v * 1.4 + 1, 3);
    let base = 132 + bulge * 30 + grain * 26 + weave * 12 - seam * 46
             + ((bag * 53) % 15) - 7 + dust * 14;
    o.r = base * 1.07; o.g = base * 0.96; o.b = base * 0.70;
    o.h = bulge * 0.95 - seam * 1.25 + weave * 0.12 + grain * 0.14;
    o.rough = 0.92 + grain * 0.07;
  });
}

/* ---- public build --------------------------------------------------------- */
let CACHE = null;
export function buildMaterials() {
  if (CACHE) return CACHE;
  const asp = asphalt(), con = concrete(), pla = plasterWall(), dir = dirt(),
        met = metalPanel(), wod = woodPlank(), rof = roofTile(),
        ctr = containerSteel(), bur = burlap();
  /* Painted steel, not paint. The tints are pre-divided by the panel's mean
     albedo so the crates land on the colours the map was laid out with, and
     the metalness matches the warehouse cladding (0.72) so a container beside
     a metal wall answers the sun the same way. */
  const painted = (color) => materialFrom(ctr, 1, { color, metalness: 0.72, normalScale: 1.10 });
  const drum = (color) => materialFrom(ctr, 1,
    { color, metalness: 0.72, normalScale: 0.95, rotate: Math.PI / 2 });
  CACHE = {
    asphalt:  materialFrom(asp, 14, { normalScale: 0.9 }),
    concrete: materialFrom(con, 3.0, { normalScale: 0.8 }),
    plaster:  materialFrom(pla, 2.4, { normalScale: 0.9 }),
    dirt:     materialFrom(dir, 12, { normalScale: 1.0 }),
    metal:    materialFrom(met, 2.0, { metalness: 0.72, normalScale: 0.9 }),
    wood:     materialFrom(wod, 2.6, { normalScale: 0.85 }),
    roof:     materialFrom(rof, 4.0, { normalScale: 0.8 }),
    sandbag:  materialFrom(bur, 1, { normalScale: 1.25 }),
    // containers, crates and the truck cab
    paintA:   painted(0x5ea270),
    paintB:   painted(0xbc5843),
    paintC:   painted(0x437096),
    // fuel drums: the same panel a quarter turn round, so the ribs hoop it
    drumA:    drum(0x8c9096),
    drumB:    drum(0xb06a3c),
    // untextured helpers
    glass:    new THREE.MeshStandardMaterial({ color: 0x6e8b93, roughness: 0.08, metalness: 0.5,
                transparent: true, opacity: 0.30, side: THREE.DoubleSide }),
    // tyres: the asphalt bake is already dark pebbled rubber, tinted down
    rubber:   materialFrom(asp, 1, { color: 0x2a2b2e, normalScale: 1.3 }),
  };
  // metal panels are used at container scale — stretch the repeat
  CACHE.metal.map.repeat.set(3, 1.2);
  CACHE.metal.normalMap.repeat.set(3, 1.2);
  CACHE.metal.roughnessMap.repeat.set(3, 1.2);
  return CACHE;
}

export const SURFACE_KIND = {
  asphalt: 'concrete', concrete: 'concrete', plaster: 'concrete', roof: 'concrete',
  dirt: 'dirt', metal: 'metal', wood: 'wood', sandbag: 'dirt',
  glass: 'glass', rubber: 'dirt', paintA: 'metal', paintB: 'metal', paintC: 'metal',
  drumA: 'metal', drumB: 'metal',
};
