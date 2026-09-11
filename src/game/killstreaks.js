/* ============================================================================
   Killstreaks.

     3  UAV                 sweeps a radar pulse; enemies show on the minimap
     7  ATTACK HELICOPTER   an AI gunship orbits and engages hostiles

   The airstrike is deliberately not on that ladder. Each side gets exactly one
   for the whole match: you paint a line on the tac-map, two jets run it, and it
   only touches the other team — and only the part of it standing under open
   sky. Anyone with a roof, a catwalk or a container over their head is safe.

   Aircraft are procedural models (no external assets) with real rotor motion,
   and everything they shoot goes through the same resolveShot path the infantry
   uses, so a helicopter round kills exactly the way a rifle round does.
   ========================================================================== */
import * as THREE from 'three';
import { clamp, lerp, damp, makeRng } from '../core/util.js';
import { explode, resolveShot } from '../weapons/combat.js';
import { WEAPONS } from '../weapons/defs.js';

const rng = makeRng(0x57BEAC);

export const STREAKS = [
  { id: 'uav',     name: 'UAV',                 cost: 3,  key: '5', dur: 32,
    desc: 'Reveals hostiles on the minimap', icon: 'uav' },
  { id: 'heli',    name: 'ATTACK HELICOPTER',   cost: 7,  key: '7', dur: 42,
    desc: 'Gunship orbits and engages', icon: 'heli' },
];

/* The airstrike is not a killstreak. Each side gets exactly one for the whole
   match, it is spent by the team rather than by a player, it cannot touch the
   side that called it, and it only reaches people standing under open sky. */
export const TEAM_STRIKE = {
  id: 'teamstrike', name: 'TEAM AIRSTRIKE', key: '6', icon: 'jet',
  desc: 'One per team, per match — only bites in the open',
};

export const STREAK_ICONS = {
  uav:    'M2 12h20M12 4l4 8-4 8-4-8z',
  jet:    'M2 13l10-9 10 9-10 3z M9 16h6l-3 5z',
  heli:   'M3 7h18M12 7v3M6 10h12v5H6z M15 15l6 2M9 19h6',
  bomb:   'M12 3v6M8 9h8l-2 11h-4z M5 6l2 2M19 6l-2 2',
};

/* ============================================================================
   Aircraft models
   ========================================================================== */
const MAT = {
  body:  new THREE.MeshStandardMaterial({ color: 0x3c4247, roughness: 0.62, metalness: 0.55 }),
  dark:  new THREE.MeshStandardMaterial({ color: 0x191c1e, roughness: 0.5, metalness: 0.6 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x101a20, roughness: 0.12, metalness: 0.3 }),
  rotor: new THREE.MeshStandardMaterial({ color: 0x101112, roughness: 0.8, metalness: 0.2,
           transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
};

export function buildHelicopter() {
  const g = new THREE.Group();
  // fuselage
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.95, 2.4, 5, 12), MAT.body);
  body.rotation.x = Math.PI / 2; body.scale.set(1, 1, 0.85);
  g.add(body);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.92, 14, 10), MAT.glass);
  nose.position.z = 1.9; nose.scale.set(1, 0.82, 1.25); g.add(nose);
  // tail boom
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.34, 4.4, 10), MAT.body);
  boom.rotation.x = Math.PI / 2; boom.position.z = -3.3; g.add(boom);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.10, 1.15, 0.8), MAT.body);
  fin.position.set(0, 0.55, -5.2); g.add(fin);
  const stab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.09, 0.5), MAT.body);
  stab.position.set(0, 0.15, -4.7); g.add(stab);
  // engine deck
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.55, 1.9), MAT.dark);
  deck.position.set(0, 0.85, -0.3); g.add(deck);
  // skids
  for (const s of [-1, 1]) {
    const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.4, 6), MAT.dark);
    skid.rotation.x = Math.PI / 2; skid.position.set(s * 0.95, -1.15, 0.1); g.add(skid);
    for (const z of [0.9, -0.9]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.75, 5), MAT.dark);
      leg.position.set(s * 0.72, -0.8, z); leg.rotation.z = s * 0.28; g.add(leg);
    }
  }
  // stub wings + pods
  for (const s of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.14, 0.75), MAT.body);
    wing.position.set(s * 1.3, 0.05, 0.2); g.add(wing);
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 1.2, 8), MAT.dark);
    pod.rotation.x = Math.PI / 2; pod.position.set(s * 1.85, -0.12, 0.2); g.add(pod);
  }
  // chin turret
  const turret = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), MAT.dark);
  turret.add(ball);
  const barrels = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.0, 8), MAT.dark);
  barrels.rotation.x = Math.PI / 2; barrels.position.z = 0.55; turret.add(barrels);
  turret.position.set(0, -0.75, 1.6);
  g.add(turret);
  g.userData.turret = turret;
  g.userData.muzzle = new THREE.Object3D();
  g.userData.muzzle.position.set(0, 0, 1.1);
  turret.add(g.userData.muzzle);

  // rotors
  const mainHub = new THREE.Group(); mainHub.position.set(0, 1.35, -0.2);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.5, 8), MAT.dark);
  mast.position.y = -0.25; mainHub.add(mast);
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.045, 0.42), MAT.rotor);
    blade.rotation.y = (i / 4) * Math.PI * 2;
    blade.position.set(Math.cos(blade.rotation.y) * 3.8, 0, Math.sin(blade.rotation.y) * 3.8);
    blade.rotation.y = -blade.rotation.y;
    const holder = new THREE.Group();
    holder.rotation.y = (i / 4) * Math.PI * 2;
    const b2 = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.05, 0.40), MAT.rotor);
    b2.position.x = 3.7;
    holder.add(b2);
    mainHub.add(holder);
  }
  g.add(mainHub);
  const tailHub = new THREE.Group(); tailHub.position.set(0.22, 0.55, -5.2);
  for (let i = 0; i < 3; i++) {
    const h = new THREE.Group(); h.rotation.x = (i / 3) * Math.PI * 2;
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.5, 0.22), MAT.rotor);
    b.position.y = 0.75; h.add(b);
    tailHub.add(h);
  }
  g.add(tailHub);
  g.userData.mainRotor = mainHub;
  g.userData.tailRotor = tailHub;

  // nav lights
  const red = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 5),
    new THREE.MeshBasicMaterial({ color: 0xff2200 }));
  red.position.set(0, -1.35, 0.4); g.add(red);
  g.userData.navLight = red;

  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  return g;
}

export function buildJet(stealth) {
  const g = new THREE.Group();
  const mat = stealth
    ? new THREE.MeshStandardMaterial({ color: 0x15181b, roughness: 0.85, metalness: 0.25 })
    : MAT.body;
  if (stealth) {
    // flying-wing planform
    const shape = new THREE.Shape();
    shape.moveTo(0, 3.4); shape.lineTo(5.6, -2.2); shape.lineTo(2.6, -3.0);
    shape.lineTo(0, -1.4); shape.lineTo(-2.6, -3.0); shape.lineTo(-5.6, -2.2);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.55, bevelEnabled: true, bevelSize: 0.18, bevelThickness: 0.14, bevelSegments: 1 });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.y = -0.2;
    g.add(m);
  } else {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.44, 5.2, 4, 10), mat);
    body.rotation.x = Math.PI / 2; g.add(body);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.44, 1.6, 10), mat);
    nose.rotation.x = Math.PI / 2; nose.position.z = 3.4; g.add(nose);
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), MAT.glass);
    canopy.scale.set(0.9, 0.7, 1.7); canopy.position.set(0, 0.32, 1.4); g.add(canopy);
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.14, 1.7), mat);
      wing.position.set(s * 2.2, -0.1, -0.4); wing.rotation.y = s * 0.32; g.add(wing);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.9), mat);
      tail.position.set(s * 0.95, 0.05, -2.7); tail.rotation.y = s * 0.28; g.add(tail);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.10, 1.0, 0.9), mat);
      fin.position.set(s * 0.45, 0.55, -2.6); fin.rotation.z = -s * 0.25; g.add(fin);
    }
    const burn = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.42, 0.7, 10),
      new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.55 }));
    burn.rotation.x = Math.PI / 2; burn.position.z = -3.2; g.add(burn);
    g.userData.burner = burn;
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

/* ============================================================================
   Manager
   ========================================================================== */
export class Killstreaks {
  constructor(game) {
    this.g = game;
    this.active = [];
    this.uavUntil = 0;
    this.counterUav = 0;
    this._v = new THREE.Vector3();
    this._d = new THREE.Vector3();
  }

  reset() {
    for (const a of this.active) if (a.obj) this.g.scene.remove(a.obj);
    for (const a of this.active) if (a.rotorSfx) this.g.audio.stopLoop(a.rotorSfx);
    this.active.length = 0;
    this.uavUntil = 0;
  }

  get uavOnline() { return this.g.time < this.uavUntil; }

  /** Called when the player (or a bot) cashes a streak. */
  call(id, owner, aimPoint, heading) {
    const def = STREAKS.find(s => s.id === id);
    if (!def) return false;
    switch (id) {
      case 'uav': this._uav(owner); break;
      case 'heli': this._heli(owner); break;
    }
    return true;
  }

  _uav(owner) {
    if (owner.team === this.g.playerTeam) {
      this.uavUntil = this.g.time + 32;
      this.g.hud.banner('UAV ONLINE', 'ENEMY POSITIONS REVEALED', false);
    } else {
      this.g.hud.banner('ENEMY UAV', 'YOU ARE BEING TRACKED', true);
      this.counterUav = this.g.time + 32;
    }
    this.g.audio.play('streak', { vol: 0.7 });
    // a slow recon drone crossing overhead
    const drone = buildJet(false);
    drone.scale.setScalar(0.55);
    const a = { kind: 'flyby', obj: drone, t: 0, dur: 26,
      from: new THREE.Vector3(-90, 44, -30), to: new THREE.Vector3(90, 46, 34), owner, orbit: true };
    this.g.scene.add(drone);
    this.active.push(a);
  }

  /**
   * The team airstrike. Two jets run the painted line and walk a stick of
   * bombs down it.
   *
   * @param owner  the actor who called it — its team is immune
   */
  teamStrike(owner, aim, heading) {
    this._airstrike(owner, aim, heading, false, true);
    return true;
  }

  _airstrike(owner, aim, heading, stealth, teamOnly) {
    const n = stealth ? 1 : 2;
    const dirX = Math.sin(heading), dirZ = Math.cos(heading);
    for (let i = 0; i < n; i++) {
      const jet = buildJet(stealth);
      jet.scale.setScalar(stealth ? 1.5 : 1.1);
      const lateral = (i - (n - 1) / 2) * 7;
      const px = aim.x - dirZ * lateral, pz = aim.z + dirX * lateral;
      const alt = stealth ? 62 : 46;
      const a = {
        kind: 'bomber', obj: jet, t: -i * 0.55, dur: 7.5, owner, stealth,
        from: new THREE.Vector3(px - dirX * 190, alt, pz - dirZ * 190),
        to: new THREE.Vector3(px + dirX * 190, alt, pz + dirZ * 190),
        dropStart: 0.455, dropEnd: stealth ? 0.60 : 0.545,
        bombs: stealth ? 16 : 9, dropped: 0,
        aim: new THREE.Vector3(px, 0, pz), heading, spacing: stealth ? 4.6 : 3.4,
        teamOnly: !!teamOnly,
      };
      this.g.scene.add(jet);
      this.active.push(a);
    }
    this.g.audio.play('jet', { vol: 1.0, important: true });
    if (owner.team === this.g.playerTeam) {
      this.g.hud.banner('AIRSTRIKE INBOUND', 'ON TARGET', false);
    } else {
      this.g.hud.banner('INCOMING AIRSTRIKE', 'GET UNDER COVER', true);
    }
  }

  _heli(owner) {
    const h = buildHelicopter();
    const a = {
      kind: 'heli', obj: h, t: 0, dur: 42, owner,
      angle: rng() * 6.28, radius: 40, alt: 27,
      fireTimer: 0, target: null, targetT: 0,
      spin: 0, ammoHeat: 0,
      weapon: { def: { ...WEAPONS.hammer, id: 'hammer', rpm: 900, pellets: 1,
        damage: { near: 42, far: 34, nearRange: 60, farRange: 120 },
        headMult: 1.4, limbMult: 0.9, penetration: 0.5, muzzleVel: 900 } },
    };
    this.g.scene.add(h);
    this.active.push(a);
    a.rotorSfx = this.g.audio.startLoop('rotor', { vol: 0.0, pos: [0, 30, 0], reverb: 0.4 });
    this.g.hud.banner(owner.team === this.g.playerTeam ? 'ATTACK HELICOPTER' : 'ENEMY HELICOPTER',
      owner.team === this.g.playerTeam ? 'SUPPORT ON STATION' : 'HOSTILE AIR', owner.team !== this.g.playerTeam);
    this.g.audio.play('streak', { vol: 0.7 });
  }

  /* ---------------------------------------------------------------- */
  update(dt) {
    const g = this.g;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      a.t += dt;

      if (a.kind === 'flyby') {
        const k = clamp(a.t / a.dur, 0, 1);
        a.obj.position.lerpVectors(a.from, a.to, k);
        a.obj.lookAt(a.to.x + (a.to.x - a.from.x), a.to.y, a.to.z + (a.to.z - a.from.z));
        a.obj.rotateY(Math.PI);
        if (k >= 1) { g.scene.remove(a.obj); this.active.splice(i, 1); }
        continue;
      }

      if (a.kind === 'bomber') {
        if (a.t < 0) continue;
        const k = clamp(a.t / a.dur, 0, 1);
        a.obj.position.lerpVectors(a.from, a.to, k);
        this._d.copy(a.to).sub(a.from).normalize();
        a.obj.lookAt(a.obj.position.x + this._d.x, a.obj.position.y, a.obj.position.z + this._d.z);
        a.obj.rotateY(Math.PI);
        a.obj.rotation.z = Math.sin(a.t * 1.4) * 0.05;
        // release the string of bombs
        if (k > a.dropStart && a.dropped < a.bombs) {
          const want = Math.floor((k - a.dropStart) / (a.dropEnd - a.dropStart) * a.bombs);
          while (a.dropped < Math.min(want, a.bombs)) {
            const idx = a.dropped++;
            const off = (idx - (a.bombs - 1) / 2) * a.spacing;
            const px = a.aim.x + Math.sin(a.heading) * off;
            const pz = a.aim.z + Math.cos(a.heading) * off;
            g.scheduleExplosion(px, 0.4, pz, a.stealth ? 8.5 : 7.4,
              a.stealth ? 210 : 185, 30, a.owner, 0.30 + idx * 0.055,
              a.teamOnly ? { enemiesOnly: true, openSkyOnly: true, label: 'AIRSTRIKE' } : null);
          }
        }
        if (k >= 1) { g.scene.remove(a.obj); this.active.splice(i, 1); }
        continue;
      }

      /* ---- helicopters ---- */
      const alive = a.t < a.dur;
      a.angle += dt * 0.21;
      const px = Math.cos(a.angle) * a.radius, pz = Math.sin(a.angle) * a.radius;
      const arrive = clamp(a.t / 4, 0, 1), leave = clamp((a.dur - a.t) / 4, 0, 1);
      const alt = a.alt + (1 - Math.min(arrive, leave)) * 26;
      a.obj.position.set(px, alt, pz);
      // bank into the turn
      const tang = Math.atan2(-Math.sin(a.angle), Math.cos(a.angle));
      a.obj.rotation.set(0, tang + Math.PI / 2, 0);
      a.obj.rotateZ(-0.22);
      a.obj.rotateX(0.06);
      a.spin += dt * 34;
      a.obj.userData.mainRotor.rotation.y = a.spin;
      a.obj.userData.tailRotor.rotation.x = a.spin * 2.6;
      a.obj.userData.navLight.visible = (Math.floor(a.t * 1.6) % 2) === 0;

      if (a.rotorSfx && a.rotorSfx.panner) {
        const p = a.rotorSfx.panner;
        p.positionX.value = px; p.positionY.value = alt; p.positionZ.value = pz;
        const target = Math.min(arrive, leave) * 0.75;
        a.rotorSfx.gain.gain.setTargetAtTime(target, g.audio.ctx.currentTime, 0.3);
      }

      this._updateHeliAI(a, dt);

      if (!alive) {
        if (a.rotorSfx) g.audio.stopLoop(a.rotorSfx);
        g.scene.remove(a.obj);
        this.active.splice(i, 1);
      }
    }
  }

  _updateHeliAI(a, dt) {
    const g = this.g;
    a.targetT -= dt;
    if (a.targetT <= 0 || !a.target || !a.target.alive) {
      a.targetT = 1.1;
      let best = null, bd = 1e9;
      for (const o of g.actors) {
        if (!o.alive || o.team === a.owner.team) continue;
        const hp = this._v.set(o.pos.x, o.pos.y + 1.2, o.pos.z);
        if (!g.map.lineOfSight(a.obj.position.x, a.obj.position.y - 0.8, a.obj.position.z, hp.x, hp.y, hp.z)) continue;
        const d = a.obj.position.distanceTo(hp);
        if (d < bd) { bd = d; best = o; }
      }
      a.target = best;
    }
    const turret = a.obj.userData.turret;
    if (a.target) {
      const hp = this._v.set(a.target.pos.x, a.target.pos.y + 1.1, a.target.pos.z);
      a.obj.worldToLocal(hp.clone());
      const local = a.obj.worldToLocal(this._v.copy(a.target.pos).setY(a.target.pos.y + 1.1));
      const yaw = Math.atan2(local.x, local.z);
      const pitch = Math.atan2(local.y, Math.hypot(local.x, local.z));
      turret.rotation.y = damp(turret.rotation.y, yaw, 5, dt);
      turret.rotation.x = damp(turret.rotation.x, -pitch, 5, dt);

      a.fireTimer -= dt;
      if (a.fireTimer <= 0) {
        a.fireTimer = 0.085;
        this._heliShoot(a, a.target, 2.6);
      }
    } else {
      turret.rotation.y = damp(turret.rotation.y, 0, 2, dt);
      turret.rotation.x = damp(turret.rotation.x, -0.5, 2, dt);
    }
  }

  _heliShoot(a, target, errDeg) {
    const g = this.g;
    a.obj.updateMatrixWorld(true);
    const muz = a.obj.userData.muzzle.getWorldPosition(this._v.clone ? new THREE.Vector3() : this._v);
    a.obj.userData.muzzle.getWorldPosition(muz);
    const aimP = new THREE.Vector3(target.pos.x, target.pos.y + 1.05, target.pos.z);
    aimP.x += target.vel.x * 0.10; aimP.z += target.vel.z * 0.10;
    const dir = aimP.sub(muz).normalize();
    const spread = errDeg * Math.PI / 180;
    const shooter = { team: a.owner.team, id: a.owner.id + '_heli', pos: a.obj.position,
                      alive: true, isHeli: true, ownerActor: a.owner };
    const hits = resolveShot(g.world, shooter, a.weapon, muz, dir, spread,
      { tracer: true, tracerColor: [1.0, 0.55, 0.18] });
    g.effects.muzzleFlash(muz, dir, 1.9);
    g.audio.play('gun_hammer', { pos: [muz.x, muz.y, muz.z], vol: 1.1, lowpass: 6000, reverb: 0.5 });
    for (const h of hits) {
      if (h.target) g.applyDamage(h.target, h.damage, a.owner, 'HELI', h.headshot,
        new THREE.Vector3(h.dirX, h.dirY, h.dirZ), h.zone);
    }
  }
}
