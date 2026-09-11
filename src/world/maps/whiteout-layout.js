/* MP_WHITEOUT's layout: only the builder calls. The definition - sky, light,
   zones, AI hotspots - is in whiteout.js. */
import { makeRng } from '../../core/util.js';

export const W = 64, D = 46;
const HW = W / 2, HD = D / 2;

export function describeWhiteout(B) {
  B.add(-HW, -1, -HD, HW, 0, HD, 'snow');
  B.add(-HW, -0.02, -2.2, HW, 0.001, 2.2, 'asphalt', { solid: false, standable: false });   // the cleared track

  /* radar: a stepped plinth, a lattice tower, the dome on its deck */
  B.add(-3.6, 0, -3.6, 3.6, 0.3, 3.6, 'concrete');
  B.add(-2.3, 0.3, -2.3, 2.3, 0.6, 2.3, 'concrete');
  for (const x of [-1.6, 1.6]) for (const z of [-1.6, 1.6]) B.pipeV(x, z, 0.6, 6.5, 0.22);
  B.add(-2.1, 7.0, -2.1, 2.1, 7.25, 2.1, 'metal', { standable: false });
  B.dome(0, 7.1, 0, 2.3);
  B.lights.push({ x: 0, y: 6.4, z: 0, color: 0xdce8ff, intensity: 5, dist: 14 });

  B.mirrored(() => {
    B.cbox(-0.6, 0.6, 0.6, 1.0, 1.0, 1.0, 'wood');                        // crates on the plinth
    /* an ice-capped ridge all round: north and west here, the mirror closes it */
    B.add(-HW - 1.4, 0, -HD - 1.4, HW + 1.4, 5.0, -HD, 'rock', { standable: false });
    B.add(-HW - 1.4, 0, -HD, -HW, 5.0, HD, 'rock', { standable: false });
    B.add(-HW - 1.6, 5.0, -HD - 1.6, HW + 1.6, 5.35, -HD + 0.1, 'snow', { standable: false });
    B.add(-HW - 1.6, 5.0, -HD, -HW + 0.1, 5.35, HD, 'snow', { standable: false });
    const far = makeRng(0x3C0);                                              // mountains: shape only
    for (let i = 0; i < 7; i++) B.inst('snowrock', -HW + 4 + i * 9.5, 0, -HD - 14 - far() * 10, far() * 6.28, far.range(14, 22), far.range(10, 20), far.range(10, 16));
    for (let i = 0; i < 5; i++) B.inst('snowrock', -HW - 14 - far() * 10, 0, -HD + 5 + i * 9, far() * 6.28, far.range(10, 16), far.range(10, 20), far.range(14, 22));
    for (let i = 0; i < 16; i++) B.inst('pineSnow', -HW - 3 - far() * 7, 0, -HD + far() * D, far() * 6.28, far.range(0.9, 1.4));

    /* station modules on low foundations; snow on every roof */
    const mod = (x0, z0, x1, z1, mat, o) => {
      B.add(x0, 0, z0, x1, 0.4, z1, 'metal');
      B.wall(x0, z0, x1, z0, 0.4, 3.0, 0.25, mat, o.n || []);
      B.wall(x0, z1, x1, z1, 0.4, 3.0, 0.25, mat, o.s || []);
      B.wall(x0, z0, x0, z1, 0.4, 3.0, 0.25, mat, o.w || []);
      B.wall(x1, z0, x1, z1, 0.4, 3.0, 0.25, mat, o.e || []);
      B.add(x0 - 0.2, 3.0, z0 - 0.2, x1 + 0.2, 3.2, z1 + 0.2, 'metal', { standable: false });
      B.add(x0 - 0.3, 3.2, z0 - 0.3, x1 + 0.3, 3.4, z1 + 0.3, 'snow', { standable: false });
    };
    const door = (at) => ({ at, w: 1.6, y0: 0.4, y1: 2.6 }), win = (at) => ({ at, w: 1.4, y0: 1.3, y1: 2.2 });
    mod(-24, -14, -16, -9, 'paintB', { n: [win(2), win(5.5)], s: [door(1.4), win(5.2)], w: [win(1.8)], e: [door(1.8)] });
    B.cbox(-21.4, 0.4, -13.2, 3.0, 0.9, 0.9, 'metal');                     // lab bench
    B.cbox(-16.625, 0.4, -12.9, 1.0, 1.0, 1.0, 'wood');                    // crate, flush to the wall
    B.lights.push({ x: -20, y: 2.7, z: -11.5, color: 0xdce8ff, intensity: 6, dist: 11 });
    mod(-24, 3, -18, 8, 'paintC', { e: [door(1.8)], n: [win(2.2)], s: [win(2.2)] });
    B.cbox(-23.3, 0.4, 5.5, 1.0, 0.7, 2.2, 'wood');                        // bunk
    B.lights.push({ x: -21, y: 2.7, z: 5.5, color: 0xffe2b8, intensity: 5, dist: 10 });

    /* fuel farm */
    B.tank(-12, 14, 1.6, 3.4);
    B.tank(-8.2, 15.9, 1.3, 2.8);
    B.pipe(-10.2, 0.15, 11.9, 3.6, 0.3, 'x');

    /* the snowcat, parked by the track */
    B.add(-11.2, 0, -13, -8.8, 1.5, -8.6, 'paintB', { standable: false });
    B.add(-11.0, 1.5, -13, -9.0, 2.6, -11.0, 'paintB', { standable: false });
    B.add(-11.5, 0, -13.2, -11.2, 0.8, -8.4, 'rubber', { standable: false });
    B.add(-8.8, 0, -13.2, -8.5, 0.8, -8.4, 'rubber', { standable: false });

    /* a snow-capped container across part of the track near each end. With its
       mirror, every straight line down the track meets one of them. */
    B.add(-19.5, 0, -2.4, -16.9, 2.6, 0.6, 'paintC', { standable: false });
    B.add(-19.6, 2.6, -2.5, -16.8, 2.75, 0.7, 'snow', { standable: false });

    /* banks, berms, crates, drums and boulders: cover along the lanes */
    B.add(-14, 0, -4.3, -9, 1.1, -3.3, 'snow');
    B.add(-26, 0, -4.4, -22, 1.0, -3.4, 'snow');
    B.add(-6.6, 0, 5.4, -5.4, 1.2, 9.6, 'snow');
    B.add(-17.5, 0, 12.5, -15.5, 1.1, 13.3, 'snow');
    B.cbox(-14.5, 0, 9.5, 1.2, 1.2, 1.2, 'wood');
    B.cbox(-13.2, 0, 10.3, 1.0, 1.0, 1.0, 'wood');
    B.cbox(-4, 0, -14, 0.9, 1.1, 0.9, 'drumB');
    B.cbox(-3, 0, -13.2, 0.9, 1.1, 0.9, 'drumA');
    B.rock(-18, 17, 2.6, 1.4, 2.0, false, 0, 'snowrock');
    B.rock(-4.5, 12.5, 1.8, 1.0, 1.4, true, 0, 'snowrock');
    B.rock(-27, -13, 2.2, 1.2, 1.8, false, 0, 'snowrock');
    B.rock(-15, -18.5, 3.0, 1.5, 2.2, true, 0, 'snowrock');
    B.pipeV(-26.5, 16.5, 0, 9, 0.2);                                         // comms mast
    B.lights.push({ x: -26.5, y: 9, z: 16.5, color: 0xff3322, intensity: 3, dist: 8 });

    /* snowy pines along the north and south ridges */
    const r = makeRng(0x3C1), trees = [];
    const clear = (x, z, pad) => !B.boxes.some(b => b.solid && b.y1 > 0.05 && b.y0 < 3 &&
      x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad);
    for (let tries = 0; tries < 2000 && trees.length < 12; tries++) {
      const x = r.range(-HW + 1.6, -2), z = r() < 0.5 ? r.range(-HD + 1.6, -HD + 6) : r.range(HD - 6, HD - 1.6);
      if (!clear(x, z, 1.4) || trees.some(t => (t[0] - x) ** 2 + (t[1] - z) ** 2 < 9)) continue;
      trees.push([x, z]);
      B.tree('pineSnow', x, z, r.range(0.9, 1.25), r() * 6.28);
    }
    for (let i = 0; i < 7; i++) B.spawnsA.push({ x: -29.2 + (i % 2) * 1.8, y: 0, z: -9 + i * 3, yaw: 0 });
  });
}
