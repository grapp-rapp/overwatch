/* ============================================================================
   MP_TIMBERLINE - a logging camp in pine and oak woods.

   Same rules as Dustline: 180-degree rotational symmetry, so neither side gets
   the better half, and every solid is a box, so bullets, sight, collision and
   the navmesh agree. What is new is the trees - an instanced shape over a
   trunk box each - and they are what make it play differently: short
   sightlines broken by trunks, a tower on each side that sees over them, and
   an open sawmill in the middle that everyone has to cross.
   ========================================================================== */
import { describeTimberline, W, D } from './timberline-layout.js';

export const TIMBERLINE = {
  id: 'timberline', name: 'TIMBERLINE', code: 'MP_TIMBERLINE', swatch: '#4f7a4a',
  blurb: 'A logging camp in the woods. Trunks break every sightline; two towers see over them.',
  w: W, d: D, describe: describeTimberline, materials: ['forest', 'rock', 'logwall'],
  /* designed high ground the map walk must be able to climb to: both tower tops */
  mustReach: [[-23.5, 8.5, 3.6], [23.5, -8.5, 3.6]],
  env: {
    sky: { zenith: [92, 116, 118], horizon: [178, 186, 170], ground: [36, 44, 32],
      cloud: [196, 202, 192], cover: 0.40, gain: 2.4, seed: 0x7B1 },
    fog: [0x7f8d7c, 24, 118], hemi: [0xb8cab2, 0x2e3a26, 0.95],
    sun: [0xfff1d6, 2.7], sunDir: [-30, 64, 40], exposure: 1.0,
  },
  zones: [['SAWMILL', 0, -5.2], ['WEST CABIN', -18, -16.8], ['EAST CABIN', 18, 16.8],
    ['WEST TOWER', -23.5, 12.6], ['EAST TOWER', 23.5, -12.6], ['LOGGING ROAD', -20, 1.2], ['LOGGING ROAD', 20, -1.2]],
  hotspots: [[0, 0, 3], [-3, 2.2, 1], [3, -2.2, 1], [-18, -12, 2], [18, 12, 2], [-23.5, 8.5, 2], [23.5, -8.5, 2],
    [-9, 12, 1], [9, -12, 1], [-8, -7, 1], [8, 7, 1], [-11, -16, 1], [11, 16, 1], [-26, 0, 0], [26, 0, 0]],
};
