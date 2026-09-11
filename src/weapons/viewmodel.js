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
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { cloneWeapon, buildLethal } from './models.js';
import { skinWeapon, skinMaterialFor } from '../game/skins.js';
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

    /* the free hand, for melee: a bare fist, and a sleeve that wears the skin */
    const f = buildFist();
    this.fist = f.group; this.fistSkin = f.skin; this.fistSleeve = f.sleeve;
    this.fist.visible = false;
    this.scene.add(this.fist);
    this.skin = null;
  }

  /** Wear a skin: camo on the gun and on the punching arm's sleeve. */
  setSkin(skin) {
    this.skin = skin;
    if (this.weapon) skinWeapon(this.weapon, skin);
    this.fistSleeve.material = skinMaterialFor('sleeve', skin);
  }

  /** The punching hand's skin tone (SKINS tab). */
  setHand(hex) { this.fistSkin.material.color.setHex(hex); }

  setWeapon(def) {
    // detach only: clones share the prototype's geometry and materials, so
    // disposing here would break every other instance of the same weapon
    if (this.weapon) this.hand.remove(this.weapon);
    this.def = def;
    this.weapon = cloneWeapon(def);
    this.weapon.traverse(o => { o.castShadow = false; o.receiveShadow = false; });
    if (this.skin) skinWeapon(this.weapon, this.skin);
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
    /* melee: the gun drops out of the way and the free hand punches. The
       punch rides the same curve as the third-person swing, so the hit lands
       as the fist arrives. The first version swung the rifle itself, and what
       you saw was a gun, not a punch. */
    const mk = s.melee || 0;
    const mc = meleeCurve(mk, this._mc || (this._mc = {}));
    const stow = mk <= 0 || mk >= 1 ? 0 : mk < 0.10 ? smooth(mk / 0.10) : mk < 0.62 ? 1 : 1 - smooth((mk - 0.62) / 0.38);
    p.x += 0.10 * stow;
    p.y -= 0.24 * stow;
    p.z += 0.05 * stow;

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
    e.x -= 0.50 * stow;
    e.y -= 0.20 * stow;
    e.z -= 0.35 * stow;

    this.rig.position.copy(p);
    this.rig.rotation.copy(e);

    /* the fist: up from below the screen into a guard, straight out to just
       under the crosshair, and back down */
    const F = this.fist;
    if (mk > 0 && mk < 1 && !this.hidden) {
      const fp = this._fp || (this._fp = new THREE.Vector3());
      const up = smooth(clamp(mk / 0.14, 0, 1)), down = smooth(clamp((mk - 0.55) / 0.40, 0, 1));
      fp.copy(FIST_START).lerp(FIST_GUARD, up * (1 - down)).lerp(FIST_HIT, mc.strike);
      F.position.copy(fp);
      // the forearm always points back at the shoulder; the fist turns from a
      // thumb-up guard to palm-down as it lands
      const d = (this._fd || (this._fd = new THREE.Vector3())).copy(FIST_SHOULDER).sub(fp).normalize();
      F.rotation.set(Math.atan2(-d.y, d.z), Math.atan2(d.x, Math.hypot(d.y, d.z)), 0.15 + 0.9 * up * (1 - mc.strike));
      F.visible = true;
    } else F.visible = false;

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

/* The punching hand: a real fist rather than a glove of boxes. The back of the
   hand and palm are one tapered, domed block with the tendons raised; four
   fingers of three phalanges each curl down from the knuckles, back under the
   palm and tuck in; the thumb wraps across the front of the index and middle
   fingers. Wrist, a bare forearm, and a sleeve rolled to mid-forearm that
   wears your skin. It comes up from below the screen into a guard at the lower
   left, jabs out to just under the crosshair on the same timing curve as the
   hit, and falls away; the forearm always points back at the shoulder. */
const FIST_START = new THREE.Vector3(-0.13, -0.44, -0.26);     // below the bottom of the screen
const FIST_GUARD = new THREE.Vector3(-0.16, -0.12, -0.30);     // raised, lower left
const FIST_HIT = new THREE.Vector3(-0.03, -0.075, -0.50);      // just under the crosshair
const FIST_SHOULDER = new THREE.Vector3(-0.22, -0.30, 0.10);

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
/* a capsule from a to b */
function capsule(a, b, r) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const g = new THREE.CapsuleGeometry(r, len, 5, 12);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}
function ellipsoid(c, rx, ry, rz, basis) {
  const g = new THREE.SphereGeometry(1, 16, 12);
  g.scale(rx, ry, rz);
  if (basis) g.applyMatrix4(basis);
  g.translate(c.x, c.y, c.z);
  return g;
}
/* each part carries a colour multiplier on the skin tone, so one material can
   draw a redder knuckle and a paler nail */
function tone(g, m) {
  if (g.attributes.uv) g.deleteAttribute('uv');
  const n = g.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(m, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
const SKIN = [1, 1, 1], KNUCKLE = [1.07, 0.86, 0.85], TIP = [1.05, 0.9, 0.88], NAIL = [1.3, 1.2, 1.16];

/* back of the hand and palm as one block: narrower at the wrist, domed on top,
   the tendons standing out toward the knuckles */
function handBlock() {
  let g = new THREE.BoxGeometry(0.080, 0.030, 0.092, 8, 4, 8);
  const p = g.attributes.position, v = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    c.set(clamp(v.x, -0.028, 0.028), clamp(v.y, -0.003, 0.003), clamp(v.z, -0.034, 0.034));
    v.sub(c); if (v.lengthSq() > 1e-12) v.setLength(0.012); v.add(c);
    const t = (v.z + 0.046) / 0.092;
    v.x *= 1 - 0.18 * t;
    if (v.y > 0) {
      v.y += 0.004 * (1 - Math.min(1, (v.x / 0.04) ** 2));
      for (const xi of [0.027, 0.009, -0.010, -0.027]) v.y += 0.0011 * Math.exp(-(((v.x - xi) / 0.0045) ** 2)) * (1 - t);
    }
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  g.computeVertexNormals();
  g.translate(0, 0, -0.041);
  return g;
}

/* x, knuckle y, knuckle z, three phalanx lengths, radius, sideways curl */
const FINGERS = [
  [0.027, 0.004, -0.086, 0.040, 0.025, 0.018, 0.0093, -0.06],
  [0.009, 0.006, -0.090, 0.044, 0.028, 0.020, 0.0097, 0],
  [-0.010, 0.004, -0.087, 0.041, 0.026, 0.019, 0.0091, 0.03],
  [-0.027, 0.000, -0.080, 0.033, 0.020, 0.016, 0.0080, 0.08],
];

function buildFist() {
  const parts = [tone(handBlock(), SKIN)];
  for (const [x, y, z, l1, l2, l3, r, sx] of FINGERS) {
    const k = V3(x, y, z);
    parts.push(tone(ellipsoid(k, r * 1.12, r, r * 1.15), KNUCKLE));
    const j1 = k.clone().addScaledVector(V3(sx, -1, -0.1).normalize(), l1);
    const j2 = j1.clone().addScaledVector(V3(sx * 0.5, -0.12, 1).normalize(), l2);
    const j3 = j2.clone().addScaledVector(V3(0, 1, 0.3).normalize(), l3);
    parts.push(tone(capsule(k, j1, r), SKIN), tone(capsule(j1, j2, r * 0.93), SKIN), tone(capsule(j2, j3, r * 0.84), TIP));
  }
  /* the thumb: the muscle at its base, then wrapped across the front of the fist */
  const t0 = V3(0.028, -0.004, -0.010), t1 = V3(0.040, -0.020, -0.050), t2 = V3(0.032, -0.046, -0.074), t3 = V3(0.008, -0.054, -0.082);
  parts.push(tone(ellipsoid(V3(0.028, -0.010, -0.030), 0.017, 0.013, 0.027), SKIN));
  parts.push(tone(capsule(t0, t1, 0.0125), SKIN), tone(capsule(t1, t2, 0.0115), SKIN), tone(capsule(t2, t3, 0.0105), TIP));
  const td = t3.clone().sub(t2).normalize(), out = V3(0, -0.6, -0.8).normalize();
  const side = new THREE.Vector3().crossVectors(td, out).normalize();
  out.crossVectors(side, td).normalize();
  const nail = t2.clone().lerp(t3, 0.72).addScaledVector(out, 0.0092);
  parts.push(tone(ellipsoid(nail, 0.0068, 0.0021, 0.0058, new THREE.Matrix4().makeBasis(td, out, side)), NAIL));
  /* wrist and bare forearm, oval in section */
  const wrist = new THREE.CylinderGeometry(1, 1, 0.055, 18, 1, true);
  wrist.rotateX(Math.PI / 2); wrist.scale(0.030, 0.021, 1); wrist.translate(0, -0.001, 0.022);
  const arm = new THREE.CylinderGeometry(1.32, 1, 0.30, 18, 1, true);
  arm.rotateX(Math.PI / 2); arm.scale(0.030, 0.022, 1); arm.translate(0, 0, 0.19);
  parts.push(tone(wrist, SKIN), tone(arm, SKIN));
  const hg = mergeGeometries(parts, false);
  hg.translate(0, 0, 0.05);            // the fist, not the wrist, at the origin
  const skin = new THREE.Mesh(hg, new THREE.MeshPhysicalMaterial({
    color: 0xc68b64, vertexColors: true, roughness: 0.55, metalness: 0,
    sheen: 0.35, sheenRoughness: 0.55, sheenColor: new THREE.Color(0xffb99c) }));
  /* a sleeve rolled to mid-forearm, wearing the skin */
  const sl = new THREE.CylinderGeometry(0.057, 0.051, 0.37, 16, 1);
  sl.rotateX(Math.PI / 2); sl.translate(0, 0, 0.235 + 0.185);
  const cuff = new THREE.TorusGeometry(0.052, 0.011, 8, 20); cuff.translate(0, 0, 0.235);
  const sleeve = new THREE.Mesh(mergeGeometries([sl, cuff], false), new THREE.MeshStandardMaterial({ color: 0x8c9678, roughness: 0.92 }));
  const group = new THREE.Group();
  group.add(skin, sleeve);
  return { group, skin, sleeve };
}
