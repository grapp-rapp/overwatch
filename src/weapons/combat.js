/* ============================================================================
   Weapon state and shot resolution.

   Player and AI run the exact same code here. That matters: it means an AI shot
   and your shot are resolved by the same raycast against the same animated
   capsules with the same falloff table, so "how did that not hit" always has a
   real answer rather than being a difference in code paths.

   Recoil is an actual aim offset, not a camera shake. Firing moves where the
   barrel points; you must pull down to stay on target, and when you stop the
   view recovers toward where it was. That is what makes a pattern learnable.
   ========================================================================== */
import * as THREE from 'three';
import { FIRE, damageAt } from './defs.js';
import { clamp, lerp, damp, makeRng, wrapPi } from '../core/util.js';

const DEG = Math.PI / 180;
const rng = makeRng(0xBA111577);

export class WeaponState {
  constructor(def, owner) {
    this.def = def;
    this.owner = owner;
    this.mag = def.mag;
    this.reserve = def.reserve;
    this.fireTimer = 0;
    this.shotIndex = 0;
    this.bloom = 0;
    this.recoilPitch = 0; this.recoilYaw = 0;
    this.shotPitch = 0; this.shotYaw = 0;   // aim offset at the instant of firing
    this.visualKick = 0; this.visualYaw = 0;
    this.reloading = false; this.reloadT = 0; this.reloadDur = 0;
    this.shellPhase = null;
    this.bolting = false; this.boltT = 0;
    this.burstLeft = 0;
    this.mode = def.fire;
    this.lastFire = -99;
    this.sinceFire = 99;
    this.swayT = rng() * 100;
    this.breath = 1;          // 1 = full lungs, 0 = out of breath
    this.steady = 0;          // 1 = breath held and the scope settled
    this.holdingBreath = false;
    this.equipT = 0;
    this.dryClick = 0;
  }

  get empty() { return this.mag <= 0; }
  get canFire() {
    return !this.reloading && !this.bolting && this.mag > 0 && this.fireTimer <= 0 && this.equipT <= 0;
  }
  get fireInterval() { return 60 / this.def.rpm; }

  reset() {
    this.mag = this.def.mag; this.reserve = this.def.reserve;
    this.reloading = false; this.bolting = false; this.bloom = 0;
    this.recoilPitch = this.recoilYaw = 0; this.shotIndex = 0;
    this.shotPitch = this.shotYaw = 0;
    this.visualKick = this.visualYaw = 0; this.breath = 1; this.steady = 0;
  }

  /** Current cone half-angle in radians. */
  spread(adsW, moving, airborne, crouched) {
    const s = this.def.spread;
    const base = lerp(s.hipBase, s.adsBase, adsW);
    const max = lerp(s.hipMax, s.adsMax, adsW);
    let v = Math.min(max, base + this.bloom);
    if (airborne) v *= s.airMult;
    else if (moving > 0.1) v *= lerp(1, s.moveMult, clamp(moving, 0, 1));
    if (crouched) v *= s.crouchMult;
    return v * DEG;
  }

  startReload(audio, pos, isLocal) {
    const d = this.def;
    if (this.reloading || this.mag >= d.mag || this.reserve <= 0) return false;
    this.reloading = true;
    this.reloadT = 0;
    if (d.shellReload) {
      this.shellPhase = 'start';
      this.reloadDur = d.reload.startup;
    } else {
      this.reloadDur = this.mag <= 0 ? d.reload.empty : d.reload.tac;
      this._playedMagOut = false; this._playedMagIn = false;
    }
    return true;
  }

  /**
   * Abort any reload outright — magazine or shell-by-shell — keeping what is
   * already in the gun. A melee does this: you drop the reload and swing, and
   * have to start it again. Rounds only move from reserve into the magazine
   * when a magazine reload completes, or one shell at a time, so abandoning a
   * reload costs time and never ammunition.
   */
  interruptReload() {
    if (!this.reloading) return false;
    this.reloading = false; this.shellPhase = null; this.reloadT = 0;
    return true;
  }

  cancelReload() {
    if (!this.reloading) return false;
    // shell-by-shell reloads can be interrupted to fire immediately
    if (this.def.shellReload && this.mag > 0) { this.reloading = false; this.shellPhase = null; return true; }
    return false;
  }

  update(dt, ctx) {
    this.fireTimer -= dt;
    this.sinceFire += dt;
    this.equipT = Math.max(0, this.equipT - dt);
    this.dryClick = Math.max(0, this.dryClick - dt);

    /* spread recovery */
    const s = this.def.spread;
    this.bloom = Math.max(0, this.bloom - s.decay * dt);

    /* recoil recovery — the barrel drifts back toward where it started */
    const r = this.def.recoil;
    const rec = this.sinceFire > 0.09 ? r.recovery : r.recovery * 0.16;
    this.recoilPitch = damp(this.recoilPitch, 0, rec, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, rec * 0.8, dt);
    this.visualKick = damp(this.visualKick, 0, 12, dt);
    this.visualYaw = damp(this.visualYaw, 0, 11, dt);
    if (this.sinceFire > 0.35) this.shotIndex = 0;

    /* bolt cycle */
    if (this.bolting) {
      this.boltT += dt;
      if (this.boltT >= this.def.boltTime) { this.bolting = false; this.boltT = 0; }
    }

    /* breath (scoped snipers) */
    const sw = this.def.sway;
    if (sw) {
      const hold = this.holdingBreath && this.breath > 0;
      if (hold) this.breath = Math.max(0, this.breath - dt / sw.breathHold);
      else this.breath = Math.min(1, this.breath + dt / sw.breathRecover);
      // holding settles the scope in a few frames; letting go, or running out, lets it drift again
      this.steady += ((hold ? 1 : 0) - this.steady) * Math.min(1, dt * (hold ? 10 : 3));
    }
    this.swayT += dt;

    /* reload */
    if (this.reloading) {
      this.reloadT += dt;
      const d = this.def;
      if (d.shellReload) this._updateShellReload(dt, ctx);
      else {
        const p = this.reloadT / this.reloadDur;
        if (ctx && ctx.audio) {
          if (!this._playedMagOut && p > 0.18) { this._playedMagOut = true; this._mech(ctx, 'magout'); }
          if (!this._playedMagIn && p > 0.62) { this._playedMagIn = true; this._mech(ctx, 'magin'); }
        }
        if (this.reloadT >= this.reloadDur) {
          const need = d.mag - this.mag;
          const take = Math.min(need, this.reserve);
          this.mag += take; this.reserve -= take;
          this.reloading = false;
          this.bloom = 0;
          if (d.fire === FIRE.BOLT) this.bolting = false;
          this._mech(ctx, 'bolt');
        }
      }
    }
  }

  _updateShellReload(dt, ctx) {
    const d = this.def;
    if (this.reloadT < this.reloadDur) return;
    this.reloadT = 0;
    if (this.shellPhase === 'start') {
      this.shellPhase = 'shell'; this.reloadDur = d.reload.perShell;
      return;
    }
    if (this.shellPhase === 'shell') {
      this.mag++; this.reserve--;
      this._mech(ctx, 'shell');
      if (this.mag >= d.mag || this.reserve <= 0) { this.shellPhase = 'end'; this.reloadDur = d.reload.endup; }
      else this.reloadDur = d.reload.perShell;
      return;
    }
    this.reloading = false; this.shellPhase = null; this.bloom = 0;
  }

  _mech(ctx, kind) {
    if (!ctx || !ctx.audio) return;
    if (ctx.isLocal) ctx.audio.play('mech_' + kind, { vol: 0.55, reverb: 0.12 });
    else if (ctx.pos) ctx.audio.play('mech_' + kind, { vol: 0.5, pos: ctx.pos, reverb: 0.2 });
  }

  /**
   * Attempt to fire. Returns the number of shots fired (0 or 1 — pellets are
   * handled inside resolveShot).
   */
  tryFire(ctx, triggerDown, triggerPressed) {
    const d = this.def;
    if (this.reloading && d.shellReload && this.mag > 0) this.cancelReload();
    if (this.reloading || this.bolting || this.equipT > 0 || this.fireTimer > 0) return 0;

    if (this.mag <= 0) {
      if (triggerPressed && this.dryClick <= 0) {
        this.dryClick = 0.35;
        this._mech(ctx, 'dryfire');
        if (ctx.autoReload) ctx.autoReload();
      }
      return 0;
    }

    let go = false;
    if (this.mode === FIRE.AUTO) go = triggerDown;
    else if (this.mode === FIRE.BURST) {
      if (triggerPressed) { this.burstLeft = 3; }
      go = this.burstLeft > 0;
    } else go = triggerPressed;   // SEMI / BOLT / PUMP

    if (!go) return 0;
    if (this.mode === FIRE.BURST) this.burstLeft--;

    this.mag--;
    this.fireTimer = this.fireInterval;
    this.sinceFire = 0;
    this.lastFire = ctx.now;

    /* The round leaves the barrel BEFORE the gun moves. Snapshot the aim offset
       as it is now, so the first shot of a magazine goes exactly where the sights
       are pointed and the kick displaces the *next* one. Getting this backwards
       makes high-recoil weapons feel broken — a bolt gun would miss its own
       crosshair by five degrees. */
    this.shotPitch = this.recoilPitch;
    this.shotYaw = this.recoilYaw;

    /* ---- recoil: deterministic pattern + small gaussian jitter ---- */
    const r = d.recoil;
    const pat = r.pattern[Math.min(this.shotIndex, r.pattern.length - 1)];
    const adsK = lerp(1, r.adsMult, ctx.adsW || 0);
    const j = r.jitter;
    this.recoilPitch += pat[0] * r.vert * adsK * (1 + rng.gauss() * j) * DEG;
    this.recoilYaw += pat[1] * r.horiz * adsK * (1 + rng.gauss() * j) * DEG;
    this.visualKick += pat[0] * r.vert * r.visual * adsK * 0.9 * DEG;
    this.visualYaw += pat[1] * r.horiz * r.visual * adsK * 0.9 * DEG;
    this.shotIndex++;

    /* ---- spread bloom ---- */
    this.bloom = Math.min(d.spread.hipMax, this.bloom + d.spread.bloom);

    if (d.fire === FIRE.BOLT) { this.bolting = true; this.boltT = 0; }
    return 1;
  }
}

/* ============================================================================
   Shot resolution — shared by every shooter in the match.
   ========================================================================== */

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _hit = {}, _zh = {};
const _tmp = new THREE.Vector3(), _perp1 = new THREE.Vector3(), _perp2 = new THREE.Vector3();
const _end = new THREE.Vector3(), _n = new THREE.Vector3();

/** Build an orthonormal pair perpendicular to d. */
function basis(d, a, b) {
  if (Math.abs(d.y) < 0.94) a.set(0, 1, 0).cross(d).normalize();
  else a.set(1, 0, 0).cross(d).normalize();
  b.crossVectors(d, a).normalize();
}

/**
 * Fire one round (or one shell of pellets).
 *
 * world = { map, actors, effects, audio, onHit(info), localActor }
 * shooter must expose { team, id, pos, alive }
 */
export function resolveShot(world, shooter, weapon, originV, dirV, spreadRad, opts = {}) {
  const def = weapon.def;
  const pellets = def.pellets || 1;
  const results = [];
  basis(dirV, _perp1, _perp2);
  const MAXT = 260;

  for (let p = 0; p < pellets; p++) {
    _d.copy(dirV);
    if (spreadRad > 0) {
      // uniform disc in the cone, gaussian-weighted toward centre for pellets
      const ang = rng() * Math.PI * 2;
      const rad = spreadRad * (pellets > 1 ? Math.sqrt(rng()) : Math.sqrt(rng()) * 0.92);
      _d.addScaledVector(_perp1, Math.cos(ang) * Math.tan(rad))
        .addScaledVector(_perp2, Math.sin(ang) * Math.tan(rad)).normalize();
    }
    _o.copy(originV);

    let remainingDamageScale = 1;
    let travelled = 0;
    let penetrations = 0;
    let terminated = false;

    while (!terminated) {
      /* --- nearest actor --- */
      let bestActor = null, bestT = MAXT - travelled, bestZone = null;
      for (const a of world.actors) {
        if (a === shooter || !a.alive || !a.char) continue;
        if (a.team === shooter.team && !world.friendlyFire) {
          // friendlies still block line of sight visually but never take damage;
          // skip them entirely so you can shoot past a teammate
          continue;
        }
        const h = a.char.raycastZones(_o.x, _o.y, _o.z, _d.x, _d.y, _d.z, bestT, _zh);
        if (h) { bestT = h.t; bestActor = a; bestZone = { zone: h.zone, kind: h.kind, x: h.px, y: h.py, z: h.pz }; }
      }

      /* --- world --- */
      const wh = world.map.raycast(_o.x, _o.y, _o.z, _d.x, _d.y, _d.z, MAXT - travelled, _hit);

      if (bestActor && (!wh || bestT < wh.t)) {
        /* ---- flesh ---- */
        const dist = travelled + bestT;
        let mult = 1;
        if (bestZone.kind === 'head') mult = def.headMult;
        else if (bestZone.kind === 'limb') mult = def.limbMult;
        else if (bestZone.kind === 'upper') mult = def.upperTorsoMult ?? 1;
        const dmg = damageAt(def, dist) * mult * remainingDamageScale;
        const info = {
          target: bestActor, zone: bestZone.zone, kind: bestZone.kind,
          headshot: bestZone.kind === 'head', damage: dmg, dist,
          x: bestZone.x, y: bestZone.y, z: bestZone.z,
          dirX: _d.x, dirY: _d.y, dirZ: _d.z, penetrated: penetrations > 0,
        };
        results.push(info);
        if (world.effects) {
          _n.set(_d.x, _d.y, _d.z);
          world.effects.bloodHit(_tmp.set(info.x, info.y, info.z), _n, info.headshot);
        }
        if (opts.tracer && world.effects) {
          world.effects.tracer(originV, _tmp.set(info.x, info.y, info.z), def.muzzleVel * 0.55, opts.tracerColor);
        }
        terminated = true;
      } else if (wh) {
        /* ---- geometry ---- */
        _end.set(wh.px, wh.py, wh.pz);
        if (world.effects) {
          _n.set(wh.nx, wh.ny, wh.nz);
          world.effects.impact(_end, _n, wh.surface, false);
          if (opts.tracer) world.effects.tracer(originV, _end, def.muzzleVel * 0.55, opts.tracerColor);
        }
        if (world.audio && opts.impactSound !== false) {
          world.audio.play('imp_' + wh.surface, { pos: [wh.px, wh.py, wh.pz], vol: 0.55, reverb: 0.28 });
        }
        results.push({ world: true, x: wh.px, y: wh.py, z: wh.pz, surface: wh.surface, dist: travelled + wh.t });

        /* ---- penetration ---- */
        const pen = def.penetration || 0;
        if (pen > 0.05 && penetrations < 1) {
          const thick = exitThickness(wh.box, _o, _d, wh.t);
          const maxThick = pen * 0.75;      // metres of concrete-equivalent
          if (thick > 0 && thick < maxThick) {
            const loss = 0.42 + 0.5 * (thick / maxThick);
            remainingDamageScale *= (1 - loss);
            travelled += wh.t + thick + 0.02;
            _o.set(wh.px + _d.x * (thick + 0.02), wh.py + _d.y * (thick + 0.02), wh.pz + _d.z * (thick + 0.02));
            penetrations++;
            if (world.effects) {
              _n.set(-wh.nx, -wh.ny, -wh.nz);
              world.effects.impact(_tmp.copy(_o), _n, wh.surface, false);
            }
            continue;
          }
        }
        terminated = true;
      } else {
        /* ---- nothing hit ---- */
        if (opts.tracer && world.effects) {
          _end.copy(_o).addScaledVector(_d, 90);
          world.effects.tracer(originV, _end, def.muzzleVel * 0.55, opts.tracerColor);
        }
        results.push({ miss: true, dirX: _d.x, dirY: _d.y, dirZ: _d.z });
        terminated = true;
      }
    }

    /* ---- supersonic crack for anyone the round passes close to ---- */
    if (world.localActor && shooter !== world.localActor && world.audio) {
      const lp = world.localActor.pos;
      const mx = lp.x - originV.x, my = (lp.y + 1.5) - originV.y, mz = lp.z - originV.z;
      const proj = mx * _d.x + my * _d.y + mz * _d.z;
      if (proj > 1 && proj < 200) {
        const d2 = (mx * mx + my * my + mz * mz) - proj * proj;
        if (d2 < 9) {
          world.audio.play('whizby', { vol: clamp(1 - Math.sqrt(d2) / 3, 0.15, 1) * 0.8, reverb: 0.1 });
        }
      }
    }
  }
  return results;
}

/** How far the ray stays inside this box after entering it. */
function exitThickness(box, o, d, tEnter) {
  const inv = (v) => 1 / (Math.abs(v) < 1e-9 ? 1e-9 : v);
  const ix = inv(d.x), iy = inv(d.y), iz = inv(d.z);
  const t1 = (box.x0 - o.x) * ix, t2 = (box.x1 - o.x) * ix;
  const t3 = (box.y0 - o.y) * iy, t4 = (box.y1 - o.y) * iy;
  const t5 = (box.z0 - o.z) * iz, t6 = (box.z1 - o.z) * iz;
  const tmax = Math.min(Math.max(t1, t2), Math.max(t3, t4), Math.max(t5, t6));
  return tmax - tEnter;
}

/* ---- explosives ---------------------------------------------------------- */
/**
 * Radial damage with line-of-sight occlusion. Returns [{actor, damage}].
 */
/**
 * Is there open sky directly above this point?
 *
 * An airstrike cannot reach you through a roof, a catwalk or a stack of
 * containers. Straight up is the honest test: it is the same geometry the
 * bombs would have to fall through, and it is cheap enough to run per victim.
 */
export function underOpenSky(world, x, y, z) {
  return world.map.raycast(x, y, z, 0, 1, 0, 60) === null;
}

/**
 * @param opts.enemiesOnly  skip anyone on the owner's team, owner included
 * @param opts.openSkyOnly  skip anyone with geometry overhead
 */
export function explode(world, origin, radius, maxDamage, minDamage, owner, opts = {}) {
  const out = [];
  for (const a of world.actors) {
    if (!a.alive || !a.char) continue;
    if (opts.enemiesOnly && owner && a.team === owner.team) continue;
    const cx = a.pos.x, cy = a.pos.y + 0.95, cz = a.pos.z;
    if (opts.openSkyOnly && !underOpenSky(world, cx, a.pos.y + 1.7, cz)) continue;
    const dist = Math.hypot(cx - origin.x, cy - origin.y, cz - origin.z);
    if (dist > radius) continue;
    // solid cover blocks the blast
    if (!world.map.lineOfSight(origin.x, origin.y, origin.z, cx, cy, cz)) {
      if (!world.map.lineOfSight(origin.x, origin.y, origin.z, cx, a.pos.y + 1.55, cz)) continue;
    }
    const k = 1 - clamp(dist / radius, 0, 1);
    const dmg = minDamage + (maxDamage - minDamage) * Math.pow(k, 1.7);
    out.push({ actor: a, damage: dmg,
      dirX: (cx - origin.x) / (dist || 1), dirY: 0, dirZ: (cz - origin.z) / (dist || 1) });
  }
  if (world.effects) world.effects.explosion(origin, radius * 0.55, radius > 6);
  if (world.audio) {
    world.audio.play(radius > 6 ? 'explodeBig' : 'explode',
      { pos: [origin.x, origin.y, origin.z], vol: 1.6, reverb: 0.6, important: true });
  }
  return out;
}

/** Ray against actors only — used by AI line-of-fire checks. */
export function actorRay(world, shooter, o, d, maxT) {
  let best = null, bestT = maxT;
  for (const a of world.actors) {
    if (a === shooter || !a.alive || !a.char) continue;
    const h = a.char.raycastZones(o.x, o.y, o.z, d.x, d.y, d.z, bestT, _zh);
    if (h) { bestT = h.t; best = { actor: a, t: h.t, kind: h.kind }; }
  }
  return best;
}
