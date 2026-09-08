const fs = require('fs');
const p = 'src/world/textures.js';
let s = fs.readFileSync(p, 'utf8');
const once = (a) => { if (s.split(a).length !== 2) throw new Error('anchor: ' + a.slice(0, 48)); };

/* --- 1. bake(): optional metalness channel ------------------------------- */
const bakeOld = `function bake(N, seed, shade) {`;
once(bakeOld);
s = s.replace(bakeOld, `function bake(N, seed, shade, bakeOpts = {}) {`);

const outOld = `  const out = { r: 0, g: 0, b: 0, h: 0, rough: 0.8 };`;
once(outOld);
s = s.replace(outOld, `  const out = { r: 0, g: 0, b: 0, h: 0, rough: 0.8, metal: 0 };
  /* Rust and worn paint are dielectric; bare and painted steel are not. Without
     a metalness map the whole panel responds to light identically and the rust
     reads as a printed decal rather than as corrosion. */
  const wantMetal = !!bakeOpts.metalMap;
  let mcv = null, mctx = null, mimg = null;
  if (wantMetal) {
    mcv = document.createElement('canvas');
    mcv.width = mcv.height = N;
    mctx = mcv.getContext('2d');
    mimg = mctx.createImageData(N, N);
  }`);

const loopOld = `      height[y * N + x] = out.h;`;
once(loopOld);
s = s.replace(loopOld, `      height[y * N + x] = out.h;
      if (wantMetal) {
        const mv = clamp(out.metal * 255, 0, 255);
        mimg.data[o] = mv; mimg.data[o + 1] = mv; mimg.data[o + 2] = mv; mimg.data[o + 3] = 255;
      }`);

const retOld = `  rctx.putImageData(rimg, 0, 0);
  return { albedo: cv, rough: rcv, height, N };`;
once(retOld);
s = s.replace(retOld, `  rctx.putImageData(rimg, 0, 0);
  if (wantMetal) mctx.putImageData(mimg, 0, 0);
  return { albedo: cv, rough: rcv, metal: mcv, height, N };`);

/* --- 2. materialFrom(): metalness map, texture rotation, normal cache ----- */
const mfOld = `function materialFrom(baked, repeat, opts = {}) {
  const nrm = normalFromHeight(baked.height, baked.N, opts.normalStrength ?? 2.4);
  const m = new THREE.MeshStandardMaterial({
    map: toTexture(baked.albedo, repeat, true),
    normalMap: toTexture(nrm, repeat, false),
    roughnessMap: toTexture(baked.rough, repeat, false),
    roughness: 1.0,
    metalness: opts.metalness ?? 0.0,
    color: opts.color ?? 0xffffff,
  });
  m.normalScale.set(opts.normalScale ?? 1.0, opts.normalScale ?? 1.0);
  return m;
}`;
once(mfOld);
s = s.replace(mfOld, `function materialFrom(baked, repeat, opts = {}) {
  /* Several materials share one bake (the container panel is reused tinted three
     ways, and again rotated for drums). The Sobel pass is the expensive part, so
     cache the normal canvas on the bake rather than recomputing it per tint. */
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
     round the barrel instead of down it. */
  if (opts.rotate) {
    for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap]) {
      if (!t) continue;
      t.center.set(0.5, 0.5);
      t.rotation = opts.rotate;
    }
  }
  return m;
}`);
fs.writeFileSync(p, s);
console.log('textures.js: bake + materialFrom patched');
