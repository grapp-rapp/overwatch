/* ============================================================================
   Soldiers.

   Every operator in the match — you included — is one instance of this class:
   a skinned, rigged, textured humanoid driven by real mocap clips from
   Soldier.glb (Idle / Walk / Run) through a THREE.AnimationMixer.

   On top of that base layer sits a small animation stack, in this order:

     1. mixer         idle <-> walk <-> run crossfade, timeScale locked to the
                      actual ground speed so strides match travel and the feet
                      do not skate.
     2. lower body    the hips yaw toward the velocity vector, so the legs
                      always face where the body is going. This is what makes
                      strafing read correctly from one forward walk cycle.
     3. aim offset    an additive twist distributed up the spine and neck, so
                      the upper body aims independently of the legs.
     4. stance        additive crouch (hip drop + knee/ankle bend).
     5. arm IK        two-bone IK puts the right hand on the weapon grip and the
                      left hand on the foregrip. The weapon itself is parented to
                      the right hand BONE, so it inherits every bit of skeletal
                      motion; the IK just decides where that hand goes.
     6. death         on death the mixer stops and the body falls under a short
                      rigid-body solve while the skeleton relaxes toward a limp
                      pose — nobody blinks out.

   Hitboxes are capsules defined between bone pairs, so hit registration follows
   the animation exactly: a leaning, running target really is a harder shot.
   ========================================================================== */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { meleeCurve, clamp, lerp, damp, dampAngle, wrapPi, makeRng } from '../core/util.js';
import { cloneWeapon, normalizeGeo } from '../weapons/models.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeBlobTexture } from '../world/textures.js';

/* GLTFLoader sanitises node names, so `mixamorig:Hips` arrives as `mixamorigHips`.
   Rather than hard-code either spelling we index bones by their unprefixed
   suffix, which also makes the rig swappable for any other Mixamo export. */
const boneKey = (name) => name.replace(/^mixamorig[:_]?/i, '');
export const TARGET_HEIGHT = 1.80;

/* ---- shared assets ------------------------------------------------------- */
let ASSETS = null;

export async function loadCharacterAssets(onProgress) {
  if (ASSETS) return ASSETS;
  const loader = new GLTFLoader();
  // module-relative so the same code works from /index.html and from /dev/*.html
  const url = new URL('../../assets/models/Soldier.glb', import.meta.url).href;
  const gltf = await new Promise((res, rej) =>
    loader.load(url, res,
      (e) => onProgress && e.total && onProgress(e.loaded / e.total), rej));

  const src = gltf.scene;
  src.updateMatrixWorld(true);

  // --- normalise to real human scale (1.80 m) ---
  const bbox = new THREE.Box3().setFromObject(src);
  const rawH = bbox.max.y - bbox.min.y;
  const scale = TARGET_HEIGHT / rawH;

  const clips = {};
  for (const c of gltf.animations) clips[c.name.toLowerCase()] = c;

  /* Which way does the rig face? Compare the right hip to the pelvis: if the
     model's right side is +X then (right,up) = (+X,+Y) and its natural forward
     is -Z, so the game (which drives yaw with forward = +Z) needs a half turn.
     Detected rather than hard-coded so another Mixamo export drops straight in. */
  const bones = {};
  src.traverse(b => { if (b.isBone) bones[boneKey(b.name)] = b; });
  const wp = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  let yawOffset = Math.PI;
  if (bones.RightUpLeg && bones.Hips) {
    yawOffset = (wp(bones.RightUpLeg).x - wp(bones.Hips).x) > 0 ? Math.PI : 0;
  }

  ASSETS = {
    scene: src,
    scale, yawOffset,
    clips: { idle: clips.idle, walk: clips.walk, run: clips.run, tpose: clips.tpose },
    // Contact shadow. Deliberately dark and fairly tight: it is the cue that
    // stops a soldier reading as floating, and at 52% grey it disappeared
    // entirely against dark asphalt.
    blobTex: makeBlobTexture('rgba(0,0,0,0.96)', 'rgba(0,0,0,0)'),
  };
  return ASSETS;
}

/* ---- gear (helmet, plate carrier, pouches) ------------------------------- */
const GEAR_MATS = {};
function gearMat(key, color, rough, metal) {
  const k = key + color;
  if (!GEAR_MATS[k]) GEAR_MATS[k] = new THREE.MeshStandardMaterial({
    color, roughness: rough ?? 0.78, metalness: metal ?? 0.10,
  });
  return GEAR_MATS[k];
}

function buildHelmet(teamColor, variant) {
  const g = new THREE.Group();
  const shellMat = gearMat('shell', variant ? 0x4a4d3f : 0x3a3d38, 0.72, 0.16);
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.118, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), shellMat);
  shell.scale.set(1.03, 1.10, 1.12);
  g.add(shell);
  // rear brim
  const brim = new THREE.Mesh(new THREE.SphereGeometry(0.122, 16, 8, Math.PI * 0.55, Math.PI * 0.9, Math.PI * 0.42, Math.PI * 0.28), shellMat);
  brim.scale.set(1.02, 1.0, 1.14);
  g.add(brim);
  // rail / NVG mount
  const mount = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.030, 0.026), gearMat('mnt', 0x1c1e1c, 0.6, 0.4));
  mount.position.set(0, 0.052, 0.098); g.add(mount);
  // side rails
  for (const s of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.020, 0.10), gearMat('mnt', 0x1c1e1c, 0.6, 0.4));
    rail.position.set(s * 0.112, 0.012, 0.012); rail.rotation.y = s * 0.12; g.add(rail);
  }
  // team band
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.116, 0.0075, 5, 18, Math.PI * 1.15),
    gearMat('band', teamColor, 0.55, 0.05));
  band.rotation.set(Math.PI / 2, 0, Math.PI * 0.42);
  band.position.y = 0.028; g.add(band);
  // chin strap
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.098, 0.0055, 4, 14, Math.PI * 0.85),
    gearMat('strap', 0x2a2c26, 0.9, 0));
  strap.rotation.set(Math.PI / 2, 0.15, 0); strap.position.set(0, -0.055, 0.008); g.add(strap);
  if (variant) { // goggles pushed up on the brow
    const gog = new THREE.Mesh(new THREE.TorusGeometry(0.100, 0.016, 5, 14, Math.PI * 0.62),
      gearMat('gog', 0x17181a, 0.4, 0.2));
    gog.rotation.set(Math.PI / 2, 0, Math.PI * 0.19); gog.position.set(0, 0.030, 0.026); g.add(gog);
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function buildVest(teamColor, variant) {
  const g = new THREE.Group();
  const cloth = gearMat('vest', variant ? 0x4e4a36 : 0x33372f, 0.90, 0.0);
  const webbing = gearMat('web', 0x24261f, 0.95, 0.0);

  const front = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.34, 0.10), cloth);
  front.position.set(0, 0.045, 0.055);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.34, 0.085), cloth);
  back.position.set(0, 0.045, -0.062);
  const shoulderL = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.055, 0.20), cloth);
  shoulderL.position.set(-0.108, 0.205, -0.005);
  const shoulderR = shoulderL.clone(); shoulderR.position.x = 0.108;
  g.add(front, back, shoulderL, shoulderR);

  // magazine pouches across the front
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.105, 0.055), webbing);
    p.position.set(-0.082 + i * 0.082, -0.055, 0.098);
    g.add(p);
  }
  // radio + admin pouch
  const radio = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.11, 0.045), webbing);
  radio.position.set(0.13, 0.10, -0.055); g.add(radio);
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.003, 0.20, 5), webbing);
  ant.position.set(0.13, 0.24, -0.06); ant.rotation.z = -0.16; g.add(ant);
  // team placard
  const placard = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.045, 0.012),
    gearMat('plac', teamColor, 0.6, 0.0));
  placard.position.set(0, 0.155, 0.104); g.add(placard);
  // shoulder team tape
  for (const s of [-1, 1]) {
    const tape = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.030, 0.13),
      gearMat('plac', teamColor, 0.6, 0.0));
    tape.position.set(s * 0.146, 0.205, -0.005); g.add(tape);
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function buildLegRig(teamColor) {
  const g = new THREE.Group();
  const webbing = gearMat('web', 0x24261f, 0.95, 0.0);
  const holster = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.15, 0.055), webbing);
  holster.position.set(0, -0.12, 0.01);
  g.add(holster);
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.006, 4, 12), webbing);
  strap.rotation.x = Math.PI / 2; strap.position.y = -0.05; g.add(strap);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

/**
 * Collapse a gear group into one mesh per material.
 *
 * A helmet is a dozen little primitives and a plate carrier another dozen. Left
 * as separate meshes that is ~25 draw calls per operator, and with fifteen
 * operators on screen the renderer spends more time issuing calls than drawing.
 * Merging is safe here because gear is rigid: it rides a single bone socket and
 * never deforms.
 */
function mergeGear(group) {
  group.updateMatrixWorld(true);
  const byMat = new Map();
  group.traverse(o => {
    if (!o.isMesh) return;
    const g = normalizeGeo(o.geometry.clone());
    g.applyMatrix4(o.matrixWorld);
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(g);
  });
  const out = new THREE.Group();
  out.name = group.name;
  for (const [mat, geos] of byMat) {
    const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, mat);
    /* Gear does not cast: the body silhouette already does, and dropping the
       gear from the shadow pass halves the per-character cost of it. */
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    out.add(mesh);
  }
  return out;
}

/* ---- two-bone IK --------------------------------------------------------- */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _t = new THREE.Vector3(), _p = new THREE.Vector3();
const _ab = new THREE.Vector3(), _cb = new THREE.Vector3(), _at = new THREE.Vector3(), _ac = new THREE.Vector3();
const _ax0 = new THREE.Vector3(), _ax1 = new THREE.Vector3(), _tmpV = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qw = new THREE.Quaternion();
const _qinv = new THREE.Quaternion();

function angleBetween(u, v) {
  return Math.acos(clamp(u.dot(v), -1, 1));
}

/* A Mixamo armature carries a cm->m scale (~0.01) on the bones, and individual
   bones can differ, so anything socketed to a bone needs that bone's own scale
   divided out or it arrives 100x too small. Measured once, in the bind pose. */
const _dp = new THREE.Vector3(), _dq = new THREE.Quaternion(), _ds = new THREE.Vector3();
export function boneUnitScale(bone) {
  bone.updateWorldMatrix(true, false);
  bone.matrixWorld.decompose(_dp, _dq, _ds);
  return (_ds.x + _ds.y + _ds.z) / 3;
}

const _pq = new THREE.Quaternion();
/** Force an object's world orientation, whatever its parents are doing. */
function setWorldQuaternion(obj, q) {
  obj.parent.updateWorldMatrix(true, false);
  obj.parent.getWorldQuaternion(_pq);
  obj.quaternion.copy(_pq.invert()).multiply(q).normalize();
}

/** Rotate a bone about a world-space axis, safely. Returns false if degenerate. */
function rotateBoneWorldAxis(bone, worldAxis, angle, boneWorldQuat) {
  if (worldAxis.lengthSq() < 1e-12 || !isFinite(angle) || Math.abs(angle) < 1e-7) return false;
  _qinv.copy(boneWorldQuat).invert();
  _tmpV.copy(worldAxis).applyQuaternion(_qinv);
  if (_tmpV.lengthSq() < 1e-12) return false;
  _tmpV.normalize();
  _q1.setFromAxisAngle(_tmpV, angle);
  bone.quaternion.multiply(_q1).normalize();   // normalise: a non-unit quat becomes scale
  boneWorldQuat.multiply(_q1).normalize();
  return true;
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _r0 = new THREE.Quaternion(),
      _r1 = new THREE.Quaternion(), _r2 = new THREE.Quaternion(), _u = new THREE.Vector3(),
      _v = new THREE.Vector3(), _axis = new THREE.Vector3(), _sc = new THREE.Vector3();

/** angleAxis expressed in the local frame of a bone whose world rotation is q. */
function localAxisAngle(out, worldAxis, q, angle) {
  _u.copy(worldAxis).applyQuaternion(_qinv.copy(q).invert());
  if (_u.lengthSq() < 1e-12 || !isFinite(angle)) return out.identity();
  return out.setFromAxisAngle(_u.normalize(), angle);
}

/**
 * Analytic two-bone IK (root -> mid -> end), the standard law-of-cosines solve.
 * `pole` then twists the whole limb about the root->target axis so the elbow
 * points where we want it; because the end effector sits on that axis after the
 * solve, the twist does not disturb the hand placement.
 * Bones must form a direct parent chain. Local quaternions are modified in place.
 */
function solveIK(rootB, midB, endB, target, pole) {
  rootB.updateWorldMatrix(true, false);
  midB.updateWorldMatrix(false, false);
  endB.updateWorldMatrix(false, false);
  _a.setFromMatrixPosition(rootB.matrixWorld);
  _b.setFromMatrixPosition(midB.matrixWorld);
  _c.setFromMatrixPosition(endB.matrixWorld);
  _t.copy(target);

  const lab = _a.distanceTo(_b), lcb = _b.distanceTo(_c);
  if (lab < 1e-5 || lcb < 1e-5) return;
  const lat = clamp(_a.distanceTo(_t), Math.abs(lab - lcb) + 1e-3, lab + lcb - 1e-3);

  _ab.copy(_b).sub(_a).normalize();
  _cb.copy(_c).sub(_b).normalize();
  _ac.copy(_c).sub(_a);
  if (_ac.lengthSq() < 1e-9) _ac.copy(_ab); else _ac.normalize();
  _at.copy(_t).sub(_a);
  if (_at.lengthSq() < 1e-9) return;
  _at.normalize();

  const ac_ab_0 = angleBetween(_ac, _ab);
  const ba_bc_0 = angleBetween(_p.copy(_ab).negate(), _cb);
  const ac_at_0 = angleBetween(_ac, _at);
  const ac_ab_1 = Math.acos(clamp((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat), -1, 1));
  const ba_bc_1 = Math.acos(clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1));

  // current bend-plane normal, and the axis that swings the limb onto the target
  _ax0.copy(_ac).cross(_ab);
  if (_ax0.lengthSq() < 1e-9) {
    _ax0.copy(_ac).cross(_p.copy(pole).sub(_a));
    if (_ax0.lengthSq() < 1e-9) _ax0.set(0, 0, 1);
  }
  _ax0.normalize();
  _ax1.copy(_ac).cross(_at);
  const hasSwing = _ax1.lengthSq() > 1e-9;
  if (hasSwing) _ax1.normalize();

  rootB.matrixWorld.decompose(_p, _qa, _sc);        // a_gr + world scale of the root bone
  midB.matrixWorld.decompose(_v, _qb, _u);          // b_gr

  localAxisAngle(_r0, _ax0, _qa, ac_ab_1 - ac_ab_0);
  localAxisAngle(_r1, _ax0, _qb, ba_bc_1 - ba_bc_0);
  if (hasSwing) localAxisAngle(_r2, _ax1, _qa, ac_at_0); else _r2.identity();

  rootB.quaternion.multiply(_r0).multiply(_r2).normalize();
  midB.quaternion.multiply(_r1).normalize();

  /* ---- pole twist ---- */
  // root's new world rotation, and hence where the elbow landed
  _qw.copy(_qa).multiply(_r0).multiply(_r2).normalize();
  _b.copy(midB.position).multiplyScalar(_sc.x).applyQuaternion(_qw).add(_a);
  _axis.copy(_t).sub(_a);
  if (_axis.lengthSq() < 1e-9) return;
  _axis.normalize();
  _u.copy(_b).sub(_a); _u.addScaledVector(_axis, -_u.dot(_axis));
  _v.copy(pole).sub(_a); _v.addScaledVector(_axis, -_v.dot(_axis));
  if (_u.lengthSq() < 1e-8 || _v.lengthSq() < 1e-8) return;
  _u.normalize(); _v.normalize();
  const twist = Math.atan2(_p.copy(_u).cross(_v).dot(_axis), _u.dot(_v));
  rotateBoneWorldAxis(rootB, _axis, twist, _qw);
}

/* ---- hit zone table ------------------------------------------------------ */
const ZONES = [
  { id: 'head',   a: 'Head',        b: null,        up: 0.135, r: 0.108, kind: 'head' },
  { id: 'neck',   a: 'Neck',        b: 'Head',      r: 0.070, kind: 'upper' },
  { id: 'chest',  a: 'Spine1',      b: 'Neck',      r: 0.185, kind: 'upper' },
  { id: 'gut',    a: 'Hips',        b: 'Spine1',    r: 0.190, kind: 'lower' },
  { id: 'armLU',  a: 'LeftArm',     b: 'LeftForeArm',  r: 0.072, kind: 'limb' },
  { id: 'armLL',  a: 'LeftForeArm', b: 'LeftHand',     r: 0.060, kind: 'limb' },
  { id: 'armRU',  a: 'RightArm',    b: 'RightForeArm', r: 0.072, kind: 'limb' },
  { id: 'armRL',  a: 'RightForeArm',b: 'RightHand',    r: 0.060, kind: 'limb' },
  { id: 'legLU',  a: 'LeftUpLeg',   b: 'LeftLeg',   r: 0.098, kind: 'limb' },
  { id: 'legLL',  a: 'LeftLeg',     b: 'LeftFoot',  r: 0.078, kind: 'limb' },
  { id: 'legRU',  a: 'RightUpLeg',  b: 'RightLeg',  r: 0.098, kind: 'limb' },
  { id: 'legRL',  a: 'RightLeg',    b: 'RightFoot', r: 0.078, kind: 'limb' },
];

/* ---- grip calibration ----------------------------------------------------
   How the hands sit on the weapon, in gun space. GRIP_R/GRIP_L are the rotation
   from "weapon axes" to "hand bone axes"; the hand's world orientation is then
   derived from the aim direction, so the barrel always points exactly where the
   reticle does no matter what the locomotion clip is doing to the arm.
   These are tuned by eye against the render — see qa/ for the reference shots. */
/* Measured from the rig: in hand-bone space +Y runs wrist -> knuckles and -Z is
   the palm normal. So the grip is specified as the gun-space directions those
   two axes should take, which is something you can reason about physically:
   "the fingers wrap forward around the grip, the back of the hand faces left."
   Gun space is +Z muzzle, +Y up, +X the weapon's LEFT. */
export const GRIP = {
  rFingers: [0.30, -0.20, 0.93],    // right hand +Y: forward around the pistol grip
  rBack:    [-0.93, -0.10, 0.35],   // right hand +Z: back of hand faces the gun's right
  rOffset:  [0.0, 0.058, -0.022],   // wrist -> grip, metres, hand space
  lFingers: [-0.90, -0.28, 0.34],   // support hand +Y: across and under the handguard
  lBack:    [-0.34, 0.90, 0.27],    // support hand +Z: back of hand faces up
  lOffset:  [0.0, 0.050, -0.018],
};
const _gripQR = new THREE.Quaternion(), _gripQL = new THREE.Quaternion();
const _gripOR = new THREE.Vector3(), _gripOL = new THREE.Vector3();

/** Build the gun-space -> hand-space rotation from a fingers/back axis pair. */
function gripQuat(fingers, back, out) {
  const y = new THREE.Vector3().fromArray(fingers).normalize();
  const z = new THREE.Vector3().fromArray(back);
  z.addScaledVector(y, -z.dot(y));                 // Gram-Schmidt against the finger axis
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z); // hand -> gun
  return out.setFromRotationMatrix(m).invert();     // gun -> hand
}

export function refreshGrip() {
  gripQuat(GRIP.rFingers, GRIP.rBack, _gripQR);
  gripQuat(GRIP.lFingers, GRIP.lBack, _gripQL);
  _gripOR.fromArray(GRIP.rOffset);
  _gripOL.fromArray(GRIP.lOffset);
}
refreshGrip();

/* spine chain used for the aim offset, with how much of the twist each takes */
const SPINE = [
  { n: 'Spine',  yaw: 0.12, pitch: 0.14 },
  { n: 'Spine1', yaw: 0.18, pitch: 0.20 },
  { n: 'Spine2', yaw: 0.26, pitch: 0.26 },
  { n: 'Neck',   yaw: 0.18, pitch: 0.18 },
  { n: 'Head',   yaw: 0.26, pitch: 0.22 },
];

const LIMP = {
  Spine: [0.10, 0, 0], Spine1: [0.12, 0, 0], Spine2: [0.08, 0, 0],
  Neck: [0.30, 0.2, 0], Head: [0.22, -0.15, 0],
  LeftArm: [0.2, 0, 0.85], RightArm: [0.2, 0, -0.85],
  LeftForeArm: [0, 0, 0.35], RightForeArm: [0, 0, -0.35],
  LeftUpLeg: [-0.25, 0, 0.12], RightUpLeg: [-0.20, 0, -0.14],
  LeftLeg: [0.55, 0, 0], RightLeg: [0.42, 0, 0],
};

/* ============================================================================
   Character
   ========================================================================== */
/* A body lies CORPSE_HOLD seconds, then fades out over CORPSE_FADE; its blood
   stays on the ground well after it (effects.js). */
const CORPSE_HOLD = 2.3, CORPSE_FADE = 0.7;

/* a transparent copy of a material for the corpse fade, made once per operator */
function fadeCopy(F, m) {
  let f = F.get(m);
  if (!f) {
    const ud = m.userData; m.userData = {};            // camo uniforms hold a texture: never JSON it
    f = m.clone(); m.userData = ud;
    f.onBeforeCompile = m.onBeforeCompile; f.customProgramCacheKey = m.customProgramCacheKey;
    f.userData.baseOpacity = m.transparent ? m.opacity : 1;
    f.transparent = true;
    F.set(m, f);
  }
  return f;
}

export class Character {
  /**
   * @param {object} o { team:'A'|'B', variant:int, isLocal:bool, layer:int }
   */
  constructor(o) {
    const A = ASSETS;
    this.team = o.team;
    this.isLocal = !!o.isLocal;
    this.teamColor = o.team === 'A' ? 0x5fbf6b : 0xc8483a;
    this.yawOffset = A.yawOffset;

    /* --- skinned model ------------------------------------------------- */
    this.root = new THREE.Group();
    this.root.name = 'char_' + (o.name || '?');
    this.model = skeletonClone(A.scene);
    this.model.scale.setScalar(A.scale);
    this.root.add(this.model);

    // per-instance material so teams can be tinted without touching the shared map
    const tint = new THREE.Color(o.team === 'A' ? 0x93a08c : 0xa89474);
    this.visorMesh = null;
    this.model.traverse(m => {
      if (!m.isMesh) return;
      // the visor is a separate small sub-mesh; tracked so it can be dropped at range
      if (/visor/i.test(m.name)) this.visorMesh = m;
      m.castShadow = true; m.receiveShadow = true;
      m.frustumCulled = false;   // skinned bounds go stale during animation
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      m.material = mats.map(mm => {
        const c = mm.clone();
        c.color = new THREE.Color(tint);
        c.roughness = Math.min(1, (c.roughness ?? 0.8) * 1.05);
        c.metalness = 0.05;
        return c;
      });
      if (m.material.length === 1) m.material = m.material[0];
      m.userData.ownMaterial = true;   // cloned for this operator; safe to dispose
    });

    /* --- bone lookup ---------------------------------------------------- */
    this.bones = {};          // keyed by unprefixed name, e.g. 'Hips', 'LeftHand'
    this.model.traverse(b => { if (b.isBone) this.bones[boneKey(b.name)] = b; });
    this.bone = (n) => this.bones[n];
    if (!this.bones.Hips) {
      throw new Error('character rig has no Hips bone; found: ' + Object.keys(this.bones).slice(0, 8).join(','));
    }

    this.hips = this.bone('Hips');
    this.spine2 = this.bone('Spine2');
    this.rHand = this.bone('RightHand');
    this.lHand = this.bone('LeftHand');

    /* --- animation ------------------------------------------------------ */
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {
      idle: this.mixer.clipAction(A.clips.idle),
      walk: this.mixer.clipAction(A.clips.walk),
      run: this.mixer.clipAction(A.clips.run),
    };
    for (const k in this.actions) {
      const a = this.actions[k];
      a.play(); a.enabled = true; a.setEffectiveWeight(k === 'idle' ? 1 : 0);
    }
    this.animW = { idle: 1, walk: 0, run: 0 };

    // capture bind-pose local axes for the additive layers
    this.model.updateMatrixWorld(true);
    this._restAxes = {};
    for (const s of SPINE) this._cacheAxes(s.n);
    for (const n of ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot']) this._cacheAxes(n);
    this._restLocal = {};
    for (const k in this.bones) this._restLocal[k] = this.bones[k].quaternion.clone();
    this._hipRestY = this.hips.position.y;

    /* --- gear ------------------------------------------------------------
       Gear is modelled in metres. Bone space is not metres (the armature
       carries a cm scale), so each socket divides out its own bone's scale. */
    const socket = (boneName, name) => {
      const b = this.bone(boneName);
      const inv = 1 / Math.max(1e-6, boneUnitScale(b));
      const g = new THREE.Group();
      g.name = name; g.scale.setScalar(inv);
      b.add(g);
      return g;
    };

    this.headSocket = socket('Head', 'headSocket');
    this.helmet = mergeGear(buildHelmet(this.teamColor, o.variant & 1));
    this.helmet.position.set(0, 0.098, 0.012);
    this.headSocket.add(this.helmet);

    this.chestSocket = socket('Spine2', 'chestSocket');
    this.vest = mergeGear(buildVest(this.teamColor, o.variant & 2));
    this.vest.position.set(0, 0.055, 0);
    this.chestSocket.add(this.vest);

    this.legSocket = socket('RightUpLeg', 'legSocket');
    this.legRig = mergeGear(buildLegRig(this.teamColor));
    this.legSocket.add(this.legRig);

    /* --- weapon socket on the hand bone --------------------------------- */
    this.handSocket = socket('RightHand', 'handSocket');
    this.weaponModel = null;

    /* --- contact shadow -------------------------------------------------- */
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: A.blobTex, transparent: true, opacity: 0.68,
        depthWrite: false, color: 0x000000 }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = -1;
    this.root.add(this.blob);

    /* --- state ---------------------------------------------------------- */
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.groundY = 0;
    this.bodyYaw = 0;      // legs / hips facing
    this.aimYaw = 0;       // where the weapon points
    this.aimPitch = 0;
    this.speed = 0;
    this.crouch = 0;       // 0..1
    this.aimW = 0;         // 0..1 ADS blend
    this.alive = true;
    this.dead = false;
    this.deathT = 0;
    this.deathDir = new THREE.Vector3(0, 0, 1);
    this.deathSpin = 0;
    this.strideAcc = 0;
    this.lastFootstep = 0;
    this.reloadT = 0;      // 0..1 progress through a reload
    this.reloading = false;
    this.sprint = 0;
    this.recoilKick = 0; this.meleeK = 0; this._mc = {};
    this.hitFlash = 0;
    this.lodFar = false;

    if (o.layer) {
      this._layer = o.layer;
      // your own gun can sit on a layer of its own, so first person can show
      // your legs without a second rifle floating under the viewmodel
      this._weaponLayer = o.weaponLayer || o.layer;
      this.model.traverse(m => m.layers.set(o.layer));
    }

    /** Re-apply the grip calibration after live tuning. */
    this.recalcGrip = () => {
      refreshGrip();
      this._arm.qGripRInv.copy(_gripQR).invert();
      this._arm.qGripLInv.copy(_gripQL).invert();
      if (this.weaponModel) {
        this.weaponModel.quaternion.copy(_gripQR);
        this.weaponModel.position.copy(_gripOR);
      }
    };

    // per-instance scratch for the arm solve (no allocation in the hot loop)
    this._arm = {
      fwd: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(),
      chest: new THREE.Vector3(), gripW: new THREE.Vector3(), fgW: new THREE.Vector3(),
      side: new THREE.Vector3(),
      handPos: new THREE.Vector3(), handPosL: new THREE.Vector3(),
      poleR: new THREE.Vector3(), poleL: new THREE.Vector3(),
      basis: new THREE.Matrix4(),
      qW: new THREE.Quaternion(), qHand: new THREE.Quaternion(), qHandL: new THREE.Quaternion(),
      qGripRInv: _gripQR.clone().invert(), qGripLInv: _gripQL.clone().invert(),
    };
    this._qtmp = new THREE.Quaternion();
    this._vtmp = new THREE.Vector3();
    this._rng = makeRng((o.seed || 1) * 2654435761);
  }

  _cacheAxes(name) {
    const b = this.bone(name);
    if (!b) return;
    const wq = new THREE.Quaternion();
    b.getWorldQuaternion(wq);
    const inv = wq.clone().invert();
    this._restAxes[name] = {
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(inv).normalize(),
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(inv).normalize(),
      fwd: new THREE.Vector3(0, 0, 1).applyQuaternion(inv).normalize(),
    };
  }

  /* ---- weapon ------------------------------------------------------------ */
  setWeapon(def) {
    // respawn re-equips the same gun most of the time; rebuilding it is pure waste
    if (def && this.weaponDef === def && this.weaponModel) {
      this.weaponModel.visible = true;
      this.weaponModel.quaternion.copy(_gripQR);
      this.weaponModel.position.copy(_gripOR);
      return;
    }
    if (this.weaponModel) { this.handSocket.remove(this.weaponModel); this.weaponModel = null; }
    if (!def) return;
    this.weaponDef = def;
    this.weaponModel = cloneWeapon(def);
    // Gun space -> hand space. Paired with the hand orientation set in
    // _solveArms this makes the muzzle point exactly along the aim vector.
    this.weaponModel.quaternion.copy(_gripQR);
    this.weaponModel.position.copy(_gripOR);
    if (this._layer) this.weaponModel.traverse(m => m.layers.set(this._weaponLayer));
    this.handSocket.add(this.weaponModel);
    if (this.onWeapon) this.onWeapon(this.weaponModel);   // e.g. the local player's skin
    this.muzzle = this.weaponModel.userData.muzzle;
    this.foreGrip = this.weaponModel.userData.foreGrip;
  }

  getMuzzleWorld(out) {
    if (!this.muzzle) return out.copy(this.pos).setY(this.pos.y + 1.45);
    return this.muzzle.getWorldPosition(out);
  }

  /* ---- damage / death ---------------------------------------------------- */
  kill(fromDir, headshot) {
    if (this.dead) return;
    this.alive = false; this.dead = true; this.deathT = 0;
    this.deathDir.copy(fromDir).setY(0).normalize();
    if (this.deathDir.lengthSq() < 1e-6) this.deathDir.set(0, 0, 1);
    // a slight turn as the body drops; up to 1.6 rad read as the body rolling over
    this.deathSpin = headshot ? this._rng.range(-0.6, 0.6) : this._rng.range(-0.25, 0.25);
    this.deathStyle = headshot ? 2 : (this._rng() < 0.42 ? 1 : 0);  // 0 fwd, 1 back, 2 crumple
    // freeze the mixer and remember the pose we died in
    this._deathPose = {};
    for (const k in this.bones) this._deathPose[k] = this.bones[k].quaternion.clone();
    this._deathHipY = this.hips.position.y;
    for (const k in this.actions) this.actions[k].setEffectiveWeight(0);
    this.deathBaseY = this.groundY;
    this.deathRootQ = this.root.quaternion.clone();
  }

  revive() {
    this.alive = true; this.dead = false; this.deathT = 0;
    this.root.rotation.set(0, this.yawOffset, 0);
    this.root.visible = true;
    this._setFade(1);
    this.hips.position.y = this._hipRestY;
    for (const k in this.bones) this.bones[k].quaternion.copy(this._restLocal[k]);
    this.animW = { idle: 1, walk: 0, run: 0 };
    for (const k in this.actions) {
      this.actions[k].reset(); this.actions[k].play();
      this.actions[k].setEffectiveWeight(k === 'idle' ? 1 : 0);
    }
    this.crouch = 0; this.aimW = 0; this.reloading = false; this.reloadT = 0; this.meleeK = 0;
    if (this.weaponModel) this.weaponModel.visible = true;
  }

  /* ---- per-frame update -------------------------------------------------- */
  /**
   * @param dt        seconds
   * @param cameraPos for LOD
   */
  update(dt, cameraPos) {
    this.root.position.copy(this.pos);

    if (this.dead) { this._updateDeath(dt); return; }

    const distSq = cameraPos ? cameraPos.distanceToSquared(this.pos) : 0;
    this.lodFar = distSq > 34 * 34;
    const doIK = !this.lodFar;
    /* Far operators run the skinning mixer at half rate. At 34 m a soldier is a
       few dozen pixels tall and the interpolation error is invisible, but the
       mixer plus skeleton update is one of the two most expensive things we do
       per character. */
    if (this.lodFar) {
      this._lodAcc = (this._lodAcc || 0) + dt;
      if (this._lodAcc < 1 / 30) { this._lodSkip = true; } else { dt = this._lodAcc; this._lodAcc = 0; this._lodSkip = false; }
      if (this._lodSkip) { this.root.position.copy(this.pos); this.root.rotation.y = this.bodyYaw + this.yawOffset; return; }
    } else this._lodAcc = 0;

    /* --- 1. locomotion blend, tied to real ground speed ----------------- */
    const v = this.vel;
    const spd = Math.hypot(v.x, v.z);
    this.speed = damp(this.speed, spd, 18, dt);

    const WALK_REF = 1.42, RUN_REF = 4.30;   // clip nominal speeds, m/s
    let wIdle = 0, wWalk = 0, wRun = 0, rate = 1;
    if (this.speed < 0.12) {
      wIdle = 1;
    } else if (this.speed < WALK_REF) {
      const t = clamp(this.speed / WALK_REF, 0, 1);
      wIdle = 1 - t; wWalk = t;
      rate = clamp(this.speed / WALK_REF, 0.55, 1.25);
    } else {
      const t = clamp((this.speed - WALK_REF) / (RUN_REF - WALK_REF), 0, 1);
      wWalk = 1 - t; wRun = t;
      rate = lerp(clamp(this.speed / WALK_REF, 0.8, 1.35), clamp(this.speed / RUN_REF, 0.7, 1.5), t);
    }
    // crouched movement uses a shorter, slower stride
    if (this.crouch > 0.1) rate *= lerp(1, 0.80, this.crouch);

    this.animW.idle = damp(this.animW.idle, wIdle, 16, dt);
    this.animW.walk = damp(this.animW.walk, wWalk, 16, dt);
    this.animW.run = damp(this.animW.run, wRun, 16, dt);
    this.actions.idle.setEffectiveWeight(this.animW.idle);
    this.actions.walk.setEffectiveWeight(this.animW.walk);
    this.actions.run.setEffectiveWeight(this.animW.run);
    this.actions.walk.setEffectiveTimeScale(rate);
    this.actions.run.setEffectiveTimeScale(rate);

    this.mixer.update(dt);

    /* --- 2. lower body faces the velocity ------------------------------- */
    let desiredBody = this.aimYaw;
    if (spd > 0.35) {
      const moveYaw = Math.atan2(v.x, v.z);
      // clamp the leg/torso separation to +-72 deg, then let the legs lead
      const rel = wrapPi(moveYaw - this.aimYaw);
      const clamped = clamp(rel, -1.256, 1.256);
      desiredBody = this.aimYaw + clamped;
    }
    const turnRate = spd > 0.35 ? 11 : 5.5;
    this.bodyYaw = dampAngle(this.bodyYaw, desiredBody, turnRate, dt);
    this.root.rotation.y = this.bodyYaw + this.yawOffset;

    /* --- 3. aim offset: twist the spine back toward the aim direction --- */
    const yawErr = clamp(wrapPi(this.aimYaw - this.bodyYaw), -1.35, 1.35);
    const pitch = clamp(this.aimPitch, -0.95, 0.85);
    for (const s of SPINE) {
      const b = this.bone(s.n), ax = this._restAxes[s.n];
      if (!b || !ax) continue;
      this._qtmp.setFromAxisAngle(ax.up, yawErr * s.yaw);
      b.quaternion.multiply(this._qtmp);
      this._qtmp.setFromAxisAngle(ax.right, -pitch * s.pitch);
      b.quaternion.multiply(this._qtmp);
    }
    // lean into a sprint
    if (this.sprint > 0.01) {
      const b = this.bone('Spine'), ax = this._restAxes.Spine;
      this._qtmp.setFromAxisAngle(ax.right, 0.22 * this.sprint);
      b.quaternion.multiply(this._qtmp);
    }
    // flinch when hit
    if (this.hitFlash > 0.001) {
      this.hitFlash = damp(this.hitFlash, 0, 9, dt);
      const b = this.bone('Spine2'), ax = this._restAxes.Spine2;
      this._qtmp.setFromAxisAngle(ax.right, -0.30 * this.hitFlash);
      b.quaternion.multiply(this._qtmp);
    }

    /* --- 4. crouch: drop the hips, bend knees and ankles ----------------- */
    if (this.crouch > 0.002) {
      const c = this.crouch;
      this.hips.position.y = this._hipRestY - (0.42 / ASSETS.scale) * c;
      for (const side of ['Left', 'Right']) {
        const up = this.bone(side + 'UpLeg'), lo = this.bone(side + 'Leg'), ft = this.bone(side + 'Foot');
        const au = this._restAxes[side + 'UpLeg'], al = this._restAxes[side + 'Leg'], af = this._restAxes[side + 'Foot'];
        this._qtmp.setFromAxisAngle(au.right, 0.95 * c); up.quaternion.multiply(this._qtmp);
        this._qtmp.setFromAxisAngle(al.right, -1.55 * c); lo.quaternion.multiply(this._qtmp);
        this._qtmp.setFromAxisAngle(af.right, 0.62 * c); ft.quaternion.multiply(this._qtmp);
      }
      const b = this.bone('Spine'), ax = this._restAxes.Spine;
      this._qtmp.setFromAxisAngle(ax.right, 0.16 * c);
      b.quaternion.multiply(this._qtmp);
    } else {
      this.hips.position.y = this._hipRestY;
    }

    /* --- 5. arms: put the hands on the gun ------------------------------ */
    this.root.updateMatrixWorld(true);
    if (doIK) this._solveArms(dt);

    /* --- 6. contact shadow ---------------------------------------------- */
    const h = Math.max(0, this.pos.y - this.groundY);
    const s = lerp(1.12, 0.62, clamp(this.crouch, 0, 1)) * (1 + h * 0.55);
    this.blob.scale.set(s, s, 1);
    this.blob.position.set(0, this.groundY - this.pos.y + 0.02, 0);
    this.blob.material.opacity = 0.68 * clamp(1 - h * 0.5, 0.10, 1);
    this.blob.rotation.z = -(this.bodyYaw + this.yawOffset);

    /* --- footsteps ------------------------------------------------------- */
    this.strideAcc += spd * dt;
    const stride = this.speed > 3.0 ? 1.62 : this.crouch > 0.5 ? 0.72 : 0.88;
    if (this.strideAcc >= stride && spd > 0.4) {
      this.strideAcc = 0;
      this.footstepPending = true;
    }
  }

  /**
   * Places the weapon by IK-ing the right hand to where the gun should be, then
   * putting the left hand on the foregrip. The gun is a child of the hand bone,
   * so it inherits everything the skeleton does.
   */
  _solveArms(dt) {
    if (!this.weaponModel) return;
    const S = this._arm;
    const aim = this.aimW, cr = this.crouch, sp = this.sprint;

    /* ---- 1. where the weapon wants to be, in world space ----
       `right` is the +X axis of the weapon's own basis. With +Z forward and +Y
       up that axis physically points to the weapon's LEFT, so `side` — the
       operator's actual right — is its negation. Only `right` goes in the
       rotation basis (flipping it would give a mirrored, non-rotation matrix);
       every positional offset uses `side`. */
    const cy = Math.cos(this.aimYaw), sy = Math.sin(this.aimYaw);
    const cp = Math.cos(this.aimPitch), sp2 = Math.sin(this.aimPitch);
    const fwd = S.fwd.set(sy * cp, sp2, cy * cp).normalize();
    const right = S.right.set(cy, 0, -sy);
    const up = S.up.crossVectors(fwd, right).normalize();
    const side = S.side.copy(right).negate();

    this.spine2.updateMatrixWorld(true);
    const chestP = S.chest.setFromMatrixPosition(this.spine2.matrixWorld);

    // carry (hip) -> shouldered (ADS). Sprint tucks it across the body.
    const ox = lerp(0.180, 0.038, aim) - sp * 0.13;
    const oy = lerp(-0.120, 0.150, aim) - cr * 0.02 - sp * 0.05;
    const oz = lerp(0.270, 0.250, aim) - sp * 0.04 - this.recoilKick * 0.06;

    const gripW = S.gripW.copy(chestP)
      .addScaledVector(side, ox).addScaledVector(up, oy).addScaledVector(fwd, oz);
    if (this.reloading) {
      const r = Math.sin(clamp(this.reloadT, 0, 1) * Math.PI);
      gripW.addScaledVector(up, -0.16 * r).addScaledVector(fwd, -0.09 * r).addScaledVector(side, -0.05 * r);
    }
    /* melee: the same wind-up and drive as the viewmodel, so the swing reads in
       third person too — in the killcam, and to anyone watching. */
    if (this.meleeK > 0) {
      const mc = meleeCurve(this.meleeK, this._mc);
      gripW.addScaledVector(fwd, 0.24 * mc.strike - 0.10 * mc.wind)
           .addScaledVector(side, 0.06 * mc.wind - 0.12 * mc.strike)
           .addScaledVector(up, 0.07 * mc.strike - 0.03 * mc.wind);
    }

    /* ---- 2. hand orientation follows from the weapon orientation ---- */
    S.basis.makeBasis(right, up, fwd);
    const weaponQ = S.qW.setFromRotationMatrix(S.basis);           // gun -> world
    const handQ = S.qHand.copy(weaponQ).multiply(S.qGripRInv);     // hand bone -> world

    // The gun's origin sits at GRIP.rOffset in hand space, so back the wrist off.
    const handPos = S.handPos.copy(_gripOR).applyQuaternion(handQ).negate().add(gripW);

    /* ---- 3. solve, then stamp the orientation ---- */
    S.poleR.copy(handPos)
      .addScaledVector(side, 0.50).addScaledVector(up, -0.85).addScaledVector(fwd, -0.30);
    solveIK(this.bone('RightArm'), this.bone('RightForeArm'), this.rHand, handPos, S.poleR);
    setWorldQuaternion(this.rHand, handQ);
    this.rHand.updateMatrixWorld(true);

    /* ---- 4. support hand ---- */
    if (!this.reloading || this.reloadT > 0.70) {
      this.foreGrip.updateMatrixWorld(true);
      const fgW = S.fgW.setFromMatrixPosition(this.foreGrip.matrixWorld);
      const lHandQ = S.qHandL.copy(weaponQ).multiply(S.qGripLInv);
      const lPos = S.handPosL.copy(_gripOL).applyQuaternion(lHandQ).negate().add(fgW);
      S.poleL.copy(lPos)
        .addScaledVector(side, -0.34).addScaledVector(up, -0.90).addScaledVector(fwd, -0.20);
      solveIK(this.bone('LeftArm'), this.bone('LeftForeArm'), this.lHand, lPos, S.poleL);
      setWorldQuaternion(this.lHand, lHandQ);
    } else {
      // mid-reload: the support hand goes to the mag pouches on the vest
      const magPos = S.handPosL.copy(chestP)
        .addScaledVector(side, -0.07).addScaledVector(up, -0.26).addScaledVector(fwd, 0.19);
      S.poleL.copy(magPos).addScaledVector(side, -0.60).addScaledVector(up, -0.50);
      solveIK(this.bone('LeftArm'), this.bone('LeftForeArm'), this.lHand, magPos, S.poleL);
    }
  }

  /** Rigid-body fall + skeletal relax. */
  _updateDeath(dt) {
    this.deathT += dt;
    const t = this.deathT;
    if (t > CORPSE_HOLD + CORPSE_FADE + 0.1) return;   // gone: nothing left to pose
    /* A body drops: it accelerates into the ground and bounces once. Easing to a
       stop instead read as a slow roll. */
    const T = 0.72;
    const k = clamp(t / T, 0, 1);
    let e = k * k * (1.35 - 0.35 * k);
    if (t > T) e = 1 + Math.sin(Math.min(1, (t - T) / 0.22) * Math.PI) * 0.035;

    const fallAxis = this._vtmp.set(this.deathDir.z, 0, -this.deathDir.x).normalize();
    const dir = this.deathStyle === 1 ? -1 : 1;
    const q = new THREE.Quaternion().setFromAxisAngle(fallAxis, dir * 1.50 * e);
    const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.deathSpin * e);
    this.root.quaternion.copy(this.deathRootQ).multiply(spin).multiply(q);

    // slide down so the body ends flat on the ground, and drift with momentum
    const drop = -0.78 * e;
    this.root.position.set(
      this.pos.x + this.deathDir.x * 0.30 * e * dir,
      this.groundY + Math.max(0, this.pos.y - this.groundY) * (1 - e) + drop * 0 + 0.02,
      this.pos.z + this.deathDir.z * 0.30 * e * dir);
    this.root.position.y = this.groundY + lerp(0, 0.10, e);

    // relax the skeleton toward the limp pose
    const relax = clamp(t / 0.55, 0, 1);
    for (const name in LIMP) {
      const b = this.bone(name);
      if (!b) continue;
      const target = this._qtmp.setFromEuler(
        new THREE.Euler(LIMP[name][0], LIMP[name][1], LIMP[name][2]));
      target.premultiply(this._restLocal[name]);
      b.quaternion.copy(this._deathPose[name]).slerp(target, relax * 0.85);
    }
    this.hips.position.y = lerp(this._deathHipY, this._hipRestY - 0.22 / ASSETS.scale, relax);

    this.blob.scale.set(1.7, 1.7, 1);
    this.blob.position.y = this.groundY - this.root.position.y + 0.02;
    // the body is gone a few seconds later; its blood is not
    const fade = clamp(1 - (t - CORPSE_HOLD) / CORPSE_FADE, 0, 1);
    this.blob.material.opacity = 0.45 * fade;
    this._setFade(fade);
    if (fade <= 0) this.root.visible = false;
  }

  /* Corpse fade. Transparent copies of this operator's materials are swapped
     in only while it fades (made once, kept), so the gear and weapon materials
     every operator shares never change and nobody alive pays for blending. */
  _setFade(k) {
    if (k >= 1) {
      if (!this._faded) return;
      this._faded = false;
      this.root.traverse(o => { if (o._solid) { o.material = o._solid; o._solid = null; } });
      return;
    }
    const F = this._fadeMats || (this._fadeMats = new Map());
    this._faded = true;
    this.root.traverse(o => {
      if (!o.isMesh || o === this.blob) return;
      if (!o._solid) {
        o._solid = o.material;
        o.material = Array.isArray(o.material) ? o.material.map(m => fadeCopy(F, m)) : fadeCopy(F, o.material);
      }
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.opacity = m.userData.baseOpacity * k;
    });
  }

  /* ---- hit registration --------------------------------------------------- */
  /**
   * Ray vs. the animated capsule set.
   * Returns { t, zone, kind, point } for the nearest hit, or null.
   */
  raycastZones(ox, oy, oz, dx, dy, dz, maxT, out) {
    if (!this.alive) return null;
    // cheap reject: bounding sphere around the body
    const cx = this.pos.x, cy = this.pos.y + 0.95, cz = this.pos.z;
    const R = 1.30;
    const mx = cx - ox, my = cy - oy, mz = cz - oz;
    const proj = mx * dx + my * dy + mz * dz;
    if (proj < -R || proj > maxT + R) return null;
    const d2 = (mx * mx + my * my + mz * mz) - proj * proj;
    if (d2 > R * R) return null;

    let best = null, bestT = maxT;
    let bestCore = null, bestCoreT = maxT;   // head / torso hits, tracked separately
    for (const z of ZONES) {
      const ba = this.bone(z.a);
      if (!ba) continue;
      ba.getWorldPosition(_a);
      if (z.b) { const bb = this.bone(z.b); if (!bb) continue; bb.getWorldPosition(_b); }
      else { _b.copy(_a); _b.y += z.up; }
      const t = rayCapsule(ox, oy, oz, dx, dy, dz, _a, _b, z.r, maxT);
      if (t === null) continue;
      if (t < bestT) { bestT = t; best = z; }
      if (z.kind !== 'limb' && t < bestCoreT) { bestCoreT = t; bestCore = z; }
    }
    if (!best) return null;
    /* An operator carries the weapon across the chest, so a clean centre-mass
       shot geometrically strikes the forearm first. Awarding that the limb
       multiplier makes the same aim produce two different time-to-kills for no
       reason the shooter can see. If a head or torso capsule lies just behind
       the limb, the round is credited to it. */
    if (best.kind === 'limb' && bestCore && bestCoreT - bestT < 0.42) {
      best = bestCore; bestT = bestCoreT;
    }
    const o = out || {};
    o.t = bestT; o.zone = best.id; o.kind = best.kind;
    o.px = ox + dx * bestT; o.py = oy + dy * bestT; o.pz = oz + dz * bestT;
    return o;
  }

  dispose() {
    this.root.removeFromParent();
    // the weapon's geometry belongs to the shared prototype — detach, never free
    if (this.weaponModel) { this.weaponModel.removeFromParent(); this.weaponModel = null; }
    /* Free only what this instance owns. The body materials are cloned per
       character so they can be tinted per faction and are ours to dispose; the
       gear materials come from a shared cache (`gearMat`) and the blob texture
       is shared across every operator — freeing either would blank the gear on
       every character created afterwards. */
    this.model.traverse(m => {
      if (!m.isMesh) return;
      m.geometry && m.geometry.dispose();
      if (m.userData.ownMaterial) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        mats.forEach(x => x && x.dispose());
      }
    });
    this.blob.geometry.dispose();   // material's map is the shared blob texture
  }
}

/* ---- ray vs capsule (segment A-B, radius r) ------------------------------ */
const _sa = new THREE.Vector3(), _sb = new THREE.Vector3();
function rayCapsule(ox, oy, oz, dx, dy, dz, A, Bp, r, maxT) {
  const ax = Bp.x - A.x, ay = Bp.y - A.y, az = Bp.z - A.z;
  const mx = ox - A.x, my = oy - A.y, mz = oz - A.z;
  const aa = ax * ax + ay * ay + az * az;
  const ad = ax * dx + ay * dy + az * dz;
  const am = ax * mx + ay * my + az * mz;
  const mm = mx * mx + my * my + mz * mz;
  const md = mx * dx + my * dy + mz * dz;

  if (aa < 1e-9) { // degenerate: sphere
    const b = md, c = mm - r * r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return (t >= 0 && t <= maxT) ? t : null;
  }

  const a = aa - ad * ad;
  const b = aa * md - am * ad;
  const c = aa * (mm - r * r) - am * am;

  if (Math.abs(a) > 1e-9) {
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      if (t >= 0 && t <= maxT) {
        const s = am + t * ad;
        if (s >= 0 && s <= aa) return t;      // hit the cylindrical body
      }
    }
  }
  // endcaps
  let best = null;
  for (const P of [A, Bp]) {
    const px = ox - P.x, py = oy - P.y, pz = oz - P.z;
    const bb = px * dx + py * dy + pz * dz;
    const cc = px * px + py * py + pz * pz - r * r;
    const disc = bb * bb - cc;
    if (disc < 0) continue;
    const t = -bb - Math.sqrt(disc);
    if (t >= 0 && t <= maxT && (best === null || t < best)) best = t;
  }
  return best;
}
