/* ============================================================================
   First-person viewmodel.

   Rendered in its own scene with its own camera and a narrower FOV, composited
   over the world with a cleared depth buffer, so the gun never clips into walls.

   The ADS pose is not hand-authored per weapon. Each gun model carries an
   `opticEye` marker at its actual sight line, and the rig simply solves for the
   translation that puts that marker on the camera axis at the right eye relief.
   Change the optic and the ADS pose follows automatically.
   ========================================================================== */
import * as THREE from 'three';
import { cloneWeapon, buildLethal } from './models.js';
import { FIRE } from './defs.js';
import { meleeCurve, clamp, lerp, damp, makeRng } from '../core/util.js';
import { makeFlashTexture } from '../world/textures.js';

const rng = makeRng(0x71DE0);

export class ViewModel {
  constructor(renderer) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.005, 12);

    // lighting rig — bright key from the upper left, cool fill, warm rim
    const key = new THREE.DirectionalLight(0xfff2e0, 2.5);
    key.position.set(-0.6, 1.0, 0.55);
    const fill = new THREE.DirectionalLight(0x9fc0e8, 0.85);
    fill.position.set(0.9, -0.2, 0.4);
    const rim = new THREE.DirectionalLight(0xffd9a8, 1.2);
    rim.position.set(0.2, 0.4, -1);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xbcd0e8, 0x3a3226, 0.9));
    this.key = key;

    this.rig = new THREE.Group();          // sway / bob / recoil
    this.hand = new THREE.Group();         // gun-space -> camera-space
    this.hand.rotation.y = Math.PI;        // gun +Z (muzzle) -> camera -Z
    this.rig.add(this.hand);
    this.scene.add(this.rig);

    this.weapon = null;
    this.def = null;
    this.optic = new THREE.Vector3();

    /* dynamic state */
    this.adsW = 0;
    this.swayX = 0; this.swayY = 0;
    this.bobPhase = 0; this.bobAmt = 0;
    this.kick = 0; this.kickYaw = 0; this.kickRoll = 0; this.kickBack = 0;
    this.sprint = 0;
    this.equip = 0;          // 1 = fully stowed
    this.reloadK = 0;
    this.landing = 0;
    this.hidden = false;
    this.inspect = 0;

    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._muzzleW = new THREE.Vector3();
    this._ejectW = new THREE.Vector3();
    this._dirW = new THREE.Vector3();
    this._upW = new THREE.Vector3();

    /* muzzle flash lives in the viewmodel scene, not the world, so it stays
       locked to the barrel no matter what the rig is doing */
    this.flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeFlashTexture(), transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, opacity: 0 }));
    this.flashSprite.visible = false;
    this.flashSprite.renderOrder = 20;
    this.scene.add(this.flashSprite);
    this.flashLight = new THREE.PointLight(0xffbb66, 0, 2.2, 2);
    this.flashLight.visible = false;
    this.scene.add(this.flashLight);
    this.flashT = 0;
  }

  setWeapon(def) {
    // detach only: clones share the prototype's geometry and materials, so
    // disposing here would break every other instance of the same weapon
    if (this.weapon) this.hand.remove(this.weapon);
    this.def = def;
    this.weapon = cloneWeapon(def);
    this.weapon.traverse(o => { o.castShadow = false; o.receiveShadow = false; });
    this.hand.add(this.weapon);
    const oe = this.weapon.userData.opticEye.position;
    this.optic.copy(oe);
    this.muzzleObj = this.weapon.userData.muzzle;
    this.ejectObj = this.weapon.userData.eject;
    this.slideObj = this.weapon.userData.slide;
    this.magObj = this.weapon.userData.magazine;
    this.slideThrow = this.weapon.userData.slideThrow;
    this.eyeRelief = def.scoped ? 0.075 : def.magnify ? 0.10 : 0.135;
    this.reloadK = 0;
  }

  /** Called on every shot. */
  onFire(recoilVisual) {
    const d = this.def;
    this.kick += (0.55 + recoilVisual * 0.5) * d.recoil.visual;
    this.kickYaw += rng.gauss() * 0.16 * d.recoil.visual;
    this.kickRoll += rng.gauss() * 0.22 * d.recoil.visual;
    this.kickBack += d.recoil.kickBack;
    this.slideT = 1;

    // flash at the actual muzzle marker, in viewmodel space
    this.rig.updateMatrixWorld(true);
    this.flashSprite.position.setFromMatrixPosition(this.muzzleObj.matrixWorld);
    const size = 0.085 * (0.7 + d.recoil.visual * 0.55) * lerp(1, 0.55, this.adsW);
    this.flashSprite.scale.setScalar(size);
    this.flashSprite.material.rotation = rng() * 6.283;
    this.flashSprite.material.opacity = 1;
    this.flashSprite.visible = true;
    this.flashLight.position.copy(this.flashSprite.position);
    this.flashLight.intensity = 2.4 * d.recoil.visual;
    this.flashLight.visible = true;
    this.flashT = 0.045;
  }

  /**
   * @param dt
   * @param s  { adsW, speed, grounded, crouch, sprint, lookDX, lookDY,
   *             reloading, reloadProgress, equipT, equipDur, hidden, boltT, boltDur }
   */
  update(dt, s) {
    const d = this.def;
    if (!d) return;
    this.hidden = s.hidden;
    this.adsW = s.adsW;

    /* ---- ADS target pose: put the optic on the camera axis ---- */
    // gun-space optic -> camera space is (x, y, -z) because of the Y flip
    const adsP = this._adsP || (this._adsP = new THREE.Vector3());
    adsP.set(-this.optic.x, -this.optic.y, this.optic.z - this.eyeRelief);

    const hipP = this._hipP || (this._hipP = new THREE.Vector3());
    hipP.set(0.132, -0.148, -0.235 - d.model.len * 0.06);

    /* ---- sway: the gun lags the camera ---- */
    const swayScale = lerp(1.0, 0.28, this.adsW);
    this.swayX = damp(this.swayX, clamp(-s.lookDX * 4.2, -0.09, 0.09), 9, dt);
    this.swayY = damp(this.swayY, clamp(-s.lookDY * 4.2, -0.075, 0.075), 9, dt);

    /* ---- bob ---- */
    const moveK = clamp(s.speed / 5.0, 0, 1);
    this.bobAmt = damp(this.bobAmt, s.grounded ? moveK : 0, 7, dt);
    this.bobPhase += dt * (5.4 + moveK * 6.2);
    const bobScale = lerp(1, 0.22, this.adsW) * this.bobAmt;
    const bobX = Math.sin(this.bobPhase) * 0.021 * bobScale;
    const bobY = (Math.abs(Math.cos(this.bobPhase)) - 0.5) * 0.026 * bobScale;
    const bobR = Math.sin(this.bobPhase * 0.5) * 0.030 * bobScale;

    /* ---- sprint pose ---- */
    this.sprint = damp(this.sprint, s.sprint, 9, dt);

    /* ---- recoil recovery ---- */
    this.kick = damp(this.kick, 0, 13, dt);
    this.kickYaw = damp(this.kickYaw, 0, 12, dt);
    this.kickRoll = damp(this.kickRoll, 0, 11, dt);
    this.kickBack = damp(this.kickBack, 0, 12, dt);
    this.landing = damp(this.landing, 0, 9, dt);

    /* ---- reload / equip ---- */
    const rp = s.reloading ? clamp(s.reloadProgress, 0, 1) : 0;
    this.reloadK = damp(this.reloadK, s.reloading ? 1 : 0, 12, dt);
    const equipK = s.equipT > 0 ? clamp(s.equipT / Math.max(0.01, s.equipDur), 0, 1) : 0;

    /* ---- compose position ---- */
    const p = this._p;
    p.lerpVectors(hipP, adsP, smooth(this.adsW));
    p.x += (this.swayX * swayScale + bobX);
    p.y += (this.swayY * swayScale + bobY - this.landing * 0.10);
    p.z += this.kickBack;
    // sprint: swing the gun down and across
    p.x += this.sprint * 0.075;
    p.y -= this.sprint * 0.085;
    p.z += this.sprint * 0.045;
    // reload: drop the gun and roll it toward the mag well
    const rdip = Math.sin(rp * Math.PI) * this.reloadK;
    p.y -= rdip * 0.135;
    p.x += rdip * 0.030;
    p.z += rdip * 0.045;
    // equip: swing up from below
    p.y -= equipK * 0.34;
    p.z += equipK * 0.12;
    /* melee: wind the weapon back and to the right, then drive it forward and
       across the body. The curve is shared with the third-person body. */
    const mc = meleeCurve(s.melee || 0, this._mc || (this._mc = {}));
    const mAds = 1 - smooth(this.adsW) * 0.6;
    p.x += (mc.wind * 0.050 - mc.strike * 0.105) * mAds;
    p.y += (mc.strike * 0.040 - mc.wind * 0.030) * mAds;
    p.z += (mc.wind * 0.085 - mc.strike * 0.230) * mAds;

    /* ---- compose rotation ---- */
    const e = this._e;
    e.set(0, 0, 0);
    e.x = -this.kick * 0.10 + this.swayY * 1.6 * swayScale + bobY * 0.9 - this.landing * 0.22;
    e.y = this.kickYaw * 0.35 - this.swayX * 1.7 * swayScale + this.sprint * 0.62;
    e.z = this.kickRoll * 0.30 + bobR + lerp(0.055, 0.0, smooth(this.adsW))
        + this.sprint * 0.40 + rdip * 0.55;
    e.x += this.sprint * 0.26;
    e.x -= equipK * 0.75;
    e.y += equipK * 0.35;
    e.x += (mc.strike * 0.22 - mc.wind * 0.10) * mAds;
    e.y += (mc.strike * 0.62 - mc.wind * 0.30) * mAds;
    e.z += (mc.strike * 0.50 - mc.wind * 0.28) * mAds;

    this.rig.position.copy(p);
    this.rig.rotation.copy(e);

    /* ---- moving parts ---- */
    if (this.slideObj) {
      let t = 0;
      if (d.fire === FIRE.BOLT && s.boltT > 0) {
        // full bolt cycle: back, pause, forward
        const k = clamp(s.boltT / Math.max(0.01, s.boltDur), 0, 1);
        t = k < 0.42 ? k / 0.42 : k < 0.62 ? 1 : 1 - (k - 0.62) / 0.38;
      } else {
        this.slideT = Math.max(0, (this.slideT || 0) - dt * 26);
        t = this.slideT;
      }
      this.slideObj.position.z = this.slideThrow * t;
      // hold the slide back on an empty magazine
      if (s.magEmpty && d.fire !== FIRE.BOLT && !s.reloading) this.slideObj.position.z = this.slideThrow;
    }
    if (this.magObj) {
      // magazine drops out and a fresh one goes in
      let my = 0, mr = 0;
      if (s.reloading && !d.shellReload) {
        if (rp < 0.42) { const k = rp / 0.42; my = -k * 0.42; mr = k * 0.5; }
        else if (rp < 0.74) { my = -0.42; mr = 0.5; }
        else { const k = (rp - 0.74) / 0.26; my = -0.42 * (1 - k); mr = 0.5 * (1 - k); }
      }
      this.magObj.position.y = my;
      this.magObj.rotation.x = mr;
      this.magObj.visible = !(s.reloading && !d.shellReload && rp > 0.40 && rp < 0.76);
    }

    /* ---- muzzle flash decay ---- */
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = clamp(this.flashT / 0.045, 0, 1);
      this.flashSprite.material.opacity = k;
      this.flashLight.intensity = 2.4 * k * d.recoil.visual;
      if (this.flashT <= 0) { this.flashSprite.visible = false; this.flashLight.visible = false; }
    }

    this.rig.visible = !this.hidden;
    if (this.hidden) { this.flashSprite.visible = false; this.flashLight.visible = false; }
    // keep the key light roughly aligned with the world sun
    if (s.sunDirCam) this.key.position.copy(s.sunDirCam).multiplyScalar(-1);
  }

  /** World-space muzzle point, given the world camera. */
  muzzleWorld(worldCamera, out) {
    if (!this.muzzleObj) return out.copy(worldCamera.position);
    this.rig.updateMatrixWorld(true);
    out.setFromMatrixPosition(this.muzzleObj.matrixWorld);
    // viewmodel space is camera space — transform into the world
    out.applyMatrix4(worldCamera.matrixWorld);
    return out;
  }
  ejectWorld(worldCamera, out) {
    if (!this.ejectObj) return out.copy(worldCamera.position);
    out.setFromMatrixPosition(this.ejectObj.matrixWorld);
    out.applyMatrix4(worldCamera.matrixWorld);
    return out;
  }

  render(renderer, aspect, fovScale) {
    if (this.hidden) return;
    this.camera.aspect = aspect;
    const base = 62;
    this.camera.fov = lerp(base, base * 0.86, this.adsW) * (fovScale || 1);
    this.camera.updateProjectionMatrix();
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.weapon) this.weapon.removeFromParent();
  }
}

function smooth(t) { return t * t * (3 - 2 * t); }

function disposeTree(root) {
  root.traverse(o => {
    if (o.isMesh) {
      o.geometry && o.geometry.dispose();
      const m = Array.isArray(o.material) ? o.material : [o.material];
      m.forEach(x => x && x.dispose && x.dispose());
    }
  });
  root.removeFromParent();
}

/* ---- thrown lethals ------------------------------------------------------ */
export class Projectile {
  constructor(def, scene) {
    this.def = def;
    this.mesh = buildLethal(def);
    scene.add(this.mesh);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.spin = new THREE.Vector3(rng.gauss() * 8, rng.gauss() * 8, rng.gauss() * 8);
    this.fuse = def.fuse;
    this.stuck = false;
    this.live = true;
    this.owner = null;
    this.bounced = 0;
  }
  launch(from, dir, speed, owner, cookedFor = 0) {
    this.pos.copy(from);
    this.vel.copy(dir).multiplyScalar(speed);
    this.owner = owner;
    this.fuse = this.def.fuse - cookedFor;
    this.live = true; this.stuck = false;
    this.mesh.visible = true;
    this.mesh.position.copy(this.pos);
  }
  update(dt, map, onDetonate, audio) {
    if (!this.live) return;
    this.fuse -= dt;
    if (!this.stuck) {
      this.vel.y -= 9.81 * dt;
      this.vel.multiplyScalar(1 - this.def.drag * dt * 6);
      const step = this._s || (this._s = new THREE.Vector3());
      step.copy(this.vel).multiplyScalar(dt);
      const len = step.length();
      if (len > 1e-5) {
        const hit = map.raycast(this.pos.x, this.pos.y, this.pos.z,
          step.x / len, step.y / len, step.z / len, len + 0.045, this._h || (this._h = {}));
        if (hit) {
          if (this.def.sticky) {
            this.stuck = true;
            this.pos.set(hit.px + hit.nx * 0.02, hit.py + hit.ny * 0.02, hit.pz + hit.nz * 0.02);
            this.vel.set(0, 0, 0);
          } else {
            this.pos.set(hit.px + hit.nx * 0.05, hit.py + hit.ny * 0.05, hit.pz + hit.nz * 0.05);
            const n = this._n || (this._n = new THREE.Vector3());
            n.set(hit.nx, hit.ny, hit.nz);
            this.vel.addScaledVector(n, -2 * this.vel.dot(n));
            this.vel.multiplyScalar(this.def.bounce);
            this.spin.multiplyScalar(0.6);
            this.bounced++;
            if (audio && this.vel.length() > 1.2) {
              audio.play('imp_' + hit.surface, { pos: [this.pos.x, this.pos.y, this.pos.z], vol: 0.35 });
            }
          }
        } else {
          this.pos.add(step);
        }
      }
      this.mesh.rotation.x += this.spin.x * dt;
      this.mesh.rotation.y += this.spin.y * dt;
      this.mesh.rotation.z += this.spin.z * dt;
    }
    this.mesh.position.copy(this.pos);
    if (this.mesh.userData.led) {
      this.mesh.userData.led.material.color.setHex(
        (Math.floor(this.fuse * 8) % 2) ? 0xff2200 : 0x330000);
    }
    if (this.fuse <= 0) {
      this.live = false;
      this.mesh.visible = false;
      onDetonate(this);
    }
  }
  dispose() { disposeTree(this.mesh); }
}
