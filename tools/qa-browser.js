/* ============================================================================
   Headless QA harness.

   A pointer-locked FPS cannot be driven by synthetic mouse events in this
   environment (the embedded pane refuses pointer lock), so instead of faking
   input we drive the simulation directly through the same functions the input
   layer calls. Every assertion below exercises real game code — real raycasts
   against real animated capsules, real collision, real damage.

   Loaded from the page with:  const QA = await import('/tools/qa-browser.js')
   ========================================================================== */

import { underOpenSky } from '../src/weapons/combat.js';
import { MAP_ORDER } from '../src/world/maps/index.js';

const G = () => window.__game;
const T = () => window.__THREE;

function pct(a, b) { return b ? (a / b * 100).toFixed(1) + '%' : '—'; }

/* ---------------------------------------------------------------- helpers */

/* search bounds for the loaded map, 3 m inside its edge (28 x 20 on Dustline, as before) */
const BW = () => G().map.halfW - 3, BD = () => G().map.halfD - 3;

/* Flat open ground with nothing solid within `side` m sideways, from `behind`
   m back to `ahead` m forward in Z, at any height a body occupies. Replaces
   the Dustline coordinates the melee, blood and controls tests hard-coded. */
function openSpot(ahead = 3.4, side = 1.4, behind = 0) {
  const g = G(), m = g.map;
  for (let x = -BW(); x <= BW(); x += 0.5) {
    for (let z = -BD() + behind; z <= BD() - ahead; z += 0.5) {
      let ok = true;
      for (let dz = -behind; dz <= ahead && ok; dz += 0.5) {
        for (let dx = -side; dx <= side && ok; dx += 0.35) {
          if (Math.abs(g.groundHeight(x + dx, z + dz, 0.5, 0.4)) > 0.01) ok = false;
          else if (m.pointBlocked(x + dx, 0.3, z + dz, 0.45) || m.pointBlocked(x + dx, 1.4, z + dz, 0.45)) ok = false;
        }
      }
      if (ok) return { x, z };
    }
  }
  return null;
}

/* A route for a map with no authored one: floor points spread over the whole
   map by farthest-point sampling, visited nearest-first, then every elevated
   place the map's definition says must be reachable, and back down again. */
function autoRoute(m) {
  const cand = [];
  for (let x = 1.5 - m.halfW; x <= m.halfW - 1.5; x += 1.4) {
    for (let z = 1.5 - m.halfD; z <= m.halfD - 1.5; z += 1.4) {
      const c = m.navIndex(x, z);
      if (!m.navN[c]) continue;
      const y = m.navH[c * m.MAXS];
      if (y > 0.3 || m.pointBlocked(x, y + 0.9, z, 0)) continue;
      cand.push([x, z, y]);
    }
  }
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const pick = [[m.spawnsA[0].x, m.spawnsA[0].z, 0]], near = cand.map(c => d2(c, pick[0]));
  while (pick.length < 36 && cand.length) {
    let bi = 0; for (let i = 1; i < cand.length; i++) if (near[i] > near[bi]) bi = i;
    pick.push(cand[bi]);
    for (let i = 0; i < cand.length; i++) near[i] = Math.min(near[i], d2(cand[i], cand[bi]));
  }
  const route = [pick.shift()];
  while (pick.length) {
    const last = route[route.length - 1];
    let bi = 0; for (let i = 1; i < pick.length; i++) if (d2(pick[i], last) < d2(pick[bi], last)) bi = i;
    route.push(pick.splice(bi, 1)[0]);
  }
  for (const q of (m.def && m.def.mustReach) || []) route.push(q, [q[0] + 3, q[1], 0]);
  return route;
}

/**
 * Bring the match back to a clean, live state with the player alive.
 *
 * Tests run back to back in one match and some left the bots active between
 * them, so the player could be shot in the gap - and the next test then
 * started while the killcam was playing. The team airstrike test failed that
 * way: its strike was (correctly) refused, because you cannot call one while
 * watching your own death. This ends any killcam through the game's own path,
 * respawns the player the way the game does, starts a fresh match if the last
 * one ended, and yields once so the pointer-lock refusal that enables
 * keyboard play has landed.
 */
async function ensureLive() {
  const g = G();
  if (g.state === 'MENU' || g.state === 'RESULT' || g.matchOver) g.deploy();
  await new Promise(r => setTimeout(r, 80));
  // keys only count once pointer lock is taken or refused; some tabs refuse slowly
  for (let i = 0; i < 60 && !(g.input.locked || g.input.lockUnavailable); i++) await new Promise(r => setTimeout(r, 50));
  if (g.state === 'KILLCAM') g.endKillcam();
  if (!g.me.alive && g.state === 'LIVE') g.spawn(g.me);
  if (g.strikeMode) g.closeStrikeSelect();
  window.__stepN(2, 1 / 60);
  return g.state === 'LIVE' && g.me.alive;
}

/**
 * Point the player at the nearest visible enemy; returns it (or null).
 *
 * `err` adds a gaussian aim error in radians. The match test uses it so the
 * harness plays like a person rather than a perfect aimbot — without it the
 * local operator never loses a fight, and death, the killcam and respawn are
 * never exercised.
 */
function aimAtNearestEnemy(maxRange = 120, err = 0) {
  const g = G(), me = g.me;
  let best = null, bd = Infinity;
  for (const a of g.actors) {
    if (!a.alive || a.team === me.team) continue;
    const d = me.pos.distanceTo(a.pos);
    if (d > maxRange || d >= bd) continue;
    if (!g.map.lineOfSight(me.pos.x, me.pos.y + me.eyeY, me.pos.z,
                           a.pos.x, a.pos.y + 1.25, a.pos.z)) continue;
    bd = d; best = a;
  }
  if (!best) return null;
  const dx = best.pos.x - me.pos.x;
  const dy = (best.pos.y + 1.25) - (me.pos.y + me.eyeY);
  const dz = best.pos.z - me.pos.z;
  const g2 = () => { let u,v,s; do { u=Math.random()*2-1; v=Math.random()*2-1; s=u*u+v*v; } while(s>=1||s===0); return u*Math.sqrt(-2*Math.log(s)/s); };
  me.yaw = Math.atan2(dx, dz) - me.weapon.recoilYaw + (err ? g2()*err : 0);
  me.pitch = Math.atan2(dy, Math.hypot(dx, dz)) - me.weapon.recoilPitch + (err ? g2()*err*0.7 : 0);
  return best;
}

/** Point the player at one specific actor, compensating for current recoil. */
function aimAtActor(target, aimY = 1.25) {
  const me = G().me;
  const dx = target.pos.x - me.pos.x;
  const dy = (target.pos.y + aimY) - (me.pos.y + me.eyeY);
  const dz = target.pos.z - me.pos.z;
  me.yaw = Math.atan2(dx, dz) - me.weapon.recoilYaw;
  me.pitch = Math.atan2(dy, Math.hypot(dx, dz)) - me.weapon.recoilPitch;
  return target;
}

/** Fire the player's weapon once through the real fire path. */
function pullTrigger() {
  const g = G(), me = g.me, W = me.weapon;
  if (!me.alive || W.reloading || W.bolting || W.equipT > 0) return false;
  if (W.mag <= 0) { W.startReload(g.audio, me.pos, true); return false; }
  const n = W.tryFire({ now: performance.now(), audio: g.audio, isLocal: true, adsW: me.adsW,
    pos: [me.pos.x, me.pos.y + 1.3, me.pos.z] }, true, true);
  if (n > 0) { g.fireWeapon(me, W); return true; }
  return false;
}

/* ================================================================ TEST 1 */
export function testBoot() {
  return {
    name: 'cold boot',
    bootMs: Math.round(window.__bootMs),
    pass: window.__bootMs < 10000,
    note: `playable state in ${(window.__bootMs / 1000).toFixed(2)} s (budget 10 s)`,
  };
}

/**
 * Find two points `range` apart, both on flat open ground with an unobstructed
 * line between them at every height a body occupies.
 */
function findClearLane(range) {
  const g = G(), m = g.map;
  const dirs = [[0, 1], [1, 0], [0.7071, 0.7071], [-0.7071, 0.7071]];
  for (let ax = -BW(); ax <= BW(); ax += 1.5) {
    for (let az = -BD(); az <= BD(); az += 1.5) {
      if (Math.abs(g.groundHeight(ax, az, 40, 0.36)) > 0.01) continue;
      if (m.pointBlocked(ax, 1.2, az, 0.5)) continue;
      for (const [ux, uz] of dirs) {
        const bx = ax + ux * range, bz = az + uz * range;
        if (Math.abs(bx) > BW() + 1 || Math.abs(bz) > BD() + 1) continue;
        if (Math.abs(g.groundHeight(bx, bz, 40, 0.36)) > 0.01) continue;
        if (m.pointBlocked(bx, 1.2, bz, 0.5)) continue;
        let clear = true;
        for (const h of [0.5, 0.9, 1.3, 1.7]) {
          if (!m.lineOfSight(ax, h, az, bx, h, bz)) { clear = false; break; }
        }
        if (clear) return { ax, az, bx, bz };
      }
    }
  }
  return { ax: 0, az: -range / 2, bx: 0, bz: range / 2 };   // fall back
}

/* ================================================================ TEST 2 */
/** Every weapon fires, cycles, reloads and registers hits on a live target. */
export function testEveryWeapon() {
  const g = G(), me = g.me;
  const { WEAPONS } = window.__defs;
  const rows = [];
  const target = g.actors.find(a => a.team !== me.team);
  if (!target) return { name: 'weapons', pass: false, note: 'no enemy actor' };

  const savedPos = me.pos.clone(), savedYaw = me.yaw, savedPitch = me.pitch;
  const savedTPos = target.pos.clone();
  // clear the range: only the designated target may be in front of the muzzle
  const parked = [];
  for (const a of g.actors) {
    if (a === me || a === target) continue;
    parked.push({ a, pos: a.pos.clone(), alive: a.alive });
    a.alive = false;
  }

  for (const id of Object.keys(WEAPONS)) {
    const def = WEAPONS[id];
    /* Stand the pair at a range the weapon is meant for, on a lane that is
       actually clear. MP_DUSTLINE is dense enough that a hard-coded pair of
       coordinates lands inside a warehouse or behind a container about as often
       as not — which measures the map, not the gun. */
    const range = def.kind === 'sniper' ? 40 : def.kind === 'shotgun' ? 5 : 14;
    const lane = findClearLane(range);
    me.pos.set(lane.ax, 0, lane.az);
    target.pos.set(lane.bx, 0, lane.bz);
    target.alive = true; target.health = 100000;
    target.char.revive(); target.char.pos.copy(target.pos);
    target.char.aimYaw = Math.PI; target.char.vel.set(0, 0, 0);
    target.char.groundY = 0;
    for (let k = 0; k < 4; k++) target.char.update(0.016, me.pos);

    g._equip(me, id, 'm9', 'frag');
    const W = me.weapons.primary;
    me.slot = 'primary';
    W.reset();
    me.adsW = 1; me.moving = 0; me.crouch = 0; me.grounded = true;
    me.yaw = 0; me.pitch = 0;
    aimAtActor(target);

    // budget enough sim time for the slowest cycle (a bolt gun needs ~1.4 s/shot)
    const cycle = def.fire === 'BOLT' ? (def.boltTime + 0.1) : (60 / def.rpm);
    const iters = Math.ceil((cycle * 7 + 0.5) * 240);

    const hp0 = target.health;
    const wantShots = Math.min(6, def.mag);
    let fired = 0, cycles = 0;
    for (let i = 0; i < iters && fired < wantShots; i++) {
      // a scoped weapon is fired with the breath held; otherwise the 1.35 deg
      // sway dominates and this measures the sway rather than the weapon
      W.holdingBreath = !!def.sway;
      W.update(1 / 240, { now: performance.now(), audio: g.audio, isLocal: true, adsW: 1,
        pos: [me.pos.x, me.pos.y + 1.3, me.pos.z] });
      // hold the reticle steady against recoil and sway, the way a player would
      aimAtActor(target);
      if (def.sway) {
        const s = g.swayOffset(W, 1);
        me.yaw -= s.x; me.pitch -= s.y;
      }
      if (pullTrigger()) fired++;
      cycles++;
    }
    const dealt = hp0 - target.health;
    const reloadOk = (() => {
      W.reloading = false; W.shellPhase = null; W.bolting = false;
      W.mag = 0;
      const started = W.startReload(g.audio, me.pos, true);
      let t = 0;
      while (W.reloading && t < 12) {
        W.update(1 / 120, { now: performance.now(), audio: g.audio, isLocal: true, adsW: 0,
          pos: [0, 1, 0] });
        t += 1 / 120;
      }
      return started && W.mag > 0;
    })();

    rows.push({
      id, name: def.name, cls: def.cls, fired, damage: +dealt.toFixed(1),
      dmgPerShot: fired ? +(dealt / fired).toFixed(1) : 0,
      reload: reloadOk, pass: fired >= wantShots && dealt > 0 && reloadOk,
    });
  }

  me.pos.copy(savedPos); me.yaw = savedYaw; me.pitch = savedPitch;
  target.pos.copy(savedTPos); target.health = 100;
  for (const p of parked) { p.a.pos.copy(p.pos); p.a.alive = p.alive; }
  g._equip(me, g.cfg.primary, g.cfg.secondary, g.cfg.lethal);
  window.__viewmodel.setWeapon(me.weapon.def);

  return { name: 'every weapon fires and registers', rows, pass: rows.every(r => r.pass) };
}

/* ================================================================ TEST 3 */
/** Hit zones resolve against the animated skeleton, not a static box. */
export function testHitZones() {
  const g = G(), me = g.me;
  const target = g.actors.find(a => a.team !== me.team);
  const V = T().Vector3;
  target.alive = true; target.health = 100000;
  target.pos.set(0, 0, 12);
  target.char.revive();
  target.char.pos.copy(target.pos);
  target.char.aimYaw = Math.PI; target.char.crouch = 0; target.char.vel.set(0, 0, 0);
  target.char.groundY = 0;
  // Update from a viewpoint next to the probe origin: the animation LOD drops
  // distant skeletons to 30 Hz, and passing the live camera (which may be
  // anywhere) would sample a stale pose rather than the current one.
  const probeEye = new V(0, 1.6, 0);
  for (let i = 0; i < 4; i++) target.char.update(0.016, probeEye);

  const origin = probeEye;
  const probes = [
    ['head',  1.68], ['chest', 1.35], ['gut', 1.02], ['legs', 0.55],
  ];
  const cast = (y, lateral = 0) => {
    const dir = new V(lateral, y - 1.6, 12).normalize();
    return target.char.raycastZones(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 40, {});
  };
  const rows = [];
  for (const [label, y] of probes) {
    const h = cast(y);
    rows.push({ probe: label, aimY: y, zone: h ? h.zone : null, kind: h ? h.kind : null, hit: !!h });
  }
  /* Knee height down the exact centreline can pass cleanly between the legs —
     that is correct behaviour for capsules welded to real bones, and it flips
     with the idle pose. Sweep a small lateral fan instead: somewhere across the
     stance a leg must be there, and nowhere at knee height may a ray come back
     as head or torso. */
  const legFan = [];
  for (const lat of [-0.30, -0.22, -0.15, -0.08, 0, 0.08, 0.15, 0.22, 0.30]) {
    const h = cast(0.55, lat);
    legFan.push({ lateral: lat, zone: h ? h.zone : null, kind: h ? h.kind : null });
  }
  const legsOk = legFan.some(r => r.kind === 'limb');
  const noHighHits = legFan.every(r => r.kind !== 'head' && r.kind !== 'upper');
  const headOk = rows.find(r => r.probe === 'head').kind === 'head';
  const chestOk = ['upper', 'lower'].includes(rows.find(r => r.probe === 'chest').kind);
  target.health = 100;
  return {
    name: 'hit zones follow the skeleton', rows, legFan,
    legZones: [...new Set(legFan.filter(r => r.kind).map(r => r.zone))],
    pass: headOk && legsOk && chestOk && noHighHits,
  };
}


/* ================================================================ TEST 4 */
/** Nobody shoots through walls: LOS and the bullet raycast must agree. */
export function testWallPenetrationHonesty() {
  const g = G(), me = g.me;
  const V = T().Vector3;
  const map = g.map;
  let mismatches = 0, samples = 0, blocked = 0;
  const rng = (s => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(42);
  for (let i = 0; i < 4000; i++) {
    const HX = G().map.halfW - 1, HZ = G().map.halfD - 1;
    const ax = (rng() * 2 - 1) * HX, az = (rng() * 2 - 1) * HZ;
    const bx = (rng() * 2 - 1) * HX, bz = (rng() * 2 - 1) * HZ;
    const ay = 1.55, by = 1.55;
    const los = map.lineOfSight(ax, ay, az, bx, by, bz);
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5) continue;
    samples++;
    const hit = map.raycast(ax, ay, az, dx / len, dy / len, dz / len, len - 0.05, {});
    if (!hit) { /* clear */ } else blocked++;
    if ((!hit) !== los) mismatches++;
  }
  return {
    name: 'line of sight matches the bullet raycast',
    samples, blockedPairs: blocked, mismatches,
    pass: mismatches === 0,
    note: `${pct(blocked, samples)} of random sightlines are blocked by geometry`,
  };
}

/* ================================================================ TEST 5 */
/**
 * Walk the perimeter and every interior along a scripted route.
 *
 * Each leg is navigated the way a player would: ask the navmesh for a path, then
 * steer the real capsule through the real collision code waypoint by waypoint.
 * Three distinct failures are reported separately, because they mean different
 * things:
 *   unreachable  the navmesh has no route at all — a connectivity hole
 *   blocked      a route exists but the capsule could not follow it — collision
 *   wedged       the capsule cannot move in ANY direction from a standable cell
 */
export function testMapWalk() {
  const g = G(), me = g.me;
  const saved = { pos: me.pos.clone(), yaw: me.yaw, vel: me.vel.clone(), health: me.health };
  const authored = [
    // --- perimeter loop, well clear of the wall ---
    [-28.5, 20.5], [-14, 20.5], [0, 20.5], [14, 20.5], [28.5, 20.5],
    [28.5, 8], [28.5, -8], [28.5, -20.5],
    [14, -20.5], [0, -20.5], [-14, -20.5], [-28.5, -20.5],
    [-28.5, -8], [-28.5, 8], [-28.5, 20.5],
    // --- the road, end to end and back through the centre pad ---
    [-26, 3.2], [-18, 2.0], [-12, 0], [0, 1.4], [12, 0], [18, -2.0], [26, -3.2],
    // --- west compound: ground floor, both rooms ---
    [-25, -3], [-25.5, -7], [-25.5, -12], [-24, -16], [-19, -16], [-16.5, -12], [-16.5, -7],
    // --- west compound: up the stairs to the first floor and across it ---
    [-26.5, -16.0], [-26.0, -12.0, 1.6], [-25.5, -9.5, 3.62], [-21, -9, 3.62], [-16.8, -8, 3.62],
    // --- east compound (the 180-degree mirror of the above) ---
    [25, 3], [25.5, 7], [25.5, 12], [24, 16], [19, 16], [16.5, 12], [16.5, 7],
    [26.5, 16.0], [26.0, 12.0, 1.6], [25.5, 9.5, 3.62], [21, 9, 3.62], [16.8, 8, 3.62],
    // --- north warehouse, then up the crate stack onto the catwalk ---
    [-8, -13.5], [-8, -19], [-2, -19.5], [-1.5, -12.0], [-1.5, -16.0, 1.3], [-1.5, -19.0, 2.55],
    // --- south warehouse (mirror) ---
    [8, 13.5], [8, 19], [2, 19.5], [1.5, 12.0], [1.5, 16.0, 1.3], [1.5, 19.0, 2.55],
    // --- container stack, up and off ---
    [-22.5, 8.4], [-18.5, 8.4, 2.6], [-16, 9.5, 2.6],
    [22.5, -8.4], [18.5, -8.4, 2.6], [16, -9.5, 2.6],
    // --- back to spawn ---
    [0, 12], [0, -12], [-28, 12],
  ];
  const route = g.map.id === 'dustline' ? authored : autoRoute(g.map);

  const unreachable = [], blocked = [], legs = [];
  me.alive = true; me.health = 1e6; me.crouch = 0; me.adsW = 0;

  /* Snap each authored waypoint onto the nearest cell the navmesh calls
     walkable. Hand-typed coordinates land inside a shipping container often
     enough that without this the test measures my typing, not the map. */
  /* Snap an authored waypoint onto the nearest cell the navmesh calls walkable.
     A third route element declares which level is meant; without it the point
     resolves to the floor, so a coordinate typed inside a shipping container
     lands in the lane beside it rather than on its roof (roofs are deliberate
     jump-up perches, not thoroughfares). */
  const snap = (x, z, wantY) => {
    const m = g.map;
    const target = wantY === undefined ? 0 : wantY;
    let best = null, bd = Infinity;
    for (let r = 0; r <= 6; r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (r > 0 && Math.abs(di) !== r && Math.abs(dj) !== r) continue;
        const px = x + di * 0.7, pz = z + dj * 0.7;
        const c = m.navIndex(px, pz);
        if (!m.navN[c]) continue;
        for (let s = 0; s < m.navN[c]; s++) {
          const y = m.navH[c * m.MAXS + s];
          const d = (px - x) ** 2 + (pz - z) ** 2 + (y - target) ** 2 * 60;
          if (d < bd) { bd = d; best = { x: px, z: pz, y }; }
        }
      }
    }
    return best || { x, z, y: target };
  };
  const snapped = route.map(([x, z, y]) => snap(x, z, y));

  const place = (p) => { me.pos.set(p.x, p.y, p.z); me.vel.set(0, 0, 0); };
  place(snapped[0]);

  let maxY = -99, minY = 99, totalSeconds = 0;
  for (let i = 1; i < route.length; i++) {
    const wpT = snapped[i];
    const tx = wpT.x, tz = wpT.z, ty = wpT.y;
    const path = g.map.findPath(me.pos.x, me.pos.y, me.pos.z, tx, ty, tz, []);
    if (!path || !path.length) {
      unreachable.push({ leg: i, from: route[i - 1], to: [tx, tz] });
      legs.push({ leg: i, to: [tx, tz], result: 'unreachable' });
      place(wpT);
      continue;
    }
    let wi = 0, t = 0, ok = false, stall = 0, lastD = Infinity;
    while (t < 26) {
      const wp = path[Math.min(wi, path.length - 1)];
      const dx = wp.x - me.pos.x, dz = wp.z - me.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.7) {
        if (wi >= path.length - 1) { ok = true; break; }
        wi++; lastD = Infinity; stall = 0; continue;
      }
      me.yaw = Math.atan2(dx / d, dz / d);
      // vault when the waypoint is above the step-up limit, or when stalled
      const jump = me.grounded && ((wp.y - me.pos.y > 0.44 && d < 1.6) || stall > 0.5);
      g.moveActor(me, 1 / 60, dx / d, dz / d, 4.2, jump);
      if (jump) stall = 0;
      if (d > lastD - 0.005) stall += 1 / 60; else stall = 0;
      lastD = Math.min(lastD, d);
      t += 1 / 60;
      maxY = Math.max(maxY, me.pos.y); minY = Math.min(minY, me.pos.y);
    }
    totalSeconds += t;
    legs.push({ leg: i, to: [tx, tz], result: ok ? 'ok' : 'blocked', seconds: +t.toFixed(1),
                waypoints: path.length, y: +me.pos.y.toFixed(2) });
    if (!ok) {
      blocked.push({ leg: i, from: route[i - 1], to: [tx, tz],
                     stuckAt: me.pos.toArray().map(v => +v.toFixed(2)), waypoints: path.length });
      place(wpT);   // don't let one bad leg cascade into the rest
    }
    if (g.map.pointBlocked(me.pos.x, me.pos.y + 0.9, me.pos.z, 0)) {
      blocked.push({ leg: i, insideGeometry: me.pos.toArray().map(v => +v.toFixed(2)) });
    }
  }

  /* --- wedge sweep: from every standable cell, can the capsule get out? --- */
  const wedges = [];
  let tested = 0;
  for (let x = 1 - g.map.halfW; x <= g.map.halfW - 1; x += 1.25) {
    for (let z = 1 - g.map.halfD; z <= g.map.halfD - 1; z += 1.25) {
      const gy = g.groundHeight(x, z, 40, 0.36);
      if (g.map.pointBlocked(x, gy + 0.9, z, 0)) continue;   // solid: not a place a player can be
      tested++;
      let moved = 0;
      for (let k = 0; k < 8; k++) {
        const a = k / 8 * Math.PI * 2;
        me.pos.set(x, gy, z); me.vel.set(0, 0, 0);
        for (let s = 0; s < 14; s++) g.moveActor(me, 1 / 60, Math.sin(a), Math.cos(a), 4.2, false);
        if (Math.hypot(me.pos.x - x, me.pos.z - z) > 0.30) moved++;
      }
      if (moved === 0) wedges.push([x, z, +gy.toFixed(2)]);
    }
  }

  me.pos.copy(saved.pos); me.yaw = saved.yaw; me.vel.copy(saved.vel); me.health = saved.health;
  /* Two different claims, kept apart on purpose:
       - CONNECTIVITY and WEDGES are properties of the map. Every leg must have a
         route, and there must be no standable cell a capsule cannot leave. These
         gate the pass.
       - TRAVERSAL is a property of this harness's steering, which is a plain
         seek-the-waypoint controller with a hop. A leg it fails to finish is
         reported for inspection but does not by itself mean the map is broken. */
  return {
    name: 'map walk: perimeter + every interior',
    legs: route.length - 1,
    reached: legs.filter(l => l.result === 'ok').length,
    traversal: ((legs.filter(l => l.result === 'ok').length / (route.length - 1)) * 100).toFixed(0) + '%',
    unreachable, blocked,
    wedgeCells: wedges.length, wedges: wedges.slice(0, 24), cellsTested: tested,
    floorRange: [+minY.toFixed(2), +maxY.toFixed(2)],
    walkedSeconds: +totalSeconds.toFixed(1),
    legDetail: legs,
    pass: unreachable.length === 0 && wedges.length === 0,
  };
}

/* ================================================================ TEST 6 */
/** Frame time with every bot alive and firing. */
export function testPerformance(frames = 320) {
  const g = G();
  /* Measure what the brief asks for: 1920x1080, actually drawn. The suite runs
     with rendering off for speed, and the screenshot tool can leave the
     renderer at any size; both used to leak into this number, and inside
     runAll it was timing the simulation alone and calling that a pass. */
  const R = window.__renderer;
  const prevNoRender = window.__noRender;
  const prevW = R.domElement.width, prevH = R.domElement.height;
  window.__noRender = false;
  R.setSize(1920, 1080, false);
  g.camera.aspect = 1920 / 1080; g.camera.updateProjectionMatrix();
  if (window.__effects) window.__effects.setPixelScale(1080);
  // quiesce the vsync loop so it is not contending with our own stepping
  window.__benchmark = true;
  // force maximum load: everyone alive, everyone shooting
  for (const a of g.actors) {
    if (!a.alive) { a.alive = true; a.health = a.maxHealth; a.char.revive(); }
  }
  /* Warm-up. The first frames pay for shader compilation and buffer upload,
     which is a real cost but a one-off. Fire during warm-up as well so the
     tracer, particle, decal and sprite programs are all compiled before the
     stopwatch starts — otherwise the first shot of the measured run shows up as
     a several-hundred-millisecond "frame" that is really a compile. */
  for (let i = 0; i < 90; i++) {
    if (i > 20) for (const a of g.actors) {
      if (a === g.me || !a.alive) continue;
      const W = a.weapon;
      if (W.mag <= 0) W.mag = W.def.mag;
      W.fireTimer = -1;
      if (W.tryFire({ now: performance.now(), audio: g.audio, isLocal: false, adsW: 0.5,
        pos: [a.pos.x, a.pos.y + 1.3, a.pos.z] }, true, true) > 0) g.fireWeapon(a, W);
    }
    window.__step(1 / 60);
  }
  const samples = [];
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    // make the bots fire regardless of what they can see
    for (const a of g.actors) {
      if (a === g.me || !a.alive) continue;
      const W = a.weapon;
      if (W.mag <= 0) W.mag = W.def.mag;
      W.fireTimer = -1;
      const n = W.tryFire({ now: performance.now(), audio: g.audio, isLocal: false, adsW: 0.5,
        pos: [a.pos.x, a.pos.y + 1.3, a.pos.z] }, true, true);
      if (n > 0) g.fireWeapon(a, W);
    }
    const s = performance.now();
    window.__step(1 / 60);
    samples.push(performance.now() - s);
  }
  const wall = performance.now() - t0;
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const p99 = samples[Math.floor(samples.length * 0.99)];
  const info = window.__renderer.info;
  const drawCalls = info.render.calls, triangles = info.render.triangles;
  window.__benchmark = false;
  window.__noRender = prevNoRender;
  R.setSize(prevW, prevH, false);
  g.camera.aspect = prevW / prevH; g.camera.updateProjectionMatrix();
  if (window.__effects) window.__effects.setPixelScale(prevH);
  return {
    name: 'frame time, all opponents active and firing',
    frames, actors: g.actors.length, warmupFrames: 90,
    meanMs: +mean.toFixed(2), medianMs: +samples[samples.length >> 1].toFixed(2),
    p95Ms: +p95.toFixed(2), p99Ms: +p99.toFixed(2), maxMs: +samples[samples.length - 1].toFixed(2),
    impliedFps: +(1000 / mean).toFixed(1),
    wallMs: +wall.toFixed(0),
    resolution: '1920x1080', drawCalls, triangles,
    pass: drawCalls > 0 && mean < 16.67,
    note: drawCalls > 0 ? 'budget for 60 fps is 16.67 ms/frame' : 'nothing was drawn: this timed the simulation only',
  };
}

/* ================================================================ TEST 7 */
/**
 * A full match, end to end, driven through the real simulation.
 *
 * Split into begin / advance / report so it can be driven across several calls:
 * a whole match is tens of thousands of simulated frames and blows any single
 * call's time budget.
 */
export function matchBegin(opts = {}) {
  const g = G();
  g.deploy();
  g.scoreLimit = opts.scoreLimit ?? 12;
  g.timeLeft = opts.seconds ?? 300;

  const st = {
    frames: 0,
    maxFrames: opts.maxFrames ?? 30000,
    grenadeThrown: false,
    seen: {
      playerShot: false, playerHit: false, playerKill: false, headshot: false,
      playerDamaged: false, playerDied: false, killcam: false, respawned: false,
      result: false, reload: false, streakEarned: false, botKill: false,
      grenade: false, hitmarker: false, adsUsed: false, weaponSwap: false,
    },
    log: [],
    deaths0: g.me.deaths, kills0: g.me.kills,
    origHit: g.hud.hitmarker.bind(g.hud),
  };
  g.hud.hitmarker = (hs, kill) => {
    st.seen.hitmarker = true;
    if (hs) st.seen.headshot = true;
    st.origHit(hs, kill);
  };
  window.__mstate = st;
  return { started: true, scoreLimit: g.scoreLimit, seconds: g.timeLeft };
}

/** Advance the match by n frames, playing the local operator like a human. */
export function matchAdvance(n = 1800, opts = {}) {
  const g = G(), st = window.__mstate;
  if (!st) return { error: 'call matchBegin first' };
  const me = g.me;
  let i = 0;
  for (; i < n && st.frames < st.maxFrames && g.state !== 'RESULT'; i++, st.frames++) {
    if (g.state === 'LIVE' && me.alive) {
      const W = me.weapon;
      if (W.reloading) st.seen.reload = true;
      if (me.slot === 'secondary') st.seen.weaponSwap = true;
      const enemy = aimAtNearestEnemy(70, opts.aimErr ?? 0.030);
      if (enemy) {
        me.adsW = Math.min(1, me.adsW + 0.12);
        if (me.adsW > 0.9) st.seen.adsUsed = true;
        if (W.mag <= 0) {
          // out of ammo mid-fight: swap to the sidearm the way a player would
          if (W.reserve <= 0 && me.slot === 'primary' && me.swapT <= 0) {
            me.swapTo = 'secondary'; me.swapT = W.def.swap.out; me.swapDur = W.def.swap.out;
          } else W.startReload(g.audio, me.pos, true);
        } else if (pullTrigger()) st.seen.playerShot = true;
        if (!st.grenadeThrown && me.lethalCount > 0 && me.pos.distanceTo(enemy.pos) > 9) {
          st.grenadeThrown = true; st.seen.grenade = true;
          g.throwLethal(me, enemy.pos);
        }
      } else {
        me.adsW = Math.max(0, me.adsW - 0.1);
        let best = null, bd = Infinity;
        for (const a of g.actors) {
          if (!a.alive || a.team === me.team) continue;
          const d = me.pos.distanceTo(a.pos);
          if (d < bd) { bd = d; best = a; }
        }
        if (best) {
          const path = g.map.findPath(me.pos.x, me.pos.y, me.pos.z, best.pos.x, best.pos.y, best.pos.z, []);
          const wp = path && path.length > 1 ? path[1] : best.pos;
          const dx = wp.x - me.pos.x, dz = wp.z - me.pos.z;
          const d = Math.hypot(dx, dz) || 1;
          me.yaw = Math.atan2(dx / d, dz / d);
          const jump = (wp.y !== undefined && wp.y - me.pos.y > 0.44 && d < 1.6 && me.grounded);
          g.moveActor(me, 1 / 60, dx / d, dz / d, me.weapon.def.walkSpeed, jump);
        }
      }
    }
    if (g.state === 'KILLCAM') st.seen.killcam = true;

    window.__step(1 / 60);

    if (me.health < me.maxHealth - 1) st.seen.playerDamaged = true;
    if (me.deaths > st.deaths0) st.seen.playerDied = true;
    if (me.shotsHit > 0) st.seen.playerHit = true;
    if (me.kills > st.kills0) st.seen.playerKill = true;
    if (me.streak >= 3) st.seen.streakEarned = true;
    if (st.seen.playerDied && me.alive) st.seen.respawned = true;
    for (const a of g.actors) if (a !== me && a.kills > 0) st.seen.botKill = true;
  }
  st.seen.result = g.state === 'RESULT';
  const done = g.state === 'RESULT' || st.frames >= st.maxFrames;
  st.log.push(`f${st.frames}: ${g.scoreA}-${g.scoreB} · me ${me.kills}/${me.deaths} · ${g.state}`);
  return {
    done, frames: st.frames, ranThisCall: i,
    state: g.state, score: [g.scoreA, g.scoreB], limit: g.scoreLimit,
    timeLeft: Math.round(g.timeLeft),
    me: { k: me.kills, d: me.deaths, shots: me.shotsFired, hits: me.shotsHit, streak: me.streak },
    seen: st.seen,
  };
}

export function matchReport() {
  const g = G(), st = window.__mstate;
  if (!st) return { error: 'no match' };
  g.hud.hitmarker = st.origHit;
  const me = g.me;
  const required = ['playerShot', 'playerHit', 'playerKill', 'playerDamaged',
                    'playerDied', 'killcam', 'respawned', 'result', 'reload',
                    'botKill', 'hitmarker', 'adsUsed', 'grenade'];
  const missing = required.filter(k => !st.seen[k]);
  return {
    name: 'full match, end to end',
    frames: st.frames, simulatedSeconds: +(st.frames / 60).toFixed(1),
    finalScore: [g.scoreA, g.scoreB], scoreLimit: g.scoreLimit,
    verdict: g.scoreA > g.scoreB ? 'VICTORY' : g.scoreA === g.scoreB ? 'DRAW' : 'DEFEAT',
    player: {
      kills: me.kills, deaths: me.deaths, shots: me.shotsFired, hits: me.shotsHit,
      accuracy: pct(me.shotsHit, me.shotsFired), headshots: me.headshots,
      damage: Math.round(me.damageDealt), bestStreak: me.bestStreak,
    },
    scoreboard: g.actors.map(a => ({ name: a.name, team: a.team, k: a.kills, d: a.deaths })),
    observed: st.seen, missing, log: st.log,
    pass: missing.length === 0,
  };
}

/** Convenience wrapper for callers that can afford one long call. */
export async function testFullMatch(opts = {}) {
  matchBegin(opts);
  let r;
  do { r = matchAdvance(1800); await new Promise(res => setTimeout(res, 0)); } while (!r.done);
  return matchReport();
}

/* ================================================================ TEST 8 */
/** Spawns are never inside geometry and never in an enemy's line of sight. */
export function testSpawns(iterations = 400) {
  const g = G();
  let inGeometry = 0, inSight = 0, tested = 0;
  for (let i = 0; i < iterations; i++) {
    for (const team of ['A', 'B']) {
      const enemies = g.actors.filter(a => a.team !== team && a.alive);
      const friends = g.actors.filter(a => a.team === team && a.alive);
      const s = g.map.pickSpawn(team, enemies, friends);
      tested++;
      if (g.map.pointBlocked(s.x, s.y + 0.9, s.z, 0.30)) inGeometry++;
      for (const e of enemies) {
        const d = Math.hypot(e.pos.x - s.x, e.pos.z - s.z);
        if (d < 34 && g.map.lineOfSight(s.x, s.y + 1.55, s.z, e.pos.x, e.pos.y + 1.55, e.pos.z)) {
          inSight++; break;
        }
      }
    }
  }
  return {
    name: 'spawn safety',
    tested, insideGeometry: inGeometry, visibleToEnemy: inSight,
    pass: inGeometry === 0 && inSight === 0,
  };
}

/* ================================================================ TEST 9 */
/** Recoil is a learnable pattern, not noise. */
export function testRecoilLearnability() {
  const g = G();
  const { WEAPONS } = window.__defs;
  const rows = [];
  for (const id of ['vk71', 'grad74', 'wasp45', 'hammer', 'kestrel']) {
    const def = WEAPONS[id];
    const runs = [];
    for (let r = 0; r < 24; r++) {
      const W = new window.__combat.WeaponState(def, null);
      const path = [];
      for (let s = 0; s < 10; s++) {
        W.tryFire({ now: 0, adsW: 1, audio: null, isLocal: false }, true, true);
        path.push([W.recoilPitch, W.recoilYaw]);
        W.fireTimer = -1;
      }
      runs.push(path);
    }
    // spread of the 10th-shot position across runs, relative to its magnitude
    const last = runs.map(p => p[9]);
    const mx = last.reduce((a, b) => a + b[0], 0) / last.length;
    const my = last.reduce((a, b) => a + b[1], 0) / last.length;
    const sd = Math.sqrt(last.reduce((a, b) => a + (b[0] - mx) ** 2 + (b[1] - my) ** 2, 0) / last.length);
    const mag = Math.hypot(mx, my);
    rows.push({
      id, name: def.name,
      meanPitchDeg: +(mx * 180 / Math.PI).toFixed(2),
      meanYawDeg: +(my * 180 / Math.PI).toFixed(2),
      spreadDeg: +(sd * 180 / Math.PI).toFixed(3),
      ratio: +(sd / (mag || 1)).toFixed(3),
      learnable: sd / (mag || 1) < 0.30,
    });
  }
  return { name: 'recoil patterns are learnable', rows, pass: rows.every(r => r.learnable),
           note: 'run-to-run spread of the 10th shot must stay well under the pattern displacement' };
}

/* ================================================================ TEST 10 */
/** Damage falloff behaves and TTK differs meaningfully between weapons. */
export function testBallistics() {
  const { WEAPONS, damageAt, stk, ttk } = window.__defs;
  const rows = [];
  for (const id of Object.keys(WEAPONS)) {
    const w = WEAPONS[id];
    rows.push({
      name: w.name, cls: w.cls,
      d5: +damageAt(w, 5).toFixed(1), d20: +damageAt(w, 20).toFixed(1),
      d40: +damageAt(w, 40).toFixed(1), d70: +damageAt(w, 70).toFixed(1),
      stk10: stk(w, 10), stk35: stk(w, 35),
      ttk10: Math.round(ttk(w, 10)), ttk35: Math.round(ttk(w, 35)),
      monotone: damageAt(w, 5) >= damageAt(w, 40) && damageAt(w, 40) >= damageAt(w, 70) - 0.001,
    });
  }
  const ttks = rows.map(r => r.ttk10);
  const distinct = new Set(ttks).size;
  return { name: 'ballistics table', rows,
    distinctTtk: distinct, pass: rows.every(r => r.monotone) && distinct >= 6 };
}

/* ================================================================ TEST 11 */
/** The killcam recorder reproduces the killer's viewpoint. */
export function testKillcam() {
  const g = G();
  const rec = g.recorder;
  if (rec.count < 8) return { name: 'killcam', pass: false, note: 'no recording captured' };
  const killer = g.actors.find(a => a !== g.me && a.alive) || g.actors[1];
  const before = { pos: g.camera.position.clone() };
  const ok = g.killcam.start(killer.idx, 3.0);
  if (!ok) return { name: 'killcam', pass: false, note: 'replay window too short' };
  let moved = 0;
  const first = g.camera.position.clone();
  for (let i = 0; i < 120; i++) {
    const done = g.killcam.update(1 / 60);
    moved = Math.max(moved, g.camera.position.distanceTo(first));
    if (done) break;
  }
  g.killcam.stop();
  const s = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: 0, adsW: 0, speed: 0, alive: true };
  const sampled = rec.sampleAt(rec.t - 1.0, killer.idx, s);
  g.camera.position.copy(before.pos);
  return {
    name: 'killcam replay',
    recordedFrames: rec.count, seconds: +(rec.t - rec.oldestTime).toFixed(1),
    events: rec.events.length,
    cameraTravelled: +moved.toFixed(2),
    sampleOk: sampled,
    pass: ok && sampled,
    note: 'camera rides the killer, driven from the transform ring buffer',
  };
}

/* ================================================================ TEST 12 */
/** AI actually paths, uses cover and does not see through walls. */
export function testAI() {
  const g = G();
  const bots = g.actors.filter(a => a.bot);
  const states = {};
  let pathed = 0, moved = 0, sawThroughWall = 0;
  const start = bots.map(b => b.pos.clone());
  for (let i = 0; i < 600; i++) window.__step(1 / 60);
  for (let i = 0; i < bots.length; i++) {
    const b = bots[i];
    states[b.bot.state] = (states[b.bot.state] || 0) + 1;
    if (b.bot.path.length) pathed++;
    if (b.pos.distanceTo(start[i]) > 2.5) moved++;
    /* The property that matters is not "does it remember where you were" — it
       should, that is what PUSH is for — but "does it ever shoot at something it
       cannot see". Replicate the bot's own eye and target heights exactly,
       including stance, and check every bot that has the trigger down. */
    const t = b.bot.target;
    if (t && b.bot.intent.fire) {
      const eyeY = b.pos.y + (b.crouch > 0.5 ? 1.12 : 1.58);
      const chestY = t.pos.y + (t.crouch > 0.5 ? 0.95 : 1.35);
      const headY = t.pos.y + 1.62;
      const los = g.map.lineOfSight(b.pos.x, eyeY, b.pos.z, t.pos.x, chestY, t.pos.z)
               || g.map.lineOfSight(b.pos.x, eyeY, b.pos.z, t.pos.x, headY, t.pos.z);
      if (!los) sawThroughWall++;
    }
  }
  const coverPoints = g.map.coverPoints.length;
  return {
    name: 'AI behaviour',
    bots: bots.length, statesSeen: states, botsWithPaths: pathed, botsThatMoved: moved,
    coverPointsOnMap: coverPoints, firingWithoutLineOfSight: sawThroughWall,
    seeingThroughWalls: sawThroughWall,
    pass: moved >= Math.ceil(bots.length * 0.6) && sawThroughWall === 0 && coverPoints > 40,
  };
}

/* ================================================================ runner */
/* ================================================================ TEST 13 */
/**
 * Movement direction, not just movement distance.
 *
 * The original control check measured how far each key moved you and called it
 * done — which is why a fully inverted strafe axis shipped. This projects the
 * displacement onto the live camera basis and asserts the sign: D must carry
 * you along the camera's screen-right, A against it, W along the look
 * direction, and neither W nor S may drift sideways.
 */
export async function testControls() {
  const g = G();
  await ensureLive();
  window.__stepN(30, 1 / 60);
  const I = g.input, me = g.me;
  /* nobody shoots the player mid-probe: a death here stopped movement and,
     worse, left the next test starting inside a killcam */
  const savedBots = g.actors.map(a => a.bot);
  for (const a of g.actors) a.bot = null;
  /* start on open ground: a tree beside the spawn turns a direction test into a collision test */
  const cs = openSpot(3.2, 3.2, 3.2);
  if (cs) { me.pos.set(cs.x, g.groundHeight(cs.x, cs.z, 0.5, 0.4), cs.z); me.vel.set(0, 0, 0); }

  const basis = () => {
    g.camera.updateMatrixWorld(true);
    const e = g.camera.matrixWorld.elements;
    const rx = e[0], rz = e[2], rl = Math.hypot(rx, rz) || 1;
    const fx = -e[8], fz = -e[10], fl = Math.hypot(fx, fz) || 1;
    return { rx: rx / rl, rz: rz / rl, fx: fx / fl, fz: fz / fl };
  };

  const probe = (code) => {
    I.keys.clear();
    window.__stepN(14, 1 / 60);          // settle, shed residual velocity
    const b = basis();
    const p0 = me.pos.clone();
    I.keys.add(code);
    window.__stepN(40, 1 / 60);
    const roll = g._strafeSign(me);
    I.keys.delete(code);
    window.__stepN(10, 1 / 60);
    const dx = me.pos.x - p0.x, dz = me.pos.z - p0.z;
    return {
      key: code,
      dist: +Math.hypot(dx, dz).toFixed(2),
      right: +(dx * b.rx + dz * b.rz).toFixed(2),
      fwd: +(dx * b.fx + dz * b.fz).toFixed(2),
      roll: +roll.toFixed(2),
    };
  };

  const D = probe('KeyD'), A = probe('KeyA'), W = probe('KeyW'), S = probe('KeyS');
  I.keys.clear();
  for (let i = 0; i < g.actors.length; i++) g.actors[i].bot = savedBots[i];

  /* Collision can shorten a leg or slide it, so require a clear majority of the
     travel on the expected axis rather than an exact vector. */
  const MIN = 0.8;
  const checks = {
    dRight: D.right > MIN,
    aLeft: A.right < -MIN,
    wForward: W.fwd > MIN,
    sBack: S.fwd < -MIN,
    wNoDrift: Math.abs(W.right) < Math.abs(W.fwd) * 0.5,
    sNoDrift: Math.abs(S.right) < Math.abs(S.fwd) * 0.5,
    rollFollowsStrafe: D.roll > 0 && A.roll < 0,
  };
  const failed = Object.keys(checks).filter(k => !checks[k]);
  return {
    name: 'control directions',
    legs: [D, A, W, S],
    checks, failed,
    pass: failed.length === 0,
    note: 'displacement projected onto the live camera basis; signs must match the key',
  };
}

/* ================================================================ TEST 14 */
/**
 * The team airstrike obeys its three rules.
 *
 * One per side for the whole match; it never touches the caller's own team;
 * and it only reaches people standing under open sky. Each of those is a thing
 * that would break quietly — a friendly-fire regression looks like ordinary
 * blast damage in a log — so all three are asserted directly.
 */
export async function testTeamAirstrike() {
  const g = G(), V = T().Vector3;
  await ensureLive();
  window.__stepN(60, 1 / 60);
  const me = g.me;
  const enemies = g.actors.filter(a => a.team !== me.team);
  const friends = g.actors.filter(a => a !== me && a.team === me.team);
  if (enemies.length < 2 || !friends.length) {
    return { name: 'team airstrike', pass: false, note: 'need 2 hostiles and 1 friendly' };
  }

  /* A sheltered spot with an exposed one inside a single blast radius of it —
     the pair is what makes the open-sky rule falsifiable rather than decorative. */
  let pair = null;
  for (let x = -BW(); x <= BW() && !pair; x += 0.5) for (let z = -BD(); z <= BD(); z += 0.5) {
    const gy = g.groundHeight(x, z, 0.5, 0.4);
    if (gy > 0.3 || underOpenSky(g.world, x, gy + 1.7, z)) continue;
    for (const [dx, dz] of [[2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5], [2, 2], [-2, -2]]) {
      const ox = x + dx, oz = z + dz;
      const ogy = g.groundHeight(ox, oz, 0.5, 0.4);
      if (ogy > 0.3 || !underOpenSky(g.world, ox, ogy + 1.7, oz)) continue;
      pair = { covered: [x, z], open: [ox, oz] }; break;
    }
  }
  if (!pair) return { name: 'team airstrike', pass: false, note: 'no covered/open pair on the map' };

  const [eOpen, eCov] = enemies, fOpen = friends[0];
  const savedBots = g.actors.map(a => a.bot);
  for (const a of g.actors) a.bot = null;          // only the strike may do damage
  g.teamStrikeUsed = { A: false, B: false };

  const spots = new Map([
    [eOpen, pair.open], [eCov, pair.covered],
    [fOpen, [pair.open[0], pair.open[1] - 1.6]],   // friendly, squarely in the blast
    [me, [pair.open[0], pair.open[1] - 4.5]],
  ]);
  const pin = () => { for (const [a, [x, z]] of spots) {
    a.pos.set(x, g.groundHeight(x, z, 0.5, 0.4), z); a.vel.set(0, 0, 0); } };
  for (const [a] of spots) { a.alive = true; a.health = 100; if (a.char) a.char.revive(); }
  pin();

  await ensureLive();       // the strike is refused outside a live match
  pin();
  const firstCall = g.callTeamStrike(me, new V(pair.open[0], 0, pair.open[1]), Math.PI / 2);
  const secondCall = g.callTeamStrike(me, new V(0, 0, 0), 0);
  /* Health has to be sampled while the strike runs: a body that dies to it
     respawns on full health inside the same window, which reads as "unharmed". */
  const low = new Map([...spots.keys()].map(a => [a, 100]));
  for (let i = 0; i < 8 * 60; i++) {
    pin(); window.__step(1 / 60);
    for (const a of low.keys()) low.set(a, Math.min(low.get(a), a.alive ? a.health : 0));
  }
  for (let i = 0; i < g.actors.length; i++) g.actors[i].bot = savedBots[i];

  const dmg = (a) => 100 - Math.max(0, Math.round(low.get(a)));
  const spent = { ...g.teamStrikeUsed };        // read before the cleanup below

  /* Put the match back: this test pins four bodies in a corner and spends a
     side's strike, and anything running after it would inherit both. */
  g.teamStrikeUsed = { A: false, B: false };
  for (const a of spots.keys()) if (a !== me) g.spawn(a, false);

  const checks = {
    oneCallPerTeam: firstCall === true && secondCall === false,
    marksTeamSpent: spent[me.team] === true,
    otherTeamUntouched: spent[me.team === 'A' ? 'B' : 'A'] === false,
    hurtsExposedEnemy: dmg(eOpen) > 40,
    sparesShelteredEnemy: dmg(eCov) === 0,
    sparesFriendly: dmg(fOpen) === 0,
    sparesCaller: dmg(me) === 0,
  };
  const failed = Object.keys(checks).filter(k => !checks[k]);
  return {
    name: 'team airstrike', checks, failed,
    damage: { exposedEnemy: dmg(eOpen), shelteredEnemy: dmg(eCov),
              friendly: dmg(fOpen), caller: dmg(me) },
    where: pair,
    pass: failed.length === 0,
  };
}

/* ================================================================ TEST 15 */
/**
 * Melee lands where a swing would, and only there.
 *
 * The original hit test was one thin ray down the crosshair: a target 12
 * degrees off centre at arm's length was a miss, so melee only worked with
 * pixel-perfect aim and felt broken. This presses V through the real input
 * layer at a spread of positions and asserts both directions: inside the arc
 * and within reach it must connect; out of reach, far to the side, at the sky
 * or through a wall it must not. It also checks a swing interrupts a reload
 * without eating ammo.
 */
export async function testMelee() {
  const g = G(), I = g.input, M = g.map;
  /* ensureLive() yields for the pointer-lock refusal: a V pressed before it
     does nothing at all (the first standalone run of this test: 0/9). */
  await ensureLive();
  window.__stepN(30, 1 / 60);
  const me = g.me;
  const foe = g.actors.find(a => a.team !== me.team);
  const saved = g.actors.map(a => a.bot);
  for (const a of g.actors) a.bot = null;
  await ensureLive();

  const solidAt = (x, z, y) => {
    M.beginQuery();
    for (const b of M.query(x - 0.42, z - 0.42, x + 0.42, z + 0.42, [])) {
      if (!b.solid) continue;
      if (x + 0.42 <= b.x0 || x - 0.42 >= b.x1 || z + 0.42 <= b.z0 || z - 0.42 >= b.z1) continue;
      if (y + 1.8 <= b.y0 || y >= b.y1) continue;
      return true;
    }
    return false;
  };

  let X = 0, Z = 0, yaw = 0, pitch = 0;
  const stage = (ax, az, ay, fx, fz, fy, crouch, p) => {
    X = ax; Z = az; pitch = p;
    yaw = Math.atan2(fx - ax, fz - az);
    me.alive = true; me.health = 100; me.meleeT = 0;
    me.pos.set(ax, ay, az); me.vel.set(0, 0, 0); me.yaw = yaw; me.pitch = pitch;
    foe.alive = true; foe.health = 100; foe.crouch = crouch; if (foe.char) foe.char.revive();
    foe.pos.set(fx, fy, fz); foe.vel.set(0, 0, 0);
  };
  const swing = (fx, fz, crouch) => {
    const h0 = foe.health;
    I.keys.add('KeyV'); I.pressed.add('KeyV');
    let hitF = -1, charK = 0, fired = false;
    for (let f = 0; f < 20; f++) {
      window.__step(1 / 60);
      if (f === 0) { I.keys.delete('KeyV'); fired = me.meleeT > 0; }
      me.pos.x = X; me.pos.z = Z; me.yaw = yaw; me.pitch = pitch;
      if (foe.alive) { foe.pos.x = fx; foe.pos.z = fz; foe.crouch = crouch; }
      if (f === 8 && me.char) charK = me.char.meleeK;
      if (hitF < 0 && (foe.health < h0 || !foe.alive)) hitF = f;
    }
    return { hit: hitF >= 0, ms: hitF >= 0 ? Math.round((hitF + 1) * 1000 / 60) : null, charK, fired };
  };

  /* open ground: the same spot the airstrike test uses; face +Z, offset sideways */
  const spot = openSpot(3.4, 1.4);
  if (!spot) { for (let i = 0; i < g.actors.length; i++) g.actors[i].bot = saved[i]; return { name: 'melee', pass: false, note: 'no open ground' }; }
  const OX = spot.x, OZ = spot.z, OY = g.groundHeight(OX, OZ, 0.5, 0.4);
  const open = (dist, lateral, p, crouch = 0) => {
    stage(OX, OZ, OY, OX + lateral, OZ + dist, OY, crouch, p);
    yaw = 0; me.yaw = 0;
    return { dist, lateral, pitch: p, crouch, ...swing(OX + lateral, OZ + dist, crouch) };
  };
  const hit = [
    open(1.2, 0, -0.15), open(1.2, 0.25, -0.15), open(1.2, -0.25, -0.15), open(1.2, 0.45, -0.15),
    open(1.6, 0, -0.15), open(2.2, 0, -0.10), open(0.8, 0, -0.30), open(1.2, 0, 0.35),
    open(1.3, 0, -0.35, 1),
  ];
  const miss = [open(2.9, 0, -0.10), open(1.2, 1.0, -0.15), open(1.2, 0, 0.9)];

  /* through a wall: two open spots 1.4 m apart with the chest line blocked */
  let wall = null;
  for (let x = -BW(); x <= BW() && !wall; x += 0.5) {
    for (let z = -BD(); z <= BD() && !wall; z += 0.5) {
      const y0 = g.groundHeight(x, z, 0.5, 0.4);
      if (y0 > 0.3 || solidAt(x, z, y0)) continue;
      for (const [dx, dz] of [[1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4]]) {
        const x1 = x + dx, z1 = z + dz, y1 = g.groundHeight(x1, z1, 0.5, 0.4);
        if (y1 > 0.3 || solidAt(x1, z1, y1)) continue;
        if (M.lineOfSight(x, y0 + 1.3, z, x1, y1 + 1.3, z1)) continue;
        wall = { a: [x, z, y0], b: [x1, z1, y1] };
        break;
      }
    }
  }
  let throughWall = null;
  if (wall) {
    stage(wall.a[0], wall.a[1], wall.a[2], wall.b[0], wall.b[1], wall.b[2], 0, -0.1);
    throughWall = swing(wall.b[0], wall.b[1], 0);
  }

  /* a swing aborts a reload, and costs no rounds */
  stage(OX, OZ, OY, OX, OZ + 3.5, OY, 0, -0.1);
  const W = me.weapon;
  W.mag = Math.max(1, W.def.mag - 8);
  W.startReload(g.audio, me.pos, true);
  window.__stepN(10, 1 / 60);
  const before = { mag: W.mag, reserve: W.reserve, reloading: W.reloading };
  I.keys.add('KeyV'); I.pressed.add('KeyV'); window.__step(1 / 60); I.keys.delete('KeyV');
  const after = { mag: W.mag, reserve: W.reserve, reloading: W.reloading };
  window.__stepN(40, 1 / 60);

  /* put the match back */
  for (let i = 0; i < g.actors.length; i++) g.actors[i].bot = saved[i];
  W.mag = W.def.mag;
  me.meleeT = 0; me.health = 100;
  g.spawn(foe, false);

  const checks = {
    connectsInsideTheArc: hit.every(r => r.hit),
    everySwingFired: hit.concat(miss).every(r => r.fired) && !!throughWall && throughWall.fired,
    missesOutsideIt: miss.every(r => r.fired && !r.hit),
    wallBlocksTheSwing: !!throughWall && throughWall.fired && !throughWall.hit,
    landsAtContact: hit.every(r => r.ms !== null && r.ms <= 250),
    bodySwingsInThirdPerson: hit.some(r => r.charK > 0.05),
    reloadInterrupted: before.reloading && !after.reloading,
    noRoundsLost: before.mag === after.mag && before.reserve === after.reserve,
  };
  const failed = Object.keys(checks).filter(k => !checks[k]);
  return {
    name: 'melee', checks, failed,
    connected: hit.filter(r => r.hit).length + '/' + hit.length,
    refused: miss.filter(r => !r.hit).length + '/' + miss.length,
    wall: wall ? { at: wall, hit: throughWall.hit } : 'no wall pair found',
    reload: { before, after },
    pass: failed.length === 0,
  };
}

/* ================================================================ TEST 16 */
/**
 * Blood appears where it should, is gone in five seconds, and the toggle means it.
 *
 * With blood on, a body hit in front of a wall must leave a splatter on the
 * wall and drips on the ground; a kill must pool blood under the body once it
 * has settled; a mark must hold, then fade, then be gone by five seconds. With
 * the toggle off a hit must leave nothing, and switching off must wipe what is
 * already there. The toggle is driven through the real checkbox.
 */
export async function testBlood() {
  const g = G(), E = g.effects, M = g.map, V = T().Vector3;
  await ensureLive();
  window.__stepN(30, 1 / 60);
  const saved = g.actors.map(a => a.bot);
  for (const a of g.actors) a.bot = null;
  const restore = () => { for (let i = 0; i < g.actors.length; i++) g.actors[i].bot = saved[i]; };
  const box = document.getElementById('tgBlood');
  const setToggle = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
  setToggle(true);
  E.clearBlood();
  const live = () => E.bSlots.filter(b => b.live);
  const normalOf = (b) => new V(0, 0, 1).applyQuaternion(b.q);

  /* a point 1.2 to 1.6 m in front of a wall, facing it */
  let spot = null;
  for (let x = -BW(); x <= BW() && !spot; x += 0.5) {
    for (let z = -BD(); z <= BD() && !spot; z += 0.5) {
      if (g.groundHeight(x, z, 0.5, 0.4) > 0.3) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const h = M.raycast(x, 1.3, z, dx, 0, dz, 3, {});
        if (!h || h.t <= 1.2 || h.t >= 1.6 || Math.abs(h.ny) >= 0.2 || h.surface === 'glass') continue;
        /* a wall, not a post: the same face 0.6 m either side and lower down. On
           Whiteout the first surface found was a 0.2 m radar leg, and splatter missed it. */
        const wide = [[0.6, 1.3], [-0.6, 1.3], [0, 0.9]].every(([o, y]) => {
          const k = M.raycast(x - dz * o, y, z + dx * o, dx, 0, dz, 3, {});
          return k && Math.abs(k.t - h.t) < 0.05;
        });
        if (wide) { spot = { x, z, dx, dz }; break; }
      }
    }
  }
  if (!spot) { restore(); return { name: 'blood', pass: false, note: 'no wall spot found' }; }

  const P = new V(spot.x, 1.3, spot.z), D = new V(spot.dx, 0, spot.dz);
  for (let k = 0; k < 3; k++) E.bloodHit(P, D, false);
  window.__step(1 / 60);
  const marks = live();
  const onWall = marks.filter(b => Math.abs(normalOf(b).y) < 0.5);
  const onGround = marks.filter(b => normalOf(b).y > 0.8);

  /* one wall mark's life: full at 6 s, fading by 10 s, gone by 12 s */
  const tracked = onWall[0] || marks[0];
  const fadeAt = (t) => {
    while (tracked && tracked.live && tracked.t < t) window.__step(1 / 60);
    return tracked && tracked.live ? E.bFade.array[tracked.i] : 0;
  };
  const f60 = fadeAt(6.0), f100 = fadeAt(10.0), f1205 = fadeAt(12.05);
  const goneAtTwelve = !!tracked && !tracked.live;

  /* a kill pools blood under the body once it has come to rest */
  E.clearBlood();
  const foe = g.actors.find(a => a.team !== g.me.team);
  foe.alive = true; foe.health = 100; if (foe.char) foe.char.revive();
  const ks = openSpot(1.5, 1.4) || { x: 0, z: 0 };
  const fy = g.groundHeight(ks.x, ks.z, 0.5, 0.4);
  foe.pos.set(ks.x, fy, ks.z); foe.vel.set(0, 0, 0);
  window.__stepN(3, 1 / 60);
  g.applyDamage(foe, 500, g.me, 'TEST', false, new V(0, 0, 1), 'chest');
  foe.respawnT = 999;                                  // keep the body out of the respawn cycle
  const livePools = () => E.pools.filter(P => P.live);
  const at = (P, k) => (P && P.live ? E.pAttr.array[P.i * 3 + k] : 0);
  window.__stepN(Math.round(1.4 * 60), 1 / 60);
  const pool = livePools()[0];
  const poolUnderBody = !!pool && Math.hypot(pool.x - ks.x, pool.z - ks.z) < 1.8;
  const front14 = at(pool, 0), bodyAt14 = foe.char.root.visible;
  window.__stepN(Math.round(2.0 * 60), 1 / 60);        // 3.4 s after the kill
  const bodyGone = !foe.char.root.visible, poolStays = !!pool && pool.live;
  window.__stepN(Math.round(4.0 * 60), 1 / 60);        // 7.4 s
  const front74 = at(pool, 0);
  window.__stepN(Math.round(12.6 * 60), 1 / 60);       // 20 s
  const op20 = at(pool, 1);
  window.__stepN(Math.round(26 * 60), 1 / 60);         // 46 s
  const poolGone = livePools().length === 0;

  /* toggle off: wipes what is there, and a hit leaves nothing */
  E.bloodHit(P, D, false);
  window.__step(1 / 60);
  const beforeOff = live().length;
  setToggle(false);
  const afterOff = live().length;
  const effectsFollowsBox = E.blood === false;
  E.bloodHit(P, D, false);
  window.__step(1 / 60);
  const hitWhileOff = live().length;
  setToggle(true);

  restore();
  g.spawn(foe, false);
  const reviveSolid = foe.char.root.visible && !foe.char._faded;
  E.clearBlood();

  const checks = {
    splatterOnWall: onWall.length > 0,
    dripsOnGround: onGround.length > 0,
    fullAtSixSeconds: f60 > 0.8,
    fadingByTen: f100 > 0 && f100 < 0.6,
    goneByTwelve: goneAtTwelve && f1205 === 0,
    poolUnderBody,
    poolSpreads: front74 > front14 + 0.2,
    bodyGoneByThreeAndAHalf: bodyAt14 && bodyGone,
    poolOutlivesBody: poolStays,
    poolStillThereAt20s: op20 > 0.9,
    poolGoneBy46s: poolGone,
    bodySolidAgainOnRespawn: reviveSolid,
    toggleReachesEffects: effectsFollowsBox,
    toggleOffWipes: beforeOff > 0 && afterOff === 0,
    noBloodWhileOff: hitWhileOff === 0,
  };
  const failed = Object.keys(checks).filter(k => !checks[k]);
  return {
    name: 'blood', checks, failed,
    marks: { total: marks.length, wall: onWall.length, ground: onGround.length },
    fade: { at6s: +f60.toFixed(2), at10s: +f100.toFixed(2), at12_05s: f1205 },
    pool: { front1_4s: +front14.toFixed(2), front7_4s: +front74.toFixed(2), opacity20s: +op20.toFixed(2), reach: pool ? +pool.reach.toFixed(2) : 0 },
    pass: failed.length === 0,
  };
}

/**
 * The map-shaped tests on every map: spawn safety, sight against the bullet
 * raycast, the map walk, the AI, controls, airstrike, melee, blood and
 * rendered frame time. Each map is deployed fresh before its run.
 */
/* ---------------------------------------------------------------------------
   First person: a punch shows a fist, not the gun; looking down shows your
   legs (cut at the waist, your own gun hidden) while the shadow keeps the
   whole body. */
export async function testFirstPerson() {
  const g = G(), I = g.input, V = window.__viewmodel, me = g.me, cam = g.camera;
  await ensureLive();
  window.__stepN(20, 1 / 60);
  const saved = g.actors.map(a => a.bot);
  for (const a of g.actors) a.bot = null;
  const restore = () => { for (let i = 0; i < g.actors.length; i++) g.actors[i].bot = saved[i]; };
  const spot = openSpot(3.2, 1.4);
  if (!spot) { restore(); return { name: 'first-person', pass: false, note: 'no open ground' }; }
  const Y = g.groundHeight(spot.x, spot.z, 0.5, 0.4);
  const pose = (pitch) => { me.alive = true; me.health = 100; me.pos.set(spot.x, Y, spot.z); me.vel.set(0, 0, 0); me.yaw = 0; me.pitch = pitch; };
  const first = (m) => (Array.isArray(m) ? m[0] : m);
  const nr = window.__noRender; window.__noRender = false;   // the body layers are set in the draw
  try {
    /* 1. the punch */
    pose(0); me.meleeT = 0;
    for (let f = 0; f < 30; f++) { window.__step(1 / 60); pose(0); }
    const restY = V.rig.position.y;
    I.keys.add('KeyV'); I.pressed.add('KeyV');
    let fistFrames = 0, centred = false, lowest = restY, gunDownWhileFist = true;
    for (let f = 0; f < 50; f++) {
      window.__step(1 / 60); if (f === 0) I.keys.delete('KeyV');
      pose(0);
      lowest = Math.min(lowest, V.rig.position.y);
      if (V.fist.visible) {
        fistFrames++;
        const p = V.fist.position;
        if (Math.abs(p.x) < 0.08 && p.z < -0.42) centred = true;
        if (V.rig.position.y > restY - 0.08 && p.z < -0.35) gunDownWhileFist = false;
      }
    }
    const fistGone = !V.fist.visible;
    /* 2. the legs */
    for (let f = 0; f < 4; f++) { window.__step(1 / 60); pose(-1.25); }
    const legsLayer = cam.layers.isEnabled(6), gunHidden = !cam.layers.isEnabled(4);
    const tris = (geo) => (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    let legs = null, body = null, botsClean = true, weaponOnOwnLayer = !!me.char.weaponModel;
    me.char.model.traverse(o => { if (o.userData.fpLegs) legs = o; else if (o.isSkinnedMesh && o !== me.char.visorMesh) body = o; });
    const legsShare = legs && body ? tris(legs.geometry) / tris(body.geometry) : 0;
    // the whole body still casts the shadow; the legs cut never does (no double shadow)
    const bodyShadow = !!body && body.castShadow && body.layers.isEnabled(5) && !!legs && !legs.castShadow;
    const clipped = !!legs && legs.layers.isEnabled(6) && legsShare > 0.15 && legsShare < 0.6;
    for (const a of g.actors) if (a !== me && a.char) a.char.model.traverse(o => {
      if (o.userData.fpLegs || (o.isMesh && o.layers.isEnabled(5))) botsClean = false;
    });
    if (me.char.weaponModel) me.char.weaponModel.traverse(o => { if (o.isMesh && !o.layers.isEnabled(4)) weaponOnOwnLayer = false; });
    let upperOff = 0;   // helmet, visor, plate carrier: shadow only
    me.char.model.traverse(o => { if (o.isMesh && o.layers.isEnabled(5)) upperOff++; });
    const upperHidden = !cam.layers.isEnabled(5);
    pose(0);
    const pass = fistFrames >= 12 && centred && fistGone && gunDownWhileFist && restY - lowest > 0.15 &&
      legsLayer && gunHidden && upperOff >= 1 && upperHidden && clipped && bodyShadow && botsClean && weaponOnOwnLayer;
    return { name: 'first-person', pass, fistFrames, centred, fistGone, gunDrop: +(restY - lowest).toFixed(3), gunDownWhileFist,
      legsLayer, gunHidden, clipped, bodyShadow, botsClean, weaponOnOwnLayer, upperOff, upperHidden, legsShare: +legsShare.toFixed(2) };
  } finally { window.__noRender = nr; restore(); }
}

/* ---------------------------------------------------------------------------
   Skins: five free, ten bought with banked headshot kills. A skin dresses your
   gun, fist and operator - and nobody else - and every one of them compiles. */
export async function testSkins() {
  const g = G(), S = await import('/src/game/skins.js'), V = window.__viewmodel, me = g.me;
  const KEY = 'obk.profile.v1', backup = localStorage.getItem(KEY);
  const first = (m) => (Array.isArray(m) ? m[0] : m);
  const camoOf = (m) => !!(m && m.userData && m.userData.camoUniforms);
  await ensureLive();
  try {
    localStorage.removeItem(KEY);
    let p = S.loadProfile();
    const free = S.SKINS.filter(s => S.isUnlocked(p, s.id)).length, paid = S.SKINS.filter(s => s.cost > 0).length;
    const tooPoor = S.unlockSkin(p, 'tiger');                   // costs 1, the bank is empty
    /* the real kill path banks a headshot kill, and only a headshot kill */
    const foes = g.actors.filter(a => a.team !== me.team && a.alive);
    const b0 = S.loadProfile().headshots;
    g.killActor(foes[0], me, 'TEST', false);
    const afterBody = S.loadProfile().headshots;
    g.killActor(foes[1], me, 'TEST', true);
    const afterHead = S.loadProfile().headshots;
    p = S.loadProfile();
    const bought = S.unlockSkin(p, 'tiger');
    const short = S.unlockSkin(p, 'gold');
    const equipped = S.equipSkin(p, 'tiger') && S.loadProfile().skin === 'tiger';
    const lockedEquip = S.equipSkin(S.loadProfile(), 'gold');
    /* dressing */
    const skin = S.SKIN_BY_ID.tiger;
    V.setSkin(skin); S.skinOperator(me.char, skin);
    const parts = {};
    V.weapon.traverse(o => { if (o.isMesh) parts[o.name] = camoOf(first(o.material)); });
    const gunOk = parts.poly === true && parts.steel === false && parts.lens === false;
    const sleeveOk = camoOf(V.fistSleeve.material);
    let suitOk = false, legsWear = false, botsClean = true, tpGun = false;
    me.char.model.traverse(o => {
      if (!o.isSkinnedMesh || /visor/i.test(o.name)) return;
      const m = first(o.material);
      if (camoOf(m)) suitOk = true;
      if (o.userData.fpLegs && camoOf(m)) legsWear = true;   // the first-person legs wear it too
    });
    for (const a of g.actors) if (a !== me && a.char) a.char.model.traverse(o => { if (o.isMesh && camoOf(first(o.material))) botsClean = false; });
    if (me.char.weaponModel) me.char.weaponModel.traverse(o => { if (o.isMesh && o.name === 'poly') tpGun = camoOf(first(o.material)); });
    /* every skin compiles: draw a frame in each */
    const nr = window.__noRender; window.__noRender = false;
    const bad = new Set();
    for (const s of S.SKINS) {
      V.setSkin(s); S.skinOperator(me.char, s); window.__step(1 / 60);
      for (const pr of window.__renderer.info.programs || []) if (pr.diagnostics && !pr.diagnostics.runnable) bad.add(s.id);
    }
    window.__noRender = nr;
    const pass = free === 5 && paid === 10 && !tooPoor.ok && afterBody === b0 && afterHead === b0 + 1 && bought.ok &&
      !short.ok && equipped && !lockedEquip && gunOk && sleeveOk && suitOk && legsWear && botsClean && tpGun && !bad.size;
    return { name: 'skins', pass, free, paid, tooPoor: tooPoor.reason, bankBody: afterBody - b0, bankHead: afterHead - b0,
      bought: bought.reason, short: short.reason, equipped, lockedEquip, gunParts: parts, sleeveOk, suitOk, legsWear,
      botsClean, tpGun, shaderErrors: [...bad] };
  } finally {
    if (backup === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, backup);
    const s = S.currentSkin(); V.setSkin(s); S.skinOperator(me.char, s);
  }
}

export async function runMaps(ids = MAP_ORDER) {
  const out = {};
  for (const id of ids) {
    const g = G();
    g.menu.selectMap(id);
    g.deploy();
    await ensureLive();
    window.__stepN(30, 1 / 60);
    const r = [];
    const run = async (f, ...a) => {
      try { r.push(await f(...a)); } catch (e) { r.push({ name: f.name, pass: false, error: String(e && e.stack || e) }); }
    };
    await run(testSpawns); await run(testWallPenetrationHonesty); await run(testMapWalk); await run(testAI);
    await run(testControls); await run(testTeamAirstrike); await run(testMelee); await run(testBlood);
    await ensureLive();
    await run(testPerformance, 240);
    out[id] = { map: g.map.id, pass: r.every(x => x.pass), failed: r.filter(x => !x.pass).map(x => x.name), results: r };
  }
  window.__mapResults = out;
  return out;
}

export async function runAll(opts = {}) {
  const out = [];
  const push = (r) => { out.push(r); console.log(`[qa] ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`); return r; };
  push(testBoot());
  push(testBallistics());
  push(testRecoilLearnability());
  push(testWallPenetrationHonesty());
  if (G().state === 'MENU') G().deploy();
  window.__stepN(60, 1 / 60);
  push(testHitZones());
  push(testEveryWeapon());
  push(testSpawns());
  push(testAI());
  push(testMapWalk());
  push(testKillcam());
  push(await testControls());
  push(await testTeamAirstrike());
  push(await testMelee());
  push(await testBlood());
  push(await testFirstPerson());
  push(await testSkins());
  await ensureLive();
  push(testPerformance(opts.perfFrames ?? 320));
  window.__qaResults = out;
  return { pass: out.every(r => r.pass), failed: out.filter(r => !r.pass).map(r => r.name), results: out };
}
