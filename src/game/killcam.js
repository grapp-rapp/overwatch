/* ============================================================================
   Killcam.

   A fixed-size ring buffer records every actor's transform and animation inputs
   at 20 Hz. On death we rewind ~5 seconds, put the camera at the killer's eye,
   and drive every character straight from the recording — including your own
   body, which is why the local player has a full skinned model rather than a
   pair of floating arms.

   Playback re-runs the real Character.update(), so the replay shows the same
   locomotion blending, spine aim offset and IK as the live game. Muzzle flashes
   are replayed from a small event list so the killer's shots read correctly.
   ========================================================================== */
import * as THREE from 'three';
import { clamp, lerp, wrapPi } from '../core/util.js';

const HZ = 20;
const SECONDS = 10;
const FRAMES = HZ * SECONDS;
const PER_ACTOR = 9;   // x y z yaw pitch crouch adsW speed alive

export class Recorder {
  constructor(maxActors = 20) {
    this.maxActors = maxActors;
    this.stride = PER_ACTOR * maxActors;
    this.data = new Float32Array(FRAMES * this.stride);
    this.times = new Float32Array(FRAMES);
    this.head = 0; this.count = 0;
    this.acc = 0;
    this.events = [];      // { t, kind, actorIdx, x,y,z, dx,dy,dz, weaponId }
    this.t = 0;
  }

  reset() { this.head = 0; this.count = 0; this.acc = 0; this.events.length = 0; this.t = 0; }

  sample(dt, actors) {
    this.t += dt;
    this.acc += dt;
    if (this.acc < 1 / HZ) return;
    this.acc -= 1 / HZ;
    const f = this.head;
    this.times[f] = this.t;
    const base = f * this.stride;
    const d = this.data;
    for (let i = 0; i < this.maxActors; i++) {
      const o = base + i * PER_ACTOR;
      const a = actors[i];
      if (!a) { d[o + 8] = -1; continue; }
      d[o] = a.pos.x; d[o + 1] = a.pos.y; d[o + 2] = a.pos.z;
      d[o + 3] = a.yaw; d[o + 4] = a.pitch;
      d[o + 5] = a.crouch; d[o + 6] = a.adsW;
      d[o + 7] = Math.hypot(a.vel.x, a.vel.z);
      d[o + 8] = a.alive ? 1 : 0;
    }
    this.head = (this.head + 1) % FRAMES;
    if (this.count < FRAMES) this.count++;
    // drop stale events
    const cutoff = this.t - SECONDS;
    while (this.events.length && this.events[0].t < cutoff) this.events.shift();
  }

  addEvent(kind, actorIdx, x, y, z, dx, dy, dz, weaponId) {
    if (this.events.length > 400) this.events.shift();
    this.events.push({ t: this.t, kind, actorIdx, x, y, z, dx, dy, dz, weaponId });
  }

  frameAt(i) { return (this.head - this.count + i + FRAMES * 2) % FRAMES; }
  get oldestTime() { return this.count ? this.times[this.frameAt(0)] : this.t; }

  /** Interpolated actor state at absolute time `t`. Returns false if out of range. */
  sampleAt(t, i, out) {
    if (this.count < 2) return false;
    // binary search over the retained window
    let lo = 0, hi = this.count - 1;
    if (t <= this.times[this.frameAt(0)]) { hi = 1; lo = 0; }
    else if (t >= this.times[this.frameAt(this.count - 1)]) { lo = this.count - 2; hi = this.count - 1; }
    else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (this.times[this.frameAt(mid)] <= t) lo = mid; else hi = mid;
      }
    }
    const fa = this.frameAt(lo), fb = this.frameAt(hi);
    const ta = this.times[fa], tb = this.times[fb];
    const k = tb > ta ? clamp((t - ta) / (tb - ta), 0, 1) : 0;
    const oa = fa * this.stride + i * PER_ACTOR;
    const ob = fb * this.stride + i * PER_ACTOR;
    const d = this.data;
    if (d[oa + 8] < 0) return false;
    out.x = lerp(d[oa], d[ob], k);
    out.y = lerp(d[oa + 1], d[ob + 1], k);
    out.z = lerp(d[oa + 2], d[ob + 2], k);
    out.yaw = d[oa + 3] + wrapPi(d[ob + 3] - d[oa + 3]) * k;
    out.pitch = lerp(d[oa + 4], d[ob + 4], k);
    out.crouch = lerp(d[oa + 5], d[ob + 5], k);
    out.adsW = lerp(d[oa + 6], d[ob + 6], k);
    out.speed = lerp(d[oa + 7], d[ob + 7], k);
    out.alive = d[ob + 8] > 0.5;
    return true;
  }
}

export class KillcamPlayer {
  constructor(recorder, actors, camera, effects) {
    this.rec = recorder;
    this.actors = actors;
    this.camera = camera;
    this.effects = effects;
    this.active = false;
    this.t = 0;
    this.endT = 0;
    this.killerIdx = -1;
    this._s = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: 0, adsW: 0, speed: 0, alive: true };
    this._prev = new Map();
    this._eventCursor = 0;
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  /** @param lookback seconds of replay before the kill */
  start(killerIdx, lookback = 4.2) {
    if (!this.rec.count) return false;
    this.killerIdx = killerIdx;
    this.endT = this.rec.t;
    this.t = Math.max(this.rec.oldestTime + 0.05, this.endT - lookback);
    if (this.endT - this.t < 0.6) return false;
    this.active = true;
    this._prev.clear();
    this._eventCursor = 0;
    // rewind to the first event inside the window
    while (this._eventCursor < this.rec.events.length &&
           this.rec.events[this._eventCursor].t < this.t) this._eventCursor++;
    // put every actor's character into the replay
    for (const a of this.actors) {
      if (!a || !a.char) continue;
      a.char.root.visible = true;
      if (a.char.dead) a.char.revive();
    }
    /* The camera rides the killer's eye socket, so their own helmet, arms and
       weapon would fill the lens. Hide the viewer's body for the duration —
       this is a first-person killcam; the body you are meant to see is yours. */
    const k = this.actors[killerIdx];
    this._hidden = k && k.char ? k.char : null;
    if (this._hidden) {
      this._hidden.model.visible = false;
      if (this._hidden.weaponModel) this._hidden.weaponModel.visible = false;
    }
    return true;
  }

  stop() {
    this.active = false;
    if (this._hidden) {
      this._hidden.model.visible = true;
      if (this._hidden.weaponModel) this._hidden.weaponModel.visible = true;
      this._hidden = null;
    }
    for (const a of this.actors) if (a && a.char) a.char.root.visible = a.alive;
  }

  update(dt) {
    if (!this.active) return false;
    this.t += dt;
    const done = this.t >= this.endT;
    if (done) this.t = this.endT;

    const s = this._s;
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      if (!a || !a.char) continue;
      if (!this.rec.sampleAt(this.t, i, s)) { a.char.root.visible = false; continue; }
      const c = a.char;
      c.root.visible = true;
      if (c === this._hidden) { c.model.visible = false; if (c.weaponModel) c.weaponModel.visible = false; }
      // derive velocity from the previous replay position so the legs blend right
      const prev = this._prev.get(i);
      if (prev && dt > 1e-5) {
        c.vel.set((s.x - prev.x) / dt, 0, (s.z - prev.z) / dt);
      } else {
        c.vel.set(Math.sin(s.yaw) * s.speed, 0, Math.cos(s.yaw) * s.speed);
      }
      this._prev.set(i, { x: s.x, z: s.z });
      c.pos.set(s.x, s.y, s.z);
      c.groundY = s.y;
      c.aimYaw = s.yaw; c.aimPitch = s.pitch;
      c.crouch = s.crouch; c.aimW = s.adsW;
      if (!s.alive && !c.dead) c.kill(this._v.set(Math.sin(s.yaw), 0, Math.cos(s.yaw)), false);
      if (s.alive && c.dead) c.revive();
      c.update(dt, this.camera.position);
    }

    /* replay the killer's muzzle flashes */
    while (this._eventCursor < this.rec.events.length && this.rec.events[this._eventCursor].t <= this.t) {
      const e = this.rec.events[this._eventCursor++];
      if (e.kind === 'shot' && this.effects) {
        this.effects.muzzleFlash(this._v.set(e.x, e.y, e.z),
          this._q.set(0, 0, 0, 1) && new THREE.Vector3(e.dx, e.dy, e.dz), 1);
      }
    }

    /* camera at the killer's eye */
    if (this.rec.sampleAt(this.t, this.killerIdx, s)) {
      const eye = 1.60 - s.crouch * 0.52;
      // a little forward of the eye socket, so the near plane clears the face
      this.camera.position.set(
        s.x + Math.sin(s.yaw) * 0.16, s.y + eye, s.z + Math.cos(s.yaw) * 0.16);
      this._e.set(s.pitch, s.yaw + Math.PI, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this._e);
    }
    return done;
  }
}
