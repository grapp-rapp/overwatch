/* MP_TIMBERLINE's layout: only the builder calls. The definition - sky,
   light, zones, AI hotspots - is in timberline.js. */
import { makeRng } from '../../core/util.js';

export const W = 64, D = 48;
const HW = W / 2, HD = D / 2;

export function describeTimberline(B) {
  B.add(-HW, -1, -HD, HW, 0, HD, 'forest');
  B.add(-HW, -0.02, -2.6, HW, 0.001, 2.6, 'dirt', { solid: false, standable: false });

  /* the sawmill: an open shed across the road, symmetric by construction */
  B.add(-5.4, 3.8, -3.9, 5.4, 4.05, 3.9, 'wood', { standable: false });
  for (const x of [-5, 0, 5]) for (const z of [-3.5, 3.5]) B.cbox(x, 0, z, 0.3, 3.8, 0.3, 'wood', { standable: false });
  /* the saw house: head-high, so the road is not one sightline from spawn to spawn */
  B.cbox(0, 0, 0, 3.6, 2.4, 1.6, 'wood', { standable: false });

  B.mirrored(() => {
    /* a rock ridge all round: north and west here, the mirror closes the ring */
    B.add(-HW - 1.4, 0, -HD - 1.4, HW + 1.4, 5.2, -HD, 'rock', { standable: false });
    B.add(-HW - 1.4, 0, -HD, -HW, 5.2, HD, 'rock', { standable: false });
    const far = makeRng(0xFA2);
    for (let i = 0; i < 34; i++) {                     // the woods beyond: shape only
      const t = far(), side = far() < 0.55;
      B.inst('pine', side ? -HW - 3.5 - far() * 9 : -HW + t * W, 0, side ? -HD + t * D : -HD - 3.5 - far() * 8,
        far() * 6.28, far.range(1.1, 1.6));
    }
    for (let i = 0; i < 9; i++) B.inst('rock', -HW + 3 + i * 7, 4.6, -HD - 0.8, far() < 0.5 ? 0 : Math.PI, far.range(2.5, 4), far.range(0.8, 1.8), 1.6);
    for (let i = 0; i < 8; i++) B.inst('rock', -HW - 0.8, 4.6, -HD + 3 + i * 6, 0, 1.6, far.range(0.8, 1.8), far.range(2.5, 4));

    /* west cabin: log walls, two doors, a lantern inside */
    const X0 = -22, X1 = -14, Z0 = -15, Z1 = -9, T = 0.3, H = 2.8;
    B.wall(X0, Z0, X1, Z0, 0, H, T, 'logwall', [{ at: 3.0, w: 1.4, y0: 0.9, y1: 1.9 }]);
    B.wall(X0, Z1, X1, Z1, 0, H, T, 'logwall', [{ at: 1.2, w: 1.6, y0: 0, y1: 2.2 }, { at: 5.2, w: 1.4, y0: 0.9, y1: 1.9 }]);
    B.wall(X0, Z0, X0, Z1, 0, H, T, 'logwall', [{ at: 2.4, w: 1.2, y0: 0.9, y1: 1.9 }]);
    B.wall(X1, Z0, X1, Z1, 0, H, T, 'logwall', [{ at: 1.2, w: 1.2, y0: 0.9, y1: 1.9 }, { at: 3.4, w: 1.6, y0: 0, y1: 2.2 }]);
    B.add(X0 - 0.4, H, Z0 - 0.4, X1 + 0.4, H + 0.25, Z1 + 0.4, 'roof', { standable: false });
    B.add(X0 - 0.4, H + 0.25, -12.4, X1 + 0.4, H + 0.8, -11.6, 'roof', { standable: false });
    B.cbox(-19.5, 0, -13.4, 1.4, 0.9, 0.8, 'wood');                  // table
    B.cbox(-14.6, 0, -13.85, 0.9, 0.6, 2.0, 'wood');                 // bunk, under the window
    B.add(-21.5, 0, -9, -16, 0.2, -7.6, 'wood');                     // porch
    B.lights.push({ x: -18, y: 2.3, z: -12, color: 0xffc77a, intensity: 6, dist: 10 });
    for (let k = 0; k < 3; k++) B.inst('log', -22.4, k * 0.3, -11 + (k % 2) * 0.15, Math.PI / 2, 1.6, 0.3, 0.3);
    B.add(-22.65, 0, -11.8, -22.15, 0.9, -10.2, 'bark', { vis: false }); // firewood, flush to the wall

    /* watchtower: a railed platform at 3.6 m, the flight running east along it */
    const TY = 3.6, rail = { standable: false };
    for (const [x, z] of [[-25, 7], [-22, 7], [-25, 10], [-22, 10]]) B.cbox(x, 0, z, 0.26, 6.0, 0.26, 'wood', rail);
    B.add(-25.2, TY - 0.22, 6.8, -21.8, TY, 10.2, 'wood');
    B.add(-25.2, TY, 6.8, -21.8, TY + 1.0, 6.9, 'wood', rail);
    B.add(-25.2, TY, 10.1, -21.8, TY + 1.0, 10.2, 'wood', rail);
    B.add(-25.2, TY, 6.8, -25.1, TY + 1.0, 10.2, 'wood', rail);
    B.add(-21.9, TY, 6.8, -21.8, TY + 1.0, 7.9, 'wood', rail);      // east rail, gap for the stairs
    B.add(-21.9, TY, 9.5, -21.8, TY + 1.0, 10.2, 'wood', rail);
    B.add(-25.6, 6.0, 6.4, -21.4, 6.2, 10.6, 'roof', rail);
    B.stairs(-14.2, 7.95, -21.8, 9.45, 0, TY, 'x', 8, 'wood');
    B.lights.push({ x: -23.5, y: 5.6, z: 8.5, color: 0xffd9a0, intensity: 4, dist: 9 });

    /* rock outcrop between the tower and the centre */
    B.rock(-9, 12, 3.2, 1.6, 2.4);
    B.rock(-7.1, 13.6, 1.8, 1.1, 1.6, true);
    B.rock(-10.8, 10.4, 1.4, 0.8, 1.2);

    /* a head-high log stack near each end of the road. With its mirror and the
       saw house, every straight line down the road meets at least one of them. */
    B.log(-19, -1.2, 3.4, 0.9, 'z');
    B.log(-19, -1.2, 3.4, 0.9, 'z', 0.9);

    /* cover along the lanes */
    B.log(-12, -4.6, 5.2, 0.7, 'x');
    B.log(-6.5, 16.5, 6.0, 0.8, 'z');
    B.log(-24, -4.4, 4.2, 0.62, 'x');
    B.rock(-15.5, 4.6, 1.6, 0.9, 1.3);
    B.rock(-3.8, -9.5, 2.0, 1.2, 1.5, true);

    /* a lumber truck, loaded */
    B.add(-9.2, 0, -11.8, -6.8, 2.3, -9.8, 'paintA', { standable: false });
    B.add(-9.2, 0, -9.8, -6.8, 1.1, -4.8, 'wood');
    B.add(-9.0, 1.1, -9.7, -7.0, 1.95, -4.9, 'bark', { vis: false });
    for (const [x, y] of [[-8.6, 1.1], [-8.0, 1.1], [-7.4, 1.1], [-8.3, 1.52], [-7.7, 1.52]]) B.inst('log', x, y, -7.3, Math.PI / 2, 4.8, 0.44, 0.44);

    /* stacked timber by the north ridge, and stumps where it came from */
    for (let row = 0; row < 3; row++) for (let k = 0; k < 3 - row; k++) B.inst('log', -11, row * 0.54, -19.6 + k * 0.62 + row * 0.31, 0, 5.6, 0.6, 0.6);
    B.add(-13.8, 0, -19.9, -8.2, 1.6, -17.8, 'bark', { vis: false });
    for (const [x, z] of [[-4.5, 12], [-16, 18], [-27, 16.5], [-2.8, -18], [-19, 3.9], [-13, 20.5]]) B.stump(x, z);

    /* the woods: scattered clear of the road, the spawn clearing and everything built */
    const r = makeRng(0x7B1), trees = [];
    const clear = (x, z, pad) => !B.boxes.some(b => b.solid && b.y1 > 0.05 && b.y0 < 3 &&
      x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad);
    for (let tries = 0; tries < 4000 && trees.length < 44; tries++) {
      const x = r.range(-HW + 1.6, -1.6), z = r.range(-HD + 1.6, HD - 1.6);
      if (Math.abs(z) < 3.8 || (x < -25.5 && Math.abs(z) < 13) || !clear(x, z, 1.5)) continue;
      if (trees.some(t => (t[0] - x) ** 2 + (t[1] - z) ** 2 < 8.4)) continue;
      trees.push([x, z]);
      if (r() < 0.6) B.tree('pine', x, z, r.range(1.08, 1.38), r() * 6.28);
      else B.tree('oak', x, z, r.range(0.9, 1.2), r() * 6.28);
    }
    for (let n = 0, tries = 0; n < 40 && tries < 3000; tries++) {
      const x = r.range(-HW + 1.2, -1), z = r.range(-HD + 1.2, HD - 1.2);
      if (Math.abs(z) < 3.0 || !clear(x, z, 0.6)) continue;
      B.bush(x, z, r.range(0.7, 1.0)); n++;
    }

    for (let i = 0; i < 8; i++) B.spawnsA.push({ x: -29.2 + (i % 2) * 1.8, y: 0, z: -10.5 + i * 3.0, yaw: 0 });
    B.lights.push({ x: -2.6, y: 3.4, z: 0, color: 0xffd9a0, intensity: 5, dist: 12 });
  });
}
