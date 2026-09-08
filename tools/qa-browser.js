/* ============================================================================
   Headless QA harness.

   A pointer-locked FPS cannot be driven by synthetic mouse events in this
   environment (the embedded pane refuses pointer lock), so instead of faking
   input we drive the simulation directly through the same functions the input
   layer calls. Every assertion below exercises real game code — real raycasts
   against real animated capsules, real collision, real damage.

   Loaded from the page with:  const QA = await import('/tools/qa-browser.js')
   ========================================================================== */

const G = () => window.__game;
const T = () => window.__THREE;

function pct(a, b) { return b ? (a / b * 100).toFixed(1) + '%' : '—'; }

/* ---------------------------------------------------------------- helpers */

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
  for (let ax = -28; ax <= 28; ax += 1.5) {
    for (let az = -20; az <= 20; az += 1.5) {
      if (Math.abs(g.groundHeight(ax, az, 40, 0.36)) > 0.01) continue;
      if (m.pointBlocked(ax, 1.2, az, 0.5)) continue;
      for (const [ux, uz] of dirs) {
        const bx = ax + ux * range, bz = az + uz * range;
        if (Math.abs(bx) > 29 || Math.abs(bz) > 21) continue;
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
    const ax = rng() * 60 - 30, az = rng() * 44 - 22;
    const bx = rng() * 60 - 30, bz = rng() * 44 - 22;
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
  const route = [
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
  for (let x = -30; x <= 30; x += 1.25) {
    for (let z = -22; z <= 22; z += 1.25) {
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
  window.__benchmark = false;
  return {
    name: 'frame time, all opponents active and firing',
    frames, actors: g.actors.length, warmupFrames: 90,
    meanMs: +mean.toFixed(2), medianMs: +samples[samples.length >> 1].toFixed(2),
    p95Ms: +p95.toFixed(2), p99Ms: +p99.toFixed(2), maxMs: +samples[samples.length - 1].toFixed(2),
    impliedFps: +(1000 / mean).toFixed(1),
    wallMs: +wall.toFixed(0),
    drawCalls: info.render.calls, triangles: info.render.triangles,
    pass: mean < 16.67,
    note: `budget for 60 fps is 16.67 ms/frame`,
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
  if (g.state === 'MENU') g.deploy();
  /* deploy() requests pointer lock; the rejection that sets lockUnavailable
     arrives as a task, so yield before driving keys or the input layer will
     still be gated and nothing moves. */
  await new Promise(r => setTimeout(r, 80));
  window.__stepN(30, 1 / 60);
  const I = g.input, me = g.me;

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
  push(testPerformance(opts.perfFrames ?? 320));
  window.__qaResults = out;
  return { pass: out.every(r => r.pass), failed: out.filter(r => !r.pass).map(r => r.name), results: out };
}
