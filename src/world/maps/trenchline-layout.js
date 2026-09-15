/* MP_TRENCHLINE's layout: only the builder calls. The definition - sky, light,
   zones, AI hotspots - is in trenchline.js.

   Everything here is still boxes, so a trench is built the other way round:
   the trench floors are the ground (y = 0) and the hill is a surface S above
   them, cut out of a mask of half-metre cells. What stands between the cuts is
   faced with dry stone and a capstone runs along every open edge. The trenches
   are deep, 2.4 m to the top of the cap: a standing soldier is well hidden, and
   a firing step of two treads (0.45 and 0.9 m) puts your eyes over it and lets
   you climb out. Bunkers stand on a floor 0.9 m up, so their slits, at ground
   level outside, are at eye height inside; tunnels are covered trench, floor
   and all. Every cut is made again turned half round, so the mask, and the
   map, is 180-degree symmetric. */
import { makeRng } from '../../core/util.js';

export const W = 64, D = 48;
export const S = 2.1;                         // the hill surface, above the trench floors
const HW = W / 2, HD = D / 2, C = 0.5, NX = W / C, NZ = D / C;
const CAP = 0.3, R = 2.95, FLOOR = 0.9;       // capstone; underside of every roof; bunker floors
const X = (i) => -HW + i * C, Z = (j) => -HD + j * C;

/* the cuts on the west side; each is made again, turned half round, for the east */
const TRENCH = [
  // the centre line: the west yard to the command bunker
  [[-26.5, -3], [-22, -3], [-22, -7], [-16, -7], [-16, -2], [-10, -2], [-10, -5.5], [-5, -5.5], [-5, -1], [-3.5, -1]],
  // the north line: over the hill, then down into the east side's centre line
  [[-26.5, 8], [-20, 8], [-20, 12.5], [-13, 12.5], [-13, 16], [-6, 16], [-6, 12], [0, 12], [6, 12], [6, 7], [16, 7]],
];
const HALF = 1.0;                             // trenches are 2 m wide: room for two to pass
const YARD = [-31.5, -11.5, -26.5, 11.5];    // the spawn, sunk to trench level
const BUNKERS = [                             // raised floors and firing slits: [x0, z0, x1, z1]
  [-3.5, -2.5, 3.5, 2.5],                     // the command bunker, across the centre
  [-17.5, 17, -12, 20.5],                     // the observation post off the north line
];
const TUNNELS = [                             // covered trench, floor and all
  [-15, -3, -11, -1],                         // on the centre line
  [-11, 15, -7, 17],                          // on the north line
  [-14, -1, -12, 11.5],                       // under the hill, from the centre line to the north line
  [-1, 2.5, 1, 11],                           // from the command bunker to the north line (turned round: the south)
  [-23, -6.5, -21, -3.5],                     // the centre line's first turn out of the yard
  [-21, 9, -19, 11.5],                        // and the north line's
];
const STEPS = [[-21, -9, -17, -8], [-19, 13.5, -14, 14.5], [1, 13, 5, 14], [-26.5, -10, -25.5, -5], [-26.5, 1, -25.5, 6]];
const STAIRS = [[-26.5, 9.5, -24, 11.5, 'x'], [-11, -6.5, -9, -9, 'z'], [-4, 13, -2, 15.5, 'z']];   // low end first

/* 0 hill, 1 trench floor, 2 firing step, 3 tunnel, 4 stairs, 5 bunker */
function buildMask() {
  const M = new Uint8Array(NX * NZ);
  const cut = (x0, z0, x1, z1, v, over = -1) => {
    const xa = Math.min(x0, x1), xb = Math.max(x0, x1), za = Math.min(z0, z1), zb = Math.max(z0, z1);
    for (const [p0, q0, p1, q1] of [[xa, za, xb, zb], [-xb, -zb, -xa, -za]]) {
      for (let j = 0; j < NZ; j++) {
        const cz = Z(j) + C / 2; if (cz < q0 || cz > q1) continue;
        for (let i = 0; i < NX; i++) {
          const cx = X(i) + C / 2; if (cx < p0 || cx > p1) continue;
          if (over < 0 || M[j * NX + i] === over) M[j * NX + i] = v;
        }
      }
    }
  };
  for (const line of TRENCH) for (let k = 0; k + 1 < line.length; k++) {
    const [ax, az] = line[k], [bx, bz] = line[k + 1];
    cut(Math.min(ax, bx) - HALF, Math.min(az, bz) - HALF, Math.max(ax, bx) + HALF, Math.max(az, bz) + HALF, 1);
  }
  cut(...YARD, 1);
  for (const s of STAIRS) cut(s[0], s[1], s[2], s[3], 4);
  for (const t of TUNNELS) cut(...t, 3);
  for (const b of BUNKERS) cut(...b, 5);
  for (const s of STEPS) cut(...s, 2, 0);
  return M;
}

export function describeTrenchline(B) {
  const M = buildMask();
  const at = (i, j) => (i < 0 || j < 0 || i >= NX || j >= NZ ? 0 : M[j * NX + i]);
  const near4 = (i, j, f) => f(at(i + 1, j)) || f(at(i - 1, j)) || f(at(i, j + 1)) || f(at(i, j - 1));
  const near8 = (i, j, f) => { for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && f(at(i + di, j + dj))) return true; return false; };
  const lower = (v) => v === 1 || v === 2, roofed = (v) => v === 3 || v === 5, floor0 = (v) => v === 1 || v === 3;
  /* no capstone within 1.5 m of a flight: from the upper treads the navmesh linked
     a climb onto the capstone across the trench corner, which no body can make */
  const byStairs = (i, j) => { for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) if (at(i + di, j + dj) === 4) return true; return false; };
  /* the west half's cells that pass `pred`, merged into as few boxes as the rows allow */
  const rects = (pred) => {
    const used = new Uint8Array(NX * NZ), out = [], H = NX / 2;
    for (let j = 0; j < NZ; j++) for (let i = 0; i < H; i++) {
      if (used[j * NX + i] || !pred(i, j)) continue;
      let i1 = i; while (i1 + 1 < H && !used[j * NX + i1 + 1] && pred(i1 + 1, j)) i1++;
      let j1 = j;
      grow: while (j1 + 1 < NZ) { for (let k = i; k <= i1; k++) if (used[(j1 + 1) * NX + k] || !pred(k, j1 + 1)) break grow; j1++; }
      for (let jj = j; jj <= j1; jj++) for (let k = i; k <= i1; k++) used[jj * NX + k] = 1;
      out.push([X(i), Z(j), X(i1 + 1), Z(j1 + 1)]);
    }
    return out;
  };
  /* open hill at (x, z), pad metres clear of every cut */
  const flat = (x, z, pad) => {
    for (let dz = -pad; dz <= pad + 1e-6; dz += C) for (let dx = -pad; dx <= pad + 1e-6; dx += C)
      if (at(Math.floor((x + dx + HW) / C), Math.floor((z + dz + HD) / C)) !== 0) return false;
    return true;
  };
  const box = (r, y0, y1, mat, o) => B.add(r[0], y0, r[1], r[2], y1, r[3], mat, o);

  B.add(-HW, -1, -HD, HW, 0, HD, 'dirt');                                  // every trench and tunnel floor

  B.mirrored(() => {
    /* a rock ridge all round: north and west here, the mirror closes the ring */
    B.add(-HW - 1.4, 0, -HD - 1.4, HW + 1.4, S + 3.0, -HD, 'rock', { standable: false });
    B.add(-HW - 1.4, 0, -HD, -HW, S + 3.0, HD, 'rock', { standable: false });
    const far = makeRng(0x7E4);                                           // the hills beyond: shape only
    for (let i = 0; i < 30; i++) {
      const t = far(), side = far() < 0.5;
      B.inst(far() < 0.55 ? 'pine' : 'oak', side ? -HW - 3.5 - far() * 8 : -HW + t * W, 0, side ? -HD + t * D : -HD - 3.5 - far() * 7, far() * 6.28, far.range(1.0, 1.5));
    }

    /* the hill: solid to S and faced with dry stone, a skin of grass on top */
    for (const r of rects((i, j) => at(i, j) === 0)) { box(r, 0, S, 'stonewall'); box(r, S, S + 0.02, 'hillside', { solid: false, standable: false }); }
    /* firing steps, two treads; bunker floors, with a tread wherever a floor meets the trench */
    for (const r of rects((i, j) => at(i, j) === 2 && near4(i, j, floor0))) box(r, 0, 0.45, 'stonewall');
    for (const r of rects((i, j) => at(i, j) === 2 && !near4(i, j, floor0))) box(r, 0, 0.9, 'stonewall');
    for (const r of rects((i, j) => at(i, j) === 5 && near4(i, j, floor0))) box(r, 0, FLOOR / 2, 'concrete');
    for (const r of rects((i, j) => at(i, j) === 5 && !near4(i, j, floor0))) box(r, 0, FLOOR, 'concrete');
    /* the capstone along every open edge, stepped so it reads rounded */
    for (const [x0, z0, x1, z1] of rects((i, j) => at(i, j) === 0 && near4(i, j, lower) && !near8(i, j, roofed) && !byStairs(i, j))) {
      B.add(x0, S, z0, x1, S + 0.2, z1, 'capstone');
      B.add(x0 + 0.07, S + 0.2, z0 + 0.07, x1 - 0.07, S + CAP, z1 - 0.07, 'capstone');
    }
    /* walls above the hill round every roof; the bunkers' slit at ground level */
    const wallCell = (i, j) => at(i, j) === 0 && near8(i, j, roofed);
    const slit = (i, j) => (i + j) % 4 === 0 && near4(i, j, (v) => v === 5);
    for (const r of rects((i, j) => wallCell(i, j) && !slit(i, j))) box(r, S, R, 'concrete', { standable: false });
    for (const r of rects((i, j) => wallCell(i, j) && slit(i, j))) { box(r, S, S + 0.15, 'concrete'); box(r, S + 0.6, R, 'concrete', { standable: false }); }
    /* roofs, concrete under a skin of earth, and a lamp under each. A rect across the
       centre that is its own mirror is built to x = 0 only; any other is built whole. */
    for (const t of [...BUNKERS, ...TUNNELS]) {
      const [x0, z0, x1, z1] = t, self = x0 === -x1 && z0 === -z1, xe = self ? Math.min(x1 + C, 0) : x1 + C;
      B.add(x0 - C, R, z0 - C, xe, R + 0.25, z1 + C, 'capstone');
      B.add(x0 - C, R + 0.25, z0 - C, xe, R + 0.27, z1 + C, 'hillside', { solid: false, standable: false });
      const lx = self ? Math.min((x0 + x1) / 2, -1.8) : (x0 + x1) / 2, big = Math.max(x1 - x0, z1 - z0) > 6;
      for (const f of big ? [0.25, 0.75] : [0.5]) B.lights.push({ x: lx, y: R - 0.35, z: z0 + (z1 - z0) * f, color: 0xffc98a, intensity: 5, dist: 9 });
    }
    for (const [x0, z0, x1, z1, dir] of STAIRS) B.stairs(x0, z0, x1, z1, 0, S, dir, 5, 'stonewall');

    /* the command bunker is two rooms: a 14 cm wall across it (at 30 cm no two standing
       places either side fit 1.4 m apart), with a 1.8 m doorway the navmesh passes */
    B.add(-3.5, 0, -0.07, -0.9, R, 0.07, 'concrete', { standable: false });
    B.cbox(-2.4, FLOOR, 1.2, 1.4, 0.8, 0.8, 'wood');                      // map table
    B.cbox(-3.0, FLOOR, 2.1, 0.8, 0.6, 0.6, 'wood');                      // ammunition
    B.cbox(-15.6, FLOOR, 19.6, 1.6, 0.8, 0.7, 'wood');                    // a bench in the observation post
    B.lamp(-31, -11);
    B.lamp(-31, 11, false);

    /* on the hill: two tanks for the look, sandbags, rocks, pines and olives */
    const keep = [];
    for (const [x, z, ry] of [[-24, 17.5, 0.3], [-2, 20, Math.PI / 2]]) { B.mbt(x, z, ry, S); keep.push([x - 4.3, z - 4.3, x + 4.3, z + 4.3]); }
    const clearOf = (x, z, r) => keep.every(k => x < k[0] - r || x > k[2] + r || z < k[1] - r || z > k[3] + r);
    for (const [x, z] of [[-8, 7.5], [-18, 1]]) if (flat(x, z, 1.6)) { B.cbox(x, S, z, 2.6, 0.7, 0.7, 'sandbag'); keep.push([x - 1.6, z - 0.7, x + 1.6, z + 0.7]); }
    for (const [x, z, w, h, d] of [[-9, 7, 2.2, 1.1, 1.6], [-19.5, -12.5, 1.8, 0.9, 1.3], [-8.5, -10, 1.5, 0.8, 1.2]])
      if (flat(x, z, 1.4) && clearOf(x, z, 0.5)) { B.rock(x, z, w, h, d, false, S); keep.push([x - w, z - d, x + w, z + d]); }
    const r = makeRng(0x7E1), trees = [];
    for (let tries = 0; tries < 3000 && trees.length < 28; tries++) {
      const x = r.range(-HW + 1.5, -1), z = r.range(-HD + 1.5, HD - 1.5);
      if (!flat(x, z, 1.5) || !clearOf(x, z, 1.2) || trees.some(t => (t[0] - x) ** 2 + (t[1] - z) ** 2 < 12)) continue;
      trees.push([x, z]);
      const pine = r() < 0.55, s = pine ? r.range(0.9, 1.2) : r.range(0.7, 0.95), t = (pine ? 0.36 : 0.5) * s;
      B.add(x - t / 2, S, z - t / 2, x + t / 2, S + 5.2 * s, z + t / 2, 'bark', { standable: false, vis: false });
      B.inst(pine ? 'pine' : 'oak', x, S, z, r() * 6.28, s);
    }
    for (let n = 0, tries = 0; n < 34 && tries < 2000; tries++) {
      const x = r.range(-HW + 1, -0.5), z = r.range(-HD + 1, HD - 1);
      if (!flat(x, z, 0.5) || !clearOf(x, z, 0.3)) continue;
      B.inst('bush', x, S, z, r() * 6.28, r.range(0.7, 1.0)); n++;
    }

    for (let i = 0; i < 8; i++) B.spawnsA.push({ x: -30.3 + (i % 2) * 1.8, y: 0, z: -9.5 + i * 2.7, yaw: 0 });
  });
}
