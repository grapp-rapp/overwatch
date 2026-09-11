/* ============================================================================
   Skins: fifteen looks, five free and ten bought with headshots.

   A skin dresses three things at once: your guns (the parts a real camo
   covers - receiver, furniture, handguard; never the bore, bolt, brass or
   glass), the sleeve of your punching arm, and your operator's fatigues
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
export const SKIN_BY_ID = Object.fromEntries(SKINS.map(s => [s.id, s]));
const FREE = new Set(SKINS.filter(s => !s.cost).map(s => s.id));

/* the bare hand you punch with, in your own skin tone (SKINS tab) */
export const HAND_TONES = [
  { id: 'porcelain', hex: 0xf1cfb9 }, { id: 'light', hex: 0xe3b28f }, { id: 'medium', hex: 0xc68b64 },
  { id: 'olive', hex: 0xa6764e }, { id: 'brown', hex: 0x7a4e33 }, { id: 'deep', hex: 0x4b2f21 },
];
const TONE_BY_ID = Object.fromEntries(HAND_TONES.map(t => [t.id, t]));
export const handTone = (p) => (TONE_BY_ID[(p || loadProfile()).hand] || TONE_BY_ID.medium).hex;
export function setHandTone(p, id) { if (!TONE_BY_ID[id]) return false; p.hand = id; saveProfile(p); return true; }

/* ---- the bank ------------------------------------------------------------ */
const KEY = 'obk.profile.v1';
export function loadProfile() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { p = null; }
  p = p && typeof p === 'object' ? p : {};
  return { headshots: Math.max(0, p.headshots | 0), earned: Math.max(0, p.earned | 0),
    unlocked: Array.isArray(p.unlocked) ? p.unlocked.filter(id => SKIN_BY_ID[id]) : [],
    skin: SKIN_BY_ID[p.skin] ? p.skin : 'standard', hand: TONE_BY_ID[p.hand] ? p.hand : 'medium' };
}
export function saveProfile(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* storage blocked */ } }
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
/** Bank one headshot kill; returns the new balance. */
export function awardHeadshot() { const p = loadProfile(); p.headshots++; p.earned++; saveProfile(p); return p.headshots; }

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
    if (!o.isMesh || skip.has(o) || o.userData.fpLegs) return;
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

/* Your body in first person is your legs. The camera sits inside the head,
   so the upper body must not reach your own view - and clipping it away was
   not enough: the torso and head wrap round the camera, so all of their
   triangles were still rasterised and discarded pixel by pixel (+1.8 to
   +3.3 ms at 1080p, measured). Instead the body mesh is split once, by skin
   weight: triangles held by the hip and leg bones become a legs-only mesh on
   layer 6, which only your own camera draws. The whole body and any gear
   above the waist move to layer 5: still in the shadow pass and a killcam,
   never in your own view. */
const LOWER = /(Hips|UpLeg|Leg|Foot|Toe)/;
const LEGS = new WeakMap();                    // body mesh -> its legs-only twin
const comp = (at, v, k) => (k === 0 ? at.getX(v) : k === 1 ? at.getY(v) : k === 2 ? at.getZ(v) : at.getW(v));
function makeLegs(body) {
  const g = body.geometry, lower = body.skeleton.bones.map(bn => LOWER.test(bn.name));
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, n = g.attributes.position.count;
  const keep = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) { const w = comp(sw, v, k); if (w > bw) { bw = w; best = comp(si, v, k); } }
    keep[v] = lower[best] ? 1 : 0;
  }
  const idx = g.index ? g.index.array : null, count = idx ? idx.length : n, out = [];
  for (let t = 0; t < count; t += 3) {
    const i0 = idx ? idx[t] : t, i1 = idx ? idx[t + 1] : t + 1, i2 = idx ? idx[t + 2] : t + 2;
    if (keep[i0] && keep[i1] && keep[i2]) out.push(i0, i1, i2);
  }
  const lg = new THREE.BufferGeometry();
  for (const name in g.attributes) lg.setAttribute(name, g.attributes[name]);   // shared, not copied
  lg.setIndex(out);
  const legs = new THREE.SkinnedMesh(lg, body.material);
  legs.name = 'fpLegs'; legs.userData.fpLegs = true;
  legs.position.copy(body.position); legs.quaternion.copy(body.quaternion); legs.scale.copy(body.scale);
  legs.bindMode = body.bindMode;
  legs.bind(body.skeleton, body.bindMatrix);
  legs.frustumCulled = false; legs.castShadow = false; legs.receiveShadow = true;
  legs.layers.set(6);
  body.parent.add(legs);
  return legs;
}
export function firstPersonBody(char) {
  char._firstPerson = true;
  const skip = weaponParts(char);
  char.model.updateMatrixWorld(true);
  const hipY = char.bones.Hips ? char.bones.Hips.getWorldPosition(new THREE.Vector3()).y : 0;
  const box = new THREE.Box3(), bodies = [];
  char.model.traverse(o => {
    if (!o.isMesh || skip.has(o) || o.userData.fpLegs) return;
    if (o.isSkinnedMesh) { o.layers.set(5); if (o !== char.visorMesh) bodies.push(o); }
    else if (box.setFromObject(o).max.y > hipY + 0.2) o.layers.set(5);
  });
  for (const body of bodies) {
    if (!LEGS.has(body)) LEGS.set(body, makeLegs(body));
    const legs = LEGS.get(body);
    legs.material = body.material;             // follows the skin
    // seen from above, into an open waist: draw both sides of the cloth. These
    // are this operator's own materials (per-operator clone or a local skin).
    mapMat(legs.material, (m) => { m.side = THREE.DoubleSide; m.shadowSide = THREE.BackSide; m.needsUpdate = true; return m; });
  }
}

/** The punching arm's sleeve. */
export function skinMaterialFor(part, skin) {
  return once('fist|' + part + '|' + (skin ? skin.id : 'standard'), () => {
    const base = new THREE.MeshStandardMaterial({ color: 0x8c9678, roughness: 0.92, metalness: 0 });
    return skin && skin.camo ? withCamo(base, suitLook(skin), 7) : base;
  });
}
