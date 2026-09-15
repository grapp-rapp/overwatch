/* ============================================================================
   The playable maps.

   Each is a definition GameMap builds from: size, layout (describe), the
   decorative pass, sky and light (env), extra surfaces, zone names for the
   tactical map, the hotspots the AI patrols between, and the high ground the
   map walk must prove is reachable. Nothing here imports the builder - a
   definition only ever receives it - so there is no import cycle.
   ========================================================================== */
import { DUSTLINE } from '../map.js';
import { TIMBERLINE } from './timberline.js';
import { WHITEOUT } from './whiteout.js';
import { FOUNDRY } from './foundry.js';
import { TRENCHLINE } from './trenchline.js';

export const MAPS = { dustline: DUSTLINE, timberline: TIMBERLINE, whiteout: WHITEOUT, foundry: FOUNDRY, trenchline: TRENCHLINE };
export const MAP_ORDER = ['dustline', 'timberline', 'whiteout', 'foundry', 'trenchline'];
