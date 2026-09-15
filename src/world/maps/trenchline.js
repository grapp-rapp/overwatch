/* ============================================================================
   MP_TRENCHLINE - a fortified hilltop.

   Stone-walled trenches zigzag over a hill of pines and olives. From each
   side's sunken yard one line runs to the command bunker in the middle, and
   one over the north slope and down into the other side's centre line; the
   trenches are deep and tunnels run under the hill between them. There are
   bunkers with firing slits at ground level, covered stretches to fight
   through by lamplight, and the open hill above, where you are fast
   and seen. 180-degree rotational symmetry, like every map here.
   ========================================================================== */
import { describeTrenchline, W, D } from './trenchline-layout.js';

export const TRENCHLINE = {
  id: 'trenchline', name: 'TRENCHLINE', code: 'MP_TRENCHLINE', swatch: '#9a9468',
  blurb: 'A fortified hill: deep stone trenches, tunnels under the hill, bunkers with firing slits.',
  w: W, d: D, describe: describeTrenchline, materials: ['stonewall', 'capstone', 'hillside', 'rock'],
  navCentre: true,          // navmesh nodes need their centre over a surface: the hill is all edges (map.js _buildNav)
  /* the roofs of the centre-line tunnels and of the command bunker: climbable from the hill */
  mustReach: [[-13, -2, 3.2], [13, 2, 3.2], [-1.5, 0, 3.2]],
  env: {
    sky: { zenith: [92, 136, 190], horizon: [208, 210, 198], ground: [62, 58, 46],
      cloud: [238, 238, 232], cover: 0.28, gain: 2.5, seed: 0x7E4 },
    fog: [0xb9bdb0, 32, 150], hemi: [0xd8ded2, 0x4c4636, 0.92],
    sun: [0xfff2dc, 3.1], sunDir: [-36, 62, 28], exposure: 1.02,
  },
  zones: [['COMMAND BUNKER', 0, 0], ['WEST YARD', -29, 0], ['EAST YARD', 29, 0],
    ['OBSERVATION POST', -14.75, 18.75], ['OBSERVATION POST', 14.75, -18.75],
    ['NORTH LINE', -16, 12.5], ['SOUTH LINE', 16, -12.5], ['TUNNEL', -13, -2], ['TUNNEL', 13, 2],
    ['THE HILL', -8, 6], ['THE HILL', 8, -6], ['CROSS TUNNEL', -13, 5], ['CROSS TUNNEL', 13, -5],
    ['CENTRE TUNNEL', 0, 7], ['CENTRE TUNNEL', 0, -7]],
  hotspots: [[0, 0, 3], [-13, -2, 2], [13, 2, 2], [-9, 16, 2], [9, -16, 2], [-14.75, 18.75, 2], [14.75, -18.75, 2],
    [-16, -7, 1], [16, 7, 1], [-20, 8, 1], [20, -8, 1], [-6, 12, 1], [6, -12, 1], [-10, -5.5, 1], [10, 5.5, 1],
    [-8, 6, 1], [8, -6, 1], [-13, 5, 2], [13, -5, 2], [0, 7, 2], [0, -7, 2], [-26, 0, 0], [26, 0, 0]],
};
