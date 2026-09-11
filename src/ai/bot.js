/* ============================================================================
   Enemy and friendly AI.

   The bot produces an *intent* each tick — move direction, aim angles, whether
   the trigger is down — and the match applies it through the same movement and
   firing code the player uses. There is no separate "AI shooting"; a bot's round
   is resolved by the same raycast against the same animated capsules.

   Perception is honest: a bot only knows where you are if it has line of sight
   through the same geometry your bullets travel through, inside its view cone,
   for longer than its reaction time. Gunfire and footsteps give it a *guess*,
   not a position, and it will walk to that guess and be wrong.

   States:
     PATROL   roam between map hotspots, look around
     ALERT    heard something — move to investigate, weapon up
     ENGAGE   target visible — hold an angle, strafe, fire in bursts
     PUSH     lost sight — move to last known position, expect a peek
     COVER    hurt or reloading — break line of sight, heal up, re-peek
     FLANK    target is dug in — path to a cover point with a new angle
   ========================================================================== */
import * as THREE from 'three';
import { makeRng, clamp, lerp, damp, wrapPi, dampAngle } from '../core/util.js';
import { FIRE } from '../weapons/defs.js';

export const DIFFICULTY = [
  { key: 0, name: 'RECRUIT',
    reaction: [0.52, 0.95], aimErrDeg: 6.0, tighten: 1.5, leadK: 0.35, headChance: 0.02,
    burst: [2, 5], burstGap: [0.42, 0.95], strafe: 0.45, coverUse: 0.30, aggression: 0.45,
    hearing: 26, viewRange: 46, viewCone: 1.15, reflexPenalty: 1.5, missBias: 1.35, health: 100 },
  { key: 1, name: 'REGULAR',
    reaction: [0.28, 0.55], aimErrDeg: 3.4, tighten: 2.5, leadK: 0.68, headChance: 0.07,
    burst: [3, 7], burstGap: [0.30, 0.70], strafe: 0.72, coverUse: 0.55, aggression: 0.68,
    hearing: 34, viewRange: 56, viewCone: 1.28, reflexPenalty: 1.0, missBias: 1.0, health: 100 },
  { key: 2, name: 'HARDENED',
    reaction: [0.17, 0.33], aimErrDeg: 2.1, tighten: 3.8, leadK: 0.88, headChance: 0.14,
    burst: [4, 9], burstGap: [0.22, 0.50], strafe: 0.88, coverUse: 0.76, aggression: 0.84,
    hearing: 42, viewRange: 64, viewCone: 1.38, reflexPenalty: 0.8, missBias: 0.82, health: 100 },
  { key: 3, name: 'VETERAN',
    reaction: [0.10, 0.21], aimErrDeg: 1.25, tighten: 5.2, leadK: 1.0, headChance: 0.22,
    burst: [5, 14], burstGap: [0.16, 0.38], strafe: 1.0, coverUse: 0.90, aggression: 1.0,
    hearing: 52, viewRange: 72, viewCone: 1.48, reflexPenalty: 0.62, missBias: 0.70, health: 100 },
];

const S = { PATROL: 'PATROL', ALERT: 'ALERT', ENGAGE: 'ENGAGE', PUSH: 'PUSH', COVER: 'COVER', FLANK: 'FLANK' };

/* global budget so a busy frame never stalls on pathfinding */
let pathBudget = 0;
export function resetPathBudget(n = 3) { pathBudget = n; }

export class Bot {
  constructor(actor, world, difficulty, seed) {
    this.a = actor;
    this.w = world;
    this.D = DIFFICULTY[clamp(difficulty, 0, 3)];
    this.r = makeRng(seed * 2654435761 + 17);

    this.state = S.PATROL;
    this.stateT = 0;
    this.target = null;
    this.lastKnown = new THREE.Vector3();
    this.hasLastKnown = false;
    this.lkAge = 99;
    this.visibleT = 0;        // how long the target has been continuously visible
    this.lostT = 99;
    this.reaction = 0;
    this.aimErr = new THREE.Vector2();
    this.aimErrTarget = new THREE.Vector2();
    this.errTimer = 0;

    this.path = [];
    this.pathIdx = 0;
    this.repath = 0;
    this.goal = new THREE.Vector3();
    this.hasGoal = false;
    this.stuckT = 0;
    this.lastPos = new THREE.Vector3();

    this.strafeDir = this.r.sign();
    this.strafeT = 0;
    this.burstLeft = 0;
    this.burstGap = 0;
    this.cover = null;
    this.peek = 0;
    this.crouchWant = 0;
    this.wantJump = false;

    this.intent = { mx: 0, mz: 0, yaw: 0, pitch: 0, fire: false, reload: false,
                    crouch: false, sprint: false, jump: false, lethal: false };
    this.hotspotIdx = this.r.int(0, 5);
    this._seeAcc = this.r() / 15;    // stagger perception ticks across the roster
    this.scanYaw = 0;
    this._v = new THREE.Vector3();
    this._u = new THREE.Vector3();
  }

  /* ---- perception ------------------------------------------------------- */
  eyePos(a, out) { return out.set(a.pos.x, a.pos.y + (a.crouch > 0.5 ? 1.12 : 1.58), a.pos.z); }

  canSee(target) {
    const a = this.a, D = this.D;
    const eye = this.eyePos(a, this._v);
    const tgt = this._u.set(target.pos.x, target.pos.y + (target.crouch > 0.5 ? 0.95 : 1.35), target.pos.z);
    const dx = tgt.x - eye.x, dy = tgt.y - eye.y, dz = tgt.z - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > D.viewRange) return false;
    // view cone
    const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
    const dot = (dx * fx + dz * fz) / (Math.hypot(dx, dz) || 1);
    if (dot < Math.cos(D.viewCone)) return false;
    // real line of sight through the same geometry bullets use
    if (!this.w.map.lineOfSight(eye.x, eye.y, eye.z, tgt.x, tgt.y, tgt.z)) {
      // try the head as a second sample — leaning targets peek over cover
      const hy = target.pos.y + 1.62;
      if (!this.w.map.lineOfSight(eye.x, eye.y, eye.z, tgt.x, hy, tgt.z)) return false;
    }
    return true;
  }

  pickTarget() {
    let best = null, bestScore = -Infinity;
    for (const o of this.w.actors) {
      if (o === this.a || !o.alive || o.team === this.a.team) continue;
      if (!this.canSee(o)) continue;
      const d = Math.hypot(o.pos.x - this.a.pos.x, o.pos.z - this.a.pos.z);
      let sc = 100 - d;
      if (o === this.target) sc += 22;            // stickiness
      if (o.isLocal) sc += 6;                     // slight lean toward the player
      if (o.health < 50) sc += 14;
      if (sc > bestScore) { bestScore = sc; best = o; }
    }
    return best;
  }

  /** Called by the match when a shot is fired nearby. */
  hearGunshot(pos, loudness) {
    const d = Math.hypot(pos.x - this.a.pos.x, pos.z - this.a.pos.z);
    if (d > this.D.hearing * loudness) return;
    if (this.state === S.ENGAGE) return;
    // a noise gives a fuzzy bearing, not a fix
    const err = clamp(d * 0.16, 1.2, 7.0);
    this.lastKnown.set(pos.x + this.r.gauss() * err, pos.y, pos.z + this.r.gauss() * err);
    this.hasLastKnown = true;
    this.lkAge = 0;
    if (this.state === S.PATROL) { this.setState(S.ALERT); this.hasGoal = false; }
  }

  onDamaged(fromPos) {
    this.lastKnown.copy(fromPos);
    this.hasLastKnown = true;
    this.lkAge = 0;
    if (this.state === S.PATROL || this.state === S.ALERT) this.setState(S.PUSH);
    // being shot at while exposed pushes the bot toward cover
    if (this.a.health < 55 && this.r() < this.D.coverUse) { this.cover = null; this.setState(S.COVER); }
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s; this.stateT = 0; this.hasGoal = false; this.path.length = 0;
  }

  /* ---- pathing ---------------------------------------------------------- */
  setGoal(x, y, z, force) {
    if (this.hasGoal && !force && this._v.set(x, y, z).distanceToSquared(this.goal) < 1.7 * 1.7) return;
    this.goal.set(x, y, z);
    this.hasGoal = true;
    this.repath = 0;
  }

  updatePath(dt) {
    this.repath -= dt;
    if (!this.hasGoal || this.repath > 0) return;
    if (pathBudget <= 0) { this.repath = 0.08; return; }
    pathBudget--;
    this.repath = this.r.range(0.55, 1.05);
    const p = this.w.map.findPath(this.a.pos.x, this.a.pos.y, this.a.pos.z,
      this.goal.x, this.goal.y, this.goal.z, this._pathOut || (this._pathOut = []));
    if (p && p.length) { this.path = p.slice(); this.pathIdx = 0; }
    else { this.path.length = 0; this.hasGoal = false; }
  }

  /** Steering toward the current path node. Returns {x,z} unit-ish direction.
   *  Sets `wantJump` when the next node is higher than the step-up allowance —
   *  the navmesh links window sills and low ledges as mantles, and without the
   *  hop a bot will grind into the wall under a window it was told to climb. */
  follow(out) {
    out.x = 0; out.z = 0;
    if (this.pathIdx >= this.path.length) return out;
    const a = this.a;
    let wp = this.path[this.pathIdx];
    let dx = wp.x - a.pos.x, dz = wp.z - a.pos.z;
    let d = Math.hypot(dx, dz);
    // advance through waypoints we've effectively reached
    while (d < 0.85 && this.pathIdx < this.path.length - 1) {
      this.pathIdx++;
      wp = this.path[this.pathIdx];
      dx = wp.x - a.pos.x; dz = wp.z - a.pos.z; d = Math.hypot(dx, dz);
    }
    if (d < 0.5 && this.pathIdx >= this.path.length - 1) { this.hasGoal = false; this.path.length = 0; return out; }
    if (d > 1e-4) { out.x = dx / d; out.z = dz / d; }
    // vault: the waypoint is above what we can step onto, and we are close enough
    if (wp.y - a.pos.y > 0.44 && d < 1.6 && a.grounded) this.wantJump = true;
    return out;
  }

  /* ---- cover ------------------------------------------------------------ */
  findCover(fromPos, minDist, maxDist) {
    const list = this.w.map.coverNear(this.a.pos.x, this.a.pos.z, maxDist,
      this._cov || (this._cov = []));
    let best = null, bestScore = -Infinity;
    for (const c of list) {
      const dSelf = Math.hypot(c.x - this.a.pos.x, c.z - this.a.pos.z);
      if (dSelf < minDist) continue;
      const dThreat = Math.hypot(c.x - fromPos.x, c.z - fromPos.z);
      if (dThreat < 5.5) continue;
      // the obstacle must be between the cover point and the threat
      const tx = fromPos.x - c.x, tz = fromPos.z - c.z;
      const tl = Math.hypot(tx, tz) || 1;
      const facing = (tx / tl) * -c.dx + (tz / tl) * -c.dz;
      if (facing < 0.30) continue;
      let sc = facing * 34 - dSelf * 1.5 + clamp(dThreat, 0, 30) * 0.5;
      if (c.crouch) sc += 6;
      sc += this.r() * 8;
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    return best;
  }

  /* ---- aiming ----------------------------------------------------------- */
  aimAt(target, dt) {
    const a = this.a, D = this.D, W = a.weapon;
    const eye = this.eyePos(a, this._v);
    const tp = this._u;
    // aim height: chest, occasionally head
    const headY = target.pos.y + (target.crouch > 0.5 ? 1.12 : 1.60);
    const chestY = target.pos.y + (target.crouch > 0.5 ? 0.88 : 1.28);
    if (this._headShotRoll === undefined || this.visibleT < 0.1) this._headShotRoll = this.r();
    const goHead = this._headShotRoll < D.headChance;
    tp.set(target.pos.x, goHead ? headY : chestY, target.pos.z);

    /* --- lead the shot --- */
    const dist = eye.distanceTo(tp);
    const vel = W ? (W.def.muzzleVel || 700) : 700;
    const tof = dist / vel + 0.045;    // travel + a human-ish extra delay
    tp.x += target.vel.x * tof * D.leadK;
    tp.z += target.vel.z * tof * D.leadK;

    /* --- error cone that tightens with time on target --- */
    this.errTimer -= dt;
    if (this.errTimer <= 0) {
      this.errTimer = this.r.range(0.14, 0.34);
      const settle = Math.exp(-this.visibleT * D.tighten);
      const spreadMul = D.missBias * (0.30 + 0.70 * settle)
        * (1 + clamp(dist / 55, 0, 1) * 0.9)
        * (a.moving > 0.4 ? 1.35 : 1.0)
        * (Math.hypot(target.vel.x, target.vel.z) > 3 ? 1.30 : 1.0);
      const amp = D.aimErrDeg * spreadMul * Math.PI / 180;
      this.aimErrTarget.set(this.r.gauss() * amp, this.r.gauss() * amp * 0.62);
    }
    this.aimErr.x = damp(this.aimErr.x, this.aimErrTarget.x, 7, dt);
    this.aimErr.y = damp(this.aimErr.y, this.aimErrTarget.y, 7, dt);

    const dx = tp.x - eye.x, dy = tp.y - eye.y, dz = tp.z - eye.z;
    const wantYaw = Math.atan2(dx, dz) + this.aimErr.x;
    const wantPitch = Math.atan2(dy, Math.hypot(dx, dz)) + this.aimErr.y;

    // turn speed: fast but not instant, scaled by difficulty
    const turn = lerp(7, 17, D.aggression) / D.reflexPenalty;
    a.yaw = dampAngle(a.yaw, wantYaw, turn, dt);
    a.pitch = damp(a.pitch, wantPitch, turn, dt);
    return { dist, aligned: Math.abs(wrapPi(wantYaw - a.yaw)) < 0.09 && Math.abs(wantPitch - a.pitch) < 0.09 };
  }

  /* ---- main tick -------------------------------------------------------- */
  think(dt) {
    const a = this.a, D = this.D, I = this.intent;
    I.mx = 0; I.mz = 0; I.fire = false; I.reload = false; I.crouch = false;
    I.sprint = false; I.jump = false; I.lethal = false;
    this.stateT += dt;
    this.lkAge += dt;

    if (!a.alive) return I;

    /* --- stuck detection --- */
    const moved = this._v.copy(a.pos).sub(this.lastPos).length();
    this.lastPos.copy(a.pos);
    if (this.hasGoal && moved < 0.012 * 60 * dt) this.stuckT += dt; else this.stuckT = 0;
    if (this.stuckT > 0.85) {
      this.stuckT = 0;
      this.path.length = 0; this.hasGoal = false; this.repath = 0;
      this.strafeDir *= -1;
      this.wantJump = true;
    }

    /* --- acquire ---
       Target selection is the expensive part of thinking: it line-of-sight tests
       this bot against every enemy, so at 60 Hz with a full roster it is a few
       thousand raycasts a second for information that cannot change meaningfully
       inside 60 ms. Run it at ~15 Hz, staggered by bot index so the cost is
       spread across frames rather than spiking on one. Aim and steering stay at
       full rate, which is what you can actually see. */
    this._seeAcc = (this._seeAcc || 0) + dt;
    let seen;
    if (this._seeAcc >= 1 / 15 || this._lastSeen === undefined) {
      this._seeAcc %= 1 / 15;
      seen = this.pickTarget();          // full scan: every enemy, ~15 Hz
      this._lastSeen = seen;
    } else {
      /* Between scans, re-verify the CURRENT target every frame. That is one
         raycast instead of one per enemy, and it keeps perception honest at the
         frame level: the moment you break line of sight the bot loses you, so it
         can never keep tracking — or keep shooting at — something behind cover.
         Only the search for someone NEW is throttled. */
      seen = (this._lastSeen && this._lastSeen.alive && this.canSee(this._lastSeen))
        ? this._lastSeen : null;
      if (!seen) this._lastSeen = null;
    }
    if (seen) {
      if (this.target !== seen) { this.target = seen; this.visibleT = 0; this.reaction = this.r.range(...D.reaction); }
      this.visibleT += dt;
      this.lostT = 0;
      this.lastKnown.copy(seen.pos); this.hasLastKnown = true; this.lkAge = 0;
      if (this.reaction > 0) this.reaction -= dt;
    } else {
      this.visibleT = 0;
      this.lostT += dt;
      if (this.lostT > 0.55 && this.target) {
        if (this.state === S.ENGAGE) this.setState(this.r() < 0.35 ? S.FLANK : S.PUSH);
      }
      if (this.lostT > 6) this.target = null;
    }

    const W = a.weapon;
    const lowMag = W && W.mag <= Math.max(1, Math.floor(W.def.mag * 0.16));

    /* --- state selection --- */
    if (seen && this.reaction <= 0 && this.state !== S.COVER) this.setState(S.ENGAGE);
    if (this.state === S.ENGAGE && (a.health < 34 && this.r() < D.coverUse * dt * 3)) this.setState(S.COVER);
    if (W && W.mag <= 0 && W.reserve > 0 && this.state === S.ENGAGE && this.r() < D.coverUse) this.setState(S.COVER);

    /* --- reload discipline --- */
    if (W && !W.reloading && W.reserve > 0) {
      if (W.mag <= 0) I.reload = true;
      else if (lowMag && (this.state !== S.ENGAGE || this.lostT > 0.8)) I.reload = true;
    }

    const move = this._moveOut || (this._moveOut = { x: 0, z: 0 });
    move.x = 0; move.z = 0;

    switch (this.state) {

      /* ---------------------------------------------------------------- */
      case S.PATROL: {
        if (!this.hasGoal) {
          const hs = this.w.hotspots;
          // prefer hotspots away from where we are, biased toward the middle
          let best = null, bs = -1e9;
          for (let i = 0; i < hs.length; i++) {
            const h = hs[i];
            const d = Math.hypot(h.x - a.pos.x, h.z - a.pos.z);
            const sc = (d > 9 ? 20 : -20) - Math.abs(d - 22) * 0.4 + this.r() * 26 + (h.weight || 0) * 6;
            if (sc > bs) { bs = sc; best = h; }
          }
          if (best) this.setGoal(best.x, best.y, best.z, true);
        }
        this.updatePath(dt);
        this.follow(move);
        I.sprint = Math.hypot(move.x, move.z) > 0.1 && this.r() < 0.9;
        // look where we're going, sweeping for contacts
        this.scanYaw += dt * 0.9;
        const base = (move.x || move.z) ? Math.atan2(move.x, move.z) : a.yaw;
        a.yaw = dampAngle(a.yaw, base + Math.sin(this.scanYaw) * 0.55, 4.5, dt);
        a.pitch = damp(a.pitch, Math.sin(this.scanYaw * 0.7) * 0.05, 3, dt);
        break;
      }

      /* ---------------------------------------------------------------- */
      case S.ALERT:
      case S.PUSH: {
        if (this.hasLastKnown) this.setGoal(this.lastKnown.x, this.lastKnown.y, this.lastKnown.z);
        this.updatePath(dt);
        this.follow(move);
        I.sprint = this.state === S.PUSH && this.lkAge < 3.5 && Math.hypot(move.x, move.z) > 0.1;
        const base = (move.x || move.z) ? Math.atan2(move.x, move.z) : a.yaw;
        // face the noise, but keep the muzzle roughly along the path
        const toLk = this.hasLastKnown
          ? Math.atan2(this.lastKnown.x - a.pos.x, this.lastKnown.z - a.pos.z) : base;
        a.yaw = dampAngle(a.yaw, this.lkAge < 2 ? toLk : base, 6, dt);
        a.pitch = damp(a.pitch, 0, 3, dt);
        if (this.stateT > 7 || (!this.hasGoal && this.stateT > 1.2)) this.setState(S.PATROL);
        break;
      }

      /* ---------------------------------------------------------------- */
      case S.ENGAGE: {
        const t = this.target;
        if (!t || !t.alive) { this.setState(S.PATROL); break; }
        const info = this.aimAt(t, dt);
        const dist = info.dist;

        /* positioning: hold a preferred range for the weapon in hand */
        const wantMin = W ? (W.def.kind === 'sniper' ? 22 : W.def.kind === 'smg' ? 4 : 8) : 8;
        const wantMax = W ? (W.def.kind === 'smg' ? 18 : W.def.kind === 'sniper' ? 90 : 34) : 30;
        const toT = this._v.set(t.pos.x - a.pos.x, 0, t.pos.z - a.pos.z);
        const dl = toT.length() || 1;
        toT.multiplyScalar(1 / dl);

        this.strafeT -= dt;
        if (this.strafeT <= 0) { this.strafeT = this.r.range(0.6, 1.6); if (this.r() < 0.45) this.strafeDir *= -1; }

        if (dist > wantMax && seen) { move.x += toT.x; move.z += toT.z; }
        else if (dist < wantMin) { move.x -= toT.x; move.z -= toT.z; }
        // strafe across the target's line — the thing that makes them hard to hit
        const sx = -toT.z * this.strafeDir, sz = toT.x * this.strafeDir;
        move.x += sx * D.strafe; move.z += sz * D.strafe;

        // crouch behind low cover when holding an angle
        this.crouchWant = (dist > 16 && this.r() < 0.004) ? 1 - this.crouchWant : this.crouchWant;
        I.crouch = this.crouchWant > 0.5 && Math.hypot(move.x, move.z) < 0.3;

        /* trigger discipline */
        if (seen && this.reaction <= 0 && W && W.mag > 0 && !W.reloading) {
          this.burstGap -= dt;
          if (this.burstLeft <= 0 && this.burstGap <= 0) {
            this.burstLeft = this.r.int(...D.burst);
            if (W.def.fire === FIRE.BOLT || W.def.fire === FIRE.SEMI) this.burstLeft = this.r.int(1, 3);
          }
          if (this.burstLeft > 0) {
            const aimOk = info.aligned || this.visibleT > 0.35;
            if (aimOk) {
              I.fire = true;
              if (W.sinceFire < 0.02) this.burstLeft--;
              if (this.burstLeft <= 0) this.burstGap = this.r.range(...D.burstGap);
            }
          }
        }
        // grenades on a dug-in target
        if (dist > 8 && dist < 24 && this.lostT > 1.2 && this.hasLastKnown &&
            a.lethalCount > 0 && this.r() < 0.0025 * D.aggression) I.lethal = true;
        break;
      }

      /* ---------------------------------------------------------------- */
      case S.COVER: {
        if (!this.cover) {
          const threat = this.hasLastKnown ? this.lastKnown : (this.target ? this.target.pos : a.pos);
          this.cover = this.findCover(threat, 1.5, 22);
          if (!this.cover) { this.setState(S.PATROL); break; }
          this.setGoal(this.cover.x, this.cover.y, this.cover.z, true);
        }
        this.updatePath(dt);
        this.follow(move);
        const atCover = Math.hypot(a.pos.x - this.cover.x, a.pos.z - this.cover.z) < 1.1;
        if (atCover) {
          I.crouch = this.cover.crouch;
          // face the threat and wait out the reload / regen
          if (this.hasLastKnown) {
            a.yaw = dampAngle(a.yaw, Math.atan2(this.lastKnown.x - a.pos.x, this.lastKnown.z - a.pos.z), 7, dt);
          }
          a.pitch = damp(a.pitch, 0, 4, dt);
          const healed = a.health > 72;
          const loaded = !W || W.mag > W.def.mag * 0.5 || W.reserve <= 0;
          if ((healed && loaded && this.stateT > 1.2) || this.stateT > 7.5) {
            this.cover = null;
            this.setState(this.target && this.target.alive ? S.PUSH : S.PATROL);
          }
        } else {
          I.sprint = a.health > 25 && Math.hypot(move.x, move.z) > 0.1;
          const base = (move.x || move.z) ? Math.atan2(move.x, move.z) : a.yaw;
          a.yaw = dampAngle(a.yaw, base, 7, dt);
        }
        if (this.stateT > 11) { this.cover = null; this.setState(S.PATROL); }
        break;
      }

      /* ---------------------------------------------------------------- */
      case S.FLANK: {
        if (!this.hasGoal) {
          const threat = this.hasLastKnown ? this.lastKnown : a.pos;
          // pick a cover point roughly 70-110 degrees off our current bearing
          const cur = Math.atan2(a.pos.x - threat.x, a.pos.z - threat.z);
          const swing = cur + this.r.sign() * this.r.range(1.1, 2.1);
          const rad = this.r.range(9, 17);
          const gx = threat.x + Math.sin(swing) * rad, gz = threat.z + Math.cos(swing) * rad;
          const c = this.w.map.navIndex(gx, gz);
          const gy = this.w.map.navN[c] ? this.w.map.navH[c * this.w.map.MAXS] : 0;
          this.setGoal(gx, gy, gz, true);
        }
        this.updatePath(dt);
        this.follow(move);
        I.sprint = Math.hypot(move.x, move.z) > 0.1;
        const base = (move.x || move.z) ? Math.atan2(move.x, move.z) : a.yaw;
        a.yaw = dampAngle(a.yaw, base, 6, dt);
        if (this.stateT > 6 || !this.hasGoal) this.setState(S.PUSH);
        break;
      }
    }

    /* --- separation: don't clump up with squadmates --- */
    for (const o of this.w.actors) {
      if (o === a || !o.alive || o.team !== a.team) continue;
      const dx = a.pos.x - o.pos.x, dz = a.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 3.2 * 3.2 && d2 > 1e-4) {
        const d = Math.sqrt(d2);
        const k = (1 - d / 3.2) * 0.75;
        move.x += (dx / d) * k; move.z += (dz / d) * k;
      }
    }

    const ml = Math.hypot(move.x, move.z);
    if (ml > 1) { move.x /= ml; move.z /= ml; }
    I.mx = move.x; I.mz = move.z;
    if (this.wantJump) { I.jump = true; this.wantJump = false; }
    // never sprint while shooting
    if (I.fire) I.sprint = false;
    if (I.sprint && this.state === S.ENGAGE) I.sprint = false;
    return I;
  }
}
