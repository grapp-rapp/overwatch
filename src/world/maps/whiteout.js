/* ============================================================================
   MP_WHITEOUT - an arctic radar station on a snowfield.

   Brighter and more open than the other maps: long sightlines down the cleared
   track, snow banks and berms for cover, two station modules to clear room by
   room, and a radar tower in the middle with nothing to hide behind but its
   own plinth. Low sun, white fog, blue shadows off the snow.
   ========================================================================== */
import { describeWhiteout, W, D } from './whiteout-layout.js';

export const WHITEOUT = {
  id: 'whiteout', name: 'WHITEOUT', code: 'MP_WHITEOUT', swatch: '#b8cfe0',
  blurb: 'An arctic radar station. Long lanes over snow, labs to clear, a tower with nowhere to hide.',
  w: W, d: D, describe: describeWhiteout, materials: ['snow', 'rock'],
  /* designed places the map walk must be able to reach: the plinth top and both labs */
  mustReach: [[0, 1.2, 0.6], [-20, -11.5, 0.4], [20, 11.5, 0.4]],
  env: {
    sky: { zenith: [148, 170, 196], horizon: [224, 232, 240], ground: [196, 206, 216],
      cloud: [238, 242, 246], cover: 0.34, gain: 2.0, seed: 0x3C0 },
    fog: [0xd6dde4, 30, 150], hemi: [0xdfe9f5, 0x98a6b6, 1.15],
    sun: [0xfff2e2, 2.4], sunDir: [-62, 30, 22], exposure: 0.95,
  },
  zones: [['RADAR', 0, -4.8], ['RED LAB', -20, -15.8], ['RED LAB', 20, 15.8], ['QUARTERS', -21, 9.8],
    ['QUARTERS', 21, -9.8], ['FUEL FARM', -10, 18.6], ['FUEL FARM', 10, -18.6]],
  hotspots: [[0, 0, 3], [-20, -11.5, 2], [20, 11.5, 2], [-21, 5.5, 2], [21, -5.5, 2], [-10, 12, 1], [10, -12, 1],
    [-10, -7.6, 1], [10, 7.6, 1], [-11.5, -5.2, 1], [11.5, 5.2, 1], [-4, -12, 1], [4, 12, 1], [-26, 0, 0], [26, 0, 0]],
};
