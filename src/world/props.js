/* ============================================================================
   Instanced props: trees, rocks, logs, tanks, domes, pipes.

   The map is axis-aligned boxes because boxes are what collision, bullets,
   line of sight and the navmesh all agree on. A forest cannot be drawn with
   them. So a prop is two things: a box for all of those systems (usually
   invisible), and a shape for the eye, drawn as one InstancedMesh per part per
   kind - a hundred trees is two draw calls, not two hundred.

   Every shape is authored at unit size and placed with a per-instance
   position, Y rotation and scale, so a rock's mesh is scaled to exactly the box
   that stops you.
   ========================================================================== */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { materialFrom } from './textures.js';
import { extraBake } from './biomes.js';
import { makeRng } from '../core/util.js';

let LIB = null;

/* displace vertices by a smooth field so a primitive reads as organic; coincident
   vertices get the same displacement, so nothing cracks open */
function lumpy(geo, amt, seed) {
  const r = makeRng(seed), p = geo.attributes.position, v = new THREE.Vector3();
  const f = [r.range(1.5, 3), r.range(1.5, 3), r.range(1.5, 3), r() * 6, r() * 6, r() * 6];
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + amt * Math.sin(v.x * f[0] + f[3]) * Math.sin(v.y * f[1] + f[4]) * Math.sin(v.z * f[2] + f[5]);
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  geo.computeVertexNormals();
  return geo;
}
const flat = (g) => (g.index ? g.toNonIndexed() : g);
const merge = (list) => mergeGeometries(list.map(flat), false);
const cyl = (rt, rb, h, seg, y, open) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, !!open); g.translate(0, y + h / 2, 0); return g; };
const cone = (r, h, seg, y) => { const g = new THREE.ConeGeometry(r, h, seg, 1); g.translate(0, y + h / 2, 0); return g; };

function materials() {
  const m = (key, rep, o) => materialFrom(extraBake(key), rep, o);
  /* Foliage covers more of the screen than anything else in the woods, several
     layers deep. A Lambert material with the albedo alone costs a fraction of
     the full standard one with normal and roughness maps, and at the distance
     a canopy is seen from the difference does not show. */
  const lam = (key, rep) => {
    const t = new THREE.CanvasTexture(extraBake(key).albedo);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return new THREE.MeshLambertMaterial({ map: t });
  };
  const bark = m('bark', 1, { normalScale: 1.4 });
  for (const t of [bark.map, bark.normalMap, bark.roughnessMap]) t.repeat.set(2, 5);
  return {
    bark, leaf: lam('foliage', 2), pine: lam('pine', 2),
    rock: m('rock', 1, { normalScale: 1.3 }), rust: m('rust', 2, { metalness: 0.8 }),
    snow: m('snow', 1, { normalScale: 0.6 }), snowy: lam('snow', 2),
    white: new THREE.MeshStandardMaterial({ color: 0xe6eaec, roughness: 0.42, metalness: 0.3 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x6d7479, roughness: 0.4, metalness: 0.85 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffd9a0, emissiveIntensity: 3 }),
  };
}

function build() {
  const M = materials(), L = {};
  /* pine, 9.5 m at scale 1: a bare trunk to 3 m, then five skirts of needles.
     The first version started the skirts at 1.9 m - head height - and every
     view in the woods had a dark cone pressed into the top of it. */
  const pTrunk = cyl(0.10, 0.22, 8.6, 7, 0);
  const pCones = lumpy(merge([cone(1.75, 2.4, 9, 3.1), cone(1.45, 2.2, 9, 4.4), cone(1.15, 2.0, 9, 5.6),
    cone(0.8, 1.8, 8, 6.8), cone(0.45, 1.5, 7, 8.0)]), 0.08, 11);
  L.pine = [{ geo: pTrunk, mat: M.bark, shadow: true }, { geo: pCones, mat: M.pine, shadow: true }];
  L.pineSnow = [{ geo: pTrunk, mat: M.bark, shadow: true }, { geo: pCones, mat: M.snowy, shadow: true }];
  /* broadleaf: a trunk with one bough, under a split crown of lumpy spheres */
  const cr = makeRng(0xC20), crown = [];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.IcosahedronGeometry(cr.range(1.3, 1.9), 1);
    const a = i / 5 * Math.PI * 2 + cr() * 0.5, d = i === 0 ? 0 : cr.range(0.8, 1.3);
    g.translate(Math.cos(a) * d, 4.6 + cr.range(-0.4, 0.9), Math.sin(a) * d);
    crown.push(g);
  }
  const bough = cyl(0.06, 0.12, 2.2, 5, 0); bough.rotateZ(0.7); bough.translate(0.5, 2.8, 0);
  L.oak = [
    { geo: merge([cyl(0.16, 0.30, 4.4, 8, 0), bough]), mat: M.bark, shadow: true },
    { geo: lumpy(mergeVertices(merge(crown)), 0.12, 21), mat: M.leaf, shadow: true },
  ];
  /* rock, normalised to x,z in [-0.5, 0.5] and y in [0, 1]: scale = its box */
  const rk = lumpy(new THREE.IcosahedronGeometry(0.5, 1), 0.18, 31);
  rk.computeBoundingBox();
  const bb = rk.boundingBox;
  rk.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  rk.scale(1 / (bb.max.x - bb.min.x), 1 / (bb.max.y - bb.min.y), 1 / (bb.max.z - bb.min.z));
  rk.computeVertexNormals();
  L.rock = [{ geo: rk, mat: M.rock, shadow: true }];
  L.snowrock = [{ geo: rk, mat: M.snow, shadow: true }];
  /* log along X: unit length and diameter, lying on y = 0 */
  const lg = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1); lg.rotateZ(Math.PI / 2); lg.translate(0, 0.5, 0);
  L.log = [{ geo: lg, mat: M.bark, shadow: true }];
  L.stump = [{ geo: cyl(0.28, 0.34, 0.5, 9, 0), mat: M.bark, shadow: true }];
  const br = makeRng(0xB05), bush = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.IcosahedronGeometry(br.range(0.35, 0.5), 0);   // 20 faces: a bush is seen at knee height
    g.translate(br.range(-0.3, 0.3), 0.3, br.range(-0.3, 0.3)); bush.push(g);
  }
  L.bush = [{ geo: lumpy(mergeVertices(merge(bush)), 0.15, 41), mat: M.leaf, shadow: false }];
  /* tank: radius 0.5, height 1 with a shallow domed top */
  const lid = new THREE.SphereGeometry(0.5, 20, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  lid.scale(1, 0.16, 1); lid.translate(0, 0.92, 0);
  const tk = merge([cyl(0.5, 0.5, 0.92, 20, 0), lid]);
  L.tank = [{ geo: tk, mat: M.white, shadow: true }];
  L.tankRust = [{ geo: tk, mat: M.rust, shadow: true }];
  const dm = new THREE.IcosahedronGeometry(0.5, 3); dm.translate(0, 0.35, 0);
  L.dome = [{ geo: dm, mat: M.white, shadow: true }];
  const pp = new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1, true); pp.rotateZ(Math.PI / 2); pp.translate(0, 0.5, 0);
  L.pipe = [{ geo: pp, mat: M.steel, shadow: true }];
  L.pipeV = [{ geo: cyl(0.5, 0.5, 1, 12, 0, true), mat: M.steel, shadow: true }];
  L.stack = [{ geo: cyl(0.5, 0.5, 1, 16, 0), mat: M.rust, shadow: true }];
  const bulb = new THREE.SphereGeometry(0.16, 10, 6); bulb.translate(0, 3.25, 0);
  L.lamp = [{ geo: cyl(0.05, 0.07, 3.2, 6, 0), mat: M.steel, shadow: true }, { geo: bulb, mat: M.lamp, shadow: false }];
  return L;
}

/**
 * InstancedMeshes from the builder's instance list, batched by kind and by map
 * quadrant, so a batch wholly behind the camera is culled - one batch per kind
 * covering the whole map was always "visible" and drew every tree every frame.
 * Anything beyond the map's edge goes in its own batch that casts no shadow:
 * the shadow map only ever covers the ground around the player.
 */
export function buildInstances(insts, bounds) {
  if (!LIB) LIB = build();
  const g = new THREE.Group(); g.name = 'props';
  const hw = bounds ? bounds.halfW : Infinity, hd = bounds ? bounds.halfD : Infinity;
  const byKind = new Map();
  for (const it of insts) {
    const far = Math.abs(it.x) > hw || Math.abs(it.z) > hd;
    const key = it.kind + '|' + (far ? 'far' : (it.x < 0 ? 'w' : 'e') + (it.z < 0 ? 'n' : 's'));
    if (!byKind.has(key)) byKind.set(key, []);
    byKind.get(key).push(it);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (const [key, list] of byKind) {
    const kind = key.split('|')[0], far = key.endsWith('|far');
    const parts = LIB[kind];
    if (!parts) { console.warn('unknown prop kind', kind); continue; }
    for (const part of parts) {
      const im = new THREE.InstancedMesh(part.geo, part.mat, list.length);
      list.forEach((it, i) => {
        q.setFromAxisAngle(up, it.ry || 0);
        im.setMatrixAt(i, m.compose(p.set(it.x, it.y, it.z), q, s.set(it.sx, it.sy, it.sz)));
      });
      im.castShadow = part.shadow && !far; im.receiveShadow = !far;
      im.computeBoundingSphere();
      im.name = 'prop_' + key;
      g.add(im);
    }
  }
  return g;
}
