/* ============================================================================
   MP_FOUNDRY - a steelworks at dusk.

   The most vertical of the maps. A brick furnace hall straddles the rail line
   in the middle: two furnaces throwing orange light, and a catwalk down each
   side that sees the whole floor and the rail doors. Outside, two yards of
   rusted tanks, beam stacks and a slag heap, a smokestack in each far corner
   to navigate by, and a hopper wagon on the rail at each end so the line
   through the hall never becomes a lane from spawn to spawn.
   ========================================================================== */
import { describeFoundry, W, D } from './foundry-layout.js';

export const FOUNDRY = {
  id: 'foundry', name: 'FOUNDRY', code: 'MP_FOUNDRY', swatch: '#c0643a',
  blurb: 'A steelworks at dusk. A furnace hall with catwalks above the floor; yards outside.',
  w: W, d: D, describe: describeFoundry, materials: ['brick', 'rust', 'grate', 'glow', 'rock'],
  /* both catwalks must be reachable by the stairs */
  mustReach: [[-4, -6, 3.45], [4, 6, 3.45]],
  env: {
    sky: { zenith: [70, 66, 84], horizon: [214, 138, 88], ground: [50, 40, 36],
      cloud: [150, 120, 110], cover: 0.42, gain: 2.2, seed: 0xF0D },
    fog: [0x8a6a58, 30, 140], hemi: [0xc8a890, 0x3a2e28, 0.85],
    sun: [0xffb070, 2.6], sunDir: [-58, 26, 34], exposure: 1.05,
  },
  zones: [['FURNACE HALL', 0, -8.4], ['WEST YARD', -18, -3], ['EAST YARD', 18, 3],
    ['OFFICE', -22.5, 17.4], ['OFFICE', 22.5, -17.4], ['STACK', -26, -20.2], ['STACK', 26, 20.2]],
  hotspots: [[0, 0, 3], [-4.5, 1.4, 2], [4.5, -1.4, 2], [-4, -6, 2], [4, 6, 2], [-14, -2.2, 1], [14, 2.2, 1],
    [-22.5, 12.5, 2], [22.5, -12.5, 2], [-20, -11, 1], [20, 11, 1], [-10, -12, 1], [10, 12, 1], [-26, 0, 0], [26, 0, 0]],
};
