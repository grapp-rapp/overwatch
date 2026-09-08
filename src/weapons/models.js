/* ============================================================================
   Procedural weapon geometry.

   Guns are built in "gun space":  +Z forward (muzzle), +Y up, +X right, with the
   origin at the web of the firing hand (top of the pistol grip). That means the
   same model can be parented straight to a hand bone in third person or to the
   viewmodel rig in first person with only a small offset.

   Each build returns a Group carrying:
     .userData.muzzle     Object3D at the muzzle tip (flash / tracer origin)
     .userData.eject      Object3D at the ejection port (brass origin)
     .userData.slide      Object3D that cycles on fire (bolt / slide / pump)
     .userData.magazine   Object3D that detaches during reload
     .userData.opticEye   Object3D at the sight line — the viewmodel aligns this
                          with the camera axis when you ADS, so every gun's ADS
                          pose is derived from its own geometry, not hand-tuned.
   ========================================================================== */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ---- shared materials (one instance each; guns tint via a cloned base) ---- */
const M = {
  poly:   new THREE.MeshStandardMaterial({ color: 0x2f3335, roughness: 0.72, metalness: 0.08 }),
  steel:  new THREE.MeshStandardMaterial({ color: 0x53585c, roughness: 0.36, metalness: 0.90 }),
  blued:  new THREE.MeshStandardMaterial({ color: 0x1d2022, roughness: 0.42, metalness: 0.80 }),
  dark:   new THREE.MeshStandardMaterial({ color: 0x141617, roughness: 0.62, metalness: 0.35 }),
  wood:   new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.70, metalness: 0.05 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x121314, roughness: 0.95, metalness: 0.0 }),
  brass:  new THREE.MeshStandardMaterial({ color: 0xb08d3f, roughness: 0.30, metalness: 1.0 }),
  glass:  new THREE.MeshStandardMaterial({ color: 0x0a1a24, roughness: 0.08, metalness: 0.2,
            emissive: 0x0e3550, emissiveIntensity: 0.55 }),
  lens:   new THREE.MeshBasicMaterial({ color: 0x8fd6ff, transparent: true, opacity: 0.28 }),
};

/* ---- primitive helpers --------------------------------------------------- */

function roundedRect(w, h, r) {
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4);
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Chamfered slab: cross-section w×h in XY, extruded along Z from z0 to z0+len. */
function slab(w, h, len, r = 0.006, bevel = 0.0035) {
  const g = new THREE.ExtrudeGeometry(roundedRect(w, h, r), {
    depth: len - bevel * 2, bevelEnabled: bevel > 0, bevelSize: bevel,
    bevelThickness: bevel, bevelSegments: 1, curveSegments: 3,
  });
  g.translate(0, 0, bevel);
  return g;
}

/** Cylinder with its axis along Z. */
function tube(r1, r2, len, seg = 12, open = false) {
  const g = new THREE.CylinderGeometry(r1, r2, len, seg, 1, open);
  g.rotateX(Math.PI / 2);
  return g;
}

function box(w, h, d) { return new THREE.BoxGeometry(w, h, d); }

function at(g, x, y, z, rx = 0, ry = 0, rz = 0) {
  if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/** Merge a list of geometries into one mesh with a single material.
 *  ExtrudeGeometry is non-indexed while Box/Cylinder are indexed, so everything
 *  is normalised to non-indexed and stripped to position/normal/uv first. */
export function normalizeGeo(g) {
  const n = g.index ? g.toNonIndexed() : g;
  for (const key of Object.keys(n.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv') n.deleteAttribute(key);
  }
  if (!n.attributes.uv) {
    const count = n.attributes.position.count;
    n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  n.morphAttributes = {};
  return n;
}

function meshOf(geos, mat, name) {
  const valid = geos.filter(Boolean).map(normalizeGeo);
  if (!valid.length) return null;
  const g = valid.length === 1 ? valid[0] : mergeGeometries(valid, false);
  if (!g) { console.warn('weapon merge failed for', name); return null; }
  const m = new THREE.Mesh(g, mat);
  m.name = name || 'part';
  m.castShadow = true; m.receiveShadow = false;
  return m;
}

function marker(name, x, y, z) {
  const o = new THREE.Object3D();
  o.name = name; o.position.set(x, y, z);
  return o;
}

/* ---- reusable sub-assemblies --------------------------------------------- */

/** Picatinny rail on top of a receiver: a strip with slots. */
function railGeo(len, z0, y, w = 0.021) {
  const parts = [at(box(w, 0.006, len), 0, y, z0 + len / 2)];
  const n = Math.max(3, Math.floor(len / 0.022));
  for (let i = 0; i < n; i++) {
    parts.push(at(box(w * 1.18, 0.005, 0.008), 0, y + 0.004, z0 + 0.012 + i * (len - 0.02) / (n - 1 || 1)));
  }
  return parts;
}

/** Pistol grip angled back, with a palm swell. */
function gripGeo(h = 0.115, ang = 0.34, w = 0.032) {
  const parts = [];
  const seg = 5;
  for (let i = 0; i < seg; i++) {
    const t = i / (seg - 1);
    const yy = -0.012 - t * h;
    const zz = -t * h * Math.tan(ang);
    const ww = w * (1 - 0.16 * Math.abs(t - 0.5) * 2) * (1 - t * 0.12);
    const hh = h / seg * 1.5;
    parts.push(at(slab(ww, hh, 0.048, 0.010, 0.002), 0, yy, zz - 0.024));
  }
  return parts;
}

/** Magazine well + magazine body. Returns { well:[geo], magGeo }. */
function magGeo(kind) {
  switch (kind) {
    case 'curved': {
      const parts = [];
      for (let i = 0; i < 6; i++) {
        const t = i / 5;
        parts.push(at(slab(0.026, 0.030, 0.052, 0.006, 0.002),
          0, -0.035 - t * 0.155, 0.010 + t * t * 0.052));
      }
      return parts;
    }
    case 'box':
      return [at(slab(0.062, 0.115, 0.135, 0.010, 0.003), 0, -0.098, 0.028),
              at(box(0.066, 0.012, 0.030), 0, -0.042, 0.028)];
    case 'box5':
      return [at(slab(0.030, 0.062, 0.086, 0.006, 0.002), 0, -0.058, 0.020)];
    case 'stick':
      return [at(slab(0.024, 0.148, 0.040, 0.005, 0.002), 0, -0.086, 0.006)];
    case 'tube':
      return [at(tube(0.0145, 0.0145, 0.46, 10), 0, -0.036, 0.26)];
    case 'cylinder':
      return [at(tube(0.026, 0.026, 0.048, 14), 0, 0.006, 0.028),
              at(tube(0.020, 0.020, 0.052, 6), 0, 0.006, 0.028)];
    default: // stanag
      return [at(slab(0.028, 0.175, 0.048, 0.006, 0.002), 0, -0.100, 0.014, 0.10)];
  }
}

/** Optic: red dot / holo / ACOG / long scope. Returns { geos, lensGeos, eyeZ, eyeY } */
function opticAssembly(kind, zBase, yTop) {
  const g = [], lens = [];
  switch (kind) {
    case 'scope8': {
      const L = 0.30;
      g.push(at(tube(0.023, 0.023, L, 16), 0, yTop + 0.036, zBase + L / 2));
      g.push(at(tube(0.030, 0.030, 0.058, 16), 0, yTop + 0.036, zBase + L - 0.024)); // objective bell
      g.push(at(tube(0.027, 0.027, 0.040, 16), 0, yTop + 0.036, zBase + 0.020));     // ocular
      g.push(at(tube(0.014, 0.014, 0.020, 10), 0, yTop + 0.058, zBase + L * 0.52));  // elevation turret
      g.push(at(tube(0.013, 0.013, 0.019, 10, false), 0.020, yTop + 0.036, zBase + L * 0.52, 0, Math.PI / 2));
      // rings
      g.push(at(tube(0.028, 0.028, 0.014, 12), 0, yTop + 0.036, zBase + 0.072));
      g.push(at(tube(0.028, 0.028, 0.014, 12), 0, yTop + 0.036, zBase + L - 0.070));
      g.push(at(box(0.020, 0.030, 0.014), 0, yTop + 0.014, zBase + 0.072));
      g.push(at(box(0.020, 0.030, 0.014), 0, yTop + 0.014, zBase + L - 0.070));
      lens.push(at(tube(0.027, 0.027, 0.002, 16), 0, yTop + 0.036, zBase + L - 0.050));
      lens.push(at(tube(0.024, 0.024, 0.002, 16), 0, yTop + 0.036, zBase + 0.002));
      return { g, lens, eyeY: yTop + 0.036, eyeZ: zBase };
    }
    case 'acog': {
      const L = 0.155;
      g.push(at(tube(0.019, 0.024, L, 14), 0, yTop + 0.030, zBase + L / 2));
      g.push(at(tube(0.027, 0.027, 0.030, 14), 0, yTop + 0.030, zBase + L - 0.012));
      g.push(at(box(0.030, 0.024, 0.050), 0, yTop + 0.008, zBase + 0.050));
      g.push(at(tube(0.010, 0.010, 0.016, 8), 0, yTop + 0.050, zBase + 0.040));
      lens.push(at(tube(0.024, 0.024, 0.002, 14), 0, yTop + 0.030, zBase + L - 0.020));
      lens.push(at(tube(0.017, 0.017, 0.002, 14), 0, yTop + 0.030, zBase + 0.004));
      return { g, lens, eyeY: yTop + 0.030, eyeZ: zBase };
    }
    case 'holo': {
      g.push(at(slab(0.040, 0.036, 0.072, 0.005, 0.002), 0, yTop + 0.026, zBase + 0.010));
      g.push(at(box(0.044, 0.044, 0.008), 0, yTop + 0.030, zBase + 0.084));
      g.push(at(box(0.006, 0.044, 0.010), 0.019, yTop + 0.030, zBase + 0.080));
      g.push(at(box(0.006, 0.044, 0.010), -0.019, yTop + 0.030, zBase + 0.080));
      lens.push(at(box(0.032, 0.032, 0.002), 0, yTop + 0.030, zBase + 0.082));
      return { g, lens, eyeY: yTop + 0.030, eyeZ: zBase };
    }
    case 'dot': {
      g.push(at(slab(0.030, 0.026, 0.044, 0.005, 0.002), 0, yTop + 0.020, zBase + 0.006));
      g.push(at(tube(0.017, 0.017, 0.036, 12, true), 0, yTop + 0.030, zBase + 0.044));
      g.push(at(box(0.034, 0.008, 0.040), 0, yTop + 0.008, zBase + 0.020));
      lens.push(at(tube(0.0155, 0.0155, 0.002, 12), 0, yTop + 0.030, zBase + 0.044));
      return { g, lens, eyeY: yTop + 0.030, eyeZ: zBase };
    }
    default: { // iron sights
      g.push(at(box(0.004, 0.016, 0.004), 0, yTop + 0.012, zBase + 0.02));
      g.push(at(box(0.020, 0.004, 0.005), 0, yTop + 0.018, zBase + 0.02));
      return { g, lens, eyeY: yTop + 0.013, eyeZ: zBase };
    }
  }
}

function stockGeo(kind, zBack) {
  switch (kind) {
    case 'folding':
      return [at(box(0.014, 0.030, 0.10), 0.026, 0.004, zBack - 0.05),
              at(box(0.038, 0.012, 0.030), 0.026, 0.004, zBack - 0.10)];
    case 'skeleton':
      return [at(box(0.020, 0.014, 0.13), 0, 0.014, zBack - 0.065),
              at(box(0.020, 0.014, 0.13), 0, -0.032, zBack - 0.065, 0.12),
              at(slab(0.038, 0.072, 0.030, 0.008, 0.002), 0, -0.006, zBack - 0.128),
              at(box(0.030, 0.020, 0.050), 0, 0.036, zBack - 0.085)];
    case 'chassis':
      return [at(slab(0.030, 0.062, 0.150, 0.010, 0.003), 0, -0.006, zBack - 0.078),
              at(box(0.034, 0.026, 0.036), 0, -0.040, zBack - 0.150),
              at(box(0.030, 0.058, 0.022), 0, 0.004, zBack - 0.162),
              at(box(0.026, 0.020, 0.058), 0, 0.030, zBack - 0.090)];
    case 'none': return [];
    default: // fixed
      return [at(slab(0.036, 0.062, 0.155, 0.012, 0.003), 0, -0.004, zBack - 0.080),
              at(box(0.040, 0.070, 0.020), 0, -0.008, zBack - 0.160)];
  }
}

/* ---- muzzle devices ------------------------------------------------------ */
function muzzleDevice(kind, r, z) {
  switch (kind) {
    case 'brake':
      return [at(tube(r * 1.85, r * 1.85, 0.048, 12), 0, 0, z + 0.024),
              at(box(r * 4, 0.004, 0.030), 0, r * 1.2, z + 0.026),
              at(box(r * 4, 0.004, 0.030), 0, -r * 1.2, z + 0.026)];
    case 'suppressor':
      return [at(tube(r * 2.6, r * 2.6, 0.135, 14), 0, 0, z + 0.068)];
    case 'flash':
    default:
      return [at(tube(r * 1.7, r * 1.55, 0.040, 10), 0, 0, z + 0.020),
              at(tube(r * 1.2, r * 1.2, 0.012, 10), 0, 0, z + 0.002)];
  }
}

/* ============================================================================
   Main builder
   ========================================================================== */

export function buildWeapon(def) {
  const spec = def.model;
  const grp = new THREE.Group();
  grp.name = 'weapon_' + def.id;

  const polyMat = M.poly.clone();
  polyMat.color = new THREE.Color(spec.tint || 0x2f3335);

  const poly = [], steel = [], blued = [], dark = [], lens = [], rubber = [], accent = [];

  const K = spec.kind;
  const isPistol = K === 'pistol' || K === 'revolver' || K === 'mpistol';

  /* ---------- receiver ---------- */
  let recW = 0.052, recH = 0.072, recZ0 = -0.10, recLen = 0.30;
  if (K === 'smg')     { recW = 0.048; recH = 0.068; recZ0 = -0.085; recLen = 0.245; }
  if (K === 'lmg')     { recW = 0.062; recH = 0.086; recZ0 = -0.115; recLen = 0.375; }
  if (K === 'sniper')  { recW = 0.050; recH = 0.076; recZ0 = -0.115; recLen = 0.400; }
  if (K === 'dmr')     { recW = 0.050; recH = 0.076; recZ0 = -0.105; recLen = 0.335; }
  if (K === 'shotgun') { recW = 0.048; recH = 0.070; recZ0 = -0.095; recLen = 0.280; }
  if (K === 'pistol')  { recW = 0.030; recH = 0.040; recZ0 = -0.030; recLen = 0.175; }
  if (K === 'mpistol') { recW = 0.032; recH = 0.046; recZ0 = -0.035; recLen = 0.215; }
  if (K === 'revolver'){ recW = 0.026; recH = 0.042; recZ0 = -0.032; recLen = 0.100; }

  const yTop = recH / 2 - 0.006;

  poly.push(at(slab(recW, recH, recLen, 0.009, 0.003), 0, 0, recZ0));

  // lower / trigger housing
  if (!isPistol) {
    poly.push(at(slab(recW * 0.92, 0.038, recLen * 0.62, 0.008, 0.002), 0, -recH * 0.52, recZ0 + 0.02));
  }

  /* ---------- grip + trigger guard ---------- */
  const gripH = isPistol ? 0.105 : 0.118;
  poly.push(...gripGeo(gripH, isPistol ? 0.20 : 0.32, isPistol ? 0.030 : 0.033));
  rubber.push(at(slab(isPistol ? 0.032 : 0.035, gripH * 0.72, 0.046, 0.010, 0.001), 0, -0.020 - gripH * 0.40,
    -(gripH * 0.40) * Math.tan(isPistol ? 0.20 : 0.32) - 0.024));
  // trigger guard loop
  {
    const seg = 9, R = 0.026;
    for (let i = 0; i < seg; i++) {
      const a = -Math.PI * 0.10 + (i / (seg - 1)) * Math.PI * 1.20;
      blued.push(at(box(0.007, 0.006, 0.011), 0, -0.028 - Math.sin(a) * R + 0.004, 0.030 + Math.cos(a) * R, 0, 0, 0));
    }
    blued.push(at(box(0.005, 0.020, 0.006), 0, -0.028, 0.030, -0.30));
  }

  /* ---------- barrel + handguard ---------- */
  const bz0 = recZ0 + recLen;
  const bLen = spec.barrel;
  const bR = K === 'shotgun' ? 0.0125 : K === 'sniper' ? 0.0105 : isPistol ? 0.0072 : 0.0090;
  steel.push(at(tube(bR, bR, bLen + 0.03, 12), 0, 0, bz0 + bLen / 2 - 0.01));

  if (!isPistol) {
    if (K === 'shotgun') {
      // heat shield + tube mag
      dark.push(at(tube(0.020, 0.020, bLen * 0.62, 10, true), 0, 0, bz0 + bLen * 0.34));
      poly.push(at(slab(0.036, 0.034, bLen * 0.46, 0.010, 0.002), 0, -0.030, bz0 + 0.03));
    } else if (K === 'sniper') {
      poly.push(at(slab(0.044, 0.046, bLen * 0.72, 0.012, 0.003), 0, -0.006, bz0 - 0.01));
      steel.push(at(box(0.012, 0.010, 0.09), 0, -0.030, bz0 + bLen * 0.62)); // bipod stub
      steel.push(at(box(0.008, 0.052, 0.008), 0.026, -0.058, bz0 + bLen * 0.60, 0, 0, 0.30));
      steel.push(at(box(0.008, 0.052, 0.008), -0.026, -0.058, bz0 + bLen * 0.60, 0, 0, -0.30));
    } else {
      // vented polymer handguard
      const hgLen = bLen * 0.80;
      poly.push(at(slab(0.044, 0.046, hgLen, 0.012, 0.003), 0, 0, bz0 - 0.005));
      const holes = Math.max(2, Math.floor(hgLen / 0.045));
      for (let i = 0; i < holes; i++) {
        const z = bz0 + 0.022 + i * (hgLen - 0.03) / (holes - 1 || 1);
        dark.push(at(tube(0.006, 0.006, 0.050, 8), 0, 0.004, z, 0, Math.PI / 2));
      }
      if (spec.rail) accent.push(...railGeo(hgLen * 0.7, bz0 + 0.01, 0.026, 0.019));
    }
  }
  // muzzle device
  const mdKind = K === 'sniper' ? 'brake' : K === 'lmg' ? 'brake' : K === 'shotgun' ? 'none' : 'flash';
  if (mdKind !== 'none') steel.push(...muzzleDevice(mdKind, bR, bz0 + bLen));

  /* ---------- top rail + optic ---------- */
  const opticKind = def.reticle === 'sniper' ? 'scope8' : def.reticle === 'acog' ? 'acog'
    : def.reticle === 'holo' ? 'holo' : def.reticle === 'dot' ? 'dot' : 'iron';
  if (!isPistol) accent.push(...railGeo(recLen * 0.80, recZ0 + recLen * 0.14, yTop + 0.004, 0.021));
  const opt = opticAssembly(opticKind, recZ0 + recLen * (K === 'sniper' ? 0.10 : 0.22), yTop + (isPistol ? -0.002 : 0.007));
  dark.push(...opt.g); lens.push(...opt.lens);

  /* ---------- magazine ---------- */
  const magParts = magGeo(spec.mag);

  /* ---------- stock ---------- */
  if (!isPistol) poly.push(...stockGeo(spec.stock, recZ0));

  /* ---------- foregrip / bipod details ---------- */
  if (K === 'lmg') {
    poly.push(at(slab(0.028, 0.070, 0.036, 0.008, 0.002), 0, -0.052, bz0 + 0.06));
    steel.push(at(box(0.010, 0.090, 0.010), 0.030, -0.086, bz0 + bLen * 0.55, 0, 0, 0.36));
    steel.push(at(box(0.010, 0.090, 0.010), -0.030, -0.086, bz0 + bLen * 0.55, 0, 0, -0.36));
  }
  if (K === 'smg' || K === 'ar') {
    poly.push(at(slab(0.024, 0.058, 0.030, 0.008, 0.002), 0, -0.048, bz0 + bLen * 0.42));
  }
  if (K === 'revolver') {
    steel.push(at(tube(0.008, 0.008, 0.10, 8), 0, -0.014, bz0 + 0.04)); // ejector rod
    blued.push(at(box(0.012, 0.014, 0.026), 0, 0.026, recZ0 + 0.004)); // hammer
  }

  /* ---------- charging handle / bolt (animated) ---------- */
  const slideGrp = new THREE.Group();
  slideGrp.name = 'slide';
  {
    const s = [];
    if (isPistol && K !== 'revolver') {
      s.push(at(slab(recW * 1.02, recH * 0.52, recLen * 0.96, 0.006, 0.002), 0, recH * 0.24, recZ0 + 0.004));
      for (let i = 0; i < 6; i++) s.push(at(box(0.004, recH * 0.34, 0.0035), recW * 0.51, recH * 0.24, recZ0 + 0.012 + i * 0.010));
      for (let i = 0; i < 6; i++) s.push(at(box(0.004, recH * 0.34, 0.0035), -recW * 0.51, recH * 0.24, recZ0 + 0.012 + i * 0.010));
    } else if (K === 'shotgun') {
      s.push(at(slab(0.040, 0.038, 0.105, 0.010, 0.002), 0, -0.030, bz0 + 0.06)); // pump
      for (let i = 0; i < 7; i++) s.push(at(box(0.042, 0.004, 0.004), 0, -0.048, bz0 + 0.020 + i * 0.013));
    } else if (K === 'sniper') {
      s.push(at(tube(0.008, 0.008, 0.052, 8), 0.030, 0.008, recZ0 + 0.075, 0, 0.30));
      s.push(at(tube(0.013, 0.013, 0.018, 10), 0.046, 0.004, recZ0 + 0.052));
    } else {
      s.push(at(box(0.016, 0.011, 0.038), 0.030, 0.016, recZ0 + recLen * 0.72));
      s.push(at(box(0.030, 0.008, 0.012), 0.036, 0.016, recZ0 + recLen * 0.72));
    }
    const m = meshOf(s, M.steel, 'slideMesh');
    if (m) slideGrp.add(m);
  }

  /* ---------- assemble ---------- */
  const addMesh = (geos, mat, name) => { const m = meshOf(geos, mat, name); if (m) grp.add(m); return m; };
  /* Consolidated draw calls: at gameplay distance blued, dark and rail steel are
     the same black metal, and rubber reads as polymer. Fifteen operators on
     screen turns "one submesh per material" into hundreds of draw calls. */
  addMesh(poly.concat(rubber), polyMat, 'poly');
  addMesh(steel, M.steel, 'steel');
  addMesh(blued.concat(dark, accent), M.blued, 'darkmetal');
  const lensMesh = meshOf(lens, M.glass, 'lens');
  if (lensMesh) { lensMesh.castShadow = false; grp.add(lensMesh); }

  const magGrp = new THREE.Group(); magGrp.name = 'magazine';
  const magMesh = meshOf(magParts, K === 'revolver' ? M.steel : polyMat, 'magMesh');
  if (magMesh) magGrp.add(magMesh);
  grp.add(magGrp);
  grp.add(slideGrp);

  /* ---------- markers ---------- */
  const muzzleZ = bz0 + bLen + (mdKind === 'suppressor' ? 0.135 : mdKind === 'none' ? 0.0 : 0.042);
  const muzzle = marker('muzzle', 0, 0, muzzleZ);
  const eject  = marker('eject', recW * 0.6, recH * 0.16, recZ0 + recLen * 0.62);
  const opticEye = marker('opticEye', 0, opt.eyeY, opt.eyeZ);
  const gripPt = marker('gripPoint', 0, -0.03, 0.01);
  const foreGrip = marker('foreGrip', 0, -0.028, bz0 + bLen * (K === 'sniper' ? 0.40 : 0.44));
  grp.add(muzzle, eject, opticEye, gripPt, foreGrip);

  grp.userData = {
    muzzle, eject, opticEye, foreGrip,
    slide: slideGrp, magazine: magGrp,
    def,
    length: muzzleZ - recZ0,
    slideAxis: (isPistol && K !== 'revolver') ? 'z' : K === 'shotgun' ? 'z' : 'z',
    slideThrow: isPistol ? -0.030 : K === 'shotgun' ? -0.075 : -0.022,
  };

  grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false; } });
  return grp;
}

/* ============================================================================
   Prototype cache.

   buildWeapon() extrudes and merges dozens of primitives — tens of milliseconds
   of work. Calling it on every respawn and every weapon swap put a visible hitch
   in the middle of a firefight. Build each weapon once, then hand out clones:
   Object3D.clone() copies the node hierarchy but SHARES geometry and materials,
   so a clone costs microseconds and adds no GPU memory.
   ========================================================================== */
const PROTOTYPES = new Map();

export function cloneWeapon(def) {
  let proto = PROTOTYPES.get(def.id);
  if (!proto) { proto = buildWeapon(def); PROTOTYPES.set(def.id, proto); }
  const g = proto.clone(true);
  // userData holds references into the prototype's tree; re-bind them to ours
  const byName = new Map();
  g.traverse(o => { if (o.name) byName.set(o.name, o); });
  g.userData = {
    ...proto.userData,
    muzzle: byName.get('muzzle'), eject: byName.get('eject'),
    opticEye: byName.get('opticEye'), foreGrip: byName.get('foreGrip'),
    slide: byName.get('slide'), magazine: byName.get('magazine'),
  };
  return g;
}

/* ---- grenades ------------------------------------------------------------ */
export function buildLethal(def) {
  const g = new THREE.Group();
  g.name = 'lethal_' + def.id;
  if (def.id === 'frag') {
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.037, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0x3c4a34, roughness: 0.78, metalness: 0.25 }));
    body.scale.set(1, 1.18, 1);
    g.add(body);
    const fuse = new THREE.Mesh(tube(0.010, 0.010, 0.022, 8), M.steel);
    fuse.position.set(0, 0.044, 0); fuse.rotation.x = Math.PI / 2; g.add(fuse);
    const lever = new THREE.Mesh(box(0.008, 0.040, 0.006), M.steel);
    lever.position.set(0.017, 0.028, 0); lever.rotation.z = 0.14; g.add(lever);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.010, 0.0022, 5, 10), M.steel);
    ring.position.set(-0.018, 0.040, 0); g.add(ring);
  } else if (def.id === 'semtex') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.048, 0.030),
      new THREE.MeshStandardMaterial({ color: 0x2fa84f, roughness: 0.55, metalness: 0.1,
        emissive: 0x114d22, emissiveIntensity: 0.35 }));
    g.add(body);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.010, 0.032),
      new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.9 }));
    strip.position.y = -0.020; g.add(strip);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.005, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xff3322 }));
    led.position.set(0.026, 0.026, 0.016); g.add(led);
    g.userData.led = led;
  } else {
    const body = new THREE.Mesh(tube(0.026, 0.026, 0.085, 10),
      new THREE.MeshStandardMaterial({ color: 0x6a5a3a, roughness: 0.7, metalness: 0.3 }));
    body.rotation.x = Math.PI / 2; g.add(body);
    const cap = new THREE.Mesh(tube(0.028, 0.020, 0.020, 10), M.steel);
    cap.rotation.x = Math.PI / 2; cap.position.y = 0.050; g.add(cap);
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  return g;
}

export const WEAPON_MATERIALS = M;
