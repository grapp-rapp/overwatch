/* ============================================================================
   MP_DUSTLINE — a small, 180-degree rotationally symmetric three-lane map.

   Everything (geometry, collision, navigation, cover, spawns) is generated from
   one list of axis-aligned boxes. Because every solid is an AABB there are no
   concave pockets for a player capsule to wedge into, and the same list serves
   as the bullet raycast set, the footstep-surface lookup and the nav source.

   Symmetry: `mirrored(fn)` runs a builder, then emits a copy of every box it
   produced rotated 180 degrees about the Y axis, so the two halves are exactly
   equivalent and neither team has an advantage.
   ========================================================================== */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildMaterials, SURFACE_KIND, makeSkyTexture } from './textures.js';
import { buildExtraMaterials } from './biomes.js';
import { buildInstances } from './props.js';
import { makeRng, clamp } from '../core/util.js';

export const MAP_W = 62, MAP_D = 46;
export const HALF_W = MAP_W / 2, HALF_D = MAP_D / 2;

/* tiling scale per material, in metres per texture repeat */
const TILE = {
  asphalt: 5.0, concrete: 2.6, plaster: 3.0, dirt: 6.0,
  metal: 2.4, wood: 1.8, roof: 2.2, sandbag: 1.2,
  paintA: 2.0, paintB: 2.0, paintC: 2.0, rubber: 1.0, glass: 2.0,
  drumA: 1.15, drumB: 1.15,
  forest: 6.0, rock: 3.2, snow: 5.0, logwall: 2.4, rust: 2.4, grate: 1.6, brick: 2.2, glow: 2.0,
};

/* ---- box geometry with world-scaled UVs ---------------------------------- */
function boxGeo(w, h, d, tile) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z — 4 verts each
  const scales = [
    [d / tile, h / tile], [d / tile, h / tile],
    [w / tile, d / tile], [w / tile, d / tile],
    [w / tile, h / tile], [w / tile, h / tile],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = scales[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  uv.needsUpdate = true;
  return g;
}

/* ============================================================================
   Builder
   ========================================================================== */
class MapBuilder {
  constructor() {
    this.boxes = [];      // { x0,y0,z0,x1,y1,z1, mat, standable, solid, vis }
    this.props = [];      // extra non-box visuals (Group)
    this.insts = [];      // instanced shapes: { kind, x, y, z, ry, sx, sy, sz }
    this.spawnsA = []; this.spawnsB = [];
    this.lights = [];
  }
  /** Add an axis-aligned box. Coordinates are min/max in world space. */
  add(x0, y0, z0, x1, y1, z1, mat, opt = {}) {
    const b = {
      x0: Math.min(x0, x1), y0: Math.min(y0, y1), z0: Math.min(z0, z1),
      x1: Math.max(x0, x1), y1: Math.max(y0, y1), z1: Math.max(z0, z1),
      mat, standable: opt.standable !== false, solid: opt.solid !== false,
      vis: opt.vis !== false, rot: opt.rot || 0,
    };
    this.boxes.push(b);
    return b;
  }
  /** Convenience: centre + size. */
  cbox(cx, cy, cz, w, h, d, mat, opt) {
    return this.add(cx - w / 2, cy, cz - d / 2, cx + w / 2, cy + h, cz + d / 2, mat, opt);
  }

  /** Run fn, then duplicate everything it produced rotated 180deg about Y.
   *  Each loop bound is captured BEFORE iterating — the loops append to the very
   *  arrays they read, so a live `.length` bound would never terminate. */
  mirrored(fn) {
    const b0 = this.boxes.length, p0 = this.props.length,
          sa = this.spawnsA.length, l0 = this.lights.length, i0 = this.insts.length;
    fn();
    const b1 = this.boxes.length, p1 = this.props.length,
          sa1 = this.spawnsA.length, l1 = this.lights.length, i1 = this.insts.length;
    for (let i = b0; i < b1; i++) {
      const b = this.boxes[i];
      this.boxes.push({
        x0: -b.x1, y0: b.y0, z0: -b.z1, x1: -b.x0, y1: b.y1, z1: -b.z0,
        mat: b.mat, standable: b.standable, solid: b.solid, vis: b.vis, rot: b.rot,
      });
    }
    for (let i = p0; i < p1; i++) {
      const p = this.props[i].clone();
      p.position.x *= -1; p.position.z *= -1;
      p.rotation.y += Math.PI;
      this.props.push(p);
    }
    for (let i = i0; i < i1; i++) {
      const t = this.insts[i];
      this.insts.push({ ...t, x: -t.x, z: -t.z, ry: t.ry + Math.PI });
    }
    for (let i = sa; i < sa1; i++) {
      const s = this.spawnsA[i];
      this.spawnsB.push({ x: -s.x, y: s.y, z: -s.z, yaw: s.yaw + Math.PI });
    }
    for (let i = l0; i < l1; i++) {
      const L = this.lights[i];
      this.lights.push({ ...L, x: -L.x, z: -L.z });
    }
  }

  /* ---- instanced props: a shape for the eye, and (mostly) a box for the rest */
  /** Place an instanced shape. It never collides on its own - add a box for that. */
  inst(kind, x, y, z, ry = 0, sx = 1, sy = sx, sz = sx) {
    this.insts.push({ kind, x, y, z, ry, sx, sy, sz });
  }
  /** A tree: the shape, plus a trunk box that stops bodies, bullets and sight.
      The crown is above head height and deliberately not solid. */
  tree(kind, x, z, s = 1, ry = 0) {
    const t = (kind.startsWith('pine') ? 0.36 : 0.5) * s;
    this.add(x - t / 2, 0, z - t / 2, x + t / 2, 5.2 * s, z + t / 2, 'bark', { standable: false, vis: false });
    this.inst(kind, x, 0, z, ry, s);
  }
  /** A boulder, its shape scaled to exactly this box. `flip` turns it half round. */
  rock(cx, cz, w, h, d, flip = false, y = 0, kind = 'rock') {
    this.add(cx - w / 2, y, cz - d / 2, cx + w / 2, y + h, cz + d / 2, 'rock', { vis: false });
    this.inst(kind, cx, y, cz, flip ? Math.PI : 0, w, h, d);
  }
  /** A felled log lying along x or z. */
  log(cx, cz, len, dia, axis = 'x', y = 0) {
    const w = axis === 'x' ? len : dia, d = axis === 'x' ? dia : len;
    this.add(cx - w / 2, y, cz - d / 2, cx + w / 2, y + dia, cz + d / 2, 'bark', { vis: false });
    this.inst('log', cx, y, cz, axis === 'x' ? 0 : Math.PI / 2, len, dia, dia);
  }
  stump(x, z) {
    this.add(x - 0.3, 0, z - 0.3, x + 0.3, 0.5, z + 0.3, 'bark', { vis: false });
    this.inst('stump', x, 0, z);
  }
  /** Ground cover: shape only, and kept below a crouching player's eyes. */
  bush(x, z, s = 1) { this.inst('bush', x, 0, z, (x * 7.3 + z * 3.1) % 6.28, s); }
  /** Collision for anything round: three boxes whose corners sit on the circle,
      so nobody stops against thin air at the corners of a square. */
  round(cx, y, cz, r, h, mat, opt = {}) {
    const o = { vis: false, standable: false, ...opt };
    this.add(cx - 0.92 * r, y, cz - 0.38 * r, cx + 0.92 * r, y + h, cz + 0.38 * r, mat, o);
    this.add(cx - 0.38 * r, y, cz - 0.92 * r, cx + 0.38 * r, y + h, cz + 0.92 * r, mat, o);
    this.add(cx - 0.71 * r, y, cz - 0.71 * r, cx + 0.71 * r, y + h, cz + 0.71 * r, mat, o);
  }
  tank(cx, cz, r, h, kind = 'tank', y = 0) {
    this.round(cx, y, cz, r, h, kind === 'tankRust' ? 'rust' : 'metal');
    this.inst(kind, cx, y, cz, 0, 2 * r, h, 2 * r);
  }
  stack(cx, cz, r, h) { this.round(cx, 0, cz, r, h, 'rust'); this.inst('stack', cx, 0, cz, 0, 2 * r, h, 2 * r); }
  dome(x, y, z, r) { this.inst('dome', x, y, z, 0, 2 * r); }
  /** A horizontal pipe along x or z, centred on (cx, y, cz). */
  pipe(cx, y, cz, len, dia, axis = 'x', solid = true) {
    const w = axis === 'x' ? len : dia, d = axis === 'x' ? dia : len;
    if (solid) this.add(cx - w / 2, y - dia / 2, cz - d / 2, cx + w / 2, y + dia / 2, cz + d / 2, 'metal', { vis: false, standable: false });
    this.inst('pipe', cx, y - dia / 2, cz, axis === 'x' ? 0 : Math.PI / 2, len, dia, dia);
  }
  pipeV(cx, cz, y0, h, dia) {
    this.add(cx - dia / 2, y0, cz - dia / 2, cx + dia / 2, y0 + h, cz + dia / 2, 'metal', { vis: false, standable: false });
    this.inst('pipeV', cx, y0, cz, 0, dia, h, dia);
  }
  lamp(x, z, light = true) {
    this.add(x - 0.06, 0, z - 0.06, x + 0.06, 3.2, z + 0.06, 'metal', { vis: false, standable: false });
    this.inst('lamp', x, 0, z);
    if (light) this.lights.push({ x, y: 3.1, z, color: 0xffd9a0, intensity: 5, dist: 12 });
  }

  /* ---- wall with door / window openings ---------------------------------- */
  /**
   * Axis-aligned wall from (ax,az) to (bx,bz).
   * openings: [{ at, w, y0, y1 }] measured along the wall from the A end.
   */
  wall(ax, az, bx, bz, yBase, yTop, thick, mat, openings = []) {
    const horiz = Math.abs(bx - ax) > Math.abs(bz - az);
    const len = horiz ? Math.abs(bx - ax) : Math.abs(bz - az);
    const s = horiz ? Math.min(ax, bx) : Math.min(az, bz);
    const cross = horiz ? az : ax;
    const ht = thick / 2;

    const seg = (t0, t1, y0, y1) => {
      if (t1 - t0 < 0.02 || y1 - y0 < 0.02) return;
      if (horiz) this.add(s + t0, y0, cross - ht, s + t1, y1, cross + ht, mat, { standable: false });
      else       this.add(cross - ht, y0, s + t0, cross + ht, y1, s + t1, mat, { standable: false });
    };

    const ops = openings.slice().sort((a, b2) => a.at - b2.at);
    let cursor = 0;
    for (const o of ops) {
      const o0 = clamp(o.at, 0, len), o1 = clamp(o.at + o.w, 0, len);
      seg(cursor, o0, yBase, yTop);
      // sill below and lintel above the hole
      seg(o0, o1, yBase, Math.max(yBase, o.y0));
      seg(o0, o1, Math.min(yTop, o.y1), yTop);
      cursor = o1;
    }
    seg(cursor, len, yBase, yTop);
  }

  /** Solid staircase (each tread is a full-height block, so nothing to fall into). */
  stairs(x0, z0, x1, z1, yBase, yTop, dir, steps = 12, mat = 'concrete') {
    const n = steps;
    const rise = (yTop - yBase) / n;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const y = yBase + rise * (i + 1);
      if (dir === 'x') this.add(x0 + (x1 - x0) * t0, yBase, z0, x0 + (x1 - x0) * t1, y, z1, mat);
      else             this.add(x0, yBase, z0 + (z1 - z0) * t0, x1, y, z0 + (z1 - z0) * t1, mat);
    }
  }
}

/* ============================================================================
   The map itself
   ========================================================================== */
function describeDustline(B) {
  /* ---------------- ground ---------------- */
  B.add(-HALF_W, -1.0, -HALF_D, HALF_W, 0, HALF_D, 'dirt', { standable: true });
  // central asphalt road (visual only, sits flush on the dirt)
  B.add(-HALF_W, -0.02, -4.5, HALF_W, 0.001, 4.5, 'asphalt', { solid: false, standable: false });
  B.add(-4.0, -0.02, -HALF_D, 4.0, 0.001, HALF_D, 'asphalt', { solid: false, standable: false });

  /* ---------------- perimeter ---------------- */
  const PW = 0.6, PH = 7.5;
  B.add(-HALF_W - PW, 0, -HALF_D - PW, HALF_W + PW, PH, -HALF_D, 'concrete', { standable: false });
  B.add(-HALF_W - PW, 0, HALF_D, HALF_W + PW, PH, HALF_D + PW, 'concrete', { standable: false });
  B.add(-HALF_W - PW, 0, -HALF_D, -HALF_W, PH, HALF_D, 'concrete', { standable: false });
  B.add(HALF_W, 0, -HALF_D, HALF_W + PW, PH, HALF_D, 'concrete', { standable: false });
  // skyline blockers beyond the wall (visual depth only)
  B.mirrored(() => {
    B.cbox(-24, 0, -HALF_D - 7, 16, 13, 9, 'plaster', { standable: false });
    B.cbox(-4, 0, -HALF_D - 9, 13, 17, 8, 'plaster', { standable: false });
    B.cbox(-HALF_W - 8, 0, -6, 10, 15, 20, 'plaster', { standable: false });
  });

  /* ---------------- MAIN COMPOUND (2 storeys), mirrored ---------------- */
  B.mirrored(() => {
    const X0 = -27.5, X1 = -14.5, Z0 = -17.5, Z1 = -5.0;   // footprint
    const T = 0.32;                                          // wall thickness
    const F1 = 3.30, F1T = 3.62;                             // 1st-floor slab
    const F2 = 6.90, F2T = 7.20;                             // roof slab

    // ---- ground floor walls
    // north wall (z = Z0): one door
    B.wall(X0, Z0, X1, Z0, 0, F1, T, 'plaster', [{ at: 4.4, w: 1.8, y0: 0, y1: 2.35 }]);
    // south wall (z = Z1): wide opening onto the road + a window
    B.wall(X0, Z1, X1, Z1, 0, F1, T, 'plaster',
      [{ at: 2.2, w: 2.6, y0: 0, y1: 2.5 }, { at: 8.6, w: 2.0, y0: 0.95, y1: 2.35 }]);
    // west wall (x = X0)
    B.wall(X0, Z0, X0, Z1, 0, F1, T, 'plaster', [{ at: 9.8, w: 2.2, y0: 0, y1: 2.4 }]);
    // east wall (x = X1): two openings facing the centre
    B.wall(X1, Z0, X1, Z1, 0, F1, T, 'plaster',
      [{ at: 2.0, w: 2.4, y0: 0, y1: 2.5 }, { at: 7.8, w: 2.6, y0: 0, y1: 2.5 }]);
    // interior partition with a doorway
    B.wall(X0 + 5.6, Z0 + 0.4, X0 + 5.6, Z1 - 0.4, 0, F1, 0.26, 'plaster',
      [{ at: 6.2, w: 1.9, y0: 0, y1: 2.4 }]);

    /* ---- 1st-floor slab, with a stairwell void down the west side.
       The flight runs the long way (in Z) rather than across the north wall,
       because a staircase has to satisfy two separate constraints at once: every
       riser under the 0.46 m step-up, AND every tread wider than one navigation
       cell plus the agent diameter (~0.6 m). The original twelve 0.47 m treads
       cleared the first and failed the second, so the first floor was a walkable
       island: the player could climb it and no bot ever could. Nine 0.92 m
       treads at a 0.40 m rise clear both. */
    const SVx0 = X0 + 0.30, SVx1 = X0 + 3.70;
    const SVz0 = Z0 + 0.30, SVz1 = Z0 + 8.60;
    B.add(SVx1, F1, Z0, X1, F1T, Z1, 'concrete');        // slab east of the stairwell
    B.add(X0, F1, SVz1, SVx1, F1T, Z1, 'concrete');      // slab south of the stairwell

    // ---- staircase, running +Z; the top tread meets the slab edge exactly
    B.stairs(SVx0 + 0.15, SVz0 + 0.30, SVx1 - 0.15, SVz1, 0, F1T, 'z', 9);
    // guard rail along the open (east) side of the flight
    B.add(SVx1 - 0.12, F1T, SVz0, SVx1 + 0.12, F1T + 1.05, SVz1, 'metal', { standable: false });

    // ---- upper floor walls (windows overlooking the centre)
    B.wall(X0, Z0, X1, Z0, F1T, F2, T, 'plaster',
      [{ at: 3.0, w: 2.2, y0: F1T + 0.95, y1: F1T + 2.35 },
       { at: 8.6, w: 2.2, y0: F1T + 0.95, y1: F1T + 2.35 }]);
    B.wall(X0, Z1, X1, Z1, F1T, F2, T, 'plaster',
      [{ at: 2.0, w: 2.6, y0: F1T + 0.85, y1: F1T + 2.45 },
       { at: 8.2, w: 2.6, y0: F1T + 0.85, y1: F1T + 2.45 }]);
    B.wall(X0, Z0, X0, Z1, F1T, F2, T, 'plaster',
      [{ at: 6.0, w: 2.2, y0: F1T + 0.95, y1: F1T + 2.35 }]);
    /* The two wide openings facing the centre are the compound's firing points,
       and also the fast way out: a 0.55 m sill sits above the 0.46 m step-up, so
       it still has to be vaulted, but comfortably inside a jump. At the original
       0.80 m the hop only just cleared it and a mover could stall half-way onto
       the ledge. */
    B.wall(X1, Z0, X1, Z1, F1T, F2, T, 'plaster',
      [{ at: 2.4, w: 3.0, y0: F1T + 0.55, y1: F1T + 2.50 },
       { at: 8.0, w: 3.0, y0: F1T + 0.55, y1: F1T + 2.50 }]);

    // ---- roof slab (not walkable — no roof camping)
    B.add(X0 - 0.4, F2, Z0 - 0.4, X1 + 0.4, F2T, Z1 + 0.4, 'roof', { standable: false });
    B.cbox(X0 + 3.0, F2T, Z0 + 6.0, 1.2, 1.6, 1.2, 'metal', { standable: false });

    // interior cover on both floors
    B.cbox(X0 + 8.6, 0, Z0 + 3.0, 1.2, 0.95, 2.4, 'wood');
    B.cbox(X0 + 3.0, 0, Z1 - 2.2, 2.2, 1.05, 1.0, 'wood');
    B.cbox(X0 + 9.6, F1T, Z0 + 8.2, 2.0, 1.00, 1.0, 'wood');
    B.cbox(X0 + 2.4, F1T, Z0 + 9.5, 1.0, 1.10, 2.0, 'metal');

    // porch canopy on the road side
    B.add(X0 + 1.0, 2.85, Z1, X0 + 5.5, 3.05, Z1 + 2.2, 'metal', { standable: false });
    B.cbox(X0 + 1.3, 0, Z1 + 2.0, 0.18, 2.85, 0.18, 'metal', { standable: false });
    B.cbox(X0 + 5.2, 0, Z1 + 2.0, 0.18, 2.85, 0.18, 'metal', { standable: false });

    B.lights.push({ x: X0 + 3.0, y: 2.9, z: Z0 + 6.0, color: 0xffd9a0, intensity: 7, dist: 12 });
    B.lights.push({ x: X0 + 8.0, y: F1T + 2.6, z: Z0 + 6.0, color: 0xffd0a0, intensity: 6, dist: 11 });

    // spawn cluster behind the compound
    for (let i = 0; i < 4; i++) {
      B.spawnsA.push({ x: -29.0 + (i % 2) * 1.6, y: 0, z: 12.0 + Math.floor(i / 2) * 3.0, yaw: -Math.PI / 2 });
    }
    B.spawnsA.push({ x: -26.0, y: 0, z: 20.0, yaw: -Math.PI / 2 });
    B.spawnsA.push({ x: -20.5, y: 0, z: 19.5, yaw: -Math.PI / 2 });
  });

  /* ---------------- WAREHOUSE with catwalk, mirrored ---------------- */
  B.mirrored(() => {
    const X0 = -10.5, X1 = 3.5, Z0 = -21.0, Z1 = -12.0;
    const H = 4.6, CT = 2.55;   // catwalk top

    // corner columns + partial walls: open-sided so it is not a death trap
    B.wall(X0, Z0, X1, Z0, 0, H, 0.30, 'metal', [{ at: 5.0, w: 3.4, y0: 0, y1: 2.9 }]);
    B.wall(X0, Z1, X1, Z1, 0, H, 0.30, 'metal',
      [{ at: 1.2, w: 3.0, y0: 0, y1: 2.9 }, { at: 9.4, w: 3.2, y0: 0, y1: 2.9 }]);
    B.wall(X0, Z0, X0, Z1, 0, H, 0.30, 'metal', [{ at: 3.0, w: 3.2, y0: 0, y1: 2.9 }]);
    B.wall(X1, Z0, X1, Z1, 0, H, 0.30, 'metal', [{ at: 3.2, w: 3.0, y0: 0, y1: 2.9 }]);
    // roof
    B.add(X0 - 0.5, H, Z0 - 0.5, X1 + 0.5, H + 0.28, Z1 + 0.5, 'metal', { standable: false });

    // catwalk along the north side
    B.add(X0 + 0.3, CT - 0.22, Z0 + 0.3, X1 - 0.3, CT, Z0 + 3.0, 'metal');
    B.add(X0 + 0.3, CT, Z0 + 0.3, X1 - 0.3, CT + 1.0, Z0 + 0.42, 'metal', { standable: false });
    /* Guard rail along the open south edge, but leave a gap where the stair
       arrives — a rail across the landing blocks headroom for the nav sampler
       and the flight becomes a staircase to nowhere. */
    B.add(X0 + 0.3, CT, Z0 + 2.88, X0 + 7.4, CT + 1.0, Z0 + 3.0, 'metal', { standable: false });
    B.add(X0 + 10.9, CT, Z0 + 2.88, X1 - 0.3, CT + 1.0, Z0 + 3.0, 'metal', { standable: false });

    /* Open steel stair up to the catwalk: six 1.0 m treads at a 0.425 m rise.
       Built with the same helper as the compound flights so it satisfies both
       the step-up limit and the navigation cell size, which is what makes the
       elevated angle usable by the AI rather than player-only. */
    B.stairs(X0 + 7.6, Z0 + 9.0, X0 + 10.7, Z0 + 3.0, 0, CT, 'z', 6);
    // crates left as clutter beside the stair
    B.cbox(X1 - 2.2, 0, Z0 + 6.4, 1.5, 0.9, 1.5, 'wood');
    B.cbox(X1 - 2.2, 0.9, Z0 + 6.4, 1.3, 0.8, 1.3, 'wood');

    // ground clutter
    B.cbox(X0 + 3.0, 0, Z0 + 6.0, 2.4, 1.15, 1.6, 'wood');
    B.cbox(X0 + 6.4, 0, Z0 + 7.2, 1.4, 1.60, 1.4, 'wood');
    B.cbox(X0 + 1.6, 0, Z1 - 2.0, 1.2, 0.95, 1.2, 'wood');

    B.lights.push({ x: (X0 + X1) / 2, y: 4.2, z: (Z0 + Z1) / 2, color: 0xbfd4e8, intensity: 8, dist: 16 });
  });

  /* ---------------- CENTRE: raised pad + hard cover ---------------- */
  {
    // low concrete pad, ramps on two opposite corners (symmetric)
    B.add(-5.0, 0, -3.2, 5.0, 1.10, 3.2, 'concrete');
    B.mirrored(() => {
      /* Ramp treads must clear two independent limits: the 0.46 m step-up, and
         one nav cell plus the agent diameter (~0.9 m) or no navigation node can
         ever sit on a tread and the pad becomes unreachable for the AI. */
      for (let i = 0; i < 4; i++) {
        const y = (i + 1) * 0.275;
        B.add(-5.0 - (4 - i) * 0.95, 0, -3.2, -5.0 - (3 - i) * 0.95, y, 3.2, 'concrete');
      }
      // sandbag emplacements on the pad
      B.cbox(-3.2, 1.10, -1.6, 2.6, 0.95, 0.7, 'sandbag');
      B.cbox(-4.2, 1.10, 0.9, 0.7, 0.95, 2.4, 'sandbag');
    });
    B.lights.push({ x: 0, y: 5.0, z: 0, color: 0xffe6bb, intensity: 6, dist: 18 });
  }

  /* ---------------- shipping containers, barriers, wrecks ---------------- */
  B.mirrored(() => {
    const cont = (x, z, rotZ, mat) => {
      if (rotZ) B.cbox(x, 0, z, 2.5, 2.6, 6.1, mat);
      else B.cbox(x, 0, z, 6.1, 2.6, 2.5, mat);
    };
    cont(-19.0, 1.5, false, 'paintA');
    cont(-11.0, -8.5, true, 'paintB');
    cont(-24.0, -1.0, true, 'paintC');
    cont(-8.0, 8.0, false, 'paintB');
    // stacked pair — gives an elevated angle onto the centre
    B.cbox(-16.0, 0, 9.5, 6.1, 2.6, 2.5, 'paintC');
    B.cbox(-16.0, 2.6, 9.5, 6.1, 2.6, 2.5, 'paintA', { standable: false });
    /* Access to the stacked containers. Originally three 0.9 m crates, which is
       taller than the 0.46 m step-up: the player could jump them but the AI could
       not, so an elevated angle onto the centre was permanently player-only.
       Now a six-tread flight — same constraints as every other stair on the map. */
    B.stairs(-23.0, 7.6, -17.6, 9.2, 0, 2.6, 'x', 6);
    B.cbox(-21.8, 0, 6.2, 1.2, 0.85, 1.2, 'wood');   // clutter beside the flight

    // jersey barriers along the road
    for (let i = 0; i < 4; i++) B.cbox(-13.5 + i * 3.1, 0, 4.9, 2.6, 0.95, 0.6, 'concrete');
    for (let i = 0; i < 3; i++) B.cbox(-26.0 + i * 3.1, 0, -2.4, 2.6, 0.95, 0.6, 'concrete');

    // sandbag nests
    B.cbox(-8.5, 0, -3.6, 3.0, 1.05, 0.8, 'sandbag');
    B.cbox(-23.0, 0, 6.0, 0.8, 1.05, 3.0, 'sandbag');

    // wrecked truck: cab + bed + wheels
    B.cbox(-13.0, 0, 15.5, 2.4, 1.9, 5.6, 'paintB');
    B.cbox(-13.0, 1.9, 14.0, 2.3, 1.0, 2.0, 'paintB', { standable: false });
    B.cbox(-13.0, 0, 12.0, 2.5, 0.9, 1.4, 'rubber');

    // barrels and pallets
    B.cbox(-6.0, 0, -13.0, 0.9, 1.1, 0.9, 'drumB');
    B.cbox(-5.0, 0, -12.2, 0.9, 1.1, 0.9, 'drumA');
    B.cbox(-27.5, 0, 3.0, 1.4, 0.55, 1.4, 'wood');
    B.cbox(-2.5, 0, 10.5, 1.2, 1.35, 1.2, 'drumA');
    B.cbox(-9.5, 0, 18.5, 2.2, 1.15, 1.1, 'concrete');
    B.cbox(2.0, 0, 16.0, 1.1, 1.4, 1.1, 'drumB');
    B.cbox(6.5, 0, 12.5, 2.4, 0.95, 0.7, 'concrete');
  });
}

/* ============================================================================
   Baking: visuals, collision broadphase, navigation, cover
   ========================================================================== */

const AGENT_R = 0.40;        // used for headroom, slightly generous
const SUPPORT_R = 0.36;      // matches the player capsule radius exactly
const STEP_UP = 0.46;
/* You can always fall off something you climbed onto. Without a downward link
   a container roof is an island in the graph: an AI that reaches one can never
   path off it again, and a route that crosses one is reported as impossible.
   Capped below the 3.6 m first-floor drop so bots still use the stairs. */
const MAX_DROP = 2.85;
const HEAD_CLEAR = 1.72;
export const NAV_CELL = 0.7;

/* Dustline's decorative pass: roadside poles and scattered rubble. Shape only. */
function dustlineDecor({ group: dec, mats, rng: r, map }) {
    // roadside poles + wires
    for (let i = 0; i < 6; i++) {
      const x = -26 + i * 10.5, z = i % 2 ? -19.5 : 19.5;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 7.2, 6), mats.metal);
      pole.position.set(x, 3.6, z); pole.castShadow = true; dec.add(pole);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.09, 0.09), mats.metal);
      arm.position.set(x + (z < 0 ? 0.7 : -0.7), 6.9, z); arm.castShadow = true; dec.add(arm);
    }
    // scattered rubble
    const rubGeos = [];
    for (let i = 0; i < 130; i++) {
      const s = r.range(0.08, 0.30);
      const gg = new THREE.BoxGeometry(s, s * r.range(0.4, 0.9), s * r.range(0.6, 1.3));
      gg.rotateY(r() * Math.PI); gg.rotateX(r.range(-0.3, 0.3));
      let x, z, tries = 0;
      do { x = r.range(-HALF_W + 1, HALF_W - 1); z = r.range(-HALF_D + 1, HALF_D - 1); tries++; }
      while (map.pointBlocked(x, 0.2, z) && tries < 8);
      gg.translate(x, s * 0.2, z);
      rubGeos.push(gg);
    }
    const rub = new THREE.Mesh(mergeGeometries(rubGeos, false), mats.concrete);
    rub.castShadow = true; rub.receiveShadow = true; dec.add(rub);
}

export class GameMap {
  constructor(def = DUSTLINE) {
    this.def = def; this.id = def.id; this.name = def.name;
    this.W = def.w; this.D = def.d; this.halfW = def.w / 2; this.halfD = def.d / 2;
    this.zones = def.zones || []; this.hotspots = def.hotspots || [];
    this.mats = { ...buildMaterials(), ...buildExtraMaterials(def.materials || []) };
    // all box materials use geometry-baked UVs
    for (const k of Object.keys(this.mats)) {
      const m = this.mats[k];
      for (const t of [m.map, m.normalMap, m.roughnessMap]) if (t) t.repeat.set(1, 1);
    }

    const B = new MapBuilder();
    def.describe(B, this);
    this.boxes = B.boxes;
    this.insts = B.insts;
    this.spawnsA = B.spawnsA;
    this.spawnsB = B.spawnsB;
    this.pointLights = B.lights;

    this.solids = this.boxes.filter(b => b.solid);
    this._buildGrid();
    this.group = this._buildVisuals();
    this._buildNav();
    this._buildNavLinks();
    this._buildCover();
    this.skyTexture = makeSkyTexture(def.env && def.env.sky);
  }

  /* ---- uniform grid broadphase over solids ---- */
  _buildGrid() {
    this.gcell = 4.0;
    this.gx0 = -this.halfW - 12; this.gz0 = -this.halfD - 12;
    this.gnx = Math.ceil((this.W + 24) / this.gcell);
    this.gnz = Math.ceil((this.D + 24) / this.gcell);
    this.grid = new Array(this.gnx * this.gnz);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = [];
    for (const b of this.solids) {
      const i0 = clamp(Math.floor((b.x0 - this.gx0) / this.gcell), 0, this.gnx - 1);
      const i1 = clamp(Math.floor((b.x1 - this.gx0) / this.gcell), 0, this.gnx - 1);
      const j0 = clamp(Math.floor((b.z0 - this.gz0) / this.gcell), 0, this.gnz - 1);
      const j1 = clamp(Math.floor((b.z1 - this.gz0) / this.gcell), 0, this.gnz - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.grid[j * this.gnx + i].push(b);
    }
  }

  /** All solids whose footprint overlaps the XZ rectangle. */
  query(x0, z0, x1, z1, out) {
    out.length = 0;
    const i0 = clamp(Math.floor((x0 - this.gx0) / this.gcell), 0, this.gnx - 1);
    const i1 = clamp(Math.floor((x1 - this.gx0) / this.gcell), 0, this.gnx - 1);
    const j0 = clamp(Math.floor((z0 - this.gz0) / this.gcell), 0, this.gnz - 1);
    const j1 = clamp(Math.floor((z1 - this.gz0) / this.gcell), 0, this.gnz - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = this.grid[j * this.gnx + i];
        for (let k = 0; k < cell.length; k++) {
          const b = cell[k];
          if (b._q === this._qid) continue;
          b._q = this._qid;
          out.push(b);
        }
      }
    }
    return out;
  }
  beginQuery() { this._qid = (this._qid || 0) + 1; }

  /* ---- visuals ---- */
  _buildVisuals() {
    const g = new THREE.Group();
    g.name = 'map';
    const byMat = new Map();
    for (const b of this.boxes) {
      if (!b.vis) continue;
      const w = b.x1 - b.x0, h = b.y1 - b.y0, d = b.z1 - b.z0;
      if (w < 1e-4 || h < 1e-4 || d < 1e-4) continue;
      const geo = boxGeo(w, h, d, TILE[b.mat] || 2.0);
      geo.translate((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
      if (!byMat.has(b.mat)) byMat.set(b.mat, []);
      byMat.get(b.mat).push(geo);
    }
    for (const [mat, geos] of byMat) {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      const m = new THREE.Mesh(merged, this.mats[mat] || this.mats.concrete);
      m.name = 'map_' + mat;
      m.castShadow = true; m.receiveShadow = true;
      g.add(m);
    }
    // ---- instanced props, then the map's own decorative pass
    if (this.insts.length) g.add(buildInstances(this.insts, this));
    const dec = new THREE.Group(); dec.name = 'decor';
    if (this.def.decor) this.def.decor({ group: dec, mats: this.mats, rng: makeRng(0x0DEC), map: this });
    g.add(dec);
    return g;
  }

  /* ---- point / ray queries ---- */
  pointBlocked(x, y, z, pad = 0) {
    this.beginQuery();
    const list = this.query(x - pad, z - pad, x + pad, z + pad, this._tmpA || (this._tmpA = []));
    for (const b of list) {
      if (x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad && y > b.y0 && y < b.y1) return true;
    }
    return false;
  }

  /**
   * Ray vs. every solid box. Returns { t, box, normal, mat } or null.
   * `maxT` in metres. Direction must be normalised.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxT, out) {
    let bestT = maxT, bestB = null, bestAxis = 0, bestSign = 0;
    const idx = 1 / (dx || 1e-9), idy = 1 / (dy || 1e-9), idz = 1 / (dz || 1e-9);
    // walk the broadphase along the segment
    this.beginQuery();
    const list = this._tmpR || (this._tmpR = []);
    const ex = ox + dx * maxT, ey = oy + dy * maxT, ez = oz + dz * maxT;
    this.query(Math.min(ox, ex), Math.min(oz, ez), Math.max(ox, ex), Math.max(oz, ez), list);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      let t0 = (b.x0 - ox) * idx, t1 = (b.x1 - ox) * idx;
      let ax = 0, sg = t0 > t1 ? 1 : -1;
      if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
      let ty0 = (b.y0 - oy) * idy, ty1 = (b.y1 - oy) * idy;
      let sgy = ty0 > ty1 ? 1 : -1;
      if (ty0 > ty1) { const s = ty0; ty0 = ty1; ty1 = s; }
      if (ty0 > t0) { t0 = ty0; ax = 1; sg = sgy; }
      if (ty1 < t1) t1 = ty1;
      let tz0 = (b.z0 - oz) * idz, tz1 = (b.z1 - oz) * idz;
      let sgz = tz0 > tz1 ? 1 : -1;
      if (tz0 > tz1) { const s = tz0; tz0 = tz1; tz1 = s; }
      if (tz0 > t0) { t0 = tz0; ax = 2; sg = sgz; }
      if (tz1 < t1) t1 = tz1;
      if (t1 < Math.max(0, t0) || t0 > bestT) continue;
      const th = t0 < 0 ? 0 : t0;
      if (th < bestT) { bestT = th; bestB = b; bestAxis = ax; bestSign = sg; }
    }
    if (!bestB) return null;
    const o = out || {};
    o.t = bestT; o.box = bestB; o.mat = bestB.mat;
    o.surface = SURFACE_KIND[bestB.mat] || 'concrete';
    o.px = ox + dx * bestT; o.py = oy + dy * bestT; o.pz = oz + dz * bestT;
    o.nx = bestAxis === 0 ? bestSign : 0;
    o.ny = bestAxis === 1 ? bestSign : 0;
    o.nz = bestAxis === 2 ? bestSign : 0;
    return o;
  }

  /** True if a clear straight line exists between two points. */
  lineOfSight(ax, ay, az, bx, by, bz) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    dx /= len; dy /= len; dz /= len;
    const hit = this.raycast(ax, ay, az, dx, dy, dz, len - 0.05, this._losOut || (this._losOut = {}));
    return !hit;
  }

  /* ---- navigation -------------------------------------------------------- */
  _buildNav() {
    const cs = NAV_CELL;
    /* Symmetric about the origin. Every map is a 180-degree mirror, and a grid
       that starts at the west edge only lines up with one half: on Foundry a
       1.3 m door had walkable cells on the west office and none on its mirror
       in the east office, so no bot could ever enter it. */
    const kx = Math.ceil(this.halfW / cs), kz = Math.ceil(this.halfD / cs);
    const nx = this.nx = 2 * kx;
    const nz = this.nz = 2 * kz;
    this.navX0 = -kx * cs; this.navZ0 = -kz * cs;
    const MAXS = 2;
    const h = this.navH = new Float32Array(nx * nz * MAXS).fill(NaN);
    const nSurf = this.navN = new Uint8Array(nx * nz);
    this.MAXS = MAXS;

    const list = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = this.navX0 + (i + 0.5) * cs, z = this.navZ0 + (j + 0.5) * cs;
        // candidate standing heights: ground plus tops of standable boxes under us
        this.beginQuery();
        this.query(x - AGENT_R, z - AGENT_R, x + AGENT_R, z + AGENT_R, list);
        /* A surface counts if it overlaps the agent's footprint at all — the same
           rule the player's own groundHeight() uses, so navigation and collision
           agree about where a body can stand. Demanding that one box cover the
           WHOLE disc looks stricter but is wrong: it silently deletes every
           staircase, because a tread narrower than the agent is never fully
           covering, and the flight becomes invisible to the AI. */
        const cands = [0];
        for (const b of list) {
          if (!b.standable) continue;
          if (x + SUPPORT_R > b.x0 && x - SUPPORT_R < b.x1 &&
              z + SUPPORT_R > b.z0 && z - SUPPORT_R < b.z1 && b.y1 > 0.02) cands.push(b.y1);
        }
        cands.sort((a, b2) => a - b2);
        let count = 0;
        for (let ci = cands.length - 1; ci >= 0 && count < MAXS; ci--) {
          const y = cands[ci];
          if (count && Math.abs(h[(j * nx + i) * MAXS + count - 1] - y) < 0.5) continue;
          /* Headroom: nothing may intersect the agent cylinder between the feet
             and HEAD_CLEAR. Anything low enough to step onto is skipped — on a
             staircase the next tread up always overlaps the cylinder, and
             counting it as an obstruction rejects every step of the flight. */
          let ok = true;
          for (const b of list) {
            if (b.y1 <= y + STEP_UP + 0.02 || b.y0 >= y + HEAD_CLEAR) continue;
            if (x + AGENT_R > b.x0 && x - AGENT_R < b.x1 && z + AGENT_R > b.z0 && z - AGENT_R < b.z1) { ok = false; break; }
          }
          if (!ok) continue;
          h[(j * nx + i) * MAXS + count] = y;
          count++;
        }
        nSurf[j * nx + i] = count;
      }
    }
    // A* scratch
    const N = nx * nz * MAXS;
    this._gScore = new Float32Array(N);
    this._fScore = new Float32Array(N);
    this._came = new Int32Array(N);
    this._closed = new Uint8Array(N);
    this._openMark = new Uint8Array(N);
    this._stamp = new Int32Array(N);
    this._epoch = 0;
  }

  /* ---- drop and mantle links --------------------------------------------
     The grid only connects cells that touch. That leaves every raised surface —
     container roofs, the catwalk, the truck bed — as an island: its nodes sit a
     cell or two back from the edge (a node needs the whole agent disc supported)
     so they are never grid-adjacent to the ground beside them. Bots could
     therefore neither climb onto an elevated angle nor get down from one.

     So we add explicit edges: DOWN wherever a body can simply fall (up to
     MAX_DROP), and UP wherever it can mantle (a short hop). Both require an
     unobstructed line between the two surfaces, so you still cannot link
     through a wall. */
  _buildNavLinks() {
    const MAXS = this.MAXS, nx = this.nx, nz = this.nz, cs = NAV_CELL;
    const N = nx * nz * MAXS;
    const MANTLE_UP = 1.15, MAX_GAP = 1.9, MAX_GAP_UP = 1.5;
    const from = [], to = [], cost = [];

    const pa = { x: 0, y: 0, z: 0 }, pb = { x: 0, y: 0, z: 0 };
    for (let c = 0; c < nx * nz; c++) {
      const n = this.navN[c];
      if (!n) continue;
      const ci = c % nx, cj = (c / nx) | 0;
      for (let s = 0; s < n; s++) {
        const a = c * MAXS + s;
        this.nodePos(a, pa);
        for (let dj = -3; dj <= 3; dj++) {
          for (let di = -3; di <= 3; di++) {
            if (Math.abs(di) < 2 && Math.abs(dj) < 2) continue;   // grid already covers these
            const i2 = ci + di, j2 = cj + dj;
            if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= nz) continue;
            const c2 = j2 * nx + i2;
            const cnt = this.navN[c2];
            if (!cnt) continue;
            for (let s2 = 0; s2 < cnt; s2++) {
              const b = c2 * MAXS + s2;
              this.nodePos(b, pb);
              const gap = Math.hypot(pb.x - pa.x, pb.z - pa.z);
              const rise = pb.y - pa.y;
              let ok = false, pen = 0;
              if (rise <= -STEP_UP && -rise <= MAX_DROP && gap <= MAX_GAP) { ok = true; pen = 1.4 - rise * 2.6; }
              else if (rise >= STEP_UP && rise <= MANTLE_UP && gap <= MAX_GAP_UP) { ok = true; pen = 2.6 + rise * 2.0; }
              if (!ok) continue;

              /* Clearance test for a ledge move. Tracing straight between the two
                 surfaces would pass through the ledge itself and reject every
                 legitimate drop, so instead check the two legs of the actual
                 movement: walk out horizontally at the upper body height, then
                 fall straight down to the lower surface. */
              const hi = rise > 0 ? pb : pa, lo = rise > 0 ? pa : pb;
              const walkY = hi.y + 0.95;
              if (!this.lineOfSight(hi.x, walkY, hi.z, lo.x, walkY, lo.z)) continue;
              if (!this.lineOfSight(lo.x, walkY, lo.z, lo.x, lo.y + 0.30, lo.z)) continue;
              from.push(a); to.push(b); cost.push(gap + pen);
            }
          }
        }
      }
    }

    // pack into CSR so A* can walk a node's links without allocating
    const counts = new Int32Array(N);
    for (const a of from) counts[a]++;
    const start = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) start[i + 1] = start[i] + counts[i];
    const cursor = start.slice(0, N);
    const dst = new Int32Array(from.length);
    const cst = new Float32Array(from.length);
    for (let k = 0; k < from.length; k++) {
      const i = cursor[from[k]]++;
      dst[i] = to[k]; cst[i] = cost[k];
    }
    this.linkStart = start; this.linkTo = dst; this.linkCost = cst;
    this.linkCount = from.length;
  }

  navIndex(x, z) {
    const i = clamp(Math.floor((x - this.navX0) / NAV_CELL), 0, this.nx - 1);
    const j = clamp(Math.floor((z - this.navZ0) / NAV_CELL), 0, this.nz - 1);
    return j * this.nx + i;
  }
  /** Nearest nav node (cell + surface) to a world point. */
  navNode(x, y, z) {
    const c = this.navIndex(x, z);
    const n = this.navN[c];
    let best = -1, bd = 1e9;
    for (let s = 0; s < n; s++) {
      const d = Math.abs(this.navH[c * this.MAXS + s] - y);
      if (d < bd) { bd = d; best = s; }
    }
    if (best < 0) {
      // fall back to the closest walkable cell in a small spiral
      for (let r = 1; r <= 4 && best < 0; r++) {
        for (let dj = -r; dj <= r && best < 0; dj++) for (let di = -r; di <= r; di++) {
          const i2 = clamp((c % this.nx) + di, 0, this.nx - 1);
          const j2 = clamp(Math.floor(c / this.nx) + dj, 0, this.nz - 1);
          const c2 = j2 * this.nx + i2;
          if (this.navN[c2] > 0) { return c2 * this.MAXS + 0; }
        }
      }
      return -1;
    }
    return c * this.MAXS + best;
  }
  nodePos(node, out) {
    const c = Math.floor(node / this.MAXS), s = node % this.MAXS;
    const i = c % this.nx, j = Math.floor(c / this.nx);
    out.x = this.navX0 + (i + 0.5) * NAV_CELL;
    out.z = this.navZ0 + (j + 0.5) * NAV_CELL;
    out.y = this.navH[c * this.MAXS + s];
    return out;
  }

  /**
   * A* between world points. Returns an array of {x,y,z} waypoints, or null.
   *
   * The open set is a binary heap. An earlier linear-scan version with a fixed
   * 9000-iteration cap silently failed on long cross-map routes: the graph has
   * ~11k nodes, and an O(n) pop plus an O(n) membership test exhausted the
   * budget before reaching the goal — which the caller could not distinguish
   * from "no path exists".
   */
  findPath(sx, sy, sz, tx, ty, tz, outPath) {
    const start = this.navNode(sx, sy, sz), goal = this.navNode(tx, ty, tz);
    if (start < 0 || goal < 0) return null;
    if (start === goal) { outPath.length = 0; outPath.push({ x: tx, y: ty, z: tz }); return outPath; }

    const MAXS = this.MAXS, nx = this.nx, nz = this.nz;
    const ep = ++this._epoch;
    const g = this._gScore, f = this._fScore, came = this._came,
          stamp = this._stamp, closed = this._closed, inOpen = this._openMark;

    const gp = { x: 0, y: 0, z: 0 }, np = { x: 0, y: 0, z: 0 };
    this.nodePos(goal, gp);

    /* ---- binary heap keyed by fScore ---- */
    const heap = this._heap || (this._heap = new Int32Array(this.navH.length * 3 + 64));
    const cap = heap.length;
    let hn = 0;
    const push = (n) => {
      if (hn >= cap) return;
      let i = hn++;
      heap[i] = n;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (f[heap[p]] <= f[heap[i]]) break;
        const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      heap[0] = heap[--hn];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < hn && f[heap[l]] < f[heap[s]]) s = l;
        if (r < hn && f[heap[r]] < f[heap[s]]) s = r;
        if (s === i) break;
        const t = heap[s]; heap[s] = heap[i]; heap[i] = t;
        i = s;
      }
      return top;
    };

    stamp[start] = ep; g[start] = 0; closed[start] = 0; inOpen[start] = 1;
    this.nodePos(start, np);
    f[start] = Math.hypot(np.x - gp.x, np.z - gp.z);
    came[start] = -1;
    push(start);

    const cur = { x: 0, y: 0, z: 0 }, nb = { x: 0, y: 0, z: 0 };
    let expanded = 0;
    const budget = this.navH.length + 4096;
    while (hn > 0 && expanded++ < budget) {
      const node = pop();
      if (stamp[node] === ep && closed[node]) continue;   // stale heap duplicate
      inOpen[node] = 0;
      if (node === goal) return this._reconstruct(came, node, outPath, tx, ty, tz);
      closed[node] = 1;
      const c = (node / MAXS) | 0;
      const ci = c % nx, cj = (c / nx) | 0;
      this.nodePos(node, cur);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i2 = ci + di, j2 = cj + dj;
          if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= nz) continue;
          const c2 = j2 * nx + i2;
          const cnt = this.navN[c2];
          if (!cnt) continue;
          // no corner cutting: a diagonal needs both orthogonal neighbours open
          if (di && dj && (!this.navN[cj * nx + i2] || !this.navN[j2 * nx + ci])) continue;
          for (let s2 = 0; s2 < cnt; s2++) {
            const n2 = c2 * MAXS + s2;
            const y2 = this.navH[c2 * MAXS + s2];
            const rise = y2 - cur.y;
            if (rise > STEP_UP || -rise > MAX_DROP) continue;
            if (stamp[n2] !== ep) { stamp[n2] = ep; g[n2] = Infinity; closed[n2] = 0; inOpen[n2] = 0; }
            if (closed[n2]) continue;
            this.nodePos(n2, nb);
            const step = Math.hypot(nb.x - cur.x, nb.z - cur.z)
              + (rise > 0 ? rise * 1.4 : -rise * 2.6);   // drops cost more than steps
            const tentative = g[node] + step;
            if (tentative < g[n2]) {
              came[n2] = node; g[n2] = tentative;
              f[n2] = tentative + Math.hypot(nb.x - gp.x, nb.z - gp.z);
              inOpen[n2] = 1;
              push(n2);   // lazy decrease-key: duplicates are skipped when popped
            }
          }
        }
      }

      /* ---- explicit drop / mantle links out of this node ---- */
      const ls = this.linkStart[node], le = this.linkStart[node + 1];
      for (let k = ls; k < le; k++) {
        const n2 = this.linkTo[k];
        if (stamp[n2] !== ep) { stamp[n2] = ep; g[n2] = Infinity; closed[n2] = 0; inOpen[n2] = 0; }
        if (closed[n2]) continue;
        const tentative = g[node] + this.linkCost[k];
        if (tentative < g[n2]) {
          came[n2] = node; g[n2] = tentative;
          this.nodePos(n2, nb);
          f[n2] = tentative + Math.hypot(nb.x - gp.x, nb.z - gp.z);
          inOpen[n2] = 1;
          push(n2);
        }
      }
    }
    return null;
  }

  _reconstruct(came, node, outPath, tx, ty, tz) {
    const raw = [];
    const p = { x: 0, y: 0, z: 0 };
    let n = node, guard = 0;
    while (n >= 0 && guard++ < 4000) {
      this.nodePos(n, p);
      raw.push({ x: p.x, y: p.y, z: p.z });
      n = came[n];
    }
    raw.reverse();
    // string-pull: drop waypoints we can walk past directly
    outPath.length = 0;
    let i = 0;
    while (i < raw.length) {
      let j = raw.length - 1;
      for (; j > i + 1; j--) {
        // never straighten across a height change: that waypoint is a drop or a
        // mantle and the mover has to arrive at its edge to make it
        if (Math.abs(raw[j].y - raw[i].y) > 0.3) continue;
        if (this._walkClear(raw[i], raw[j])) break;
      }
      outPath.push(raw[j]);
      if (j === i) break;
      i = j;
    }
    outPath.push({ x: tx, y: ty, z: tz });
    return outPath;
  }

  _walkClear(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const d = Math.hypot(dx, dz);
    const steps = Math.ceil(d / (NAV_CELL * 0.7));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const x = a.x + dx * t, z = a.z + dz * t;
      const c = this.navIndex(x, z);
      let ok = false;
      for (let s = 0; s < this.navN[c]; s++) {
        if (Math.abs(this.navH[c * this.MAXS + s] - a.y) < 0.4) { ok = true; break; }
      }
      if (!ok) return false;
    }
    return true;
  }

  /* ---- cover points ------------------------------------------------------ */
  _buildCover() {
    const pts = [];
    for (const b of this.boxes) {
      if (!b.solid) continue;
      const h = b.y1 - b.y0;
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      if (b.y0 > 4.0) continue;
      if (h < 0.75 || h > 3.4) continue;
      if (w > 20 || d > 20) continue;
      const off = 0.72;
      const sides = [
        { nx: 0, nz: -1, len: w, ax: 'x' }, { nx: 0, nz: 1, len: w, ax: 'x' },
        { nx: -1, nz: 0, len: d, ax: 'z' }, { nx: 1, nz: 0, len: d, ax: 'z' },
      ];
      for (const s of sides) {
        const n = Math.max(1, Math.floor(s.len / 1.6));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          let x, z;
          if (s.ax === 'x') { x = b.x0 + w * t; z = s.nz < 0 ? b.z0 - off : b.z1 + off; }
          else { z = b.z0 + d * t; x = s.nx < 0 ? b.x0 - off : b.x1 + off; }
          const c = this.navIndex(x, z);
          if (!this.navN[c]) continue;
          const y = this.navH[c * this.MAXS + 0];
          if (Math.abs(y - b.y0) > 0.6) continue;
          pts.push({
            x, y, z,
            // the direction that is PROTECTED (looking from cover across the box)
            dx: -s.nx, dz: -s.nz,
            height: b.y1 - y,
            crouch: (b.y1 - y) < 1.35,
          });
        }
      }
    }
    this.coverPoints = pts;
    // spatial bucket for fast nearest queries
    this.coverGrid = new Map();
    for (const p of pts) {
      const k = Math.floor(p.x / 6) + ',' + Math.floor(p.z / 6);
      if (!this.coverGrid.has(k)) this.coverGrid.set(k, []);
      this.coverGrid.get(k).push(p);
    }
  }

  coverNear(x, z, radius, out) {
    out.length = 0;
    const r = Math.ceil(radius / 6);
    const ci = Math.floor(x / 6), cj = Math.floor(z / 6);
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      const arr = this.coverGrid.get((ci + i) + ',' + (cj + j));
      if (arr) for (const p of arr) {
        if ((p.x - x) ** 2 + (p.z - z) ** 2 <= radius * radius) out.push(p);
      }
    }
    return out;
  }

  /* ---- spawn selection --------------------------------------------------- */
  /**
   * Score each candidate spawn by distance to the nearest live enemy and whether
   * that enemy can see it. Never returns a point another team can currently
   * shoot — this is the "nobody spawns in a crosshair" rule.
   */
  pickSpawn(team, enemies, friends) {
    const pool = team === 'A' ? this.spawnsA : this.spawnsB;
    const alt  = team === 'A' ? this.spawnsB : this.spawnsA;
    let best = null, bestScore = -Infinity;
    const consider = (s, penalty) => {
      let score = penalty;
      let nearest = 1e9, visible = false;
      for (const e of enemies) {
        if (!e.alive) continue;
        const d = Math.hypot(e.pos.x - s.x, e.pos.z - s.z);
        if (d < nearest) nearest = d;
        if (d < 34 && this.lineOfSight(s.x, s.y + 1.55, s.z, e.pos.x, e.pos.y + 1.55, e.pos.z)) visible = true;
      }
      score += Math.min(nearest, 40) * 1.6;
      if (visible) score -= 260;
      if (nearest < 9) score -= 200;
      for (const f of friends) {
        if (!f.alive) continue;
        const d = Math.hypot(f.pos.x - s.x, f.pos.z - s.z);
        if (d < 2.2) score -= 90;         // don't stack bodies
        else if (d < 16) score += 14;     // but do spawn near the squad
      }
      score += Math.random() * 12;
      if (score > bestScore) { bestScore = score; best = s; }
    };
    for (const s of pool) consider(s, 0);
    for (const s of alt) consider(s, -120);   // last resort: cross-spawn
    return best || pool[0];
  }
}

/* ============================================================================
   Dustline's definition. The other maps live in ./maps/, and all of them are
   gathered in ./maps/index.js.
   ========================================================================== */
export const DUSTLINE = {
  id: 'dustline', name: 'DUSTLINE', code: 'MP_DUSTLINE', swatch: '#c9a86a',
  blurb: 'Desert compounds, two warehouses, a raised centre. Three fast lanes.',
  w: MAP_W, d: MAP_D,
  describe: describeDustline, decor: dustlineDecor,
  env: {},        // main.js and makeSkyTexture default to Dustline's own dusk
  zones: [
    ['WEST COMPOUND', -21, -11], ['EAST COMPOUND', 21, 11],
    ['NORTH WAREHOUSE', -3.5, -16.5], ['SOUTH WAREHOUSE', 2, 16.5],
    ['CENTRE', 0, -5.5], ['ROAD', -28, 1.5], ['ROAD', 28, -1.5],
  ],
  hotspots: [
    [0, 0, 3], [-8, -3, 1], [8, 3, 1], [-20, -11, 2], [20, 11, 2], [-21, -7, 1], [21, 7, 1],
    [-3.5, -16.5, 2], [3.5, 16.5, 2], [-16, 9.5, 1], [16, -9.5, 1], [-27, 3, 0], [27, -3, 0],
    [-13, 15.5, 0], [13, -15.5, 0], [-11, -8.5, 1], [11, 8.5, 1],
  ],
};

/** Layout only - boxes, spawns, props - for the briefing's tactical map.
 *  No meshes and no navmesh, so it costs a few milliseconds. */
export function previewMap(def) {
  const B = new MapBuilder();
  def.describe(B, null);
  return {
    def, id: def.id, name: def.name, W: def.w, D: def.d, halfW: def.w / 2, halfD: def.d / 2,
    zones: def.zones || [], boxes: B.boxes, spawnsA: B.spawnsA, spawnsB: B.spawnsB, insts: B.insts,
  };
}
