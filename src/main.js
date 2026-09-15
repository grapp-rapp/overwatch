/* ============================================================================
   Boot and frame loop.

   Target: 1920x1080, 60 fps locked. To hold that we keep the light count fixed
   (four roving point lights repositioned to the nearest map fixtures rather than
   toggled, which would recompile shaders mid-match), merge all static map
   geometry into one draw call per material, and cap the device pixel ratio.
   ========================================================================== */
import * as THREE from 'three';
import { GameMap } from './world/map.js';
import { MAPS } from './world/maps/index.js';
import { loadCharacterAssets, Character } from './chars/characters.js';
import { AudioEngine } from './core/audio.js';
import { Input } from './core/input.js';
import { Effects } from './game/effects.js';
import { ViewModel } from './weapons/viewmodel.js';
import { HUD } from './game/hud.js';
import { Menu } from './game/menu.js';
import { Game, STATE } from './game/game.js';
import { currentSkin, skinOperator, syncProfile, skinWeapon } from './game/skins.js';
import { cloneWeapon } from './weapons/models.js';
import { buildHelicopter, buildJet } from './game/killstreaks.js';
import { camoClock } from './game/camo.js';
import { WEAPONS, PRIMARIES, SECONDARIES } from './weapons/defs.js';
import { Stat, clamp, lerp, damp, yieldToBrowser } from './core/util.js';

const $ = (id) => document.getElementById(id);
const boot = $('boot'), bootFill = $('bootFill'), bootMsg = $('bootMsg');

/* Yield to the browser so the loading bar paints. Deliberately does NOT wait on
   requestAnimationFrame: a backgrounded or hidden tab throttles rAF to a crawl
   and boot would never finish. setTimeout still fires, so loading completes
   whether or not anyone is looking at it. */
let __stage=performance.now();
function progress(p, msg) {
  const n=performance.now(); console.log(`[boot] +${(n-__stage).toFixed(0)}ms -> ${msg||p}`); __stage=n;
  bootFill.style.width = Math.round(p * 100) + '%';
  if (msg) bootMsg.textContent = msg;
  return yieldToBrowser();
}

/* ============================================================================ */
async function main() {
  const t0 = performance.now();

  /* ---- renderer ---- */
  const canvas = $('gl');
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
  });
  /* The target is 1920x1080 at 60 fps. A 1.25 device pixel ratio quietly turns
     that into 2400x1350 — 56% more pixels through every shader for detail nobody
     asked for. Render at 1:1 and spend the budget on frame rate. */
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;   // driven manually at 30 Hz, see below
  renderer.autoClear = false;
  renderer.info.autoReset = false;

  await progress(0.06, 'INITIALISING RENDERER');

  /* ---- scene ---- */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(85, (window.innerWidth / window.innerHeight) || 16 / 9, 0.055, 320);
  camera.layers.enable(0);
  const _fwd = new THREE.Vector3(), _upv = new THREE.Vector3();   // first-person legs, see the draw
  /* your own left arm gets a pass of its own, through the viewmodel's lens */
  const armCam = new THREE.PerspectiveCamera(62, 16 / 9, 0.01, 10);
  armCam.layers.set(7);
  let lights7 = false;
  let legShiftX = 0, legShiftZ = 0;         // the body eased back for the draw, put back after it
  const fpArm = { on: false, ndc: [0, 0, 0] };
  window.__fpArm = fpArm;
  const _aR = new THREE.Vector3(), _aU = new THREE.Vector3(), _aF = new THREE.Vector3(), _aP = new THREE.Vector3();
  const _aFing = new THREE.Vector3(), _aTh = new THREE.Vector3(), _aW = new THREE.Vector3(), _aPole = new THREE.Vector3(), _aUp = new THREE.Vector3(0, 1, 0);
  const _aS = new THREE.Vector3();
  const _gPos = new THREE.Vector3();   // the ledge-grab hand

  await progress(0.12, 'GENERATING TERRAIN');
  /* Every map is a definition; the one on screen is built from it. Built maps
     are kept, so going back to one you have already played is instant. */
  let map = new GameMap(MAPS.dustline);
  const mapCache = new Map([[map.id, map]]);
  scene.add(map.group);
  scene.fog = new THREE.Fog(0x9aa8ac, 68, 240);

  await progress(0.34, 'PLACING LIGHTS');

  /* Sky fill vs sun. At 1.05 against a 2.55 sun the ambient term washed the
     shadow terms almost flat — the shadow map was rendering correctly and you
     simply could not see it. A dimmer sky and a stronger key give the contact
     shadows and building shadows real contrast without crushing the interiors,
     which keep their own point lights. */
  const hemi = new THREE.HemisphereLight(0xbcd2e8, 0x4d4133, 0.80);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffeeda, 3.4);
  sun.position.set(-46, 58, 32);
  sun.castShadow = true;
  /* A 2048 map over an 84x68 m frustum is ~4 cm per texel and cost 10 ms a frame
     with fifteen skinned operators in the pass. A 1024 map over a 52x44 m
     frustum that follows the player is 5 cm per texel — visually the same at
     head height — for a quarter of the fill. */
  sun.shadow.mapSize.set(1024, 1024);
  const SC = sun.shadow.camera;
  SC.left = -26; SC.right = 26; SC.top = 22; SC.bottom = -22;
  SC.near = 12; SC.far = 150;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  sun.shadow.camera.layers.enableAll();   // the local player's body still casts
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.set(0, 0, 0);

  /* A map brings its own weather: sky, fog, the colour and strength of the sky
     fill and of the sun, which way the sun comes from, and exposure. */
  const sunOffset = new THREE.Vector3(-46, 58, 32);
  function applyEnv(m) {
    const e = m.def.env || {};
    scene.background = m.skyTexture;
    scene.environment = m.skyTexture;
    const f = e.fog || [0x9aa8ac, 68, 240];
    scene.fog.color.setHex(f[0]); scene.fog.near = f[1]; scene.fog.far = f[2];
    const h = e.hemi || [0xbcd2e8, 0x4d4133, 0.80];
    hemi.color.setHex(h[0]); hemi.groundColor.setHex(h[1]); hemi.intensity = h[2];
    const su = e.sun || [0xffeeda, 3.4];
    sun.color.setHex(su[0]); sun.intensity = su[1];
    const d = e.sunDir || [-46, 58, 32];
    sunOffset.set(d[0], d[1], d[2]);
    renderer.toneMappingExposure = e.exposure || 1.02;
    renderer.shadowMap.needsUpdate = true;
  }
  applyEnv(map);

  // fixed pool of point lights, moved to the nearest fixtures each frame
  const POINTS = 4;
  const pointLights = [];
  for (let i = 0; i < POINTS; i++) {
    const L = new THREE.PointLight(0xffd9a0, 0, 14, 2);
    scene.add(L);
    pointLights.push(L);
  }

  await progress(0.44, 'LOADING OPERATORS');
  await loadCharacterAssets(p => { bootFill.style.width = Math.round((0.44 + p * 0.22) * 100) + '%'; });

  await progress(0.68, 'SYNTHESISING AUDIO');
  const audio = new AudioEngine();
  const allWeapons = [...PRIMARIES, ...SECONDARIES];
  await audio.bake(allWeapons, (p, name) => {
    bootFill.style.width = Math.round((0.68 + p * 0.22) * 100) + '%';
    bootMsg.textContent = 'SYNTHESISING AUDIO · ' + name.toUpperCase();
  });

  await progress(0.92, 'ARMING SYSTEMS');
  const effects = new Effects(scene, audio);
  effects.setPixelScale(window.innerHeight);
  const viewmodel = new ViewModel(renderer);
  const input = new Input(canvas);
  const hud = new HUD({ map });

  const game = new Game({ scene, camera, renderer, map, audio, effects, hud, input, viewmodel });
  hud.g = game;

  /** Put another map on screen and point every system at it. */
  function switchMap(id) {
    if (!MAPS[id] || map.id === id) return map;
    scene.remove(map.group);
    map = mapCache.get(id) || new GameMap(MAPS[id]);
    mapCache.set(id, map);
    scene.add(map.group);
    applyEnv(map);
    game.setMap(map);
    window.__map = map;
    return map;
  }
  window.__switchMap = switchMap;
  await syncProfile();          // a saved bank comes back even if the browser forgot it
  const menu = new Menu(game);
  game.menu = menu;
  game.audio = audio;

  /* ---- config plumbing ---- */
  menu.onConfigChange = (key, v) => {
    if (key === 'device') input.device = v;
    else if (key === 'sensitivity') input.sensitivity = v;
    else if (key === 'adsMult') input.adsMult = v;
    else if (key === 'volume') audio.setVolume(v);
    else if (key === 'invert') input.invert = v;
    else if (key === 'holdAds') input.holdAds = v;
    else if (key === 'holdSprint') input.holdSprint = v;
    else if (key === 'blood') game.effects && game.effects.setBlood(v);
    else if (key === 'shadows') { renderer.shadowMap.enabled = v; scene.traverse(o => { if (o.isMesh) o.material && (o.material.needsUpdate = true); }); }
  };
  input.sensitivity = menu.cfg.sensitivity;
  input.adsMult = menu.cfg.adsMult;
  audio.setVolume(menu.cfg.volume);

  /* ---- deploy / pause / result wiring ---- */
  /* Your operator wears your skin and gets its legs-only cut for first person.
     The match builds a fresh operator for you, so this runs after it has -
     dressing the old one at deploy left the new one whole, and the camera
     inside its head - and the draw re-runs it if the operator is rebuilt. */
  let activeSkin = null;
  const dressLocal = () => {
    const c = game.me && game.me.char;
    if (!c) return;
    c._firstPerson = true;
    skinOperator(c, activeSkin || currentSkin());
  };

  /* Every shader the match will use, compiled before its first frame. This was
     one render of everything, which compiled them one after another on the main
     thread: 1.5 to 4 s of frozen screen after DEPLOY on an Intel Iris Xe. Now they
     go to the driver together (compileAsync, KHR_parallel_shader_compile) while
     the game holds (`deploying`), and it covers what a match only draws later,
     each of which used to compile on first sight: bodies fading, every gun in
     your hands, the killstreak aircraft, every effect. The lights are always on
     (dark when idle), so the light count every lit shader is built for no longer
     changes mid-match - that alone recompiled 60 programs in a minute of play. */
  let deploying = false, deployToken = 0;
  /* compileAsync resolves once every program reports ready. One whose material is
     disposed meanwhile (a match restarted mid-compile) never reports, and that
     must not leave DEPLOY, or anything else, waiting forever. */
  const settle = (jobs, ms) => Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, ms))]);

  /* The same, before anyone clicks: in the menu, compile what every match draws,
     against the lights the match will have - two operators (yours in your skin,
     and a bot), as they are and fading; every gun, in your hands and in theirs;
     the killstreak aircraft; every effect. DEPLOY then finds nearly all of it
     ready. The stand-ins are kept, never disposed: disposing their materials
     would release the very programs this compiled. */
  let warmKeep = null;
  const prewarm = async () => {
    if (warmKeep || game.state !== STATE.MENU) return;
    const t0 = performance.now(), skin = currentSkin();
    const mine = new Character({ team: 'A', variant: 0, seed: 1, isLocal: true, layer: 3, weaponLayer: 4, name: 'warm' });   // game.js PLAYER_LAYER
    mine.setWeapon(WEAPONS[menu.cfg.primary] || PRIMARIES[0]);
    mine._firstPerson = true; skinOperator(mine, skin);
    const bot = new Character({ team: 'B', variant: 1, seed: 9, name: 'warm' });
    bot.setWeapon(PRIMARIES[0]);
    const hold = new THREE.Group(), guns = new THREE.Group();
    hold.add(mine.root, bot.root);
    for (const b of [buildHelicopter, () => buildJet(false), () => buildJet(true)]) { try { hold.add(b()); } catch (e) { /* optional */ } }
    for (const def of [...PRIMARIES, ...SECONDARIES]) { const w = cloneWeapon(def); skinWeapon(w, skin); guns.add(w); }
    guns.visible = false; viewmodel.scene.add(guns);
    if (!lights7) { scene.traverse(o => { if (o.isLight) o.layers.enable(7); }); lights7 = true; }
    const jobs = [];
    for (const f of [1, 0.5]) {
      mine._setFade(f); bot._setFade(f);
      jobs.push(renderer.compileAsync(hold, camera, scene));
    }
    mine._setFade(1); bot._setFade(1);
    jobs.push(renderer.compileAsync(viewmodel.scene, viewmodel.camera));
    jobs.push(renderer.compileAsync(scene, camera));               // the map and every effect
    await settle(jobs, 15000);
    viewmodel.scene.remove(guns);
    warmKeep = [mine, bot, hold, guns];
    game.prewarmMs = Math.round(performance.now() - t0);
  };
  const warmShaders = async () => {
    const token = ++deployToken;           // only the latest DEPLOY may end the hold
    deploying = true;
    if (renderer.getPixelRatio() !== 1) { renderer.setPixelRatio(1); resize(); }   // each match starts at full resolution
    const dep = document.getElementById('deploying'); if (dep) dep.classList.remove('hidden');
    const t0 = performance.now();
    const extra = new THREE.Group(), guns = new THREE.Group();
    extra.visible = guns.visible = false;                         // compiled, never drawn
    for (const b of [buildHelicopter, () => buildJet(false), () => buildJet(true)]) { try { extra.add(b()); } catch (e) { /* optional */ } }
    for (const def of [...PRIMARIES, ...SECONDARIES]) { const w = cloneWeapon(def); skinWeapon(w, activeSkin); guns.add(w); }
    scene.add(extra); viewmodel.scene.add(guns);
    if (!lights7) { scene.traverse(o => { if (o.isLight) o.layers.enable(7); }); lights7 = true; }
    const chars = game.actors.map(a => a.char).filter(Boolean);
    try {
      const jobs = [];
      for (const f of [1, 0.5]) {                                   // as they are, and fading
        for (const c of chars) c._setFade(f);
        jobs.push(renderer.compileAsync(scene, camera));
      }
      for (const c of chars) c._setFade(1);
      jobs.push(renderer.compileAsync(viewmodel.scene, viewmodel.camera));
      await settle(jobs, 6000);
    } catch (e) { console.warn('shader warm-up:', e); }
    scene.remove(extra); viewmodel.scene.remove(guns);
    game.warmMs = Math.round(performance.now() - t0);
    if (token !== deployToken) return;
    deploying = false;
    if (dep) dep.classList.add('hidden');
  };

  game.deploy = () => {
    audio.resume();
    switchMap(menu.cfg.map || 'dustline');
    menu.show(false);
    // your skin: the viewmodel gun and fist now, your operator once the match
    // has built it (dressLocal, below)
    activeSkin = currentSkin();
    viewmodel.setSkin(activeSkin);
    viewmodel.setWeapon(WEAPONS[menu.cfg.primary]);
    game.startMatch({ ...menu.cfg });
    dressLocal();
    $('result').classList.add('hidden');
    $('pause').classList.add('hidden');
    requestLock();                          // inside the click, where the browser allows it
    game.deployReady = warmShaders();
  };

  const requestLock = () => {
    $('clickToPlay').classList.toggle('hidden', input.locked);
    if (!input.locked) input.requestLock();
  };
  $('clickToPlay').addEventListener('click', () => { audio.resume(); input.requestLock(); });
  canvas.addEventListener('click', () => {
    if (game.state === STATE.LIVE || game.state === STATE.KILLCAM) { audio.resume(); input.requestLock(); }
  });

  input.onLockChange = (locked) => {
    document.body.classList.toggle('playing', locked);
    const inMatch = game.state === STATE.LIVE || game.state === STATE.KILLCAM;
    const noLock = input.lockUnavailable;
    $('clickToPlay').classList.toggle('hidden', locked || !inMatch || game.paused || noLock);
    if (!locked && inMatch && !game.paused && !noLock) showPause();
  };

  function showPause() {
    if (game.state !== STATE.LIVE && game.state !== STATE.KILLCAM) return;
    game.paused = true;
    $('pause').classList.remove('hidden');
    $('clickToPlay').classList.add('hidden');
    const me = game.me;
    const acc = me.shotsFired ? (me.shotsHit / me.shotsFired * 100) : 0;
    $('pauseStats').innerHTML = [
      ['SCORE', `${game.scoreA} — ${game.scoreB}`], ['KILLS / DEATHS', `${me.kills} / ${me.deaths}`],
      ['ACCURACY', acc.toFixed(0) + '%'], ['STREAK', me.streak],
      ['TIME LEFT', Math.floor(game.timeLeft / 60) + ':' + String(Math.floor(game.timeLeft % 60)).padStart(2, '0')],
    ].map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('');
    audio.suspend();
  }
  function hidePause() {
    game.paused = false;
    $('pause').classList.add('hidden');
    audio.resume();
    requestLock();
  }
  $('resumeBtn').addEventListener('click', hidePause);
  $('restartBtn').addEventListener('click', () => { game.paused = false; $('pause').classList.add('hidden'); game.deploy(); });
  $('quitBtn').addEventListener('click', () => {
    game.paused = false;
    $('pause').classList.add('hidden');
    game.clearMatch();
    game.state = STATE.MENU;
    hud.show(false);
    menu.show(true);
    audio.resume();
  });
  $('againBtn').addEventListener('click', () => game.deploy());
  $('menuBtn').addEventListener('click', () => {
    $('result').classList.add('hidden');
    game.clearMatch();
    game.state = STATE.MENU;
    menu.show(true);
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      if (game.strikeMode) { game.closeStrikeSelect(); return; }
      if (game.paused) hidePause();
      else if (game.state === STATE.LIVE || game.state === STATE.KILLCAM) { input.exitLock(); }
    }
    if (e.code === 'F3') { e.preventDefault(); game.showFps = !game.showFps; hud.el.fps.style.display = game.showFps ? '' : 'none'; }
  });

  /* ---- resize ---- */
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    // a minimised or hidden window reports 0 x 0: keep the last real size, or
    // the aspect becomes 0/0 and every projection's x turns to NaN
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    effects.setPixelScale(h * renderer.getPixelRatio());
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---- profiler ---- */
  const frameStat = new Stat(240);
  const cpuStat = new Stat(240);
  let last = performance.now();
  let acc = 0, frames = 0;

  const sunCamDir = new THREE.Vector3();
  const _frustum = new THREE.Frustum();
  const _projScreen = new THREE.Matrix4();
  const _cullSphere = new THREE.Sphere(new THREE.Vector3(), 1.5);
  let _shadowAcc = 0;

  /* ---- loop ----
     The frame body is split out so the headless QA harness can drive the exact
     same code path with a fixed timestep, without depending on requestAnimation-
     Frame (which a hidden tab throttles to a standstill). */
  /* Resolution that keeps up. On a laptop GPU (an Intel Iris Xe: 42 fps at 1080p,
     58 at 80%) the drawing buffer shrinks in 10% steps, down to 60%, while a match
     runs slower than about 55 fps; every deploy starts back at full. The HUD is
     DOM, so it stays sharp. Only the real frame loop adapts: the QA harness drives
     step() itself and never trips it. */
  let slowT = 0;
  const autoScale = (raw) => {
    if (game.state !== STATE.LIVE || game.paused || raw > 0.25) { slowT = 0; return; }
    slowT = raw > 0.018 ? slowT + raw : Math.max(0, slowT - raw * 0.5);   // aim for ~55 fps: 50 left 1080p hovering at 90%
    const r = renderer.getPixelRatio();
    if (slowT > 1.2 && r > 0.61) { renderer.setPixelRatio(Math.round((r - 0.1) * 10) / 10); resize(); slowT = 0; }
  };

  function frame(now) {
    requestAnimationFrame(frame);
    const raw = (now - last) / 1000;
    last = now;
    /* Benchmark mode: the QA harness drives step() itself in a tight loop. If the
       vsync loop kept running too, the two would contend for the GPU and the
       measurement would report roughly double the real frame cost. */
    if (window.__benchmark) return;
    if (deploying) return;                  // the match's shaders are compiling: hold the last frame
    autoScale(raw);
    step(raw);
  }

  function step(raw) {
    frameStat.push(raw * 1000);
    const dt = clamp(raw, 1 / 300, 1 / 20);
    camoClock.value += dt;                    // animated skins drift, pulse and turn
    const cpu0 = performance.now();
    const now = cpu0;
    const cp = camera.position;   // used by culling, shadow LOD and the light pool

    if (game.paused) { input.endFrame(); return; }

    if (game.state === STATE.MENU || game.state === STATE.RESULT) {
      menu.update(dt);
      // slow drift over the map so the menu is not a dead screen
      game.time += dt;
      const a = game.time * 0.055;
      camera.position.set(Math.cos(a) * 46, 22 + Math.sin(a * 0.7) * 5, Math.sin(a) * 40);
      camera.lookAt(0, 2.5, 0);
      camera.fov = 46; camera.updateProjectionMatrix();
    } else {
      if (game.strikeMode) game.updateStrikeSelect(dt);
      game.update(dt, now);
      /* viewmodel */
      const me = game.me;
      const W = me.weapon;
      const look = input.lookDelta(me.adsW);
      sunCamDir.copy(sun.position).normalize().applyQuaternion(camera.quaternion.clone().invert());
      /* the ledge grab point in the viewmodel camera's terms: the main camera's
         view space, x and y scaled for the viewmodel's narrower FOV so the hand
         lands where the ledge is on screen */
      let grabPos = null;
      if (me.mantle) {
        camera.updateMatrixWorld();
        const fovK = Math.tan(viewmodel.camera.fov * Math.PI / 360) / Math.tan(camera.fov * Math.PI / 360);
        grabPos = _gPos.set(me.mantle.gx, me.mantle.top + 0.02, me.mantle.gz).applyMatrix4(camera.matrixWorldInverse);
        grabPos.x *= fovK; grabPos.y *= fovK;
      }
      viewmodel.update(dt, {
        adsW: me.adsW, speed: Math.hypot(me.vel.x, me.vel.z), grounded: me.grounded,
        crouch: me.crouch, sprint: me.sprint, lookDX: look.x, lookDY: look.y,
        reloading: W.reloading, reloadProgress: W.reloading ? W.reloadT / Math.max(0.01, W.reloadDur) : 0,
        equipT: me.swapT, equipDur: Math.max(0.01, me.swapDur),
        hidden: viewmodel.hidden || !me.alive || game.state === STATE.KILLCAM,
        boltT: W.bolting ? W.boltT : 0, boltDur: W.def.boltTime || 1,
        magEmpty: W.mag <= 0, sunDirCam: sunCamDir,
        melee: me.meleeT > 0 ? 1 - me.meleeT / (me.meleeDur || 0.6) : 0,
        mantle: me.mantle ? Math.min(1, me.mantle.t / me.mantle.T) : 0, grabPos,
      });
    }

    effects.update(dt, map);

    /* roving point lights */
    const src = map.pointLights;
    if (src.length) {
      const sorted = src.map(l => ({ l, d: (l.x - cp.x) ** 2 + (l.z - cp.z) ** 2 }))
        .sort((a, b) => a.d - b.d);
      for (let i = 0; i < POINTS; i++) {
        const P = pointLights[i];
        const s = sorted[i];
        if (!s) { P.intensity = 0; continue; }
        P.position.set(s.l.x, s.l.y, s.l.z);
        P.color.setHex(s.l.color);
        P.distance = s.l.dist;
        // decay 2 means intensity is divided by distance squared; the authored
        // values are relative, so scale them into a range that actually lights a room
        P.intensity = s.l.intensity * 5.5 * clamp(1 - Math.sqrt(s.d) / 44, 0, 1);
      }
    }
    // keep the shadow frustum tight around the player
    sun.target.position.set(cp.x * 0.55, 0, cp.z * 0.55);
    sun.position.set(cp.x * 0.55 + sunOffset.x, sunOffset.y, cp.z * 0.55 + sunOffset.z);

    /* ---- per-frame culling of skinned operators ----
       Skinned meshes carry frustumCulled=false because their bind-pose bounds go
       stale as the skeleton moves, so three.js would draw every soldier every
       frame including the ones behind you. Cull them ourselves against a
       generous sphere at the actor's feet, which is cheap and never pops. */
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    if (game.actors) {
      const spectating = game.state === STATE.KILLCAM;
      for (const a of game.actors) {
        if (!a.char) continue;
        _cullSphere.center.set(a.pos.x, a.pos.y + 0.95, a.pos.z);
        _cullSphere.radius = 1.5;
        const vis = _frustum.intersectsSphere(_cullSphere);
        a.char.model.visible = vis;
        a.char.blob.visible = vis;
        /* Two distance LODs on the operator, both invisible in play and both
           worth several milliseconds with a full roster on screen:
             - shadow casting stops at 12 m. Past that the cast shadow is a
               handful of pixels and the contact blob under every soldier reads
               the same, but each caster is a whole extra skinned draw in the
               shadow pass.
             - the visor sub-mesh is dropped at 18 m. It is a second skinned
               mesh and a second draw call per character for a detail that is a
               few pixels wide at that range. */
        const d2 = _cullSphere.center.distanceToSquared(cp);
        const castNear = d2 < 12 * 12;
        if (a.char._castNear !== castNear) {
          a.char._castNear = castNear;
          a.char.model.traverse(o => { if (o.isMesh && !o.userData.fpCut) o.castShadow = castNear; });
        }
        if (a.char.visorMesh) {
          const showVisor = vis && d2 < 18 * 18;
          if (a.char._visorOn !== showVisor) {
            a.char._visorOn = showVisor;
            a.char.visorMesh.visible = showVisor;
          }
        }
      }
      if (spectating) {
        // during a killcam nothing is culled — the replay camera can be anywhere
        // — except the operator whose eyes we are borrowing, whom the killcam
        // deliberately hides so we are not looking through their own helmet.
        const hidden = game.killcam && game.killcam._hidden;
        for (const a of game.actors) {
          if (!a.char) continue;
          a.char.model.visible = a.char !== hidden;
        }
      }
    }

    /* ---- shadows at 30 Hz ----
       Re-rendering the shadow map every frame is the single most expensive thing
       in the pass. At half rate the worst case is a 16 ms lag on a moving
       shadow, which is not perceptible, and it halves the cost outright. */
    _shadowAcc += dt;
    if (_shadowAcc >= 1 / 30) {
      _shadowAcc = 0;
      // NB: the flag three.js actually checks is on the shadow map, not the
      // light. Setting light.shadow.needsUpdate does nothing here, and with
      // autoUpdate off that means the shadow pass never runs at all.
      renderer.shadowMap.needsUpdate = true;
    }

    /* ---- draw ---- */
    // The QA harness can simulate without drawing: a logic-only match runs the
    // full game loop but skips the GPU work, so thousands of frames fit in one
    // call. Never set in normal play.
    if (window.__noRender) { input.endFrame(); cpuStat.push(performance.now() - cpu0); return; }
    renderer.info.reset();
    renderer.clear();
    /* your own body. In a killcam you are seen whole, gun and all (layers 3-5).
       In play your camera draws the legs-only cut of your body (6, built in
       skins.js) and any gear at the waist (3); the full body, the gear above
       the waist (5) and your third-person gun (4) stay in the shadow pass only.
       Looking down eases the body back a little, so you see legs and boots
       rather than straight down into your belt. */
    const meC = game.me && game.me.char;
    if (meC && !meC._firstPerson) dressLocal();
    const L = camera.layers;
    if (game.state === STATE.KILLCAM) { L.enable(3); L.enable(4); L.enable(5); L.disable(6); }
    else {
      L.disable(4); L.disable(5);
      // __noLegs: QA switch for an A/B frame-time run
      const legs = !window.__noLegs && game.state === STATE.LIVE && meC && game.me.alive && !meC.dead && !game.me.mantle;
      if (legs) {
        camera.getWorldDirection(_fwd);
        _upv.set(0, 1, 0).applyQuaternion(camera.quaternion);
        const cosP = Math.sqrt(Math.max(0, 1 - _fwd.y * _fwd.y)), sinP = _fwd.y;
        const hx = _fwd.x * cosP - _upv.x * sinP, hz = _fwd.z * cosP - _upv.z * sinP, hl = Math.hypot(hx, hz) || 1;
        /* ease the body back just far enough that the top of the cut - the
           stomach, up to where the chest begins (Spine1) - sits under the bottom
           edge of the view: below it the belly, the belt, legs and boots stay in
           sight. The edge's angle below the horizon is the pitch plus half the
           vertical FOV. Measured off the skeleton, so crouching and leaning
           follow. */
        const top = meC.bone('Spine1').getWorldPosition(_aS);
        const below = Math.max(0.1, camera.position.y - top.y);
        const ahead = ((top.x - camera.position.x) * hx + (top.z - camera.position.z) * hz) / hl + 0.14;
        const edge = Math.asin(clamp(-_fwd.y, -1, 1)) + camera.fov * Math.PI / 360 - Math.PI / 2;
        const off = edge > -1.4 ? Math.max(0, ahead + below * Math.tan(Math.min(edge, 1.0)) + 0.03) : 0;
        legShiftX = -hx / hl * off; legShiftZ = -hz / hl * off;
        meC.root.position.x += legShiftX; meC.root.position.z += legShiftZ;
        L.enable(3); L.enable(6);
      } else { L.disable(3); L.disable(6); }
    }
    /* your own left arm, when the hand has something to do (layer 7): IK'd to
       where the viewmodel wants the hand, then drawn after the world through a
       camera with the viewmodel's narrower lens, so it keeps arm's-length
       proportions the way the gun does and never sinks into a wall */
    const H = viewmodel.handPose;
    let armOn = false;
    if (H.on && game.state === STATE.LIVE && meC && game.me.alive && !meC.dead) {
      armCam.position.copy(camera.position); armCam.quaternion.copy(camera.quaternion);
      armCam.fov = viewmodel.camera.fov; armCam.aspect = camera.aspect;
      armCam.updateProjectionMatrix(); armCam.updateMatrixWorld();
      _aR.set(1, 0, 0).applyQuaternion(camera.quaternion);
      _aU.set(0, 1, 0).applyQuaternion(camera.quaternion);
      _aF.set(0, 0, -1).applyQuaternion(camera.quaternion);
      _aP.copy(H.pos).applyMatrix4(armCam.matrixWorld);                     // where the hand goes, in the world
      if (H.kind === 'punch') {
        // knuckles forward and a touch down; the thumb turns from up to the right
        _aFing.copy(_aF).addScaledVector(_aU, -0.12).normalize();
        _aTh.copy(_aR).multiplyScalar(Math.cos(H.roll)).addScaledVector(_aU, Math.sin(H.roll));
        _aW.copy(_aP).addScaledVector(_aFing, -0.075);                     // the wrist sits behind the fist
        // the arm starts low at the left of your view, as a viewmodel arm does
        _aS.copy(camera.position).addScaledVector(_aR, -0.33).addScaledVector(_aU, -0.34).addScaledVector(_aF, 0.04);
      } else {
        // palm flat on the top, fingers over the lip, thumb to the right
        _aFing.set(game.me.mantle.fx, 0, game.me.mantle.fz).normalize();
        _aTh.crossVectors(_aFing, _aUp).normalize();
        _aW.copy(_aP).addScaledVector(_aFing, -0.08).addScaledVector(_aUp, 0.03);
      }
      _aPole.copy(_aW).addScaledVector(_aR, -0.35).addScaledVector(_aU, -0.9).addScaledVector(_aF, -0.3);
      meC.root.updateMatrixWorld(true);
      armOn = meC.poseFirstPersonArm(_aW, _aFing, _aTh, _aPole, H.curl, H.kind === 'punch' ? _aS : null);
      if (armOn && !lights7) { scene.traverse(o => { if (o.isLight) o.layers.enable(7); }); lights7 = true; }
    }
    fpArm.on = armOn;
    if (armOn) _aP.setFromMatrixPosition(meC.lHand.matrixWorld).project(armCam).toArray(fpArm.ndc);
    renderer.render(scene, camera);
    if (armOn) {
      const bg = scene.background; scene.background = null;
      renderer.clearDepth();
      renderer.render(scene, armCam);
      scene.background = bg;
      meC.restoreArm();
    }
    if (legShiftX || legShiftZ) {              // hit tests before the next update must see you where you are
      meC.root.position.x -= legShiftX; meC.root.position.z -= legShiftZ;
      meC.root.updateMatrixWorld(true);
      legShiftX = legShiftZ = 0;
    }
    if (game.state !== STATE.MENU && game.state !== STATE.RESULT) {
      viewmodel.render(renderer, camera.aspect, 1);
    }

    input.endFrame();

    cpuStat.push(performance.now() - cpu0);
    frames++; acc += raw;
    if (acc > 0.5) {
      const fps = frames / acc;
      const p99 = frameStat.percentile(0.99);
      hud.setFps(`${fps.toFixed(0)} FPS\n${frameStat.mean.toFixed(2)} ms avg\n`
        + `${p99.toFixed(2)} ms p99\ncpu ${cpuStat.mean.toFixed(2)} ms\n`
        + `${renderer.info.render.calls} calls · ${(renderer.info.render.triangles / 1000).toFixed(0)}k tri`);
      frames = 0; acc = 0;
      game.perf = { fps, mean: frameStat.mean, p99, cpu: cpuStat.mean,
        calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    }
  }

  await progress(1.0, 'READY');
  boot.classList.add('hidden');
  menu.show(true);
  requestAnimationFrame(frame);
  // in the menu, before anyone clicks DEPLOY (?noprewarm turns it off, to compare)
  if (!/[?&]noprewarm/.test(location.search)) setTimeout(() => { prewarm().catch(e => console.warn('shader prewarm:', e)); }, 300);

  const bootMs = performance.now() - t0;
  console.log(`[blackout] ready in ${bootMs.toFixed(0)} ms`);

  // finish the non-critical audio banks while the player reads the briefing
  audio.bakeDeferred().then(() => console.log('[blackout] deferred audio ready'));

  /* ---- test hooks (used by the headless QA harness) ---- */
  window.__game = game;
  window.__menu = menu;
  window.__map = map;
  window.__THREE = THREE;
  window.__renderer = renderer;
  window.__bootMs = bootMs;
  window.__audio = audio;
  window.__viewmodel = viewmodel;
  window.__effects = effects;
  window.__scene = scene;
  window.__camera = camera;
  window.__sun = sun;
  /** Drive one frame with a fixed timestep — used by the QA harness. */
  window.__step = (dt) => step(dt || 1 / 60);
  window.__stepN = (n, dt) => { for (let i = 0; i < n; i++) step(dt || 1 / 60); };
  // module handles the QA harness needs to exercise real code paths
  window.__defs = await import('./weapons/defs.js');
  window.__combat = await import('./weapons/combat.js');
  window.__ready = true;
}

main().catch(e => {
  console.error(e);
  bootMsg.textContent = 'FAILED: ' + e.message;
  bootMsg.style.color = '#ff5b47';
  window.__bootError = String(e && e.stack || e);
});
