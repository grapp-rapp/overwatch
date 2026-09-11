/* MP_FOUNDRY's layout: only the builder calls. The definition - sky, light,
   zones, AI hotspots - is in foundry.js. */
import { makeRng } from '../../core/util.js';

export const W = 62, D = 46;
const HW = W / 2, HD = D / 2;

export function describeFoundry(B) {
  B.add(-HW, -1, -HD, HW, 0, HD, 'concrete');
  /* the rail line: two rails on sleepers, flush, shape only */
  B.add(-HW, -0.02, -1.3, HW, 0.004, 1.3, 'dirt', { solid: false, standable: false });
  for (const z of [-0.72, 0.72]) B.add(-HW, 0.004, z - 0.04, HW, 0.02, z + 0.04, 'metal', { solid: false, standable: false });

  /* the furnace hall straddles the rail; roof and walls are symmetric by construction */
  const HX = 9, HZ = 7, HH = 7.2, CY = 3.45;
  B.add(-HX - 0.3, HH, -HZ - 0.3, HX + 0.3, HH + 0.3, HZ + 0.3, 'rust', { standable: false });
  B.lights.push({ x: 0, y: 6.4, z: 0, color: 0xffc890, intensity: 5, dist: 16 });

  B.mirrored(() => {
    /* brick boundary: north and west here, the mirror closes it */
    B.add(-HW - 0.8, 0, -HD - 0.8, HW + 0.8, 6.0, -HD, 'brick', { standable: false });
    B.add(-HW - 0.8, 0, -HD, -HW, 6.0, HD, 'brick', { standable: false });
    B.pipe(-8, 4.2, -HD + 0.45, 44, 0.6, 'x', false);                     // a main along the north wall
    const far = makeRng(0xF0D);                                             // the works beyond: shape only
    for (let i = 0; i < 5; i++) B.add(-HW + 2 + i * 12, 0, -HD - 16, -HW + 10 + i * 12, far.range(10, 18), -HD - 7, i % 2 ? 'rust' : 'brick', { solid: false, standable: false });
    B.inst('stack', -HW + 14, 0, -HD - 20, 0, 3.2, 26, 3.2);

    /* hall walls: the west wall with the rail door, and the west half of north and south */
    B.wall(-HX, -HZ, -HX, HZ, 0, HH, 0.4, 'brick', [{ at: 5.0, w: 4.0, y0: 0, y1: 4.6 }]);
    B.wall(-HX, -HZ, 0, -HZ, 0, HH, 0.4, 'brick', [{ at: 3.0, w: 2.2, y0: 0, y1: 2.8 }]);
    B.wall(-HX, HZ, 0, HZ, 0, HH, 0.4, 'brick', [{ at: 5.2, w: 2.2, y0: 0, y1: 2.8 }]);
    /* north catwalk on grating, railed on the inside and open at the stair head */
    B.add(-HX + 0.2, CY - 0.15, -HZ + 0.2, HX - 0.2, CY, -HZ + 1.8, 'grate');
    B.add(-7.2, CY, -HZ + 1.72, HX - 0.2, CY + 1.0, -HZ + 1.8, 'metal', { standable: false });
    B.stairs(-1.0, -5.2, -8.6, -3.6, 0, CY, 'x', 8, 'metal');
    /* a furnace facing the rail: glowing mouth, flue up through the roof */
    B.add(-6.5, 0, 2.4, -2.5, 3.2, 5.0, 'rust');
    B.add(-5.4, 0.6, 2.32, -3.6, 1.8, 2.42, 'glow', { solid: false, standable: false });
    B.pipeV(-4.5, 3.7, 3.2, 4.0, 0.8);
    B.lights.push({ x: -4.5, y: 1.4, z: 1.6, color: 0xff7a2a, intensity: 8, dist: 12 });
    B.cbox(-7.6, 0, -1.9, 1.2, 1.2, 1.2, 'drumB');                          // a ladle's worth of cover

    /* a hopper wagon on the rail, and crates beside it: with the mirror, no
       straight line runs down the rail from one spawn to the other */
    B.add(-16.6, 0, -1.1, -11.9, 0.6, 1.1, 'rubber', { standable: false });
    B.add(-17, 0.6, -1.3, -11.5, 2.9, 1.3, 'rust', { standable: false });
    B.cbox(-14, 0, 1.8, 1.2, 1.8, 1.0, 'wood');

    /* the west yard */
    B.stack(-26, -17, 1.5, 18);
    B.tank(-20, -16, 2.0, 5.0, 'tankRust');
    B.tank(-15, -17.5, 1.5, 4.0, 'tankRust');
    B.add(-24, 0, -8, -19, 0.9, -7, 'metal');                               // a stack of beams
    B.add(-23.6, 0.9, -7.9, -19.4, 1.5, -7.1, 'metal');
    B.pipe(-12, 0.45, -10.5, 6, 0.5, 'x');                                   // a low pipe rack to vault
    B.rock(-8, 13, 3.4, 1.4, 2.6);                                           // slag heap
    B.cbox(-17.5, 0, 6.5, 1.2, 1.2, 1.2, 'wood');
    B.cbox(-16.3, 0, 7.3, 1.0, 1.0, 1.0, 'wood');
    B.cbox(-3.5, 0, -12.5, 0.9, 1.1, 0.9, 'drumA');
    B.cbox(-2.5, 0, -11.7, 0.9, 1.1, 0.9, 'drumB');
    B.cbox(-12.5, 0, 17.5, 2.4, 1.2, 1.2, 'paintB');
    B.lamp(-12, -4.5);
    B.lamp(-22, 4.5);

    /* the office: one storey of brick, door to the yard */
    const X0 = -26, X1 = -19, Z0 = 9, Z1 = 16, T = 0.3, H = 3.2;
    B.wall(X0, Z0, X1, Z0, 0, H, T, 'brick', [{ at: 4.6, w: 1.6, y0: 0, y1: 2.3 }]);
    B.wall(X0, Z1, X1, Z1, 0, H, T, 'brick', [{ at: 2.0, w: 1.6, y0: 1.0, y1: 2.1 }]);
    B.wall(X0, Z0, X0, Z1, 0, H, T, 'brick', [{ at: 3.0, w: 1.6, y0: 1.0, y1: 2.1 }]);
    B.wall(X1, Z0, X1, Z1, 0, H, T, 'brick', [{ at: 1.4, w: 1.6, y0: 0, y1: 2.3 }, { at: 4.4, w: 1.6, y0: 1.0, y1: 2.1 }]);
    B.add(X0 - 0.3, H, Z0 - 0.3, X1 + 0.3, H + 0.25, Z1 + 0.3, 'rust', { standable: false });
    B.cbox(-23.4, 0, 14.2, 2.0, 0.8, 1.0, 'wood');                           // desk
    B.lights.push({ x: -22.5, y: 2.8, z: 12.5, color: 0xffe0b0, intensity: 5, dist: 9 });

    for (let i = 0; i < 7; i++) B.spawnsA.push({ x: -28.6 + (i % 2) * 1.8, y: 0, z: -9 + i * 3, yaw: 0 });
  });
}
