/* ============================================================================
   Boot and frame loop.

   Target: 1920x1080, 60 fps locked. To hold that we keep the light count fixed
   (four roving point lights repositioned to the nearest map fixtures rather than
   toggled, which would recompile shaders mid-match), merge all static map
   geometry into one draw call per material, and cap the device pixel ratio.
   ========================================================================== */
import * as THREE from 'three';
import { GameMap, MAP_W, MAP_D } from './world/map.js';
import { loadCharacterAssets } from './chars/characters.js';
import { AudioEngine } from './core/audio.js';
import { Input } from './core/input.js';
import { Effects } from './game/effects.js';
import { ViewModel } from './weapons/viewmodel.js';
import { HUD } from './game/hud.js';
import { Menu } from './game/menu.js';
import { Game, STATE } from './game/game.js';
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
  const camera = new THREE.PerspectiveCamera(85, window.innerWidth / window.innerHeight, 0.055, 320);
  camera.layers.enable(0);

  await progress(0.12, 'GENERATING TERRAIN');
  const map = new GameMap();
  scene.add(map.group);
  scene.background = map.skyTexture;
  scene.environment = map.skyTexture;
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
    else if (key === 'shadows') { renderer.shadowMap.enabled = v; scene.traverse(o => { if (o.isMesh) o.material && (o.material.needsUpdate = true); }); }
  };
  input.sensitivity = menu.cfg.sensitivity;
  input.adsMult = menu.cfg.adsMult;
  audio.setVolume(menu.cfg.volume);

  /* ---- deploy / pause / result wiring ---- */
  game.deploy = () => {
    audio.resume();
    menu.show(false);
    viewmodel.setWeapon(WEAPONS[menu.cfg.primary]);
    game.startMatch({ ...menu.cfg });
    $('result').classList.add('hidden');
    $('pause').classList.add('hidden');
    requestLock();
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
  function frame(now) {
    requestAnimationFrame(frame);
    const raw = (now - last) / 1000;
    last = now;
    /* Benchmark mode: the QA harness drives step() itself in a tight loop. If the
       vsync loop kept running too, the two would contend for the GPU and the
       measurement would report roughly double the real frame cost. */
    if (window.__benchmark) return;
    step(raw);
  }

  function step(raw) {
    frameStat.push(raw * 1000);
    const dt = clamp(raw, 1 / 300, 1 / 20);
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
      viewmodel.update(dt, {
        adsW: me.adsW, speed: Math.hypot(me.vel.x, me.vel.z), grounded: me.grounded,
        crouch: me.crouch, sprint: me.sprint, lookDX: look.x, lookDY: look.y,
        reloading: W.reloading, reloadProgress: W.reloading ? W.reloadT / Math.max(0.01, W.reloadDur) : 0,
        equipT: me.swapT, equipDur: Math.max(0.01, me.swapDur),
        hidden: viewmodel.hidden || !me.alive || me.inGunner || game.state === STATE.KILLCAM,
        boltT: W.bolting ? W.boltT : 0, boltDur: W.def.boltTime || 1,
        magEmpty: W.mag <= 0, sunDirCam: sunCamDir,
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
    sun.position.set(cp.x * 0.55 - 46, 58, cp.z * 0.55 + 32);

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
          a.char.model.traverse(o => { if (o.isMesh) o.castShadow = castNear; });
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
    if (game.state === STATE.KILLCAM) camera.layers.enable(3); else camera.layers.disable(3);
    renderer.render(scene, camera);
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
