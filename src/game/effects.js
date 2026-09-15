/* ============================================================================
   Visual effects: everything pooled, nothing allocated per shot.

   - particles   two Points systems, 1600 slots, GPU-side ageing via a shader
   - tracers     one LineSegments buffer, 96 slots, alpha by remaining life
   - decals      one InstancedMesh of quads, 160 slots, oldest recycled
   - casings     one InstancedMesh with a cheap ballistic + bounce integrator
   - flashes     4 shared point lights, round-robin
   - sprites     20 shared additive billboards for muzzle flash and fireballs

   Particle attribute buffers upload only the slots written that frame; flagging
   the whole system dirty on every shot was ~180 KB of traffic per frame.
   ========================================================================== */
import * as THREE from 'three';
import { makeRng, clamp, lerp } from '../core/util.js';
import { makeBlobTexture, makeFlashTexture, makeImpactTexture, makeBloodAtlas, makePoolTexture } from '../world/textures.js';

const rng = makeRng(0xEFFEC7);

/* Blood. A splatter or drip is gone BLOOD_LIFE seconds after it lands, fading
   over the last BLOOD_FADE. A pool under a body spreads for POOL_SPREAD s,
   dries (darker, duller) between POOL_DRY[0] and POOL_DRY[1] s, and fades out
   over the last POOL_FADE s of its POOL_LIFE. Atlas tile offsets are in UV
   space (the canvas is flipped). */
const BLOOD_LIFE = 12.0, BLOOD_FADE = 5.0;
const POOL_LIFE = 45, POOL_SPREAD = 7.5, POOL_DRY = [8, 32], POOL_FADE = 20;
const BLOOD_TILES = [[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]];

/* a pool's colour, in place of three's map chunk: inside where the front has
   passed (sharp, anti-aliased edge), thin and red at the front, deep and near
   black behind it, browning as it dries */
const POOL_FRAG = `
  vec4 pTex = texture2D( map, vMapUv );
  float pW = max( fwidth( pTex.r ) * 1.5, 0.004 );
  float pIn = 1.0 - smoothstep( vPool.x - pW, vPool.x + pW * 0.5, pTex.r );
  float pDepth = clamp( ( vPool.x - pTex.r ) * 5.0, 0.0, 1.0 );
  vec3 pWet = mix( vec3( 0.32, 0.014, 0.012 ), vec3( 0.060, 0.003, 0.003 ), pDepth );
  vec3 pCol = mix( pWet, vec3( 0.040, 0.010, 0.007 ), vPool.z ) * ( 0.82 + 0.36 * pTex.g );
  diffuseColor = vec4( pCol, pIn * mix( 0.58, 0.97, pDepth ) * vPool.y );
`;

/* ---- particle shader ----------------------------------------------------- */
const PARTICLE_VS = `
attribute vec3 vel;
attribute vec4 born;     // x: t0, y: life, z: size0, w: size1
attribute vec4 col0;
attribute vec4 col1;
attribute float grav;
uniform float uTime;
uniform float uPixelScale;
varying vec4 vColor;
void main() {
  float age = uTime - born.x;
  float k = age / born.y;
  if (k < 0.0 || k > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec4(0.0); return; }
  vec3 drag = vel * (1.0 - exp(-age * 2.2)) / 2.2;
  vec3 p = position + drag + vec3(0.0, -0.5 * grav * age * age, 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float sz = mix(born.z, born.w, k);
  gl_PointSize = max(1.0, sz * uPixelScale / max(0.15, -mv.z));
  vColor = mix(col0, col1, k);
}`;
const ATTRS = ['position', 'vel', 'born', 'col0', 'col1', 'grav'];

const PARTICLE_FS = `
varying vec4 vColor;
uniform sampler2D uMap;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor.rgb, vColor.a * t.a);
  if (gl_FragColor.a < 0.01) discard;
}`;

class Particles {
  constructor(scene, max, texture, blending) {
    this.max = max; this.i = 0; this.time = 0;
    this._n = 0; this._start = 0;   // range of slots written this frame
    const g = new THREE.BufferGeometry();
    const zeros = (n, k) => new THREE.BufferAttribute(new Float32Array(max * k), k).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', zeros(max, 3));
    g.setAttribute('vel', zeros(max, 3));
    g.setAttribute('born', zeros(max, 4));
    g.setAttribute('col0', zeros(max, 4));
    g.setAttribute('col1', zeros(max, 4));
    g.setAttribute('grav', zeros(max, 1));
    // park everything off-screen until used
    const b = g.attributes.born.array;
    for (let i = 0; i < max; i++) { b[i * 4] = -1000; b[i * 4 + 1] = 1; }
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uMap: { value: texture }, uPixelScale: { value: 600 } },
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS,
      transparent: true, depthWrite: false, blending: blending ?? THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);
  }
  spawn(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, grav) {
    const i = this.i; this.i = (this.i + 1) % this.max;
    if (this._n === 0) this._start = i;   // first write of the frame
    this._n++;
    const g = this.geo.attributes;
    g.position.array[i * 3] = x; g.position.array[i * 3 + 1] = y; g.position.array[i * 3 + 2] = z;
    g.vel.array[i * 3] = vx; g.vel.array[i * 3 + 1] = vy; g.vel.array[i * 3 + 2] = vz;
    const b = g.born.array;
    b[i * 4] = this.time; b[i * 4 + 1] = life; b[i * 4 + 2] = s0; b[i * 4 + 3] = s1;
    g.col0.array.set(c0, i * 4); g.col1.array.set(c1, i * 4);
    g.grav.array[i] = grav;
    // (_n/_start above record the dirty range; no whole-buffer flag needed)
  }
  /**
   * Push only the slots that were written this frame.
   *
   * Flagging all six attributes dirty re-uploads the whole system every frame a
   * shot is fired — for 2400 particles that is about 180 KB of PCIe traffic per
   * frame to change a handful of entries. Spawns are sequential in a ring, so
   * the touched region is almost always a short contiguous run; only a
   * wrap-around needs the full upload.
   */
  update(dt) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    if (this._n === 0) return;
    const n = this._n, start = this._start;
    // spawns are sequential, so the frame's writes are one run unless the ring
    // wrapped past the end — in that case just push the whole buffer
    const full = n >= this.max || start + n > this.max;
    for (const k of ATTRS) {
      const at = this.geo.attributes[k];
      if (at.clearUpdateRanges) at.clearUpdateRanges();
      if (full) {
        if (at.updateRange) { at.updateRange.offset = 0; at.updateRange.count = -1; }
      } else {
        const off = start * at.itemSize, cnt = n * at.itemSize;
        if (at.addUpdateRange) at.addUpdateRange(off, cnt);
        else if (at.updateRange) { at.updateRange.offset = off; at.updateRange.count = cnt; }
      }
      at.needsUpdate = true;
    }
    this._n = 0;
  }
}

/* ---- main effects manager ------------------------------------------------ */
export class Effects {
  constructor(scene, audio) {
    this.scene = scene;
    this.audio = audio;
    this.soft = makeBlobTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 64);
    this.flashTex = makeFlashTexture();
    this.impactTex = makeImpactTexture();

    this.sparks = new Particles(scene, 900, this.soft, THREE.AdditiveBlending);
    this.debris = new Particles(scene, 700, this.soft, THREE.NormalBlending);

    /* ---- tracers ---- */
    this.TR = 96;
    this.trGeo = new THREE.BufferGeometry();
    this.trPos = new Float32Array(this.TR * 6);
    this.trCol = new Float32Array(this.TR * 6);
    this.trGeo.setAttribute('position', new THREE.BufferAttribute(this.trPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.trGeo.setAttribute('color', new THREE.BufferAttribute(this.trCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracerMesh = new THREE.LineSegments(this.trGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.renderOrder = 5;
    scene.add(this.tracerMesh);
    this.tracers = [];
    for (let i = 0; i < this.TR; i++) this.tracers.push({ live: false, i });
    this.trFree = this.tracers.slice();

    /* ---- decals ---- */
    this.DC = 160;
    const dgeo = new THREE.PlaneGeometry(1, 1);
    this.decalMat = new THREE.MeshBasicMaterial({
      map: this.impactTex, transparent: true, depthWrite: false, opacity: 0.9,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.decals = new THREE.InstancedMesh(dgeo, this.decalMat, this.DC);
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 2;
    this.decals.count = this.DC;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.DC; i++) this.decals.setMatrixAt(i, zero);
    scene.add(this.decals);
    this.dcIdx = 0;

    /* ---- blood decals ----
       Kept apart from the bullet holes because blood is lit and wet: a standard
       material at low roughness, so it goes dark in shade and catches a sheen in
       the sun, where an unlit decal would glow. Per-instance fade and atlas tile
       are injected into the standard shader rather than writing a new one, so
       fog, tone mapping and shadows stay consistent with the world. */
    this.blood = true;
    this.map = null;
    this.BN = 128;
    const bgeo = new THREE.PlaneGeometry(1, 1);
    this.bFade = new THREE.InstancedBufferAttribute(new Float32Array(this.BN), 1).setUsage(THREE.DynamicDrawUsage);
    this.bTile = new THREE.InstancedBufferAttribute(new Float32Array(this.BN * 2), 2).setUsage(THREE.DynamicDrawUsage);
    bgeo.setAttribute('aFade', this.bFade);
    bgeo.setAttribute('aTile', this.bTile);
    this.bloodMat = new THREE.MeshStandardMaterial({
      map: makeBloodAtlas(), transparent: true, depthWrite: false,
      roughness: 0.26, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
    });
    this.bloodMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aFade;\nattribute vec2 aTile;\nvarying float vFade;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = vMapUv * 0.5 + aTile;\nvFade = aFade;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vFade;');
    };
    this.bloodMesh = new THREE.InstancedMesh(bgeo, this.bloodMat, this.BN);
    this.bloodMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bloodMesh.frustumCulled = false;
    this.bloodMesh.renderOrder = 3;
    this.bloodMesh.receiveShadow = true;
    for (let i = 0; i < this.BN; i++) this.bloodMesh.setMatrixAt(i, zero);
    scene.add(this.bloodMesh);
    this.bSlots = [];
    for (let i = 0; i < this.BN; i++) {
      this.bSlots.push({ i, live: false, t: 0, grow: 0, size: 1, stretch: 1, alpha: 1,
        p: new THREE.Vector3(), q: new THREE.Quaternion() });
    }
    this.bIdx = 0; this.bLive = 0;

    /* ---- blood pools ----
       A body's blood does not appear at full size: it runs out from under the
       body along a ragged front, and the edge stays sharp as it spreads (a
       decal scaled up blurs its edge with it). The spread is in the shader:
       the texture stores when the front reaches each texel, and each pool
       carries how far its front has got. Fresh blood is glossy - red at the
       thin edge, near black where it is deep - then dries darker and duller,
       and fades. */
    this.PN = 24;
    const pgeo = new THREE.PlaneGeometry(1, 1);
    this.pAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.PN * 3), 3).setUsage(THREE.DynamicDrawUsage);
    pgeo.setAttribute('aPool', this.pAttr);          // x: front 0..1, y: opacity, z: dryness
    this.poolMat = new THREE.MeshStandardMaterial({
      map: makePoolTexture(), transparent: true, depthWrite: false, roughness: 0.2, metalness: 0,
      envMapIntensity: 0.45,              // a wet sheen, not a mirror of the sky that drowns the red
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.poolMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>' + String.fromCharCode(10) + 'attribute vec3 aPool; varying vec3 vPool;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>' + String.fromCharCode(10) + 'vPool = aPool;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>' + String.fromCharCode(10) + 'varying vec3 vPool;')
        .replace('#include <map_fragment>', POOL_FRAG)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix( 0.16, 0.66, vPool.z ) + ( 1.0 - pDepth ) * 0.12;');
    };
    this.poolMat.customProgramCacheKey = () => 'blood-pool-v1';
    this.poolMesh = new THREE.InstancedMesh(pgeo, this.poolMat, this.PN);
    this.poolMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.poolMesh.frustumCulled = false;
    this.poolMesh.renderOrder = 2;
    this.poolMesh.receiveShadow = true;
    for (let i = 0; i < this.PN; i++) this.poolMesh.setMatrixAt(i, zero);
    scene.add(this.poolMesh);
    this.pools = [];
    for (let i = 0; i < this.PN; i++) this.pools.push({ i, live: false, t: 0, x: 0, z: 0, reach: 0 });
    this.pIdx = 0; this.pLive = 0;
    this._pp = new THREE.Vector3(); this._pq = new THREE.Quaternion();

    /* ---- shell casings ---- */
    this.SH = 56;
    const shGeo = new THREE.CylinderGeometry(0.0045, 0.005, 0.024, 6);
    shGeo.rotateZ(Math.PI / 2);
    this.shellMesh = new THREE.InstancedMesh(shGeo,
      new THREE.MeshStandardMaterial({ color: 0xc09b46, roughness: 0.32, metalness: 1.0 }), this.SH);
    this.shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shellMesh.frustumCulled = false;
    this.shellMesh.castShadow = false;
    for (let i = 0; i < this.SH; i++) this.shellMesh.setMatrixAt(i, zero);
    scene.add(this.shellMesh);
    this.shells = [];
    for (let i = 0; i < this.SH; i++) this.shells.push({ live: false, t: 0,
      p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(),
      w: new THREE.Vector3(), i });
    this.shIdx = 0;

    /* ---- lights ---- */
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      /* always visible, dark when idle: hiding a light changes the scene's light
         count, and every lit material then recompiles for the new count - the
         two-second freezes in a fight, 60 programs compiled mid-match */
      const L = new THREE.PointLight(0xffcc77, 0, 9, 2);
      scene.add(L);
      this.lights.push({ L, t: 0, dur: 0, peak: 0, on: false });
    }
    this.lIdx = 0;

    /* ---- billboards (muzzle flash / fireball) ---- */
    this.SP = 20;
    this.sprites = [];
    for (let i = 0; i < this.SP; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flashTex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0 }));
      m.visible = false; m.renderOrder = 7;
      scene.add(m);
      this.sprites.push({ m, t: 0, dur: 0, s0: 1, s1: 1, rot: 0, live: false });
    }
    this.spIdx = 0;

    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4(); this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /* ------------------------------------------------------------------ */
  muzzleFlash(pos, dir, scale = 1, layer = 0) {
    const s = this.sprites[this.spIdx = (this.spIdx + 1) % this.SP];
    s.m.position.copy(pos).addScaledVector(dir, 0.10 * scale);
    s.m.material.rotation = rng() * Math.PI * 2;
    s.m.material.opacity = 1;
    s.m.visible = true; s.live = true; s.t = 0; s.dur = 0.055;
    s.s0 = 0.42 * scale; s.s1 = 0.26 * scale;
    s.m.layers.set(layer);
    s.m.scale.setScalar(s.s0);

    const l = this.lights[this.lIdx = (this.lIdx + 1) % 4];
    l.L.position.copy(pos).addScaledVector(dir, 0.3);
    l.L.color.setHex(0xffbb66);
    l.L.distance = 11 * scale;
    l.peak = 14 * scale; l.dur = 0.06; l.t = 0; l.on = true;

    // burning powder
    for (let i = 0; i < 4; i++) {
      this.sparks.spawn(pos.x, pos.y, pos.z,
        dir.x * rng.range(3, 9) + rng.gauss() * 1.6,
        dir.y * rng.range(3, 9) + rng.gauss() * 1.6,
        dir.z * rng.range(3, 9) + rng.gauss() * 1.6,
        rng.range(0.10, 0.22), 0.045, 0.005,
        [1, 0.78, 0.32, 1], [1, 0.30, 0.06, 0], 4);
    }
  }

  tracer(from, to, speed, colour) {
    if (!this.trFree.length) return;
    const t = this.trFree.pop();
    t.live = true;
    t.from = t.from || new THREE.Vector3();
    t.to = t.to || new THREE.Vector3();
    t.from.copy(from); t.to.copy(to);
    t.len = from.distanceTo(to);
    t.trail = clamp(t.len * 0.35, 1.2, 6.5);
    t.d = this._v.copy(to).sub(from).normalize().clone();
    t.travelled = 0;
    t.speed = speed;
    t.col = colour || [1.0, 0.72, 0.28];
    t.fade = 1;
  }

  impact(pos, normal, surface, big) {
    /* decal */
    const i = this.dcIdx = (this.dcIdx + 1) % this.DC;
    this._q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this._v.copy(normal));
    const sc = (big ? 0.5 : 0.16) * rng.range(0.8, 1.35);
    this._m.compose(this._v.copy(pos).addScaledVector(normal, 0.012), this._q, this._s.set(sc, sc, sc));
    this.decals.setMatrixAt(i, this._m);
    this.decals.instanceMatrix.needsUpdate = true;

    /* sparks + dust, coloured by surface */
    const P = {
      concrete: { spark: 3, dust: 9, dc: [0.72, 0.68, 0.60], sc: [1, 0.85, 0.5] },
      metal:    { spark: 12, dust: 3, dc: [0.6, 0.6, 0.62], sc: [1, 0.92, 0.65] },
      wood:     { spark: 2, dust: 8, dc: [0.52, 0.38, 0.22], sc: [1, 0.7, 0.35] },
      dirt:     { spark: 0, dust: 14, dc: [0.62, 0.52, 0.34], sc: [1, 0.8, 0.4] },
      glass:    { spark: 8, dust: 5, dc: [0.8, 0.88, 0.92], sc: [0.9, 0.98, 1] },
      flesh:    { spark: 0, dust: 0, dc: [0.5, 0.05, 0.05], sc: [0.7, 0.05, 0.05] },
    }[surface] || { spark: 3, dust: 8, dc: [0.7, 0.66, 0.6], sc: [1, 0.85, 0.5] };

    for (let k = 0; k < P.spark; k++) {
      const sx = normal.x * rng.range(1, 6) + rng.gauss() * 2.4;
      const sy = normal.y * rng.range(1, 6) + rng.gauss() * 2.4 + 1.4;
      const sz = normal.z * rng.range(1, 6) + rng.gauss() * 2.4;
      this.sparks.spawn(pos.x, pos.y, pos.z, sx, sy, sz,
        rng.range(0.18, 0.52), 0.020, 0.004,
        [P.sc[0], P.sc[1], P.sc[2], 1], [0.9, 0.25, 0.05, 0], 9);
    }
    for (let k = 0; k < P.dust; k++) {
      const sx = normal.x * rng.range(0.4, 2.2) + rng.gauss() * 0.8;
      const sy = normal.y * rng.range(0.4, 2.2) + rng.gauss() * 0.8 + 0.5;
      const sz = normal.z * rng.range(0.4, 2.2) + rng.gauss() * 0.8;
      this.debris.spawn(pos.x, pos.y, pos.z, sx, sy, sz,
        rng.range(0.35, 0.9), 0.05, 0.34,
        [P.dc[0], P.dc[1], P.dc[2], 0.55], [P.dc[0], P.dc[1], P.dc[2], 0], 1.2);
    }
  }

  /* ------------------------------------------------------------------ blood */

  /**
   * A round (or a rifle butt) meets a body.
   *
   * With blood on: a short mist back toward the shooter at the entry, a cone of
   * droplets out along the travel that falls under gravity, a splatter decal on
   * whatever surface is behind the target inside 2.4 m, stretched along the
   * travel so a grazing wall gets a streak and a square hit gets a burst, and
   * drips on the ground below. Everything it leaves is gone in BLOOD_LIFE s.
   *
   * With blood off: a small grey puff of fabric, so a hit still reads.
   */
  bloodHit(pos, dir, headshot) {
    if (!this.blood) {
      for (let i = 0; i < 5; i++) {
        this.debris.spawn(pos.x, pos.y, pos.z,
          dir.x * rng.range(0.4, 1.4) + rng.gauss() * 0.5, rng.gauss() * 0.5 + 0.4,
          dir.z * rng.range(0.4, 1.4) + rng.gauss() * 0.5,
          rng.range(0.25, 0.45), 0.05, 0.16,
          [0.46, 0.44, 0.40, 0.45], [0.40, 0.38, 0.35, 0], 0.8);
      }
      return;
    }
    const big = headshot ? 1.7 : 1;
    for (let i = 0; i < 6 * big; i++) {
      this.debris.spawn(pos.x, pos.y, pos.z,
        -dir.x * rng.range(0.3, 1.2) + rng.gauss() * 0.5, rng.gauss() * 0.5 + 0.3,
        -dir.z * rng.range(0.3, 1.2) + rng.gauss() * 0.5,
        rng.range(0.18, 0.35), 0.06, 0.20,
        [0.36, 0.02, 0.02, 0.50], [0.22, 0.01, 0.01, 0], 1.5);
    }
    for (let i = 0; i < 16 * big; i++) {
      const s = rng.range(1.5, 6.0);
      this.debris.spawn(pos.x, pos.y, pos.z,
        dir.x * s + rng.gauss() * 1.1, dir.y * s + rng.gauss() * 1.0 + 0.5,
        dir.z * s + rng.gauss() * 1.1,
        rng.range(0.35, 0.75), rng.range(0.018, 0.04), 0.010,
        [0.40, 0.02, 0.02, 0.95], [0.20, 0.01, 0.01, 0.6], 9.8);
    }
    for (let i = 0; i < 5 * big; i++) {
      this.debris.spawn(pos.x, pos.y, pos.z,
        dir.x * rng.range(0.6, 2.0) + rng.gauss() * 0.6, rng.gauss() * 0.5 + 0.2,
        dir.z * rng.range(0.6, 2.0) + rng.gauss() * 0.6,
        rng.range(0.4, 0.8), 0.08, 0.34,
        [0.30, 0.02, 0.02, 0.35], [0.20, 0.01, 0.01, 0], 0.6);
    }
    if (!this.map) return;
    const M = this.map, h = this._bh || (this._bh = {});
    for (let k = 0; k < (headshot ? 2 : 1); k++) {
      const jx = dir.x + rng.gauss() * 0.12, jy = dir.y + rng.gauss() * 0.10 - 0.08, jz = dir.z + rng.gauss() * 0.12;
      const jl = Math.hypot(jx, jy, jz) || 1;
      const wh = M.raycast(pos.x, pos.y, pos.z, jx / jl, jy / jl, jz / jl, 2.4, h);
      if (!wh || wh.surface === 'glass') continue;
      const graze = 1 - Math.abs((jx * wh.nx + jy * wh.ny + jz * wh.nz) / jl);
      const falloff = 1 - (wh.t / 2.4) * 0.5;
      this._bloodDecal(wh.px, wh.py, wh.pz, wh.nx, wh.ny, wh.nz, graze > 0.45 ? 1 : 0,
        rng.range(0.42, 0.70) * big * falloff, 1 + graze * 1.6, jx, jy, jz, 0, 0.92);
    }
    const gd = M.raycast(pos.x + dir.x * 0.25, pos.y, pos.z + dir.z * 0.25, 0, -1, 0, 3.0, h);
    if (gd) {
      this._bloodDecal(gd.px, gd.py, gd.pz, gd.nx, gd.ny, gd.nz, 3,
        rng.range(0.28, 0.44) * big, 1, rng.gauss(), 0, rng.gauss(), 0, 0.85);
    }
  }

  /**
   * A body has come to rest: its blood runs out from under it. `scale` 1 is the
   * body, about 0.55 a head wound. It spreads only as far as the ground stays
   * level, so a pool never hangs off a ledge or runs up a wall.
   */
  bloodPool(pos, scale = 1) {
    if (!this.blood || !this.map) return;
    const h = this._bh || (this._bh = {});
    const g = this.map.raycast(pos.x, pos.y + 0.4, pos.z, 0, -1, 0, 2.5, h);
    if (!g || g.ny < 0.6) return;
    const gx = g.px, cy = g.py, gz = g.pz;
    const n = (this._bn || (this._bn = new THREE.Vector3())).set(g.nx, g.ny, g.nz).normalize();
    let cx = gx, cz = gz, reach = this._poolReach(gx, cy, gz, scale);
    if (reach < 0.64 * scale) {
      /* up against a crate or a wall: let it run out on the open side instead */
      const off = 0.28 * scale;
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4, x = gx + Math.cos(a) * off, z = gz + Math.sin(a) * off;
        const r = this._poolReach(x, cy, z, scale);
        if (r > reach) { reach = r; cx = x; cz = z; }
      }
    }
    reach = Math.max(reach, 0.14 * scale);
    const P = this.pools[this.pIdx = (this.pIdx + 1) % this.PN];
    if (!P.live) this.pLive++;
    P.live = true; P.t = 0; P.x = cx; P.z = cz; P.reach = reach;
    const ang = rng() * Math.PI * 2;
    const x = (this._bx || (this._bx = new THREE.Vector3())).set(Math.cos(ang), 0, Math.sin(ang));
    x.addScaledVector(n, -x.dot(n)).normalize();
    const y = (this._by || (this._by = new THREE.Vector3())).crossVectors(n, x);
    this._m.makeBasis(x, y, n);
    this._pq.setFromRotationMatrix(this._m);
    const side = reach * 2 / 0.89;            // the front stops at 0.89 of the half-size
    this._pp.set(cx + n.x * 0.004, cy + n.y * 0.004, cz + n.z * 0.004);
    this._m.compose(this._pp, this._pq, this._s.set(side, side, 1));
    this.poolMesh.setMatrixAt(P.i, this._m);
    this.poolMesh.instanceMatrix.needsUpdate = true;
    const A = this.pAttr.array;
    A[P.i * 3] = 0.064; A[P.i * 3 + 1] = 1; A[P.i * 3 + 2] = 0;
    this.pAttr.needsUpdate = true;
  }

  /* how far the ground stays level around (cx, cz) at height cy: eight
     directions at growing radii, stopping at the first that is not */
  _poolReach(cx, cy, cz, scale) {
    const M = this.map, h2 = this._bh2 || (this._bh2 = {});
    let reach = 0;
    for (const R of [0.22, 0.36, 0.5, 0.64, 0.8]) {
      const r = R * scale;
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4, q = M.raycast(cx + Math.cos(a) * r, cy + 1.0, cz + Math.sin(a) * r, 0, -1, 0, 1.3, h2);
        if (!q || Math.abs(q.py - cy) > 0.05 || q.ny < 0.9) return reach;
      }
      reach = r;
    }
    return reach;
  }

  _bloodDecal(px, py, pz, nx, ny, nz, tile, size, stretch, ax, ay, az, grow, alpha) {
    const b = this.bSlots[this.bIdx = (this.bIdx + 1) % this.BN];
    if (!b.live) this.bLive++;
    b.live = true; b.t = 0; b.grow = grow; b.size = size; b.stretch = stretch; b.alpha = alpha;
    /* +Z on the surface normal, +X along the travel projected onto the surface */
    const n = this._bn || (this._bn = new THREE.Vector3());
    const x = this._bx || (this._bx = new THREE.Vector3());
    const y = this._by || (this._by = new THREE.Vector3());
    n.set(nx, ny, nz).normalize();
    x.set(ax, ay, az).addScaledVector(n, -(ax * n.x + ay * n.y + az * n.z));
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0).addScaledVector(n, -n.x);
    if (x.lengthSq() < 1e-6) x.set(0, 0, 1);
    x.normalize();
    y.crossVectors(n, x);
    this._m.makeBasis(x, y, n);
    b.q.setFromRotationMatrix(this._m);
    b.p.set(px + n.x * 0.006, py + n.y * 0.006, pz + n.z * 0.006);
    const TO = BLOOD_TILES[tile];
    this.bTile.array[b.i * 2] = TO[0]; this.bTile.array[b.i * 2 + 1] = TO[1];
    this.bTile.needsUpdate = true;
    this.bFade.array[b.i] = alpha; this.bFade.needsUpdate = true;
    this._bloodMatrix(b);
    this.bloodMesh.instanceMatrix.needsUpdate = true;
  }

  _bloodMatrix(b) {
    const g = b.grow > 0 ? 0.22 + 0.78 * (1 - Math.pow(1 - Math.min(1, b.t / b.grow), 2.2)) : 1;
    const s = b.size * g;
    this._m.compose(b.p, b.q, this._s.set(s * b.stretch, s, 1));
    this.bloodMesh.setMatrixAt(b.i, this._m);
  }

  clearBlood() {
    const zero = this._zeroM || (this._zeroM = new THREE.Matrix4().makeScale(0, 0, 0));
    for (const b of this.bSlots) { b.live = false; this.bloodMesh.setMatrixAt(b.i, zero); this.bFade.array[b.i] = 0; }
    this.bLive = 0;
    this.bloodMesh.instanceMatrix.needsUpdate = true;
    this.bFade.needsUpdate = true;
    for (const P of this.pools) { P.live = false; this.poolMesh.setMatrixAt(P.i, zero); this.pAttr.array[P.i * 3 + 1] = 0; }
    this.pLive = 0;
    this.poolMesh.instanceMatrix.needsUpdate = true;
    this.pAttr.needsUpdate = true;
  }

  /** The settings toggle. Switching blood off also wipes whatever is on the map. */
  setBlood(on) { this.blood = !!on; if (!this.blood) this.clearBlood(); }

  shellEject(pos, dir, up, small) {
    const s = this.shells[this.shIdx = (this.shIdx + 1) % this.SH];
    s.live = true; s.t = 0; s.settled = false;
    s.p.copy(pos);
    s.v.copy(dir).multiplyScalar(rng.range(2.0, 3.4))
      .addScaledVector(up, rng.range(1.4, 2.6))
      .add(this._v.set(rng.gauss() * 0.4, 0, rng.gauss() * 0.4));
    s.q.setFromEuler(new THREE.Euler(rng() * 6, rng() * 6, rng() * 6));
    s.w.set(rng.gauss() * 22, rng.gauss() * 22, rng.gauss() * 22);
    s.scale = small ? 0.8 : 1.25;
  }

  explosion(pos, radius, big) {
    const s = this.sprites[this.spIdx = (this.spIdx + 1) % this.SP];
    s.m.position.copy(pos);
    s.m.material.opacity = 1;
    s.m.material.rotation = rng() * 6.28;
    s.m.visible = true; s.live = true; s.t = 0; s.dur = big ? 0.42 : 0.30;
    s.s0 = radius * 0.55; s.s1 = radius * 1.75;
    s.m.layers.set(0);
    s.m.scale.setScalar(s.s0);

    const l = this.lights[this.lIdx = (this.lIdx + 1) % 4];
    l.L.position.copy(pos); l.L.color.setHex(0xff9a3c);
    l.L.distance = radius * 5;
    l.peak = 70; l.dur = big ? 0.55 : 0.34; l.t = 0; l.on = true;

    for (let i = 0; i < 46; i++) {
      const a = rng() * 6.283, e = Math.acos(rng() * 1.6 - 0.6);
      const sp = rng.range(4, 22);
      const vx = Math.sin(e) * Math.cos(a) * sp, vy = Math.abs(Math.cos(e)) * sp * 0.9, vz = Math.sin(e) * Math.sin(a) * sp;
      this.sparks.spawn(pos.x, pos.y + 0.2, pos.z, vx, vy, vz,
        rng.range(0.3, 0.95), 0.10, 0.01,
        [1, 0.82, 0.35, 1], [0.9, 0.18, 0.03, 0], 11);
    }
    for (let i = 0; i < 34; i++) {
      const a = rng() * 6.283;
      const sp = rng.range(1.5, 7);
      this.debris.spawn(pos.x, pos.y + 0.25, pos.z,
        Math.cos(a) * sp, rng.range(1.5, 6), Math.sin(a) * sp,
        rng.range(1.1, 2.4), 0.35, 1.85,
        [0.24, 0.22, 0.20, 0.75], [0.36, 0.34, 0.32, 0], 0.5);
    }
  }

  smokePuff(pos, size, life) {
    for (let i = 0; i < 5; i++) {
      this.debris.spawn(pos.x, pos.y, pos.z,
        rng.gauss() * 0.5, rng.range(0.4, 1.2), rng.gauss() * 0.5,
        life, size * 0.4, size * 1.7,
        [0.32, 0.30, 0.28, 0.5], [0.42, 0.40, 0.38, 0], 0.2);
    }
  }

  /* ------------------------------------------------------------------ */
  update(dt, map) {
    this.sparks.update(dt);
    this.debris.update(dt);
    if (map) this.map = map;

    /* blood: every mark lives BLOOD_LIFE seconds, full and then drying away
       over the last BLOOD_FADE, and pools spread out as they appear */
    if (this.bLive > 0) {
      let dirty = false;
      for (const b of this.bSlots) {
        if (!b.live) continue;
        b.t += dt;
        if (b.t >= BLOOD_LIFE) {
          b.live = false; this.bLive--;
          this.bFade.array[b.i] = 0;
          this.bloodMesh.setMatrixAt(b.i, this._zeroM || (this._zeroM = new THREE.Matrix4().makeScale(0, 0, 0)));
          dirty = true;
          continue;
        }
        const f = b.t < BLOOD_LIFE - BLOOD_FADE ? 1 : (BLOOD_LIFE - b.t) / BLOOD_FADE;
        this.bFade.array[b.i] = b.alpha * f;
        if (b.grow > 0 && b.t < b.grow + 0.05) { this._bloodMatrix(b); dirty = true; }
      }
      this.bFade.needsUpdate = true;
      if (dirty) this.bloodMesh.instanceMatrix.needsUpdate = true;
    }

    /* pools: the front runs out fast and slows, the blood dries, then fades */
    if (this.pLive > 0) {
      const A = this.pAttr.array;
      for (const P of this.pools) {
        if (!P.live) continue;
        P.t += dt;
        if (P.t >= POOL_LIFE) {
          P.live = false; this.pLive--;
          A[P.i * 3 + 1] = 0;
          this.poolMesh.setMatrixAt(P.i, this._zeroM || (this._zeroM = new THREE.Matrix4().makeScale(0, 0, 0)));
          this.poolMesh.instanceMatrix.needsUpdate = true;
          continue;
        }
        const k = Math.min(1, P.t / POOL_SPREAD), f = Math.min(1, (POOL_LIFE - P.t) / POOL_FADE);
        A[P.i * 3] = 0.92 * (0.07 + 0.93 * (1 - Math.pow(1 - k, 2.4)));
        A[P.i * 3 + 1] = f * f * (3 - 2 * f);
        A[P.i * 3 + 2] = clamp((P.t - POOL_DRY[0]) / (POOL_DRY[1] - POOL_DRY[0]), 0, 1);
      }
      this.pAttr.needsUpdate = true;
    }

    /* tracers */
    let any = false;
    for (const t of this.tracers) {
      const o = t.i * 6;
      if (!t.live) { this.trPos[o] = this.trPos[o + 3] = 0; this.trPos[o + 1] = this.trPos[o + 4] = -9999; continue; }
      any = true;
      t.travelled += t.speed * dt;
      if (t.travelled >= t.len) {
        t.fade -= dt * 9;
        if (t.fade <= 0) { t.live = false; this.trFree.push(t); continue; }
        t.travelled = t.len;
      }
      const head = Math.min(t.travelled, t.len);
      const tail = Math.max(0, head - t.trail);
      this.trPos[o]     = t.from.x + t.d.x * tail;
      this.trPos[o + 1] = t.from.y + t.d.y * tail;
      this.trPos[o + 2] = t.from.z + t.d.z * tail;
      this.trPos[o + 3] = t.from.x + t.d.x * head;
      this.trPos[o + 4] = t.from.y + t.d.y * head;
      this.trPos[o + 5] = t.from.z + t.d.z * head;
      const f = t.fade;
      this.trCol[o] = t.col[0] * 0.10 * f; this.trCol[o + 1] = t.col[1] * 0.10 * f; this.trCol[o + 2] = t.col[2] * 0.10 * f;
      this.trCol[o + 3] = t.col[0] * f; this.trCol[o + 4] = t.col[1] * f; this.trCol[o + 5] = t.col[2] * f;
    }
    this.trGeo.attributes.position.needsUpdate = true;
    this.trGeo.attributes.color.needsUpdate = true;
    this.tracerMesh.visible = any;

    /* lights */
    for (const l of this.lights) {
      if (!l.on) continue;
      l.t += dt;
      const k = l.t / l.dur;
      if (k >= 1) { l.on = false; l.L.intensity = 0; continue; }
      l.L.intensity = l.peak * (1 - k) * (1 - k);
    }

    /* billboards */
    for (const s of this.sprites) {
      if (!s.live) continue;
      s.t += dt;
      const k = s.t / s.dur;
      if (k >= 1) { s.live = false; s.m.visible = false; continue; }
      s.m.scale.setScalar(lerp(s.s0, s.s1, k));
      s.m.material.opacity = (1 - k) * (1 - k * 0.4);
    }

    /* casings */
    let shellDirty = false;
    for (const s of this.shells) {
      if (!s.live) continue;
      shellDirty = true;
      s.t += dt;
      if (s.t > 6) {
        s.live = false;
        this._m.makeScale(0, 0, 0);
        this.shellMesh.setMatrixAt(s.i, this._m);
        continue;
      }
      if (s.settled) {
        // a shell that has come to rest needs no physics and no raycast; it just
        // sits there fading. With continuous fire this was thousands of
        // unnecessary ground queries a second.
        const fadeOnly = clamp((6 - s.t) / 1.2, 0, 1);
        this._m.compose(s.p, s.q, this._s.setScalar(s.scale * fadeOnly));
        this.shellMesh.setMatrixAt(s.i, this._m);
        continue;
      }
      s.v.y -= 9.81 * dt;
      s.p.addScaledVector(s.v, dt);
      // one cheap ground test against whatever is beneath
      const gy = map ? groundAt(map, s.p.x, s.p.z, s.p.y + 0.4) : 0;
      if (s.p.y < gy + 0.006) {
        s.p.y = gy + 0.006;
        if (Math.abs(s.v.y) > 0.35) {
          s.v.y *= -0.32; s.v.x *= 0.55; s.v.z *= 0.55;
          s.w.multiplyScalar(0.5);
          if (this.audio && s.t < 3) this.audio.play('mech_shell', {
            pos: [s.p.x, s.p.y, s.p.z], vol: 0.16, reverb: 0.2 });
        } else { s.v.set(0, 0, 0); s.w.set(0, 0, 0); s.settled = true; }
      }
      this._q.setFromEuler(new THREE.Euler(s.w.x * dt, s.w.y * dt, s.w.z * dt));
      s.q.multiply(this._q);
      const fade = clamp((6 - s.t) / 1.2, 0, 1);
      this._m.compose(s.p, s.q, this._s.setScalar(s.scale * fade));
      this.shellMesh.setMatrixAt(s.i, this._m);
    }
    if (shellDirty) this.shellMesh.instanceMatrix.needsUpdate = true;
  }

  setPixelScale(h) { this.sparks.mat.uniforms.uPixelScale.value = h * 0.55;
                     this.debris.mat.uniforms.uPixelScale.value = h * 0.55; }

  clear() {
    for (const t of this.tracers) if (t.live) { t.live = false; this.trFree.push(t); }
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.DC; i++) this.decals.setMatrixAt(i, zero);
    this.decals.instanceMatrix.needsUpdate = true;
    for (const s of this.shells) { s.live = false; this.shellMesh.setMatrixAt(s.i, zero); }
    this.shellMesh.instanceMatrix.needsUpdate = true;
    for (const s of this.sprites) { s.live = false; s.m.visible = false; }
    for (const l of this.lights) { l.on = false; l.L.intensity = 0; }
    this.clearBlood();
  }
}

/** Highest solid surface under (x,z) below `from`. */
function groundAt(map, x, z, from) {
  const hit = map.raycast(x, from, z, 0, -1, 0, from + 2, map._gaOut || (map._gaOut = {}));
  return hit ? hit.py : 0;
}
