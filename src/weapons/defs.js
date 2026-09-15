/* ============================================================================
   Weapon definitions.

   Every number here is tuned so the guns feel measurably different in the hand:
   time-to-kill, recoil shape, spread growth, ADS speed and movement penalty are
   all independent axes. Nothing is shared between two weapons by accident.

   damage:  near dmg held out to nearRange, then linearly falls to far dmg at
            farRange and stays there. Body = 1.0x, head = headMult, limbs = limbMult.
   recoil:  `pattern` is a deterministic, LEARNABLE sequence of [pitch, yaw] kicks
            in degrees, indexed by shot number. Small gaussian jitter is layered on
            top so it is learnable but not literally identical every mag.
   spread:  cone half-angle in degrees. Grows by bloom per shot up to a max, decays
            back at `decay` deg/s. ADS uses its own base/max pair.
   ========================================================================== */

export const FIRE = { AUTO: 'AUTO', SEMI: 'SEMI', BURST: 'BURST', BOLT: 'BOLT', PUMP: 'PUMP' };

/* ---- recoil patterns -------------------------------------------------------
   Authored as short shapes that repeat; index clamps to last element so long
   holds settle into a steady drift you can counter. */
const P = {
  // Classic AR: hard vertical for 5, then drifts right, then a left hook.
  ar_vk: [[1.00, 0.06], [0.92, -0.10], [0.86, 0.16], [0.78, 0.30], [0.70, 0.44],
          [0.62, 0.52], [0.55, 0.44], [0.50, 0.18], [0.46, -0.22], [0.44, -0.52],
          [0.42, -0.66], [0.42, -0.50], [0.42, -0.14], [0.44, 0.26], [0.46, 0.58]],
  // Heavier AR: bigger first kick, tighter lateral, slower settle.
  ar_grad: [[1.34, -0.12], [1.20, 0.22], [1.06, 0.46], [0.94, 0.30], [0.86, -0.16],
            [0.80, -0.50], [0.76, -0.62], [0.74, -0.38], [0.72, 0.10], [0.72, 0.52],
            [0.72, 0.70], [0.74, 0.48]],
  // SMG: low per-shot but very fast, so it climbs quickly. Whippy lateral.
  smg_wasp: [[0.60, 0.20], [0.58, -0.26], [0.56, 0.34], [0.54, -0.38], [0.54, 0.42],
             [0.52, -0.30], [0.52, 0.22], [0.52, -0.44], [0.52, 0.48], [0.52, -0.20]],
  // Shotgun: single huge kick.
  sg: [[3.20, 0.30], [3.10, -0.34]],
  // LMG: brutal opening, then a long stable plateau — reward for holding.
  lmg: [[1.55, 0.10], [1.42, -0.24], [1.26, 0.34], [1.08, 0.46], [0.92, 0.24],
        [0.78, -0.20], [0.66, -0.42], [0.56, -0.30], [0.48, 0.04], [0.42, 0.30],
        [0.38, 0.34], [0.36, 0.18], [0.34, -0.06], [0.33, -0.24], [0.32, -0.18],
        [0.32, 0.06], [0.32, 0.22]],
  dmr: [[1.65, 0.18], [1.58, -0.22], [1.52, 0.26]],
  bolt: [[4.30, 0.42]],
  pistol: [[1.05, 0.16], [1.00, -0.20], [0.98, 0.24]],
  revolver: [[2.85, 0.34], [2.75, -0.38]],
  mpistol: [[0.66, 0.26], [0.64, -0.30], [0.62, 0.36], [0.62, -0.34]],
};

/* ---- weapon list --------------------------------------------------------- */

export const WEAPONS = {

  /* ===================== ASSAULT RIFLES ===================== */
  vk71: {
    id: 'vk71', name: 'VK-71', cls: 'ASSAULT RIFLE', slot: 'primary', kind: 'ar',
    desc: 'The reference rifle. A 730-rpm gas piston carbine with a predictable five-shot climb and a right-hand drift you can hold through a full magazine. Nothing it does is exceptional; nothing it does is bad.',
    rpm: 730, fire: FIRE.AUTO, mag: 30, reserve: 210, pellets: 1,
    damage: { near: 33, far: 22, nearRange: 24, farRange: 48 },
    headMult: 1.5, limbMult: 0.9, penetration: 0.34, muzzleVel: 780,
    recoil: { pattern: P.ar_vk, vert: 0.62, horiz: 0.50, jitter: 0.11, recovery: 7.4,
              visual: 1.0, adsMult: 0.72, kickBack: 0.030 },
    spread: { hipBase: 2.5, hipMax: 6.4, adsBase: 0.16, adsMax: 1.5,
              bloom: 0.30, decay: 5.6, moveMult: 1.7, airMult: 3.0, crouchMult: 0.78 },
    ads: { time: 0.245, fov: 46, sensMult: 0.78, moveMult: 0.52 },
    optic: 'RED DOT', reticle: 'dot',
    reload: { tac: 1.95, empty: 2.55 }, swap: { in: 0.62, out: 0.42 },
    mobility: 62, sprintSpeed: 6.3, walkSpeed: 4.15, adsSpeed: 2.15,
    bars: { damage: 55, fireRate: 66, range: 62, mobility: 62, accuracy: 68 },
    audio: { gain: 1.00, crackHz: 2300, crackQ: 1.3, bodyHz: 118, tail: 0.44, tailHz: 900, mech: 0.55, punch: 1.0 },
    model: { kind: 'ar', len: 0.86, barrel: 0.30, stock: 'fixed', mag: 'stanag', rail: true, tint: 0x3b3f3d },
  },

  grad74: {
    id: 'grad74', name: 'GRAD-74', cls: 'ASSAULT RIFLE', slot: 'primary', kind: 'ar',
    desc: 'Slower, heavier, meaner. 600 rpm of 5.45 that hits three points harder than the VK and keeps that damage twelve metres further out. The first kick is violent — tap it in fours past forty metres.',
    rpm: 600, fire: FIRE.AUTO, mag: 30, reserve: 180, pellets: 1,
    damage: { near: 38, far: 26, nearRange: 32, farRange: 60 },
    headMult: 1.55, limbMult: 0.88, penetration: 0.46, muzzleVel: 880,
    recoil: { pattern: P.ar_grad, vert: 0.74, horiz: 0.44, jitter: 0.14, recovery: 6.5,
              visual: 1.16, adsMult: 0.74, kickBack: 0.038 },
    spread: { hipBase: 3.0, hipMax: 7.2, adsBase: 0.13, adsMax: 1.35,
              bloom: 0.33, decay: 5.0, moveMult: 1.85, airMult: 3.2, crouchMult: 0.74 },
    ads: { time: 0.285, fov: 44, sensMult: 0.74, moveMult: 0.46 },
    optic: 'HYBRID HOLO', reticle: 'holo',
    reload: { tac: 2.25, empty: 2.95 }, swap: { in: 0.72, out: 0.48 },
    mobility: 54, sprintSpeed: 6.0, walkSpeed: 3.95, adsSpeed: 1.90,
    bars: { damage: 68, fireRate: 54, range: 76, mobility: 52, accuracy: 60 },
    audio: { gain: 1.14, crackHz: 1950, crackQ: 1.1, bodyHz: 96, tail: 0.58, tailHz: 720, mech: 0.72, punch: 1.25 },
    model: { kind: 'ar', len: 0.92, barrel: 0.34, stock: 'skeleton', mag: 'curved', rail: true, tint: 0x4a3b2e },
  },

  /* ===================== SMG ===================== */
  wasp45: {
    id: 'wasp45', name: 'WASP .45', cls: 'SMG', slot: 'primary', kind: 'smg',
    desc: 'A 1050-rpm folding-stock machine pistol built for doorways. Fastest ADS in the armoury and it barely slows you down — but the damage cliff at eighteen metres is a wall, not a slope.',
    rpm: 1050, fire: FIRE.AUTO, mag: 32, reserve: 224, pellets: 1,
    damage: { near: 27, far: 15, nearRange: 13, farRange: 30 },
    headMult: 1.4, limbMult: 0.92, penetration: 0.18, muzzleVel: 400,
    recoil: { pattern: P.smg_wasp, vert: 0.50, horiz: 0.62, jitter: 0.17, recovery: 9.2,
              visual: 0.82, adsMult: 0.70, kickBack: 0.022 },
    spread: { hipBase: 2.1, hipMax: 6.8, adsBase: 0.30, adsMax: 2.4,
              bloom: 0.26, decay: 7.4, moveMult: 1.25, airMult: 2.3, crouchMult: 0.85 },
    ads: { time: 0.165, fov: 52, sensMult: 0.86, moveMult: 0.68 },
    optic: 'RED DOT', reticle: 'dot',
    reload: { tac: 1.62, empty: 2.15 }, swap: { in: 0.48, out: 0.32 },
    mobility: 88, sprintSpeed: 7.1, walkSpeed: 4.65, adsSpeed: 2.95,
    bars: { damage: 40, fireRate: 92, range: 30, mobility: 88, accuracy: 52 },
    audio: { gain: 0.80, crackHz: 2900, crackQ: 1.5, bodyHz: 150, tail: 0.26, tailHz: 1250, mech: 0.62, punch: 0.7 },
    model: { kind: 'smg', len: 0.55, barrel: 0.16, stock: 'folding', mag: 'stick', rail: true, tint: 0x2e3234 },
  },

  /* ===================== SHOTGUN ===================== */
  breacher12: {
    id: 'breacher12', name: 'BREACHER 12', cls: 'SHOTGUN', slot: 'primary', kind: 'shotgun',
    desc: 'Semi-auto 12 gauge, eight pellets a shell. Inside seven metres it deletes people. Past twelve it is a loud way to announce your position. Reloads shell by shell — you can cancel it and fire.',
    rpm: 205, fire: FIRE.SEMI, mag: 8, reserve: 40, pellets: 8, shellReload: true,
    damage: { near: 19, far: 4.5, nearRange: 6.5, farRange: 15 },
    headMult: 1.35, limbMult: 0.95, penetration: 0.10, muzzleVel: 380,
    recoil: { pattern: P.sg, vert: 1.05, horiz: 0.42, jitter: 0.22, recovery: 5.2,
              visual: 2.0, adsMult: 0.86, kickBack: 0.085 },
    spread: { hipBase: 4.4, hipMax: 5.6, adsBase: 2.6, adsMax: 3.4,
              bloom: 0.20, decay: 6.0, moveMult: 1.3, airMult: 1.9, crouchMult: 0.90, pelletCone: true },
    ads: { time: 0.225, fov: 58, sensMult: 0.90, moveMult: 0.60 },
    optic: 'BEAD SIGHT', reticle: 'shotgun',
    reload: { tac: 0.52, empty: 0.52, perShell: 0.44, startup: 0.42, endup: 0.38 }, swap: { in: 0.60, out: 0.40 },
    mobility: 70, sprintSpeed: 6.5, walkSpeed: 4.30, adsSpeed: 2.35,
    bars: { damage: 96, fireRate: 22, range: 14, mobility: 70, accuracy: 24 },
    audio: { gain: 1.35, crackHz: 1300, crackQ: 0.8, bodyHz: 72, tail: 0.72, tailHz: 520, mech: 1.0, punch: 1.7 },
    model: { kind: 'shotgun', len: 0.90, barrel: 0.46, stock: 'fixed', mag: 'tube', rail: false, tint: 0x3a2f28 },
  },

  /* ===================== LMG ===================== */
  hammer: {
    id: 'hammer', name: 'HAMMER LMG', cls: 'LIGHT MACHINE GUN', slot: 'primary', kind: 'lmg',
    desc: 'A hundred rounds of suppression. The first eight shots try to throw the gun over your shoulder; ride them and the pattern flattens into the steadiest platform here. Bipod-heavy — you will not win a footrace.',
    rpm: 640, fire: FIRE.AUTO, mag: 100, reserve: 200, pellets: 1,
    damage: { near: 35, far: 27, nearRange: 38, farRange: 72 },
    headMult: 1.45, limbMult: 0.90, penetration: 0.62, muzzleVel: 840,
    recoil: { pattern: P.lmg, vert: 0.70, horiz: 0.48, jitter: 0.15, recovery: 5.4,
              visual: 1.22, adsMult: 0.66, kickBack: 0.040 },
    spread: { hipBase: 4.6, hipMax: 9.5, adsBase: 0.20, adsMax: 1.20,
              bloom: 0.22, decay: 4.4, moveMult: 2.2, airMult: 3.6, crouchMult: 0.62 },
    ads: { time: 0.395, fov: 42, sensMult: 0.68, moveMult: 0.34 },
    optic: 'ACOG 4x', reticle: 'acog', magnify: 2.2,
    reload: { tac: 4.30, empty: 5.10 }, swap: { in: 0.95, out: 0.66 },
    mobility: 34, sprintSpeed: 5.35, walkSpeed: 3.50, adsSpeed: 1.45,
    bars: { damage: 62, fireRate: 58, range: 88, mobility: 26, accuracy: 74 },
    audio: { gain: 1.22, crackHz: 1750, crackQ: 1.0, bodyHz: 88, tail: 0.66, tailHz: 640, mech: 0.85, punch: 1.35 },
    model: { kind: 'lmg', len: 1.06, barrel: 0.46, stock: 'fixed', mag: 'box', rail: true, tint: 0x33372f },
  },

  /* ===================== MARKSMAN ===================== */
  kestrel: {
    id: 'kestrel', name: 'KESTREL DMR', cls: 'MARKSMAN RIFLE', slot: 'primary', kind: 'dmr',
    desc: 'Semi-automatic 7.62 under a 4x ACOG. Two rounds centre-mass or one clean headshot at any range on this map. Fast enough to answer an SMG if you land the first shot.',
    rpm: 375, fire: FIRE.SEMI, mag: 20, reserve: 120, pellets: 1,
    damage: { near: 58, far: 46, nearRange: 44, farRange: 80 },
    headMult: 1.95, limbMult: 0.85, penetration: 0.72, muzzleVel: 900,
    recoil: { pattern: P.dmr, vert: 0.86, horiz: 0.34, jitter: 0.10, recovery: 6.8,
              visual: 1.45, adsMult: 0.80, kickBack: 0.055 },
    spread: { hipBase: 4.0, hipMax: 7.5, adsBase: 0.06, adsMax: 0.85,
              bloom: 0.42, decay: 5.5, moveMult: 2.0, airMult: 3.4, crouchMult: 0.70 },
    ads: { time: 0.335, fov: 26, sensMult: 0.56, moveMult: 0.40 },
    optic: 'ACOG 4x', reticle: 'acog', magnify: 3.4,
    reload: { tac: 2.45, empty: 3.15 }, swap: { in: 0.80, out: 0.55 },
    mobility: 46, sprintSpeed: 5.85, walkSpeed: 3.80, adsSpeed: 1.70,
    bars: { damage: 82, fireRate: 34, range: 92, mobility: 44, accuracy: 88 },
    audio: { gain: 1.20, crackHz: 2050, crackQ: 1.2, bodyHz: 84, tail: 0.70, tailHz: 600, mech: 0.80, punch: 1.4 },
    model: { kind: 'dmr', len: 1.00, barrel: 0.44, stock: 'skeleton', mag: 'curved', rail: true, tint: 0x35322c },
  },

  /* ===================== SNIPER (Intervention-class) ===================== */
  longbow: {
    id: 'longbow', name: 'LONGBOW .408', cls: 'BOLT-ACTION SNIPER', slot: 'primary', kind: 'sniper',
    desc: 'Intervention-class .408 bolt gun under a true 8x magnifying scope. Anything above the navel is a kill, anywhere on the map. The cost is a 1.35-second bolt cycle, a slow scope drift you steady by holding your breath (Shift), and a scope glint that tells everyone where you are.',
    rpm: 44, fire: FIRE.BOLT, mag: 5, reserve: 30, pellets: 1, boltTime: 1.35,
    damage: { near: 105, far: 92, nearRange: 90, farRange: 140 },
    headMult: 1.6, limbMult: 0.62, upperTorsoMult: 1.0, penetration: 0.95, muzzleVel: 950,
    recoil: { pattern: P.bolt, vert: 1.20, horiz: 0.30, jitter: 0.08, recovery: 3.4,
              visual: 2.6, adsMult: 1.0, kickBack: 0.11 },
    spread: { hipBase: 7.5, hipMax: 9.0, adsBase: 0.012, adsMax: 0.16,
              bloom: 0.55, decay: 3.0, moveMult: 2.6, airMult: 5.0, crouchMult: 0.55 },
    ads: { time: 0.545, fov: 12, sensMult: 0.36, moveMult: 0.30 },
    scoped: true, scopeFov: 8.0, glint: true,
    sway: { amp: 0.5, freq: 1.0, breathHold: 4.0, breathRecover: 4.0 },
    optic: 'MAG 8x SCOPE', reticle: 'sniper', magnify: 8,
    reload: { tac: 3.05, empty: 3.85 }, swap: { in: 1.05, out: 0.72 },
    mobility: 38, sprintSpeed: 5.70, walkSpeed: 3.70, adsSpeed: 1.35,
    bars: { damage: 100, fireRate: 8, range: 100, mobility: 36, accuracy: 96 },
    audio: { gain: 1.55, crackHz: 1500, crackQ: 0.9, bodyHz: 66, tail: 1.10, tailHz: 430, mech: 1.15, punch: 1.9 },
    model: { kind: 'sniper', len: 1.22, barrel: 0.60, stock: 'chassis', mag: 'box5', rail: true, tint: 0x2b2f33 },
  },

  /* ===================== SECONDARIES ===================== */
  m9: {
    id: 'm9', name: 'M9 SIDEARM', cls: 'PISTOL', slot: 'secondary', kind: 'pistol',
    desc: 'Fifteen rounds of 9mm and the fastest weapon swap you own. Finishes what the primary started.',
    rpm: 450, fire: FIRE.SEMI, mag: 15, reserve: 60, pellets: 1,
    damage: { near: 28, far: 18, nearRange: 16, farRange: 34 },
    headMult: 1.6, limbMult: 0.9, penetration: 0.14, muzzleVel: 380,
    recoil: { pattern: P.pistol, vert: 0.56, horiz: 0.40, jitter: 0.16, recovery: 9.0,
              visual: 0.9, adsMult: 0.76, kickBack: 0.024 },
    spread: { hipBase: 2.6, hipMax: 6.0, adsBase: 0.25, adsMax: 1.8,
              bloom: 0.40, decay: 7.0, moveMult: 1.3, airMult: 2.2, crouchMult: 0.82 },
    ads: { time: 0.175, fov: 54, sensMult: 0.88, moveMult: 0.72 },
    optic: 'IRON SIGHTS', reticle: 'iron',
    reload: { tac: 1.55, empty: 2.05 }, swap: { in: 0.36, out: 0.26 },
    mobility: 96, sprintSpeed: 7.4, walkSpeed: 4.80, adsSpeed: 3.2,
    bars: { damage: 42, fireRate: 40, range: 34, mobility: 96, accuracy: 58 },
    audio: { gain: 0.72, crackHz: 2600, crackQ: 1.4, bodyHz: 140, tail: 0.30, tailHz: 1100, mech: 0.60, punch: 0.75 },
    model: { kind: 'pistol', len: 0.24, barrel: 0.10, stock: 'none', mag: 'stick', rail: false, tint: 0x2c2f31 },
  },

  handcannon: {
    id: 'handcannon', name: 'HAND CANNON .50', cls: 'REVOLVER', slot: 'secondary', kind: 'revolver',
    desc: 'Six rounds of .50 that two-tap at any sane range. Recoil that resets your aim to the sky. Deeply unfair when it connects.',
    rpm: 210, fire: FIRE.SEMI, mag: 6, reserve: 30, pellets: 1,
    damage: { near: 64, far: 46, nearRange: 24, farRange: 46 },
    headMult: 1.7, limbMult: 0.82, penetration: 0.55, muzzleVel: 470,
    recoil: { pattern: P.revolver, vert: 1.10, horiz: 0.44, jitter: 0.20, recovery: 4.6,
              visual: 2.1, adsMult: 0.88, kickBack: 0.075 },
    spread: { hipBase: 3.4, hipMax: 7.0, adsBase: 0.16, adsMax: 1.4,
              bloom: 0.62, decay: 5.0, moveMult: 1.5, airMult: 2.6, crouchMult: 0.76 },
    ads: { time: 0.235, fov: 48, sensMult: 0.78, moveMult: 0.64 },
    optic: 'IRON SIGHTS', reticle: 'iron',
    reload: { tac: 2.55, empty: 2.55 }, swap: { in: 0.46, out: 0.32 },
    mobility: 82, sprintSpeed: 7.0, walkSpeed: 4.55, adsSpeed: 2.75,
    bars: { damage: 88, fireRate: 20, range: 56, mobility: 82, accuracy: 46 },
    audio: { gain: 1.40, crackHz: 1700, crackQ: 0.85, bodyHz: 78, tail: 0.80, tailHz: 560, mech: 0.90, punch: 1.75 },
    model: { kind: 'revolver', len: 0.30, barrel: 0.16, stock: 'none', mag: 'cylinder', rail: false, tint: 0x35383a },
  },

  minisub: {
    id: 'minisub', name: 'MINI SUB', cls: 'MACHINE PISTOL', slot: 'secondary', kind: 'mpistol',
    desc: 'A 1200-rpm sidearm that empties in one second. A panic button with a trigger.',
    rpm: 1200, fire: FIRE.AUTO, mag: 20, reserve: 120, pellets: 1,
    damage: { near: 21, far: 12, nearRange: 10, farRange: 24 },
    headMult: 1.35, limbMult: 0.94, penetration: 0.12, muzzleVel: 360,
    recoil: { pattern: P.mpistol, vert: 0.48, horiz: 0.66, jitter: 0.22, recovery: 10.0,
              visual: 0.78, adsMult: 0.80, kickBack: 0.018 },
    spread: { hipBase: 2.4, hipMax: 7.6, adsBase: 0.44, adsMax: 3.0,
              bloom: 0.24, decay: 8.4, moveMult: 1.2, airMult: 2.0, crouchMult: 0.88 },
    ads: { time: 0.155, fov: 56, sensMult: 0.90, moveMult: 0.76 },
    optic: 'IRON SIGHTS', reticle: 'iron',
    reload: { tac: 1.45, empty: 1.95 }, swap: { in: 0.38, out: 0.28 },
    mobility: 94, sprintSpeed: 7.3, walkSpeed: 4.75, adsSpeed: 3.1,
    bars: { damage: 32, fireRate: 100, range: 24, mobility: 94, accuracy: 40 },
    audio: { gain: 0.68, crackHz: 3100, crackQ: 1.6, bodyHz: 165, tail: 0.22, tailHz: 1400, mech: 0.50, punch: 0.6 },
    model: { kind: 'mpistol', len: 0.34, barrel: 0.11, stock: 'none', mag: 'stick', rail: true, tint: 0x282b2d },
  },
};

/* ---- lethals ------------------------------------------------------------- */
export const LETHALS = {
  frag: {
    id: 'frag', name: 'FRAG GRENADE', cls: 'LETHAL', count: 2, fuse: 3.4, cookable: true,
    radius: 7.0, damage: 165, minDamage: 22, throwSpeed: 17, bounce: 0.34, drag: 0.06,
    desc: 'Cookable fuse. Bounces. Damage falls off hard past four metres — it kills people who stay still.',
    bars: { damage: 78, radius: 82, speed: 46 },
  },
  semtex: {
    id: 'semtex', name: 'SEMTEX', cls: 'LETHAL', count: 2, fuse: 2.15, cookable: false, sticky: true,
    radius: 5.6, damage: 190, minDamage: 30, throwSpeed: 20, bounce: 0.0, drag: 0.04,
    desc: 'Sticks to whatever it touches — including people. Shorter radius, no cook, no rollback.',
    bars: { damage: 92, radius: 62, speed: 66 },
  },
  thermite: {
    id: 'thermite', name: 'THERMITE', cls: 'LETHAL', count: 2, fuse: 0.9, cookable: false, sticky: true,
    radius: 3.6, damage: 44, minDamage: 14, burn: 6.0, burnDps: 46, throwSpeed: 18, bounce: 0.1, drag: 0.05,
    desc: 'Low burst damage, then six seconds of burning ground. Area denial — take a stairwell away from them.',
    bars: { damage: 54, radius: 44, speed: 58 },
  },
};

export const PRIMARIES = Object.values(WEAPONS).filter(w => w.slot === 'primary');
export const SECONDARIES = Object.values(WEAPONS).filter(w => w.slot === 'secondary');

/* ---- derived helpers ----------------------------------------------------- */

/** Damage at a distance, before hit-zone multipliers. */
export function damageAt(w, dist) {
  const d = w.damage;
  if (dist <= d.nearRange) return d.near;
  if (dist >= d.farRange) return d.far;
  const t = (dist - d.nearRange) / (d.farRange - d.nearRange);
  return d.near + (d.far - d.near) * t;
}

/** Shots-to-kill against 100 hp at a distance, for the UI. */
export function stk(w, dist, mult = 1) {
  const dmg = damageAt(w, dist) * mult * (w.pellets > 1 ? w.pellets : 1);
  return Math.max(1, Math.ceil(100 / Math.max(1, dmg)));
}

/** Theoretical time to kill in ms (ignores travel time). */
export function ttk(w, dist) {
  const n = stk(w, dist);
  if (w.fire === FIRE.BOLT) return (n - 1) * (w.boltTime * 1000);
  return (n - 1) * (60000 / w.rpm);
}

/** Aggregate 0-100 bars for a full loadout (primary + secondary + lethal). */
export function loadoutBars(pri, sec, leth) {
  const w = (a, b, k) => Math.round(a * k + b * (1 - k));
  return {
    damage:   Math.round(Math.min(100, w(pri.bars.damage, sec.bars.damage, 0.78) * 0.88 + leth.bars.damage * 0.14)),
    fireRate: w(pri.bars.fireRate, sec.bars.fireRate, 0.80),
    range:    w(pri.bars.range, sec.bars.range, 0.85),
    mobility: Math.round(w(pri.bars.mobility, sec.bars.mobility, 0.72) * 0.94 + leth.bars.speed * 0.06),
    accuracy: w(pri.bars.accuracy, sec.bars.accuracy, 0.82),
  };
}
