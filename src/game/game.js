/* ============================================================================
   The match.

   One Actor type covers you and every bot. Movement, collision, firing, damage
   and death all run through the same functions; the only difference is that your
   intent comes from the mouse and theirs comes from Bot.think(). That symmetry
   is what makes the killcam honest — it is replaying the same simulation.
   ========================================================================== */
import { awardHeadshot, loadProfile } from './skins.js';
import * as THREE from 'three';
import { Character } from '../chars/characters.js';
import { WeaponState, resolveShot, explode, underOpenSky } from '../weapons/combat.js';
import { WEAPONS, LETHALS, FIRE } from '../weapons/defs.js';
import { Projectile } from '../weapons/viewmodel.js';
import { Bot, DIFFICULTY, resetPathBudget } from '../ai/bot.js';
import { Recorder, KillcamPlayer } from './killcam.js';
import { Killstreaks, STREAKS, TEAM_STRIKE } from './killstreaks.js';
import { MELEE_DUR, MELEE_HIT_K, clamp, lerp, damp, dampAngle, wrapPi, makeRng, callsign, fmtTime } from '../core/util.js';

const RADIUS = 0.36;
const HEIGHT_STAND = 1.80, HEIGHT_CROUCH = 1.22;
const EYE_STAND = 1.63, EYE_CROUCH = 1.08;
const STEP_UP = 0.46;
const GRAVITY = 21.5;
const JUMP_V = 6.15;
const PLAYER_LAYER = 3;

export const STATE = { MENU: 'MENU', LIVE: 'LIVE', KILLCAM: 'KILLCAM', RESULT: 'RESULT', PAUSED: 'PAUSED' };

let nextId = 1;

class Actor {
  constructor(o) {
    this.id = nextId++;
    this.idx = o.idx;
    this.name = o.name;
    this.team = o.team;
    this.isLocal = !!o.isLocal;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.health = 100; this.maxHealth = 100;
    this.alive = true;
    this.crouch = 0; this.crouchWant = false;
    this.adsW = 0; this.adsWant = false;
    this.sprint = 0; this.sprintWant = false;
    this.grounded = true; this.groundY = 0;
    this.moving = 0;
    this.kills = 0; this.deaths = 0; this.streak = 0; this.bestStreak = 0;
    this.damageDealt = 0; this.shotsFired = 0; this.shotsHit = 0; this.headshots = 0;
    this.respawnT = 0;
    this.lastDamage = -99;
    this.lastAttacker = null;
    this.mmVisible = false;
    this.firingFlash = 0;
    this.lethalCount = 2;
    this.cookT = 0; this.cooking = false;
    this.slot = 'primary';
    this.swapT = 0; this.swapDur = 0; this.swapTo = null;
    this.meleeT = 0; this.meleeDur = MELEE_DUR; this.meleeSeq = 0;
    this.char = null;
    this.bot = null;
    this.streakEarned = new Set();
    this.pendingStreak = null;
  }
  get weapon() { return this.weapons ? this.weapons[this.slot] : null; }
  get height() { return lerp(HEIGHT_STAND, HEIGHT_CROUCH, this.crouch); }
  get eyeY() { return lerp(EYE_STAND, EYE_CROUCH, this.crouch); }
}

/* ============================================================================ */
/* Where on a body a swing can land: hit zone, height above the feet standing. */
const MELEE_POINTS = [['head', 1.62], ['chest', 1.28], ['gut', 0.98]];
const MELEE_DAMAGE = 150;      // one hit, as everywhere in the genre

export class Game {
  constructor(deps) {
    Object.assign(this, deps);   // scene, camera, renderer, map, audio, effects, hud, input, viewmodel
    this.state = STATE.MENU;
    this.time = 0;
    this.actors = [];
    this.bots = [];
    this.rng = makeRng(0x600D);
    this.recorder = new Recorder(20);
    this.killcam = new KillcamPlayer(this.recorder, this.actors, this.camera, this.effects);
    this.streaks = new Killstreaks(this);
    this.projectiles = [];
    this.pendingBlasts = [];
    this.playerTeam = 'A';
    this.scoreA = 0; this.scoreB = 0;
    this.timeLeft = 600;
    this.scoreLimit = 30;
    this.matchOver = false;
    this.world = {
      map: this.map, actors: this.actors, effects: this.effects, audio: this.audio,
      localActor: null, friendlyFire: false,
    };
    this.hotspots = this._buildHotspots();
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3();
    this._dir = new THREE.Vector3(); this._eye = new THREE.Vector3();
    this._muz = new THREE.Vector3();
    this._ejR = new THREE.Vector3(); this._ejU = new THREE.Vector3();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this.camShake = 0; this.camShakeT = 0;
    this.killcamT = 0;
    this.respawnDelay = 0;
    this.strikeMode = null;
    this.strikeCursor = { x: 0, z: 0, heading: 0 };
    this.fpsAcc = 0; this.fpsFrames = 0; this.fpsText = '';
    this.showFps = true;
    this.frameStats = [];
    /* Deferred work runs on GAME time, not wall clock. setTimeout would stall in
       a backgrounded tab (the match would never end while you were on another
       window) and never fires at all inside a synchronous simulation, which is
       how the headless harness drives the game. */
    this.timers = [];
  }

  /** Run fn after `delay` seconds of match time. */
  after(delay, fn) { this.timers.push({ t: delay, fn }); }

  /** Point everything at another map. Only ever called between matches. */
  setMap(map) {
    this.map = map;
    this.world.map = map;
    this.hotspots = this._buildHotspots();
  }

  _buildHotspots() {
    const pts = [];
    const add = (x, z, w) => { const c = this.map.navIndex(x, z);
      pts.push({ x, y: this.map.navN[c] ? this.map.navH[c * this.map.MAXS] : 0, z, weight: w || 0 }); };
    /* each map names the places worth patrolling; one with none still gives
       the AI somewhere to go */
    for (const [x, z, w] of this.map.hotspots || []) add(x, z, w);
    if (!pts.length) add(0, 0, 1);
    return pts;
  }

  /* ================================================================ setup */
  startMatch(cfg) {
    this.cfg = cfg;
    this.clearMatch();
    this.scoreA = 0; this.scoreB = 0;
    this.timeLeft = cfg.timeLimit * 60;
    this.scoreLimit = cfg.scoreLimit;
    this.matchOver = false;
    this.time = 0;
    this.recorder.reset();
    this.hud.clear();

    const names = new Set();
    const uniqueName = () => { let n; do { n = callsign(this.rng); } while (names.has(n)); names.add(n); return n; };

    /* --- local player --- */
    const me = new Actor({ idx: 0, name: 'YOU', team: 'A', isLocal: true });
    me.char = new Character({ team: 'A', variant: 0, seed: 1, isLocal: true, layer: PLAYER_LAYER, weaponLayer: PLAYER_LAYER + 1, name: 'you' });
    this.scene.add(me.char.root);
    this._equip(me, cfg.primary, cfg.secondary, cfg.lethal);
    this.actors.push(me);
    this.me = me;
    this.world.localActor = me;

    /* --- squad --- */
    const primaryPool = ['vk71', 'grad74', 'wasp45', 'hammer', 'kestrel', 'breacher12', 'longbow'];
    let idx = 1;
    const mkBot = (team) => {
      const a = new Actor({ idx: idx++, name: uniqueName(), team });
      a.char = new Character({ team, variant: this.rng.int(0, 3), seed: a.idx + 7, name: a.name });
      this.scene.add(a.char.root);
      const w = this.rng.pick(primaryPool);
      const sec = this.rng.pick(['m9', 'handcannon', 'minisub']);
      this._equip(a, w, sec, this.rng.pick(['frag', 'semtex', 'thermite']));
      a.bot = new Bot(a, { map: this.map, actors: this.actors, hotspots: this.hotspots },
        cfg.difficulty, a.idx * 31 + 5);
      a.maxHealth = a.health = DIFFICULTY[cfg.difficulty].health;
      this.actors.push(a);
      this.bots.push(a.bot);
      return a;
    };
    for (let i = 0; i < cfg.friends; i++) mkBot('A');
    for (let i = 0; i < cfg.enemies; i++) mkBot('B');

    /* --- spawn everyone ---
       A new Actor starts "alive" at the origin. Placing them one at a time, the
       first ones were scored against enemies still standing at the centre of
       the map: wherever a spawn could see the centre it read as "enemy in
       view", and on Timberline, whose road runs straight to it, a bot fled to
       the other team's spawn. Nobody counts until they have been placed. */
    this.bankedThisMatch = 0;
    for (const a of this.actors) a.alive = false;
    for (const a of this.actors) this.spawn(a, true);

    this.state = STATE.LIVE;
    this.hud.show(true);
    this.hud.setWeapon(me.weapon.def, LETHALS[cfg.lethal].name, me.lethalCount);
    this.hud.banner('OPERATION ' + this.map.name, 'TEAM DEATHMATCH · ' + cfg.scoreLimit, false);
    this.ambienceLoop = this.ambienceLoop || this.audio.startLoop('ambience', { vol: 0.35 });
  }

  _equip(a, primaryId, secondaryId, lethalId) {
    a.weapons = {
      primary: new WeaponState(WEAPONS[primaryId], a),
      secondary: new WeaponState(WEAPONS[secondaryId], a),
    };
    a.slot = 'primary';
    a.lethalDef = LETHALS[lethalId];
    a.lethalCount = a.lethalDef.count;
    if (a.char) a.char.setWeapon(a.weapon.def);
  }

  clearMatch() {
    for (const a of this.actors) { if (a.char) a.char.dispose(); }
    this.actors.length = 0;
    this.bots.length = 0;
    for (const p of this.projectiles) p.dispose();
    this.projectiles.length = 0;
    this.pendingBlasts.length = 0;
    this.timers.length = 0;
    this.streaks.reset();
    /* One airstrike each, for the whole match. Keyed by team so a respawn, a
       swap or a dead caller cannot get a side a second one. */
    this.teamStrikeUsed = { A: false, B: false };
    this.enemyStrikeAt = 0;
    this.effects.clear();
    this.recorder.reset();
    nextId = 1;
  }

  /* ================================================================ spawn */
  spawn(a, initial) {
    a.meleeT = 0; a.meleeSeq++;
    const enemies = this.actors.filter(o => o.team !== a.team);
    const friends = this.actors.filter(o => o.team === a.team && o !== a);
    const s = this.map.pickSpawn(a.team, enemies, friends);
    a.pos.set(s.x, s.y, s.z);
    a.vel.set(0, 0, 0);
    // Always face into the map rather than at the nearest wall: derived from the
    // spawn's own position so it stays correct if spawns are ever moved.
    a.yaw = Math.atan2(-s.x, -s.z);
    a.pitch = 0;
    a.health = a.maxHealth;
    a.alive = true;
    a.crouch = 0; a.crouchWant = false;
    a.adsW = 0; a.sprint = 0;
    a.grounded = true; a.groundY = s.y;
    a.slot = 'primary';
    a.weapons.primary.reset();
    a.weapons.secondary.reset();
    a.lethalCount = a.lethalDef.count;
    a.cooking = false; a.cookT = 0;
    a.swapT = 0;
    a.lastAttacker = null;
    if (a.char) {
      a.char.revive();
      a.char.pos.copy(a.pos);
      a.char.setWeapon(a.weapon.def);
      a.char.bodyYaw = a.yaw; a.char.aimYaw = a.yaw; a.char.aimPitch = 0;
      a.char.root.visible = true;
    }
    if (a.bot) { a.bot.setState('PATROL'); a.bot.target = null; a.bot.hasLastKnown = false; }
    if (a.isLocal) {
      this.hud.setWeapon(a.weapon.def, a.lethalDef.name, a.lethalCount);
      this.camera.position.set(a.pos.x, a.pos.y + a.eyeY, a.pos.z);
    }
  }

  /* ================================================================ loop */
  update(dt, now) {
    this.time += dt;

    /* ---- game-time deferred callbacks ---- */
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const t = this.timers[i];
      t.t -= dt;
      if (t.t <= 0) { this.timers.splice(i, 1); t.fn(); }
    }

    if (this.state === STATE.LIVE || this.state === STATE.KILLCAM) {
      if (!this.matchOver) {
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) { this.timeLeft = 0; this.endMatch(); }
      }
    }

    // Cap A* work per frame. Bots re-plan roughly once a second each, so two
    // queries a frame clears a 14-bot roster comfortably while bounding the
    // worst-case frame.
    resetPathBudget(2);

    /* ---- actors ---- */
    if (this.state === STATE.LIVE || this.state === STATE.KILLCAM) {
      for (const a of this.actors) this.updateActor(a, dt, now);
      this.updateProjectiles(dt);
      this.updateBlasts(dt);
      this.streaks.update(dt);
      this.updateEnemyStrike(dt);
      this.recorder.sample(dt, this.actors);
    }

    /* ---- camera ---- */
    if (this.state === STATE.KILLCAM) {
      this.killcamT -= dt;
      this.hud.setKillcamCount(this.killcamT);
      const done = this.killcam.update(dt);
      if (done || this.killcamT <= 0 || this.input.hit('jump')) this.endKillcam();
    } else if (this.state === STATE.LIVE) {
      this.updateCamera(dt);
    }

    /* ---- HUD ---- */
    if (this.state !== STATE.MENU) this.updateHud(dt);
  }

  /* ---------------------------------------------------------------- actor */
  updateActor(a, dt, now) {
    /* --- dead: countdown to respawn --- */
    if (!a.alive) {
      a.respawnT -= dt;
      if (a.char) a.char.update(dt, this.camera.position);
      if (a.respawnT <= 0 && !this.matchOver) {
        if (a.isLocal) { if (this.state === STATE.LIVE) this.spawn(a); }
        else this.spawn(a);
      }
      return;
    }

    /* --- intent --- */
    let mx = 0, mz = 0, jump = false, fireDown = false, firePressed = false;
    let wantCrouch = false, wantSprint = false, wantAds = false, wantReload = false;

    if (a.isLocal) {
      // Keyboard play still works where pointer lock is refused; only mouse look is lost.
      const canPlay = this.input.locked || this.input.lockUnavailable;
      if (this.state === STATE.LIVE && canPlay) {
        const I = this.input;
        const f = (I.down('forward') ? 1 : 0) - (I.down('back') ? 1 : 0);
        const r = (I.down('right') ? 1 : 0) - (I.down('left') ? 1 : 0);
        const sy = Math.sin(a.yaw), cy = Math.cos(a.yaw);
        /* Screen-right is cross(forward, up) = (-cos yaw, 0, sin yaw); forward is
           (sin yaw, 0, cos yaw). Getting this lateral axis backwards inverts A/D. */
        mx = sy * f - cy * r;
        mz = cy * f + sy * r;
        const ml = Math.hypot(mx, mz);
        if (ml > 1) { mx /= ml; mz /= ml; }
        jump = I.hit('jump');
        wantCrouch = I.holdSprint ? I.down('crouch') : a.crouchWant;
        if (!I.holdSprint && I.hit('crouch')) wantCrouch = a.crouchWant = !a.crouchWant;
        else if (I.holdSprint) a.crouchWant = wantCrouch;
        wantSprint = I.down('sprint') && f > 0.1;
        wantAds = I.holdAds ? I.mouse.right : a.adsWant;
        if (!I.holdAds && I.mouse.rightPressed) wantAds = a.adsWant = !a.adsWant;
        else if (I.holdAds) a.adsWant = wantAds;
        fireDown = I.mouse.left;
        firePressed = I.mouse.leftPressed;
        wantReload = I.hit('reload');
        this.handlePlayerActions(a, dt);
      }
    } else if (a.bot) {
      const I = a.bot.think(dt);
      mx = I.mx; mz = I.mz;
      jump = I.jump;
      wantCrouch = I.crouch;
      wantSprint = I.sprint;
      wantReload = I.reload;
      fireDown = I.fire; firePressed = I.fire;
      wantAds = !I.sprint && a.bot.state === 'ENGAGE' && a.weapon.def.kind !== 'shotgun';
      if (I.lethal && a.lethalCount > 0 && a.bot.hasLastKnown) this.throwLethal(a, a.bot.lastKnown);
    }

    /* --- stance blending --- */
    const canStand = this.headroom(a, HEIGHT_STAND);
    a.crouch = damp(a.crouch, (wantCrouch || !canStand) ? 1 : 0, 12, dt);
    const W = a.weapon;
    const sprinting = wantSprint && !wantAds && a.grounded && !W.reloading && a.crouch < 0.4 && a.meleeT <= 0;
    a.sprint = damp(a.sprint, sprinting ? 1 : 0, sprinting ? 9 : 14, dt);
    const adsAllowed = !sprinting && a.swapT <= 0 && a.meleeT <= 0;
    const adsRate = 1 / Math.max(0.05, W.def.ads.time);
    a.adsW = clamp(a.adsW + ((wantAds && adsAllowed) ? 1 : -1.35) * adsRate * dt, 0, 1);

    /* --- movement --- */
    const base = W.def.walkSpeed;
    let speed = base;
    if (sprinting) speed = W.def.sprintSpeed;
    else if (a.adsW > 0.05) speed = lerp(base, W.def.adsSpeed, a.adsW);
    speed *= lerp(1, 0.56, a.crouch);
    if (!a.grounded) speed *= 1.0;
    this.moveActor(a, dt, mx, mz, speed, jump);
    a.moving = clamp(Math.hypot(a.vel.x, a.vel.z) / Math.max(0.1, base), 0, 1.6);

    /* --- weapon --- */
    const ctx = {
      now, audio: this.audio, isLocal: a.isLocal, adsW: a.adsW,
      pos: [a.pos.x, a.pos.y + 1.3, a.pos.z],
      autoReload: () => { if (W.reserve > 0) W.startReload(this.audio, a.pos, a.isLocal); },
    };
    W.update(dt, ctx);
    if (wantReload && !W.reloading && W.mag < W.def.mag && W.reserve > 0) {
      W.startReload(this.audio, a.pos, a.isLocal);
      if (a.isLocal) this.audio.play('mech_swap', { vol: 0.3 });
    }
    if (a.swapT > 0) {
      a.swapT -= dt;
      if (a.swapT <= 0 && a.swapTo) {
        a.slot = a.swapTo; a.swapTo = null;
        a.weapon.equipT = a.weapon.def.swap.in;
        a.swapT = a.weapon.def.swap.in; a.swapDur = a.weapon.def.swap.in;
        if (a.char) a.char.setWeapon(a.weapon.def);
        if (a.isLocal) {
          this.viewmodel.setWeapon(a.weapon.def);
          this.hud.setWeapon(a.weapon.def, a.lethalDef.name, a.lethalCount);
        }
      }
    }

    /* --- firing --- */
    const canShoot = !sprinting && a.swapT <= 0 && a.meleeT <= 0 && !a.cooking;
    if (canShoot) {
      const shots = W.tryFire(ctx, fireDown, firePressed);
      if (shots > 0) this.fireWeapon(a, W);
    }

    /* --- recoil feeds the aim --- */
    a.pitch = clamp(a.pitch, -1.45, 1.45);

    /* --- health regeneration --- */
    if (this.time - a.lastDamage > 4.2 && a.health < a.maxHealth) {
      a.health = Math.min(a.maxHealth, a.health + 42 * dt);
    }

    /* --- character drive --- */
    const c = a.char;
    if (c) {
      c.pos.copy(a.pos);
      c.vel.copy(a.vel);
      c.groundY = a.groundY;
      c.aimYaw = a.yaw + W.recoilYaw;
      c.aimPitch = a.pitch + W.recoilPitch;
      c.crouch = a.crouch;
      c.aimW = a.adsW;
      c.sprint = a.sprint;
      c.reloading = W.reloading;
      c.reloadT = W.reloading ? clamp(W.reloadT / Math.max(0.01, W.reloadDur), 0, 1) : 0;
      c.recoilKick = W.visualKick;
      c.meleeK = a.meleeT > 0 ? 1 - a.meleeT / a.meleeDur : 0;
      c.update(dt, this.camera.position);
      if (c.footstepPending) {
        c.footstepPending = false;
        this.footstep(a);
      }
    }

    a.firingFlash = Math.max(0, a.firingFlash - dt * 2.2);
    a.mmVisible = this.isVisibleOnMinimap(a);
  }

  isVisibleOnMinimap(a) {
    if (a.team === this.playerTeam) return true;
    if (this.streaks.uavOnline) return true;
    if (a.firingFlash > 0 && !a.weapon.def.suppressed) return true;
    return false;
  }

  /* ---------------------------------------------------------------- moving */
  moveActor(a, dt, mx, mz, speed, jump) {
    const accel = a.grounded ? 52 : 12;
    const friction = a.grounded ? 12 : 0.6;
    const wantX = mx * speed, wantZ = mz * speed;

    if (mx || mz) {
      a.vel.x = damp(a.vel.x, wantX, accel / Math.max(1, speed), dt);
      a.vel.z = damp(a.vel.z, wantZ, accel / Math.max(1, speed), dt);
    } else if (a.grounded) {
      a.vel.x = damp(a.vel.x, 0, friction, dt);
      a.vel.z = damp(a.vel.z, 0, friction, dt);
    }
    const sp = Math.hypot(a.vel.x, a.vel.z);
    if (sp > speed) { a.vel.x *= speed / sp; a.vel.z *= speed / sp; }

    if (jump && a.grounded && a.crouch < 0.5) {
      a.vel.y = JUMP_V; a.grounded = false;
      if (a.isLocal) this.viewmodel.landing = -0.4;
    }
    a.vel.y -= GRAVITY * dt;
    if (a.vel.y < -55) a.vel.y = -55;

    const h = a.height;
    const feet = a.pos.y;
    /* --- horizontal, one axis at a time --- */
    this.sweep(a, 'x', a.vel.x * dt, RADIUS, feet + STEP_UP, feet + h);
    this.sweep(a, 'z', a.vel.z * dt, RADIUS, feet + STEP_UP, feet + h);

    /* --- vertical --- */
    a.pos.y += a.vel.y * dt;
    const gy = this.groundHeight(a.pos.x, a.pos.z, a.pos.y + STEP_UP, RADIUS);
    if (a.pos.y <= gy + 0.02 && a.vel.y <= 0.001) {
      if (!a.grounded && a.isLocal && a.vel.y < -6) {
        this.viewmodel.landing = clamp(-a.vel.y / 16, 0, 1);
        this.camShake = Math.max(this.camShake, clamp(-a.vel.y / 30, 0, 0.5));
        this.audio.play('step_dirt', { vol: 0.55 });
      }
      a.pos.y = gy; a.vel.y = 0; a.grounded = true;
    } else {
      a.grounded = false;
    }
    a.groundY = gy;

    /* --- ceiling --- */
    const ceil = this.ceilingHeight(a.pos.x, a.pos.z, a.pos.y, RADIUS, a.pos.y + h);
    if (ceil !== null && a.pos.y + h > ceil) {
      a.pos.y = Math.max(gy, ceil - h - 0.01);
      if (a.vel.y > 0) a.vel.y = 0;
    }

    /* --- keep inside the arena, always --- */
    a.pos.x = clamp(a.pos.x, -31 + RADIUS, 31 - RADIUS);
    a.pos.z = clamp(a.pos.z, -23 + RADIUS, 23 - RADIUS);
  }

  sweep(a, axis, delta, r, y0, y1) {
    if (delta === 0) return;
    a.pos[axis] += delta;
    const m = this.map;
    m.beginQuery();
    const list = m.query(a.pos.x - r, a.pos.z - r, a.pos.x + r, a.pos.z + r, this._sw || (this._sw = []));
    const EPS = 0.001;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (y1 <= b.y0 + EPS || y0 >= b.y1 - EPS) continue;
      if (a.pos.x + r <= b.x0 || a.pos.x - r >= b.x1) continue;
      if (a.pos.z + r <= b.z0 || a.pos.z - r >= b.z1) continue;
      if (axis === 'x') {
        if (delta > 0) a.pos.x = b.x0 - r - EPS; else a.pos.x = b.x1 + r + EPS;
        a.vel.x = 0;
      } else {
        if (delta > 0) a.pos.z = b.z0 - r - EPS; else a.pos.z = b.z1 + r + EPS;
        a.vel.z = 0;
      }
    }
  }

  /** Highest standable surface under a cylinder, at or below `maxY`.
   *  Boxes flagged `standable:false` (roofs, wall caps, guard rails, canopies)
   *  are skipped so the player and the navmesh agree on where a body can be —
   *  otherwise a bug could leave someone standing somewhere the AI cannot path
   *  to and cannot reason about. */
  groundHeight(x, z, maxY, r) {
    const m = this.map;
    m.beginQuery();
    const list = m.query(x - r, z - r, x + r, z + r, this._gh || (this._gh = []));
    let best = -50;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b.standable) continue;
      if (b.y1 > maxY + 0.001) continue;
      if (x + r <= b.x0 || x - r >= b.x1) continue;
      if (z + r <= b.z0 || z - r >= b.z1) continue;
      if (b.y1 > best) best = b.y1;
    }
    return best <= -50 ? 0 : best;
  }

  /** Lowest blocking surface above `fromY`, or null. */
  ceilingHeight(x, z, fromY, r, headY) {
    const m = this.map;
    m.beginQuery();
    const list = m.query(x - r, z - r, x + r, z + r, this._ch || (this._ch = []));
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.y0 < fromY + 0.15) continue;
      if (x + r <= b.x0 || x - r >= b.x1) continue;
      if (z + r <= b.z0 || z - r >= b.z1) continue;
      if (best === null || b.y0 < best) best = b.y0;
    }
    return best;
  }

  headroom(a, wantHeight) {
    const c = this.ceilingHeight(a.pos.x, a.pos.z, a.pos.y, RADIUS, a.pos.y + wantHeight);
    return c === null || c > a.pos.y + wantHeight + 0.02;
  }

  /* ---------------------------------------------------------------- firing */
  fireWeapon(a, W) {
    const def = W.def;
    a.shotsFired++;
    a.firingFlash = 1;

    /* aim vector uses the recoil offset as it was when the trigger broke */
    const yaw = a.yaw + W.shotYaw;
    let pitch = a.pitch + W.shotPitch;
    if (a.isLocal && def.sway && a.adsW > 0.6) {
      const s = this.swayOffset(W, a.adsW);
      pitch += s.y; // sway already folded into the aim for the local player
    }
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    this._dir.set(sy * cp, sp, cy * cp).normalize();

    /* eye-height origin — never lets anyone shoot around a corner */
    this._eye.set(a.pos.x, a.pos.y + a.eyeY, a.pos.z);

    /* muzzle for visuals */
    if (a.isLocal) {
      this.viewmodel.muzzleWorld(this.camera, this._muz);
    } else if (a.char && a.char.muzzle) {
      a.char.getMuzzleWorld(this._muz);
    } else this._muz.copy(this._eye);

    const spread = W.spread(a.adsW, a.moving, !a.grounded, a.crouch > 0.5);
    const hits = resolveShot(this.world, a, W, this._eye, this._dir, spread, {
      tracer: false, impactSound: true,
    });

    /* tracer from the muzzle to the first impact */
    const first = hits.find(h => h.x !== undefined) || hits[0];
    if (this.rng() < (def.pellets > 1 ? 0.5 : 0.72)) {
      const to = this._v.set(
        first && first.x !== undefined ? first.x : this._muz.x + this._dir.x * 90,
        first && first.y !== undefined ? first.y : this._muz.y + this._dir.y * 90,
        first && first.z !== undefined ? first.z : this._muz.z + this._dir.z * 90);
      this.effects.tracer(this._muz, to, def.muzzleVel * 0.5,
        a.team === this.playerTeam ? [1.0, 0.78, 0.32] : [1.0, 0.42, 0.20]);
    }

    /* muzzle flash + shell */
    if (a.isLocal) {
      this.viewmodel.onFire(def.recoil.visual);   // owns its own flash, in vm space
      this.camShake = Math.min(0.9, this.camShake + def.recoil.visual * 0.10);
      const ej = this.viewmodel.ejectWorld(this.camera, this._v2);
      // reused scratch: this runs up to ~20 times a second per shooter
      this._ejR.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this._ejU.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this.effects.shellEject(ej, this._ejR, this._ejU, def.kind === 'pistol' || def.kind === 'smg');
    } else {
      this.effects.muzzleFlash(this._muz, this._dir, def.kind === 'sniper' ? 1.5 : 1.0);
      if (a.char) {
        const eject = a.char.weaponModel && a.char.weaponModel.userData.eject;
        if (eject) {
          eject.getWorldPosition(this._v2);
          this._ejR.set(cy, 0, -sy);
          this._ejU.set(0, 1, 0);
          this.effects.shellEject(this._v2, this._ejR, this._ejU,
            def.kind === 'pistol' || def.kind === 'smg');
        }
      }
    }

    /* audio */
    this.audio.gunshot(def.id, [this._muz.x, this._muz.y, this._muz.z], this.camera.position, a.isLocal);
    this.recorder.addEvent('shot', a.idx, this._muz.x, this._muz.y, this._muz.z,
      this._dir.x, this._dir.y, this._dir.z, def.id);

    /* everyone nearby hears it */
    for (const o of this.actors) {
      if (o.bot && o !== a) o.bot.hearGunshot(a.pos, 1);
    }

    /* damage */
    let anyHit = false, anyHead = false, anyKill = false;
    for (const h of hits) {
      if (!h.target) continue;
      anyHit = true;
      if (h.headshot) anyHead = true;
      const died = this.applyDamage(h.target, h.damage, a, def.name, h.headshot,
        this._v2.set(h.dirX, h.dirY, h.dirZ), h.zone);
      if (died) anyKill = true;
    }
    if (anyHit) {
      a.shotsHit++;
      if (anyHead) a.headshots++;
      if (a.isLocal) {
        this.hud.hitmarker(anyHead, anyKill);
        this.audio.play(anyKill ? 'hitmarkKill' : anyHead ? 'hitmarkHS' : 'hitmark',
          { vol: anyKill ? 0.7 : 0.5, reverb: 0 });
      }
    }
  }

  swayOffset(W, adsW) {
    const s = W.def.sway;
    if (!s) return { x: 0, y: 0 };
    const t = W.swayT;
    const amp = s.amp * (Math.PI / 180) * adsW * lerp(0.06, 1, W.breath);
    return {
      x: Math.sin(t * s.freq * 2 * Math.PI * 0.61) * amp * 1.15,
      y: Math.sin(t * s.freq * 2 * Math.PI * 0.43 + 1.1) * amp * 0.72,
    };
  }

  /* ---------------------------------------------------------------- damage */
  applyDamage(target, dmg, attacker, weaponName, headshot, dir, zone) {
    if (!target.alive) return false;
    target.health -= dmg;
    target.lastDamage = this.time;
    target.lastAttacker = attacker;
    if (attacker) attacker.damageDealt += Math.min(dmg, target.health + dmg);
    if (target.char) target.char.hitFlash = Math.min(1, (target.char.hitFlash || 0) + clamp(dmg / 45, 0.2, 1));
    if (target.bot && attacker) target.bot.onDamaged(attacker.pos);

    if (target.isLocal) {
      const ang = Math.atan2(attacker.pos.x - target.pos.x, attacker.pos.z - target.pos.z);
      this.hud.damageDirection(wrapPi(ang - target.yaw));
      this.camShake = Math.min(1.1, this.camShake + clamp(dmg / 70, 0.08, 0.4));
    }

    if (target.health <= 0) {
      this.killActor(target, attacker, weaponName, headshot, dir);
      return true;
    }
    return false;
  }

  killActor(victim, killer, weaponName, headshot, dir) {
    victim.alive = false;
    victim.health = 0;
    victim.deaths++;
    victim.streak = 0;
    victim.respawnT = victim.isLocal ? 99 : this.rng.range(3.0, 5.5);
    if (victim.char) victim.char.kill(dir || this._v.set(0, 0, 1), headshot);
    /* as the body comes to rest, blood starts to run out from under it: from
       the hips, and from the head as well on a headshot. The body itself is
       gone about three seconds after death (Character._updateDeath). */
    if (victim.char) {
      const c = victim.char;
      this.after(0.85, () => {
        if (victim.alive || !this.effects) return;
        const p = this._poolP || (this._poolP = new THREE.Vector3());
        const hips = c.bone && c.bone('Hips');
        if (hips) hips.getWorldPosition(p); else p.copy(victim.pos);
        this.effects.bloodPool(p, 1);
        const head = headshot && c.bone && c.bone('Head');
        if (head) { head.getWorldPosition(p); this.effects.bloodPool(p, 0.55); }
      });
    }
    this.audio.play('death', { pos: [victim.pos.x, victim.pos.y + 1, victim.pos.z], vol: 0.5 });

    if (killer && killer !== victim) {
      killer.kills++;
      killer.streak++;
      killer.bestStreak = Math.max(killer.bestStreak, killer.streak);
      if (killer.team === 'A') this.scoreA++; else this.scoreB++;
      this.checkStreaks(killer);
    } else {
      if (victim.team === 'A') this.scoreB++; else this.scoreA++;
    }

    this.hud.addKill(killer ? killer.name : 'WORLD', killer ? killer.team : victim.team,
      victim.name, victim.team, weaponName, headshot,
      killer === this.me || victim === this.me);

    if (victim.isLocal) {
      this.hud.banner('YOU WERE KILLED BY', killer ? killer.name : 'THE WORLD', true);
      this.startKillcam(killer, weaponName);
    } else if (killer === this.me) {
      // every headshot kill banks one headshot: the currency skins are bought with
      if (headshot) {
        const bank = awardHeadshot();
        this.bankedThisMatch = (this.bankedThisMatch || 0) + 1;
        this.hud.banner('HEADSHOT', victim.name + '  ·  +1 BANKED (' + bank + ')', false);
      } else this.hud.banner('ELIMINATED', victim.name, false);
    }

    if (this.scoreA >= this.scoreLimit || this.scoreB >= this.scoreLimit) this.endMatch();
  }

  checkStreaks(a) {
    for (const s of STREAKS) {
      if (a.streak >= s.cost && !a.streakEarned.has(s.id + a.streak)) {
        a.streakEarned.add(s.id + a.streak);
        if (a.isLocal) {
          this.hud.streakToast(s);
          this.audio.play('streak', { vol: 0.55 });
        } else if (a.bot) {
          // bots cash streaks automatically a moment later
          this.after(1.4 + this.rng() * 2.2, () => {
            if (!a.alive || this.state === STATE.RESULT) return;
            this.streaks.call(s.id, a);
          });
        }
      }
    }
  }

  /* ---------------------------------------------------------------- killcam */
  startKillcam(killer, weaponName) {
    if (!killer || killer === this.me || this.matchOver) {
      this.me.respawnT = 2.2;
      this.after(2.2, () => { if (this.state === STATE.LIVE && !this.me.alive) this.spawn(this.me); });
      return;
    }
    const ok = this.killcam.start(killer.idx, 4.2);
    if (!ok) {
      this.me.respawnT = 2.0;
      this.after(2.0, () => { if (!this.me.alive && !this.matchOver) this.spawn(this.me); });
      return;
    }
    this.state = STATE.KILLCAM;
    this.killcamT = 5.0;
    this.hud.showKillcam(killer.name, weaponName);
    this.viewmodel.hidden = true;
    // the killcam takes the whole screen: no scope ring and no strike
    // selector left drawn underneath it
    this.hud.setScope(false);
    this.hud.showScoreboard(false);
    if (this.strikeMode) this.closeStrikeSelect();
  }

  endKillcam() {
    if (this.state !== STATE.KILLCAM) return;
    this.killcam.stop();
    this.hud.hideKillcam();
    this.viewmodel.hidden = false;
    if (this.matchOver) { this.showResult(); return; }
    this.state = STATE.LIVE;
    this.spawn(this.me);
  }

  /* ---------------------------------------------------------------- lethals */
  throwLethal(a, targetPoint, cookedFor = 0) {
    if (a.lethalCount <= 0) return;
    a.lethalCount--;
    const def = a.lethalDef;
    const p = new Projectile(def, this.scene);
    const from = this._v.set(a.pos.x, a.pos.y + a.eyeY - 0.1, a.pos.z);
    let dir;
    if (targetPoint) {
      // simple ballistic solve toward the point
      const dx = targetPoint.x - from.x, dz = targetPoint.z - from.z;
      const d = Math.hypot(dx, dz);
      const elev = clamp(d / 60, 0.12, 0.55);
      dir = new THREE.Vector3(dx / d, elev * 2, dz / d).normalize();
    } else {
      const cy = Math.cos(a.yaw), sy = Math.sin(a.yaw);
      const cp = Math.cos(a.pitch + 0.18), sp = Math.sin(a.pitch + 0.18);
      dir = new THREE.Vector3(sy * cp, sp, cy * cp).normalize();
    }
    p.launch(from, dir, def.throwSpeed, a, cookedFor);
    this.projectiles.push(p);
    if (a.isLocal) this.hud.setLethal(def.name, a.lethalCount);
    this.audio.play('mech_pin', { vol: 0.5 });
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.update(dt, this.map, (pr) => this.detonate(pr), this.audio);
      if (!p.live) { p.dispose(); this.projectiles.splice(i, 1); }
    }
  }

  detonate(p) {
    const def = p.def;
    const hits = explode(this.world, p.pos, def.radius, def.damage, def.minDamage, p.owner);
    for (const h of hits) {
      this.applyDamage(h.actor, h.damage, p.owner, def.name, false,
        this._v.set(h.dirX, 0, h.dirZ), 'blast');
    }
    const d = this.camera.position.distanceTo(p.pos);
    if (d < def.radius * 2.2) {
      this.camShake = Math.min(1.4, this.camShake + clamp(1 - d / (def.radius * 2.2), 0, 1) * 1.1);
      if (d < def.radius * 1.3) this.audio.concuss(2.4);
    }
    for (const o of this.actors) if (o.bot) o.bot.hearGunshot(p.pos, 2.2);
  }

  scheduleExplosion(x, y, z, radius, dmg, minDmg, owner, delay, opts) {
    this.pendingBlasts.push({ x, y, z, radius, dmg, minDmg, owner, t: delay, opts: opts || null });
  }

  updateBlasts(dt) {
    for (let i = this.pendingBlasts.length - 1; i >= 0; i--) {
      const b = this.pendingBlasts[i];
      b.t -= dt;
      if (b.t > 0) continue;
      this.pendingBlasts.splice(i, 1);
      const pos = new THREE.Vector3(b.x, b.y, b.z);
      const hits = explode(this.world, pos, b.radius, b.dmg, b.minDmg, b.owner, b.opts || undefined);
      for (const h of hits) {
        this.applyDamage(h.actor, h.damage, b.owner, (b.opts && b.opts.label) || 'AIRSTRIKE', false,
          this._v.set(h.dirX, 0, h.dirZ), 'blast');
      }
      const d = this.camera.position.distanceTo(pos);
      if (d < 42) {
        this.camShake = Math.min(1.6, this.camShake + clamp(1 - d / 42, 0, 1) * 1.0);
        if (d < 14) this.audio.concuss(2.6);
      }
    }
  }

  /* ---------------------------------------------------------------- player */
  handlePlayerActions(a, dt) {
    const I = this.input;
    const W = a.weapon;

    /* weapon swap */
    const wantSlot = I.hit('primary') ? 'primary' : I.hit('secondary') ? 'secondary'
      : I.hit('swap') ? (a.slot === 'primary' ? 'secondary' : 'primary') : null;
    if (wantSlot && wantSlot !== a.slot && a.swapT <= 0) {
      a.swapTo = wantSlot;
      a.swapT = W.def.swap.out; a.swapDur = W.def.swap.out;
      this.audio.play('mech_swap', { vol: 0.45 });
    }

    /* fire mode */
    if (I.hit('fireMode')) {
      const d = W.def;
      if (d.fire === FIRE.AUTO) W.mode = (W.mode === FIRE.AUTO) ? FIRE.SEMI : FIRE.AUTO;
      this.hud.setWeapon({ ...d, fire: W.mode }, a.lethalDef.name, a.lethalCount);
      this.audio.play('uiClick', { vol: 0.35 });
    }

    /* lethal: hold to cook (frag only) */
    if (I.down('lethal') && a.lethalCount > 0 && !a.cooking && a.swapT <= 0) {
      a.cooking = true; a.cookT = 0;
      if (a.lethalDef.cookable) this.audio.play('mech_pin', { vol: 0.6 });
    }
    if (a.cooking) {
      a.cookT += dt;
      if (a.lethalDef.cookable && a.cookT > a.lethalDef.fuse - 0.15) {
        // held too long
        a.cooking = false;
        this.throwLethal(a, null, a.lethalDef.fuse - 0.05);
      } else if (!I.down('lethal')) {
        a.cooking = false;
        this.throwLethal(a, null, a.lethalDef.cookable ? a.cookT : 0);
      }
    }

    /* melee */
    if (I.hit('melee') && a.meleeT <= 0 && a.swapT <= 0 && !a.cooking) this.startMelee(a);
    if (a.meleeT > 0) a.meleeT = Math.max(0, a.meleeT - dt);

    /* hold breath */
    W.holdingBreath = I.down('hold') && a.adsW > 0.6 && !!W.def.sway;

    /* the team airstrike — not a streak, so it has its own key and its own
       availability rule: your side simply has not spent it yet */
    if (I.hit('streak2')) {
      if (this.teamStrikeReady(a)) this.openStrikeSelect(TEAM_STRIKE, a);
      else this.hud.banner('AIRSTRIKE SPENT', 'YOUR TEAM HAS USED ITS STRIKE', true);
    }

    /* killstreaks */
    for (const s of STREAKS) {
      const key = s.key === '5' ? 'streak1' : 'streak3';
      if (!I.hit(key)) continue;
      const avail = STREAKS.filter(x => x.key === s.key && a.streak >= x.cost);
      if (!avail.length) continue;
      const best = avail[avail.length - 1];
      this.streaks.call(best.id, a);
      a.streak = 0; a.streakEarned.clear(); this.hud.setStreaks(0);
      break;
    }

    /* scoreboard */
    this.hud.showScoreboard(I.down('scoreboard'));
    if (I.down('scoreboard')) {
      this.hud.renderScoreboard(this.actors, this.scoreA, this.scoreB, this.scoreLimit, this.me);
    }
  }

  /* ---------------------------------------------------------------- melee */

  /**
   * Start a swing. The hit is not resolved on the key press but at the point
   * in the animation where the weapon arrives — MELEE_HIT_K of the way through
   * — so what you see connect is what connects.
   */
  startMelee(a) {
    const W = a.weapon;
    if (W.reloading) W.interruptReload();       // drop the reload and swing
    a.meleeT = a.meleeDur = MELEE_DUR;
    const seq = ++a.meleeSeq;
    if (a.isLocal) this.audio.play('melee_swing', { vol: 0.55, reverb: 0.05 });
    else this.audio.play('melee_swing', { pos: [a.pos.x, a.pos.y + 1.3, a.pos.z], vol: 0.8 });
    this.after(MELEE_DUR * MELEE_HIT_K, () => {
      if (!a.alive || a.meleeSeq !== seq || this.state !== STATE.LIVE) return;
      this.resolveMelee(a);
    });
  }

  /**
   * Who does the swing connect with?
   *
   * The first version fired one infinitely thin ray down the crosshair, 2.1 m
   * long. Measured, a target 0.25 m off-centre at arm's length — about 12° —
   * was a miss, and so was looking up at someone's head: melee only worked
   * with pixel-perfect aim, and a miss gave nothing back but a click. A swing
   * sweeps an arc, so this tests a cone: each enemy's head, chest and hips,
   * within reach, inside ~28° of where you are looking, with nothing solid in
   * between. The most centred candidate wins.
   */
  resolveMelee(a) {
    const REACH = 2.3, CONE = Math.cos(28 * Math.PI / 180);
    const cy = Math.cos(a.yaw), sy = Math.sin(a.yaw);
    const cp = Math.cos(a.pitch), sp = Math.sin(a.pitch);
    const dir = this._dir.set(sy * cp, sp, cy * cp).normalize();
    const eye = this._eye.set(a.pos.x, a.pos.y + a.eyeY, a.pos.z);
    const M = this.map;
    let best = null, bestScore = -Infinity;
    for (const o of this.actors) {
      if (o === a || !o.alive || o.team === a.team) continue;
      if (Math.hypot(o.pos.x - eye.x, o.pos.z - eye.z) > REACH + 0.5) continue;
      for (const [zone, h] of MELEE_POINTS) {
        const y = o.pos.y + h * (1 - (o.crouch || 0) * 0.32);
        const vx = o.pos.x - eye.x, vy = y - eye.y, vz = o.pos.z - eye.z;
        const d = Math.hypot(vx, vy, vz);
        if (d > REACH || d < 1e-3) continue;
        const c = (vx * dir.x + vy * dir.y + vz * dir.z) / d;
        if (c < CONE) continue;
        if (!M.lineOfSight(eye.x, eye.y, eye.z, o.pos.x, y, o.pos.z)) continue;
        const score = c - d * 0.04;
        if (score > bestScore) { bestScore = score; best = { o, zone, x: o.pos.x, y, z: o.pos.z }; }
      }
    }

    const hitDir = this._mDir || (this._mDir = new THREE.Vector3());
    const hitPos = this._mPos || (this._mPos = new THREE.Vector3());
    if (best) {
      const o = best.o;
      hitDir.set(best.x - eye.x, 0, best.z - eye.z).normalize();
      hitPos.set(best.x, best.y, best.z);
      this.applyDamage(o, MELEE_DAMAGE, a, 'MELEE', false, hitDir, best.zone);
      this.effects.bloodHit(hitPos, hitDir, false);
      this.audio.play('melee_hit', { pos: [best.x, best.y, best.z], vol: a.isLocal ? 1.0 : 0.9, reverb: 0.1 });
      if (a.isLocal) {
        this.hud.hitmarker(false, !o.alive);
        this.camShake = Math.min(1.6, this.camShake + 0.35);
      }
      return true;
    }

    /* nobody in the arc — but a wall within reach still takes the blow */
    const wh = M.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, 1.7, this._mh || (this._mh = {}));
    if (wh) {
      hitPos.set(wh.px, wh.py, wh.pz);
      hitDir.set(wh.nx, wh.ny, wh.nz);
      this.effects.impact(hitPos, hitDir, wh.surface, false);
      this.audio.play('imp_' + wh.surface, { pos: [wh.px, wh.py, wh.pz], vol: 0.7, reverb: 0.2 });
      if (a.isLocal) this.camShake = Math.min(1.6, this.camShake + 0.18);
    }
    return false;
  }

  footstep(a) {
    const surf = this.surfaceUnder(a);
    const running = Math.hypot(a.vel.x, a.vel.z) > 3.0;
    const name = (running ? 'run_' : 'step_') + surf;
    if (a.isLocal) {
      this.audio.play(name, { vol: a.crouch > 0.5 ? 0.10 : running ? 0.30 : 0.20, reverb: 0.16 });
    } else {
      const d = this.camera.position.distanceTo(a.pos);
      if (d < 26) {
        this.audio.play(name, { pos: [a.pos.x, a.pos.y, a.pos.z],
          vol: (a.crouch > 0.5 ? 0.35 : running ? 1.0 : 0.7), reverb: 0.3 });
      }
    }
  }

  surfaceUnder(a) {
    const hit = this.map.raycast(a.pos.x, a.pos.y + 0.4, a.pos.z, 0, -1, 0, 1.2, this._su || (this._su = {}));
    return hit ? hit.surface : 'dirt';
  }

  /* ---------------------------------------------------------------- camera */
  updateCamera(dt) {
    const a = this.me;
    const I = this.input;
    const W = a.weapon;

    if (this.state === STATE.LIVE && (I.locked || I.lockUnavailable) && a.alive && !this.strikeMode) {
      const d = I.lookDelta(a.adsW);
      a.yaw -= d.x;
      a.pitch -= d.y;
      a.pitch = clamp(a.pitch, -1.45, 1.45);
    }

    /* sway (scoped weapons) folded into the view */
    let swayX = 0, swayY = 0;
    if (W.def.sway && a.adsW > 0.05) {
      const s = this.swayOffset(W, a.adsW);
      swayX = s.x; swayY = s.y;
    }

    const eyeY = a.pos.y + a.eyeY;
    this.camera.position.set(a.pos.x, eyeY, a.pos.z);

    /* camera shake */
    this.camShake = damp(this.camShake, 0, 5.2, dt);
    this.camShakeT += dt * 34;
    const sh = this.camShake * this.camShake;
    const shX = Math.sin(this.camShakeT * 1.7) * sh * 0.030 + Math.sin(this.camShakeT * 3.1) * sh * 0.014;
    const shY = Math.cos(this.camShakeT * 2.3) * sh * 0.030 + Math.sin(this.camShakeT * 4.7) * sh * 0.011;

    /* view kick from recoil (recovers faster than the aim offset) */
    const kickP = W.visualKick, kickY = W.visualYaw;

    /* landing dip + walk roll */
    const rollTarget = -(this._strafeSign(a)) * 0.018 * (1 - a.adsW * 0.7);
    this.camRoll = damp(this.camRoll || 0, rollTarget, 7, dt);

    this._e.set(
      a.pitch + W.recoilPitch + kickP + swayY + shY,
      a.yaw + W.recoilYaw + kickY + swayX + shX + Math.PI,
      this.camRoll + Math.sin(this.camShakeT * 1.3) * sh * 0.02,
      'YXZ');
    this.camera.quaternion.setFromEuler(this._e);

    /* FOV: base, narrowed by ADS, widened by sprint */
    const baseFov = this.cfg ? this.cfg.fov : 85;
    let want = baseFov;
    if (a.adsW > 0.001) {
      const target = W.def.scoped ? W.def.scopeFov : W.def.ads.fov;
      want = lerp(baseFov, target, smoothstep(a.adsW));
    }
    want *= 1 + a.sprint * 0.045;
    this.camera.fov = damp(this.camera.fov, want, 22, dt);
    this.camera.updateProjectionMatrix();

    /* scope overlay + hide the viewmodel when fully scoped */
    const scoped = !!W.def.scoped && a.adsW > 0.72;
    this.hud.setScope(scoped, W.holdingBreath && W.breath > 0.02);
    this.viewmodel.hidden = scoped || !a.alive;

    /* listener */
    const fwd = this._v.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const up = this._v2.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.audio.setListener(this.camera.position, fwd, up);
  }

  _strafeSign(a) {
    const cy = Math.cos(a.yaw), sy = Math.sin(a.yaw);
    return clamp((a.vel.z * sy - a.vel.x * cy) / 4.0, -1, 1);
  }

  /* ---------------------------------------------------------------- strike */
  /* ------------------------------------------------------- team airstrike */

  /** Has this actor's side still got its one strike, and can it call it now? */
  teamStrikeReady(a) {
    if (!a || !a.alive || this.state !== STATE.LIVE) return false;
    return !this.teamStrikeUsed[a.team];
  }

  /**
   * Spend the caller's team airstrike.
   *
   * Marking the team spent *before* the jets fly matters: the run takes several
   * seconds, and without it a player could open the map twice and buy two.
   */
  callTeamStrike(owner, aim, heading) {
    if (!this.teamStrikeReady(owner)) return false;
    this.teamStrikeUsed[owner.team] = true;
    this.streaks.teamStrike(owner, aim, heading);
    this.hud.setTeamStrike(this.teamStrikeReady(this.me));
    return true;
  }

  /**
   * The enemy side calls its strike once, on its own.
   *
   * It aims at the tightest cluster of our people who are actually standing in
   * the open, because that is the only place the bombs bite — dropping it on a
   * man indoors would waste the side's one shot. If nobody is exposed it simply
   * waits, which is why the strike sometimes never comes.
   */
  updateEnemyStrike(dt) {
    if (this.state !== STATE.LIVE) return;
    const team = this.playerTeam === 'A' ? 'B' : 'A';
    if (this.teamStrikeUsed[team]) return;
    if (this.time < 35) return;                 // not in the opening exchange
    if (this.time < this.enemyStrikeAt) return;
    this.enemyStrikeAt = this.time + 3.0;       // re-evaluate every few seconds

    const caller = this.actors.find(a => a.alive && a.team === team && a.bot);
    if (!caller) return;

    const exposed = this.actors.filter(a =>
      a.alive && a.team !== team && underOpenSky(this.world, a.pos.x, a.pos.y + 1.7, a.pos.z));
    if (!exposed.length) return;

    // tightest cluster: the target with the most exposed company inside a stick
    let best = null, bestN = 0;
    for (const t of exposed) {
      let n = 0;
      for (const o of exposed) if (Math.hypot(o.pos.x - t.pos.x, o.pos.z - t.pos.z) < 9) n++;
      if (n > bestN) { bestN = n; best = t; }
    }
    if (!best) return;
    // hold the single strike for a worthwhile target unless the match is late
    if (bestN < 2 && this.timeLeft > 90 && this.rng() > 0.02) return;

    const aim = new THREE.Vector3(best.pos.x, 0, best.pos.z);
    const heading = Math.atan2(best.pos.x - caller.pos.x, best.pos.z - caller.pos.z);
    this.callTeamStrike(caller, aim, heading);
  }

  openStrikeSelect(def, owner) {
    this.strikeMode = { def, owner };
    this.strikeCursor.x = 0; this.strikeCursor.z = 0; this.strikeCursor.heading = 0;
    document.getElementById('strikeSel').classList.remove('hidden');
    document.getElementById('ssTitle').textContent =
      def.name + ' — YOUR TEAM’S ONLY STRIKE';
    this.drawStrikeMap();
  }

  updateStrikeSelect(dt) {
    if (!this.strikeMode) return;
    const I = this.input;
    this.strikeCursor.x = clamp(this.strikeCursor.x + I.mouse.dx * 0.055, 1 - this.map.halfW, this.map.halfW - 1);
    this.strikeCursor.z = clamp(this.strikeCursor.z + I.mouse.dy * 0.055, 1 - this.map.halfD, this.map.halfD - 1);
    this.strikeCursor.heading += I.mouse.wheel * 0.24;
    this.drawStrikeMap();
    if (I.mouse.leftPressed) {
      const { owner } = this.strikeMode;
      this.callTeamStrike(owner,
        new THREE.Vector3(this.strikeCursor.x, 0, this.strikeCursor.z), this.strikeCursor.heading);
      this.closeStrikeSelect();
    } else if (I.hit('pause')) this.closeStrikeSelect();
  }

  closeStrikeSelect() {
    this.strikeMode = null;
    document.getElementById('strikeSel').classList.add('hidden');
  }

  drawStrikeMap() {
    const cv = document.getElementById('strikeCv'), c = cv.getContext('2d');
    const W = cv.width, H = cv.height, pad = 20;
    const s = Math.min((W - pad * 2) / this.map.W, (H - pad * 2) / this.map.D);
    const X = (x) => W / 2 + x * s, Z = (z) => H / 2 + z * s;
    c.fillStyle = '#08100c'; c.fillRect(0, 0, W, H);
    for (const b of this.map.boxes) {
      if (!b.solid || b.y1 - b.y0 < 0.6 || b.y0 > 4.5) continue;
      if (!b.vis && !((b.mat === 'rock' || b.mat === 'bark') && b.y1 - b.y0 < 2.5)) continue;
      if (Math.abs(b.x0) > this.map.halfW + 2 || Math.abs(b.z0) > this.map.halfD + 2) continue;
      c.fillStyle = (b.y1 - b.y0) > 2.6 ? 'rgba(70,88,94,0.9)' : 'rgba(80,100,84,0.7)';
      c.fillRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * s, (b.z1 - b.z0) * s);
    }
    // live actors
    for (const a of this.actors) {
      if (!a.alive) continue;
      const known = a.team === this.playerTeam || this.streaks.uavOnline || a.firingFlash > 0;
      if (!known) continue;
      c.fillStyle = a.team === this.playerTeam ? '#7ee787' : '#ff5b47';
      c.beginPath(); c.arc(X(a.pos.x), Z(a.pos.z), 4, 0, 6.283); c.fill();
    }
    // strike line
    const h = this.strikeCursor.heading;
    const dx = Math.sin(h), dz = Math.cos(h);
    const cx = X(this.strikeCursor.x), cz = Z(this.strikeCursor.z);
    const L = 18;
    c.strokeStyle = '#ffcb47'; c.lineWidth = 2; c.setLineDash([7, 5]);
    c.beginPath();
    c.moveTo(cx - dx * L * s, cz - dz * L * s);
    c.lineTo(cx + dx * L * s, cz + dz * L * s);
    c.stroke(); c.setLineDash([]);
    c.strokeStyle = '#ffcb47'; c.lineWidth = 1.6;
    c.beginPath(); c.arc(cx, cz, 12, 0, 6.283); c.stroke();
    c.beginPath(); c.moveTo(cx - 18, cz); c.lineTo(cx + 18, cz);
    c.moveTo(cx, cz - 18); c.lineTo(cx, cz + 18); c.stroke();
    c.fillStyle = 'rgba(255,203,71,0.75)';
    c.font = '11px monospace'; c.textAlign = 'center';
    c.fillText('SCROLL TO ROTATE', cx, cz + 34);
  }

  /* ---------------------------------------------------------------- hud */
  updateHud(dt) {
    const a = this.me;
    const W = a.weapon;
    this.hud.setScore(this.scoreA, this.scoreB, this.timeLeft,
      'TEAM DEATHMATCH · ' + this.scoreLimit);
    this.hud.setVitals(a.health, a.maxHealth,
      a.sprint > 0.5 ? 'SPRINT' : a.crouch > 0.5 ? 'CROUCH' : 'STAND',
      Math.round(clamp(a.health / a.maxHealth, 0, 1) * 3));
    this.hud.setAmmo(W.mag, W.reserve, W.mag <= W.def.mag * 0.2);
    this.hud.setStreaks(a.streak);
    this.hud.setTeamStrike(this.teamStrikeReady(a));
    this.hud.setLethal(a.lethalDef.name, a.lethalCount);

    /* reticle gap from real spread */
    const spreadRad = W.spread(a.adsW, a.moving, !a.grounded, a.crouch > 0.5);
    const halfFov = (this.camera.fov * Math.PI / 180) / 2;
    // convert the cone to a fraction of the screen, then to reticle units
    const frac = Math.tan(spreadRad) / Math.tan(halfFov);
    const gap = clamp(frac * 50, 2.5, 46);
    let onEnemy = false;
    if (this.state === STATE.LIVE && a.alive) {
      const cy = Math.cos(a.yaw), sy = Math.sin(a.yaw), cp = Math.cos(a.pitch), sp = Math.sin(a.pitch);
      this._dir.set(sy * cp, sp, cy * cp);
      this._eye.set(a.pos.x, a.pos.y + a.eyeY, a.pos.z);
      for (const o of this.actors) {
        if (!o.alive || o.team === a.team || !o.char) continue;
        const h = o.char.raycastZones(this._eye.x, this._eye.y, this._eye.z,
          this._dir.x, this._dir.y, this._dir.z, 90, {});
        if (h && this.map.lineOfSight(this._eye.x, this._eye.y, this._eye.z, h.px, h.py, h.pz)) { onEnemy = true; break; }
      }
    }
    this.hud.updateReticle(gap, a.adsW, this.state === STATE.LIVE && a.alive, onEnemy);

    this.hud.update(dt, {
      pos: a.pos, yaw: a.yaw, team: a.team, self: a, actors: this.actors,
      uav: this.streaks.uavOnline,
      markers: this.strikeMode ? [{ x: this.strikeCursor.x, z: this.strikeCursor.z, color: '#ffcb47' }] : null,
    });
  }

  /* ---------------------------------------------------------------- end */
  endMatch() {
    if (this.matchOver) return;
    this.matchOver = true;
    if (this.state === STATE.KILLCAM) return;
    this.after(1.4, () => this.showResult());
  }

  showResult() {
    this.state = STATE.RESULT;
    this.hud.show(false);
    this.input.exitLock();
    const win = this.scoreA > this.scoreB;
    const el = document.getElementById('result');
    document.getElementById('resVerdict').textContent = win ? 'VICTORY' : this.scoreA === this.scoreB ? 'DRAW' : 'DEFEAT';
    document.getElementById('resVerdict').className = 'res-verdict ' + (win ? 'win' : 'lose');
    document.getElementById('resLine').textContent =
      `ALLIED ${this.scoreA} — ${this.scoreB} HOSTILE · ${fmtTime(this.timeLeft)} REMAINING`;
    document.getElementById('resBoard').innerHTML =
      this.hud.renderScoreboard(this.actors, this.scoreA, this.scoreB, this.scoreLimit, this.me);
    const me = this.me;
    const acc = me.shotsFired ? (me.shotsHit / me.shotsFired * 100) : 0;
    document.getElementById('resStats').innerHTML = [
      ['KILLS', me.kills], ['DEATHS', me.deaths],
      ['K/D', me.deaths ? (me.kills / me.deaths).toFixed(2) : me.kills.toFixed(2)],
      ['ACCURACY', acc.toFixed(0) + '%'], ['HEADSHOTS', me.headshots],
      ['BEST STREAK', me.bestStreak], ['DAMAGE', Math.round(me.damageDealt)],
      ['HEADSHOT BANK', '+' + (this.bankedThisMatch || 0) + ' → ' + loadProfile().headshots],
    ].map(([k, v]) => `<div><div class="rv">${v}</div><div class="rk">${k}</div></div>`).join('');
    el.classList.remove('hidden');
    if (this.ambienceLoop) { this.audio.stopLoop(this.ambienceLoop); this.ambienceLoop = null; }
  }
}

function smoothstep(t) { return t * t * (3 - 2 * t); }
