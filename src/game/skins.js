/* ============================================================================
   Skins: five free, and hundreds more bought with headshots, up to a single
   ultimate at 750.

   A skin dresses three things at once: your guns (the parts a real camo
   covers - receiver, furniture, handguard; never the bore, bolt, brass or
   glass), and your operator's fatigues
   and gear, seen from the waist down when you look at your feet and in full in
   a killcam. Bots keep their faction colours, so a team still reads at a glance.

   Headshot kills are the currency. Each one is banked for good (localStorage);
   unlocking a skin spends from the bank.
   ========================================================================== */
import * as THREE from 'three';
import { withCamo } from './camo.js';

export const SKINS = [
  { id: 'standard', name: 'STANDARD ISSUE', cost: 0, swatch: '#3a3f42', desc: 'Factory finish, faction fatigues.' },
  { id: 'woodland', name: 'WOODLAND', cost: 0, swatch: '#4d5a36', desc: 'Four-colour woodland blotch.',
    camo: { pat: 'blotch', pal: [0x6b6a45, 0x3d4a2a, 0x5a4330, 0x1e211a], seed: 11 }, suit: 0xa3ab8c, gear: 0x4a5236 },
  { id: 'desert', name: 'DESERT', cost: 0, swatch: '#b39a6b', desc: 'Three-colour arid pattern.',
    camo: { pat: 'blotch', pal: [0xc8b088, 0xa4865c, 0x7a6244], seed: 23 }, suit: 0xd3c09c, gear: 0x9c8660 },
  { id: 'arctic', name: 'ARCTIC', cost: 0, swatch: '#d5dbe0', desc: 'Snow white over grey rock.',
    camo: { pat: 'blotch', pal: [0xe6eaee, 0xb9c1c8, 0x7d8790], seed: 37 }, suit: 0xe4e8ec, gear: 0xc9d0d6 },
  { id: 'digital', name: 'URBAN DIGITAL', cost: 0, swatch: '#7e858a', desc: 'Pixelated greys for the city.',
    camo: { pat: 'digital', pal: [0x2e3236, 0x565c61, 0x80868b, 0xaab0b4], seed: 41 }, suit: 0x9ea4a8, gear: 0x55595c },
  { id: 'tiger', name: 'TIGER STRIPE', cost: 1, swatch: '#c9782e', desc: 'Orange and black. Impossible to miss.',
    camo: { pat: 'stripes', pal: [0xd08632, 0x1a1512, 0x8a4a1c], seed: 53 }, suit: 0xd8a060, gear: 0x3a2a1c },
  { id: 'nightops', name: 'NIGHT OPS', cost: 2, swatch: '#22262a', desc: 'Charcoal on black, made for the dark.',
    camo: { pat: 'digital', pal: [0x0e1012, 0x1b1e21, 0x2a2e32, 0x3a3f44], seed: 61 }, suit: 0x3a3e42, gear: 0x16181a },
  { id: 'carbon', name: 'CARBON', cost: 2, swatch: '#1c1e20', desc: 'Woven carbon fibre under clear coat.',
    camo: { pat: 'carbon', pal: [0x0d0e0f, 0x3a3d40] }, look: { rough: 0.32, metal: 0.25 }, suit: 0x2c2f32, gear: 0x121314 },
  { id: 'dragon', name: 'RED DRAGON', cost: 3, swatch: '#9e1f1f', desc: 'Crimson scales edged in black.',
    camo: { pat: 'scales', pal: [0xa3201f, 0x160c0c] }, look: { rough: 0.38, metal: 0.35 }, suit: 0x8a2a24, gear: 0x1a0e0e },
  { id: 'jungle', name: 'JUNGLE', cost: 3, swatch: '#2f6b3a', desc: 'Deep greens from the canopy floor.',
    camo: { pat: 'blotch', pal: [0x2e5a2c, 0x4f7f3a, 0x17301a, 0x6a8c4a], seed: 71, cells: 7 }, suit: 0x6f8f5c, gear: 0x24401f },
  { id: 'ocean', name: 'DEEP OCEAN', cost: 4, swatch: '#1f4f7a', desc: 'Navy and teal, cut like waves.',
    camo: { pat: 'blotch', pal: [0x173a5c, 0x2a6a8a, 0x0c1d30, 0x4f94a8], seed: 83 }, suit: 0x5a7c98, gear: 0x14283c },
  { id: 'volcanic', name: 'VOLCANIC', cost: 5, swatch: '#ff6a1a', desc: 'Black rock split by glowing magma.',
    camo: { pat: 'cracks', pal: [0x151112, 0xff6a1a], seed: 97 }, look: { glow: 2.2, rough: 0.6 }, suit: 0x3a2a26, gear: 0x120c0c },
  { id: 'neon', name: 'NEON SYNTH', cost: 6, swatch: '#b04cff', desc: 'A lit grid in cyan and violet.',
    camo: { pat: 'neon', pal: [0x0b0714, 0x2ee6ff, 0xb04cff], seed: 101 }, look: { glow: 2.6, rough: 0.35, metal: 0.3 }, suit: 0x3c2a5a, gear: 0x120c1c },
  { id: 'chrome', name: 'CHROME', cost: 8, swatch: '#d8dde2', desc: 'Polished mirror steel.',
    camo: { pat: 'brushed', pal: [0xffffff], seed: 7 }, look: { color: 0xdfe4e8, metal: 1.0, rough: 0.12, env: 1.4 }, suit: 0x8d949a, gear: 0xb8c0c6 },
  { id: 'gold', name: 'GOLD', cost: 10, swatch: '#e0b040', desc: 'Solid gold. You earned it.',
    camo: { pat: 'brushed', pal: [0xffffff], seed: 9 }, look: { color: 0xffc34d, metal: 1.0, rough: 0.2, env: 1.5 }, suit: 0xc9a24a, gear: 0x8a6a22 },
];
/* ---- the rest of the collection ---------------------------------------------
   Every finish in every colourway: twelve finishes x twenty-six colourways,
   priced by how much work the finish is and how rare the colourway (earth tones
   cheapest, neon dearest). Then a shelf of hand-made legendaries and one
   ultimate. Ids are stable, so what you have unlocked stays unlocked when the
   list grows. */
const PALETTES = [
  { id: 'forest', name: 'FOREST', kind: 'earth', pal: [0x2f3b24, 0x4f6136, 0x6f7a4a, 0x1b2016], say: 'forest greens' },
  { id: 'sahara', name: 'SAHARA', kind: 'earth', pal: [0xc8aa78, 0xa3845a, 0x7d6444, 0xe0cda6], say: 'desert sand' },
  { id: 'slate', name: 'SLATE', kind: 'earth', pal: [0x3c4248, 0x5b636b, 0x7e878f, 0x23272b], say: 'slate grey' },
  { id: 'tundra', name: 'TUNDRA', kind: 'earth', pal: [0xdfe5ea, 0xaab4bd, 0x76828c, 0xf4f7f9], say: 'snow and rock' },
  { id: 'mud', name: 'MUD', kind: 'earth', pal: [0x4a3a2a, 0x6b5539, 0x8c7250, 0x2c2218], say: 'wet earth' },
  { id: 'olive', name: 'OLIVE', kind: 'earth', pal: [0x556b2f, 0x6b7f3a, 0x3d4a22, 0x8a9a5b], say: 'olive drab' },
  { id: 'crimson', name: 'CRIMSON', kind: 'bright', pal: [0x8e1a1a, 0xc42b2b, 0x4a0d0d, 0xe05a4a], say: 'deep reds' },
  { id: 'cobalt', name: 'COBALT', kind: 'bright', pal: [0x1d3f8a, 0x2f65c8, 0x0f2150, 0x6f9be8], say: 'cobalt blue' },
  { id: 'ember', name: 'EMBER', kind: 'bright', pal: [0xd9531e, 0xf08c2a, 0x7a2410, 0xffc15a], say: 'fire orange' },
  { id: 'jade', name: 'JADE', kind: 'bright', pal: [0x1f7a5a, 0x2fae7f, 0x0e3f2d, 0x7fe0b5], say: 'jade green' },
  { id: 'violet', name: 'VIOLET', kind: 'bright', pal: [0x5b2a8a, 0x8a4fcf, 0x2a1245, 0xc9a2f0], say: 'violet' },
  { id: 'sunset', name: 'SUNSET', kind: 'bright', pal: [0xff7e5f, 0xfeb47b, 0x8e2d5a, 0x3a1c4a], say: 'sunset colours' },
  { id: 'reef', name: 'REEF', kind: 'bright', pal: [0x0f4c75, 0x3282b8, 0x0b2a3f, 0xbbe1fa], say: 'ocean blues' },
  { id: 'rose', name: 'ROSE', kind: 'bright', pal: [0xd6687f, 0xf2a6b8, 0x7a2e45, 0xffe0e8], say: 'rose pink' },
  { id: 'candy', name: 'CANDY', kind: 'bright', pal: [0xff5fa2, 0x5fd3ff, 0xfff05f, 0x9b5fff], say: 'candy colours' },
  { id: 'aureate', name: 'AUREATE', kind: 'metal', pal: [0xffcf5a, 0xd49a2a, 0x8a5c12, 0xfff0b0], say: 'gold' },
  { id: 'mirror', name: 'MIRROR', kind: 'metal', pal: [0xe6ebef, 0xb8c0c7, 0x7d868e, 0xffffff], say: 'polished chrome' },
  { id: 'bronze', name: 'BRONZE', kind: 'metal', pal: [0xb5793a, 0x8a5424, 0x5a3414, 0xe0a86a], say: 'bronze' },
  { id: 'copper', name: 'COPPER', kind: 'metal', pal: [0xd4764a, 0xa3502a, 0x6e2e16, 0xf2b08a], say: 'copper' },
  { id: 'rosegold', name: 'ROSE GOLD', kind: 'metal', pal: [0xe8b4a0, 0xc98a78, 0x9a5e50, 0xfbe0d4], say: 'rose gold' },
  { id: 'gunmetal', name: 'GUNMETAL', kind: 'metal', pal: [0x4b5158, 0x2f3338, 0x6c737a, 0x1c1f22], say: 'gunmetal' },
  { id: 'toxic', name: 'TOXIC', kind: 'neon', pal: [0x0b120a, 0x7dff3a, 0x2a4f1a, 0xd4ff5a], say: 'toxic green light' },
  { id: 'plasma', name: 'PLASMA', kind: 'neon', pal: [0x0a0716, 0xb04cff, 0x2ee6ff, 0xff4cd2], say: 'plasma light' },
  { id: 'void', name: 'VOID', kind: 'neon', pal: [0x050508, 0x3a2f7a, 0x8a6aff, 0x00e0ff], say: 'void and starlight' },
  { id: 'inferno', name: 'INFERNO', kind: 'neon', pal: [0x120605, 0xff3a0a, 0xffb020, 0xff6a1a], say: 'burning light' },
  { id: 'cryo', name: 'CRYO', kind: 'neon', pal: [0x06121c, 0x5ad8ff, 0xc8f4ff, 0x2a7fff], say: 'icy light' },
];
const FINISHES = [
  { id: 'camo', pat: 'blotch', name: 'CAMO', base: 4, say: 'Blotch camouflage' },
  { id: 'digital', pat: 'digital', name: 'DIGITAL', base: 6, say: 'Pixel camouflage' },
  { id: 'tiger', pat: 'stripes', name: 'TIGER', base: 8, say: 'Tiger stripes' },
  { id: 'spots', pat: 'spots', name: 'SPOTS', base: 10, say: 'Rosette spots' },
  { id: 'hex', pat: 'hex', name: 'HEX', base: 12, say: 'Hexagon plating' },
  { id: 'weave', pat: 'carbon', name: 'WEAVE', base: 14, say: 'Woven fibre' },
  { id: 'marble', pat: 'marble', name: 'MARBLE', base: 18, say: 'Veined marble' },
  { id: 'scale', pat: 'scales', name: 'SCALE', base: 22, say: 'Overlapping scales' },
  { id: 'circuit', pat: 'circuit', name: 'CIRCUIT', base: 28, say: 'A circuit board' },
  { id: 'damascus', pat: 'damascus', name: 'DAMASCUS', base: 34, say: 'Folded damascus layers' },
  { id: 'shard', pat: 'shard', name: 'SHARD', base: 40, say: 'Crystal facets' },
  { id: 'nebula', pat: 'nebula', name: 'NEBULA', base: 48, say: 'Deep-space clouds and stars' },
];
const KIND = {
  earth: { mult: 1, look: {} },
  bright: { mult: 2, look: { rough: 0.45, metal: 0.2 } },
  metal: { mult: 3.5, look: { metal: 0.95, rough: 0.28, env: 1.3 } },
  neon: { mult: 4.5, look: { glow: 2.0, rough: 0.35, metal: 0.25 } },
};
const nice = (v) => (v < 20 ? Math.round(v) : v < 100 ? Math.round(v / 5) * 5 : Math.round(v / 10) * 10);
const hex6 = (h) => '#' + h.toString(16).padStart(6, '0');
PALETTES.forEach((P, pi) => FINISHES.forEach((F, fi) => {
  const K = KIND[P.kind];
  SKINS.push({
    id: 'g-' + P.id + '-' + F.id, name: P.name + ' ' + F.name, cost: nice(F.base * K.mult),
    swatch: hex6(P.pal[1]), desc: F.say + ' in ' + P.say + '.',
    camo: { pat: F.pat, pal: P.pal, seed: 1000 + pi * 37 + fi * 11 }, look: { ...K.look },
    suit: P.pal[1], gear: P.pal[3],
  });
}));
SKINS.push(
  { id: 'lg-damascus', name: 'DAMASCUS STEEL', cost: 250, swatch: '#9aa3ab', desc: 'Hand-folded steel, a hundred layers deep.',
    camo: { pat: 'damascus', pal: [0x3a3f45, 0xc9d1d8], seed: 71 }, look: { color: 0xffffff, metal: 1.0, rough: 0.22, env: 1.5 }, suit: 0x8d949a, gear: 0x2a2d30 },
  { id: 'lg-frostbite', name: 'FROSTBITE', cost: 260, swatch: '#9fe6ff', desc: 'Glacier crystal that holds a cold light.',
    camo: { pat: 'shard', pal: [0x0c2438, 0x2f6f9a, 0x9fe6ff, 0xe8fbff], seed: 73, cells: 6 }, look: { glow: 1.3, rough: 0.2, metal: 0.4, env: 1.2 }, suit: 0xbfe8f5, gear: 0x1c3446 },
  { id: 'lg-venom', name: 'VENOM', cost: 280, swatch: '#7dff3a', desc: 'Toxic scales that glow in the dark.',
    camo: { pat: 'scales', pal: [0x3aa01a, 0x050805], seed: 77 }, look: { glow: 1.8, rough: 0.3, metal: 0.3 }, suit: 0x5a7a3a, gear: 0x0a0f08 },
  { id: 'lg-electric', name: 'ELECTRIC', cost: 300, swatch: '#2ee6ff', desc: 'Live circuitry: the current runs across it.',
    camo: { pat: 'circuit', pal: [0x040a12, 0x2ee6ff, 0xffffff, 0x0a1a2a], seed: 79 }, look: { glow: 2.8, pulse: 0.6, flow: [0.25, 0, 0.1], rough: 0.3, metal: 0.4 }, suit: 0x2a4a6a, gear: 0x071018 },
  { id: 'lg-prism', name: 'PRISM', cost: 320, swatch: '#ff7ad9', desc: 'Every facet a different colour, and the colours turn.',
    camo: { pat: 'shard', pal: [0xff4d4d, 0xffb84d, 0xfff34d, 0x4dff88, 0x4dc9ff, 0xa64dff, 0xffffff], seed: 83, cells: 6 }, look: { glow: 0.8, hue: 0.4, rough: 0.18, metal: 0.5, env: 1.2 }, suit: 0xd8b8e8, gear: 0x3a2a4a },
  { id: 'lg-aurora', name: 'AURORA', cost: 350, swatch: '#3affb0', desc: 'The northern lights, drifting across the steel.',
    camo: { pat: 'aurora', pal: [0x03060d, 0x3affb0, 0xb04cff], seed: 89 }, look: { glow: 2.2, flow: [0, 0.08, 0.05], rough: 0.3, metal: 0.3 }, suit: 0x2a4a5a, gear: 0x06101a },
  { id: 'lg-bloodmoon', name: 'BLOOD MOON', cost: 375, swatch: '#b0101a', desc: 'A red nebula under a dying star.',
    camo: { pat: 'nebula', pal: [0x080203, 0x8a0f14, 0xff5a3a, 0xffd0c0], seed: 97 }, look: { glow: 1.6, flow: [0.03, 0.02, 0], rough: 0.35, metal: 0.3 }, suit: 0x6a2a2a, gear: 0x140606 },
  { id: 'lg-molten', name: 'MOLTEN CORE', cost: 420, swatch: '#ff5a0a', desc: 'Magma running through the cracks. It moves.',
    camo: { pat: 'cracks', pal: [0x100806, 0xff6a0a], seed: 101 }, look: { glow: 3.0, pulse: 0.35, flow: [0.06, -0.04, 0.02], rough: 0.55 }, suit: 0x3a2622, gear: 0x0e0808 },
  { id: 'lg-golddragon', name: 'GOLDEN DRAGON', cost: 500, swatch: '#ffcf5a', desc: 'Scales of solid gold.',
    camo: { pat: 'scales', pal: [0xffd46a, 0x6a4410], seed: 103 }, look: { color: 0xffffff, metal: 1.0, rough: 0.18, env: 1.6 }, suit: 0xd8b060, gear: 0x6a4a18 },
  { id: 'ultimate-singularity', name: 'SINGULARITY', cost: 750, ultimate: true, swatch: '#8a6aff',
    desc: 'A galaxy caught in the metal: the stars drift, the colours turn, the light breathes. The rarest thing in the game.',
    camo: { pat: 'nebula', pal: [0x030208, 0x3a1a8a, 0x00d0ff, 0xffffff], seed: 777 },
    look: { glow: 2.6, pulse: 0.45, hue: 0.25, flow: [0.04, 0.03, 0.02], rough: 0.2, metal: 0.55, env: 1.3 }, suit: 0x3a2a6a, gear: 0x0a0616 },
);
/* how rare a skin is, from what it costs; the SKINS tab filters and colours by it */
export const RARITY = ['free', 'common', 'rare', 'epic', 'legendary', 'ultimate'];
export const rarity = (s) => (s.ultimate ? 'ultimate' : !s.cost ? 'free' : s.cost <= 15 ? 'common' : s.cost <= 60 ? 'rare' : s.cost <= 200 ? 'epic' : 'legendary');
export const SKIN_BY_ID = Object.fromEntries(SKINS.map(s => [s.id, s]));
const FREE = new Set(SKINS.filter(s => !s.cost).map(s => s.id));


/* ---- the bank ------------------------------------------------------------
   Your profile is kept twice: in the browser's localStorage and, when the game
   is served by tools/serve.mjs, in save/profile.json next to the game. The
   file outlives the browser forgetting its storage (a cleared cache, another
   browser, an app that starts every session fresh). syncProfile() runs once
   at boot and keeps whichever copy has earned more headshots. */
const KEY = 'obk.profile.v1', SAVE_URL = '/_save/profile';
let fileSave = true;               // off once the server turns out to have no save endpoint
function normalise(p) {
  p = p && typeof p === 'object' ? p : {};
  return { headshots: Math.max(0, p.headshots | 0), earned: Math.max(0, p.earned | 0),
    unlocked: Array.isArray(p.unlocked) ? p.unlocked.filter(id => SKIN_BY_ID[id]) : [],
    skin: SKIN_BY_ID[p.skin] ? p.skin : 'standard',
    savedAt: Math.max(0, +p.savedAt || 0) };
}
/* The profile is held in memory as well. Where the browser will not keep
   localStorage (blocked, or an app that forgets it mid-session) every read came
   back empty: each headshot banked "+1 (1)" and the bank never grew. */
let memo = null;
export function loadProfile() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { p = null; }
  return normalise(p || memo);
}
/** Forget the in-memory copy (the QA harness puts the real profile back under it). */
export function dropProfileCache() { memo = null; }
function mirror(p) {
  if (!fileSave || typeof fetch !== 'function') return;
  fetch(SAVE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    .then(r => { if (!r.ok) fileSave = false; }, () => { fileSave = false; });
}
export function saveProfile(p) {
  p.savedAt = Date.now();
  memo = JSON.parse(JSON.stringify(p));
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* storage blocked: memory and the file still have it */ }
  mirror(p);
}
/** Once at boot: bring the saved file back if the browser has lost it or fallen behind. */
export async function syncProfile() {
  const local = loadProfile();
  let remote = null;
  try {
    const r = await fetch(SAVE_URL, { cache: 'no-store' });
    if (r.ok) remote = normalise(await r.json());
  } catch (e) { /* no server to ask */ }
  if (!remote) { if (local.earned || local.unlocked.length || local.skin !== 'standard') mirror(local); return local; }
  const best = remote.earned > local.earned || (remote.earned === local.earned && remote.savedAt > local.savedAt) ? remote : local;
  best.unlocked = [...new Set([...local.unlocked, ...remote.unlocked])];
  memo = JSON.parse(JSON.stringify(best));
  try { localStorage.setItem(KEY, JSON.stringify(best)); } catch (e) { /* storage blocked */ }
  if (JSON.stringify(best) !== JSON.stringify(remote)) mirror(best);
  return best;
}
export const isUnlocked = (p, id) => FREE.has(id) || p.unlocked.includes(id);
/** Spend headshots on a skin: { ok, reason: 'owned'|'bought'|'short'|'unknown', short } */
export function unlockSkin(p, id) {
  const s = SKIN_BY_ID[id];
  if (!s) return { ok: false, reason: 'unknown' };
  if (isUnlocked(p, id)) return { ok: true, reason: 'owned' };
  if (p.headshots < s.cost) return { ok: false, reason: 'short', short: s.cost - p.headshots };
  p.headshots -= s.cost; p.unlocked.push(id); saveProfile(p);
  return { ok: true, reason: 'bought' };
}
export function equipSkin(p, id) { if (!isUnlocked(p, id)) return false; p.skin = id; saveProfile(p); return true; }
export function currentSkin(p) { p = p || loadProfile(); return SKIN_BY_ID[p.skin] || SKINS[0]; }
/** Bank one headshot kill; returns the new balance. A page the QA harness has
 *  loaded banks nothing outside its guarded tests: its bots kept fighting between
 *  runs, and their headshots went into the player's real save. */
export function awardHeadshot() {
  if (typeof window !== 'undefined' && window.__qaNoBank) return loadProfile().headshots;
  const p = loadProfile(); p.headshots++; p.earned++; saveProfile(p); return p.headshots;
}

/* ---- dressing things ----------------------------------------------------- */
const CACHE = new Map();
const once = (k, make) => { if (!CACHE.has(k)) CACHE.set(k, make()); return CACHE.get(k); };
const BASE = new WeakMap();                    // mesh -> the material it had before any skin
const baseOf = (o) => { if (!BASE.has(o)) BASE.set(o, o.material); return BASE.get(o); };
const mapMat = (mat, fn) => (Array.isArray(mat) ? mat.map(fn) : fn(mat));
const local = (m) => { m.userData.localOnly = true; return m; };
const weaponParts = (char) => { const s = new Set(); if (char.weaponModel) char.weaponModel.traverse(o => s.add(o)); return s; };
/* what a camo covers: polymer, furniture, the blued receiver. Bright steel
   (bore, bolt, slide), glass and anything already glowing stay factory. */
export const skinnable = (m) => !!m && !!m.isMeshStandardMaterial && !m.transparent && m.metalness < 0.88 &&
  !(m.emissive && m.emissive.getHex() !== 0);
const gunLook = (s) => ({ ...s, look: { color: 0xe8e8e8, metal: 0.12, rough: 0.66, ...(s.look || {}) } });
/* cloth: a pattern multiplied over the fatigues' own dark texture came out
   near black. The base goes halfway to white and the pattern is lifted to a
   set mean brightness (norm): a dark woodland reads as cloth, an arctic white
   is left alone, and NIGHT OPS stays dark because the lift is capped. */
const light = (hex, k, to = 0xffffff) => new THREE.Color(hex).lerp(new THREE.Color(to), k).getHex();
const suitLook = (s) => ({ ...s, look: { color: light(s.suit ?? 0xffffff, 0.5), rough: 0.9, metal: 0.02, norm: 0.3 } });

/** Camo onto a weapon tree; the standard skin puts the factory materials back. */
export function skinWeapon(root, skin) {
  root.traverse(o => {
    if (!o.isMesh) return;
    o.material = mapMat(baseOf(o), (b) => skin && skin.camo && skinnable(b)
      ? once('gun|' + b.uuid + '|' + skin.id, () => withCamo(b, gunLook(skin), 4)) : b);
  });
}

/** Your operator: camo over the fatigues' own cloth, the skin's colour on the gear. */
export function skinOperator(char, skin) {
  if (!char) return;
  char.onWeapon = (model) => skinWeapon(model, skin);
  if (char.weaponModel) skinWeapon(char.weaponModel, skin);
  const skip = weaponParts(char);
  char.model.traverse(o => {
    if (!o.isMesh || skip.has(o) || o.userData.fpCut) return;
    o.material = mapMat(baseOf(o), (b) => {
      if (!skin || !skin.camo) return b;
      if (o.isSkinnedMesh) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const sz = o.geometry.boundingBox.getSize(new THREE.Vector3()), big = Math.max(sz.x, sz.y, sz.z) || 1;
        return once('suit|' + b.uuid + '|' + skin.id, () => local(withCamo(b, suitLook(skin), 4 / big)));
      }
      return once('gear|' + b.uuid + '|' + skin.id, () => { const m = b.clone(); m.color = new THREE.Color(skin.gear ?? 0x444444); return local(m); });
    });
  });
  if (char._firstPerson) firstPersonBody(char);
}

/* Your body in first person: your legs, and your left arm when it has
   something to do. The camera sits inside the head, so the upper body must not
   reach your own view - and clipping it away was not enough: the torso and
   head wrap round the camera, so all of their triangles were still rasterised
   and discarded pixel by pixel (+1.8 to +3.3 ms at 1080p, measured). Instead
   the body mesh is cut once, by skin weight, into twins that share its
   vertices: your body from the stomach down (layer 6, always in your view) and
   the left arm and hand (layer 7, drawn by main.js in a pass of its own while
   you punch or climb). The whole body and every piece of gear go to layer 5:
   the shadow pass and a killcam, never your own view. The first cut kept the
   hips and the belt gear, and looking straight down the pelvis and pouches
   read as somebody's helmet and shoulders under you. With the stomach in the
   cut and the gear hidden, looking down reads as your own body. */
const CUTS = [
  { key: 'fpLegs', re: /(Hips|Spine$|UpLeg|Leg|Foot|Toe)/, layer: 6 },
  { key: 'fpArm', re: /Left(Fore)?Arm|LeftHand/, layer: 7 },
];
const TWINS = new WeakMap();                   // body mesh -> { fpLegs, fpArm }
const comp = (at, v, k) => (k === 0 ? at.getX(v) : k === 1 ? at.getY(v) : k === 2 ? at.getZ(v) : at.getW(v));
function makeCut(body, c) {
  const g = body.geometry, pick = body.skeleton.bones.map(bn => c.re.test(bn.name));
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, n = g.attributes.position.count;
  const keep = new Uint8Array(n), dom = new Uint16Array(n);
  for (let v = 0; v < n; v++) {
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) { const w = comp(sw, v, k); if (w > bw) { bw = w; best = comp(si, v, k); } }
    dom[v] = best; keep[v] = pick[best] ? 1 : 0;
  }
  const idx = g.index ? g.index.array : null, count = idx ? idx.length : n, out = [];
  for (let t = 0; t < count; t += 3) {
    const i0 = idx ? idx[t] : t, i1 = idx ? idx[t + 1] : t + 1, i2 = idx ? idx[t + 2] : t + 2;
    if (keep[i0] && keep[i1] && keep[i2]) out.push(i0, i1, i2);
  }
  const cg = new THREE.BufferGeometry();
  for (const name in g.attributes) cg.setAttribute(name, g.attributes[name]);   // shared, not copied
  cg.setIndex(out);
  const m = new THREE.SkinnedMesh(cg, body.material);
  m.name = c.key; m.userData.fpCut = true; m.userData[c.key] = true;
  m.position.copy(body.position); m.quaternion.copy(body.quaternion); m.scale.copy(body.scale);
  m.bindMode = body.bindMode;
  m.bind(body.skeleton, body.bindMatrix);
  m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true;
  m.layers.set(c.layer);
  body.parent.add(m);
  return m;
}
export function firstPersonBody(char) {
  char._firstPerson = true;
  const skip = weaponParts(char), bodies = [];
  char.model.traverse(o => {
    if (!o.isMesh || skip.has(o) || o.userData.fpCut) return;
    o.layers.set(5);
    if (o.isSkinnedMesh && o !== char.visorMesh) bodies.push(o);
  });
  for (const body of bodies) {
    if (!TWINS.has(body)) TWINS.set(body, Object.fromEntries(CUTS.map(c => [c.key, makeCut(body, c)])));
    for (const twin of Object.values(TWINS.get(body))) {
      twin.material = body.material;           // follows the skin
      // seen into an open end (the tops of the thighs, the shoulder): draw both
      // sides. This operator's own materials (per-operator clone or local skin).
      mapMat(twin.material, (m) => { m.side = THREE.DoubleSide; m.shadowSide = THREE.BackSide; m.needsUpdate = true; return m; });
    }
  }
}
