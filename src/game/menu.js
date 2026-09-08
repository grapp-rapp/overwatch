/* ============================================================================
   Pre-match: briefing, armoury, loadout, controls.

   Weapon renders are real 3D — a dedicated small WebGL context draws each gun
   model and blits it into the card canvases, so the picture in the armoury is
   literally the weapon you will be holding.
   ========================================================================== */
import * as THREE from 'three';
import { PRIMARIES, SECONDARIES, WEAPONS, LETHALS, loadoutBars, stk, ttk } from '../weapons/defs.js';
import { buildWeapon, buildLethal } from '../weapons/models.js';
import { STREAKS, STREAK_ICONS, TEAM_STRIKE } from './killstreaks.js';
import { CONTROL_LEGEND } from '../core/input.js';
import { MAP_W, MAP_D, HALF_W, HALF_D } from '../world/map.js';
import { clamp, lerp } from '../core/util.js';

const $ = (id) => document.getElementById(id);

/* ---- shared offscreen renderer for weapon previews ----------------------- */
class GunStudio {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 720; this.canvas.height = 340;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 20);
    const key = new THREE.DirectionalLight(0xfff0dd, 3.2); key.position.set(-1.6, 2.2, 2.4);
    const rim = new THREE.DirectionalLight(0x8fc4ff, 2.0); rim.position.set(2.4, 0.4, -2.2);
    const fill = new THREE.DirectionalLight(0xffd9b0, 0.9); fill.position.set(1.2, -1.4, 1.0);
    this.scene.add(key, rim, fill, new THREE.HemisphereLight(0xa8c4e0, 0x2a2620, 1.1));
    this.holder = new THREE.Group();
    this.scene.add(this.holder);
    this.cache = new Map();
  }
  model(def, lethal) {
    const k = def.id;
    if (!this.cache.has(k)) {
      const m = lethal ? buildLethal(def) : buildWeapon(def);
      m.traverse(o => { o.castShadow = false; });
      this.cache.set(k, m);
    }
    return this.cache.get(k);
  }
  /** Render `def` into a target 2D canvas. */
  draw(target, def, yaw, pitch, lethal) {
    const w = target.width, h = target.height;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.renderer.setSize(w, h, false);
    }
    this.holder.clear();
    const m = this.model(def, lethal);
    this.holder.add(m);
    // frame the model
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    m.position.set(-centre.x, -centre.y, -centre.z);
    this.holder.rotation.set(pitch, yaw, 0);
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    const dist = radius / Math.tan((30 * Math.PI / 180) / 2) * 1.30;
    this.camera.aspect = w / h;
    this.camera.position.set(0, radius * 0.18, dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const ctx = target.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.canvas, 0, 0, w, h);
  }
}

/* ============================================================================ */
export class Menu {
  constructor(game) {
    this.g = game;
    this.studio = new GunStudio();
    this.cfg = {
      enemies: 5, friends: 3, scoreLimit: 30, timeLimit: 10, difficulty: 1,
      primary: 'vk71', secondary: 'm9', lethal: 'frag',
      device: 'mouse', sensitivity: 1.0, adsMult: 0.75, fov: 85, volume: 0.7,
      invert: false, holdAds: true, holdSprint: true, shadows: true,
    };
    this.selected = 'vk71';
    this.detailYaw = 0.7;
    this.t = 0;
    this.visible = false;
    this._bind();
    this._buildStreakList();
    this._buildKeyList();
    this._buildGunGrid();
    this._buildPickers();
    this.selectGun('vk71');
    this.refreshLoadout();
  }

  /* ---------------------------------------------------------------- bind */
  _bind() {
    const c = this.cfg;
    document.querySelectorAll('#tabs .tab').forEach(t => {
      t.addEventListener('click', () => {
        document.querySelectorAll('#tabs .tab').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.pane').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        document.querySelector(`.pane[data-pane="${t.dataset.tab}"]`).classList.add('active');
        this.g.audio && this.g.audio.play('uiClick', { vol: 0.4 });
        if (t.dataset.tab === 'loadout') this.refreshLoadout();
      });
    });

    const slider = (id, out, key, fmt, scale) => {
      const el = $(id), o = $(out);
      const upd = () => {
        const v = Number(el.value) * (scale || 1);
        c[key] = v;
        o.textContent = fmt ? fmt(v) : v;
        this.onConfigChange && this.onConfigChange(key, v);
      };
      el.addEventListener('input', upd);
      upd();
    };
    slider('cfgEnemies', 'outEnemies', 'enemies');
    slider('cfgFriends', 'outFriends', 'friends');
    slider('cfgScore', 'outScore', 'scoreLimit');
    slider('cfgTime', 'outTime', 'timeLimit', v => v + ':00');
    slider('cfgSens', 'outSens', 'sensitivity', v => v.toFixed(2), 0.01);
    slider('cfgAds', 'outAds', 'adsMult', v => v.toFixed(2), 0.01);
    slider('cfgFov', 'outFov', 'fov', v => v + '°');
    slider('cfgVol', 'outVol', 'volume', v => Math.round(v * 100) + '%', 0.01);

    $('diffSel').addEventListener('click', e => {
      const b = e.target.closest('.diff-b'); if (!b) return;
      $('diffSel').querySelectorAll('.diff-b').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      c.difficulty = Number(b.dataset.diff);
      this.g.audio && this.g.audio.play('uiSelect', { vol: 0.4 });
    });

    $('devSel').addEventListener('click', e => {
      const b = e.target.closest('.dev-b'); if (!b) return;
      $('devSel').querySelectorAll('.dev-b').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      c.device = b.dataset.dev;
      this.onConfigChange && this.onConfigChange('device', c.device);
      this.g.audio && this.g.audio.play('uiSelect', { vol: 0.4 });
    });

    const tg = (id, key) => {
      const el = $(id);
      el.checked = c[key];
      el.addEventListener('change', () => { c[key] = el.checked; this.onConfigChange && this.onConfigChange(key, el.checked); });
    };
    tg('tgInvert', 'invert'); tg('tgHoldAds', 'holdAds');
    tg('tgHoldSprint', 'holdSprint'); tg('tgShadows', 'shadows');

    $('deployBtn').addEventListener('click', () => this.g.deploy());
    window.addEventListener('keydown', e => {
      if (!this.visible) return;
      if (e.code === 'Enter') { e.preventDefault(); this.g.deploy(); }
    });
  }

  _buildStreakList() {
    $('streakList').innerHTML = STREAKS.map(s =>
      `<li><span class="sk-n">${s.cost}</span>
        <svg class="sk-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
          stroke-linecap="round" stroke-linejoin="round"><path d="${STREAK_ICONS[s.icon]}"/></svg>
        <b>${s.name}</b><i>${s.desc}</i></li>`).join('') +
      `<li class="team-asset"><span class="sk-n">${TEAM_STRIKE.key}</span>
        <svg class="sk-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
          stroke-linecap="round" stroke-linejoin="round"><path d="${STREAK_ICONS[TEAM_STRIKE.icon]}"/></svg>
        <b>${TEAM_STRIKE.name}</b><i>${TEAM_STRIKE.desc}</i></li>`;
  }

  _buildKeyList() {
    $('keyList').innerHTML = CONTROL_LEGEND.map(k => k.grp
      ? `<div class="keyrow grp">${k.grp}</div>`
      : `<div class="keyrow"><span class="k">${k.k}</span><span class="d">${k.d}</span></div>`).join('');
  }

  _buildGunGrid() {
    const grid = $('gunGrid');
    grid.innerHTML = '';
    $('gunCount').textContent = PRIMARIES.length + ' AVAILABLE';
    this.cards = PRIMARIES.map(w => {
      const d = document.createElement('div');
      d.className = 'gcard';
      d.dataset.id = w.id;
      d.innerHTML = `<div class="gc-top"><span class="gc-name">${w.name}</span><span class="gc-cls">${w.cls}</span></div>
        <canvas width="300" height="82"></canvas>
        <div class="gc-meta"><span>MAG <em>${w.mag}</em></span><span>RPM <em>${w.rpm}</em></span>
          <span>OPTIC <em>${w.optic}</em></span><span>SPRINT <em>${w.sprintSpeed.toFixed(1)}</em></span></div>`;
      d.addEventListener('click', () => { this.selectGun(w.id); this.g.audio && this.g.audio.play('uiSelect', { vol: 0.4 }); });
      grid.appendChild(d);
      const cv = d.querySelector('canvas');
      this.studio.draw(cv, w, 0.62, 0.16);
      return { el: d, def: w, canvas: cv };
    });
  }

  _buildPickers() {
    const mk = (host, list, key, isLethal) => {
      const el = $(host);
      el.innerHTML = '';
      for (const w of list) {
        const b = document.createElement('button');
        b.textContent = w.name;
        b.dataset.id = w.id;
        b.addEventListener('click', () => {
          this.cfg[key] = w.id;
          if (key === 'primary') this.selectGun(w.id);
          this.refreshLoadout();
          this.g.audio && this.g.audio.play('uiSelect', { vol: 0.4 });
        });
        el.appendChild(b);
      }
    };
    mk('pickPrimary', PRIMARIES, 'primary');
    mk('pickSecondary', SECONDARIES, 'secondary');
    mk('pickLethal', Object.values(LETHALS), 'lethal', true);
  }

  /* ---------------------------------------------------------------- guns */
  selectGun(id) {
    this.selected = id;
    this.cfg.primary = id;
    const w = WEAPONS[id];
    for (const c of this.cards) c.el.classList.toggle('active', c.def.id === id);
    $('gdName').textContent = w.name;
    $('gdClass').textContent = w.cls;
    $('gdStats').innerHTML = [
      ['DAMAGE', w.bars.damage], ['FIRE RATE', w.bars.fireRate], ['RANGE', w.bars.range],
      ['MOBILITY', w.bars.mobility], ['ACCURACY', w.bars.accuracy],
    ].map(([k, v]) => `<div class="statrow"><span class="s-k">${k}</span>
      <span class="s-t"><span class="s-f" style="width:${v}%"></span></span>
      <span class="s-v">${v}</span></div>`).join('');
    const t10 = Math.round(ttk(w, 10)), t30 = Math.round(ttk(w, 30));
    $('gdDesc').innerHTML = `${w.desc}
      <div class="spec">
        <span>MAGAZINE <b>${w.mag}</b></span><span>RESERVE <b>${w.reserve}</b></span>
        <span>RPM <b>${w.rpm}</b></span><span>MODE <b>${w.fire}</b></span>
        <span>OPTIC <b>${w.optic}</b></span><span>ADS <b>${(w.ads.time * 1000).toFixed(0)} ms</b></span>
        <span>SPRINT <b>${w.sprintSpeed.toFixed(2)} m/s</b></span><span>RELOAD <b>${w.reload.empty.toFixed(2)} s</b></span>
        <span>STK @10m <b>${stk(w, 10)}</b></span><span>STK @30m <b>${stk(w, 30)}</b></span>
        <span>TTK @10m <b>${t10} ms</b></span><span>TTK @30m <b>${t30} ms</b></span>
        <span>DMG <b>${w.damage.near}→${w.damage.far}</b></span><span>HEADSHOT <b>×${w.headMult}</b></span>
      </div>`;
    this.refreshLoadout();
  }

  refreshLoadout() {
    const c = this.cfg;
    const p = WEAPONS[c.primary], s = WEAPONS[c.secondary], l = LETHALS[c.lethal];
    $('loPrimary').textContent = p.name;
    $('loSecondary').textContent = s.name;
    $('loLethal').textContent = l.name;
    for (const [host, id] of [['pickPrimary', c.primary], ['pickSecondary', c.secondary], ['pickLethal', c.lethal]]) {
      $(host).querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.id === id));
    }
    const bars = loadoutBars(p, s, l);
    $('loBars').innerHTML = Object.entries(bars).map(([k, v]) =>
      `<div class="statrow"><span class="s-k">${k.toUpperCase()}</span>
       <span class="s-t"><span class="s-f" style="width:${v}%"></span></span>
       <span class="s-v">${v}</span></div>`).join('');
    $('loSummary').innerHTML = `
      <div class="row"><span>PRIMARY</span><b>${p.name} · ${p.cls}</b></div>
      <div class="row"><span>SECONDARY</span><b>${s.name} · ${s.cls}</b></div>
      <div class="row"><span>LETHAL</span><b>${l.name} ×${l.count}</b></div>
      <div class="row"><span>SPRINT SPEED</span><b>${p.sprintSpeed.toFixed(2)} m/s</b></div>
      <div class="row"><span>ADS TIME</span><b>${(p.ads.time * 1000).toFixed(0)} ms</b></div>
      <div class="row"><span>SWAP TO SECONDARY</span><b>${((p.swap.out + s.swap.in) * 1000).toFixed(0)} ms</b></div>
      <div class="row"><span>BLAST RADIUS</span><b>${l.radius.toFixed(1)} m</b></div>
      <div class="row"><span>${l.desc}</span><b></b></div>`;
    for (const [sel, def, lethal] of [['primary', p, false], ['secondary', s, false], ['lethal', l, true]]) {
      const cv = document.querySelector(`.lo-canvas[data-slot="${sel}"]`);
      if (cv) this.studio.draw(cv, def, 0.62, 0.16, lethal);
    }
  }

  /* ---------------------------------------------------------------- tacmap */
  drawTacMap(map) {
    const cv = $('tacmap'), c = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const pad = 22;
    const sx = (W - pad * 2) / MAP_W, sz = (H - pad * 2) / MAP_D;
    const s = Math.min(sx, sz);
    const ox = W / 2, oz = H / 2;
    const X = (x) => ox + x * s, Z = (z) => oz + z * s;

    c.clearRect(0, 0, W, H);
    // ground
    c.fillStyle = '#0d1412';
    c.fillRect(X(-HALF_W), Z(-HALF_D), MAP_W * s, MAP_D * s);
    // grid
    c.strokeStyle = 'rgba(126,231,135,0.055)'; c.lineWidth = 1;
    for (let x = -HALF_W; x <= HALF_W; x += 5) { c.beginPath(); c.moveTo(X(x), Z(-HALF_D)); c.lineTo(X(x), Z(HALF_D)); c.stroke(); }
    for (let z = -HALF_D; z <= HALF_D; z += 5) { c.beginPath(); c.moveTo(X(-HALF_W), Z(z)); c.lineTo(X(HALF_W), Z(z)); c.stroke(); }

    // structures, painted from the real collision boxes
    const sorted = map.boxes.filter(b => b.solid && b.vis && b.y1 - b.y0 > 0.5 &&
      Math.abs(b.x0) < HALF_W + 2 && Math.abs(b.z0) < HALF_D + 2)
      .sort((a, b) => a.y1 - b.y1);
    for (const b of sorted) {
      const h = b.y1 - b.y0;
      if (b.y0 > 4.5) continue;
      if (b.y0 > 2.5) c.fillStyle = 'rgba(47,90,114,0.85)';        // elevated
      else if (h > 2.6) c.fillStyle = 'rgba(57,71,77,0.92)';       // structure
      else c.fillStyle = 'rgba(93,111,95,0.85)';                   // hard cover
      c.fillRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * s, (b.z1 - b.z0) * s);
    }
    // outline
    c.strokeStyle = 'rgba(126,231,135,0.35)'; c.lineWidth = 1.4;
    c.strokeRect(X(-HALF_W), Z(-HALF_D), MAP_W * s, MAP_D * s);

    // spawns
    const mark = (list, col, label) => {
      for (const p of list) {
        c.fillStyle = col;
        c.beginPath(); c.arc(X(p.x), Z(p.z), 4, 0, 6.283); c.fill();
        c.strokeStyle = col; c.globalAlpha = 0.30;
        c.beginPath(); c.arc(X(p.x), Z(p.z), 9, 0, 6.283); c.stroke();
        c.globalAlpha = 1;
      }
      if (list.length) {
        const cx = list.reduce((a, p) => a + p.x, 0) / list.length;
        const cz = list.reduce((a, p) => a + p.z, 0) / list.length;
        c.fillStyle = col;
        c.font = '600 12px Bahnschrift, Segoe UI, sans-serif';
        c.textAlign = 'center';
        c.fillText(label, X(cx), Z(cz) - 16);
      }
    };
    mark(map.spawnsA, '#7ee787', 'ALLIED');
    mark(map.spawnsB, '#ff5b47', 'HOSTILE');

    // named zones
    c.font = '600 11px Bahnschrift, Segoe UI, sans-serif';
    c.fillStyle = 'rgba(216,226,223,0.55)';
    c.textAlign = 'center';
    const zones = [
      ['WEST COMPOUND', -21, -11], ['EAST COMPOUND', 21, 11],
      ['NORTH WAREHOUSE', -3.5, -16.5], ['SOUTH WAREHOUSE', 2, 16.5],
      ['CENTRE', 0, -5.5], ['ROAD', -28, 1.5], ['ROAD', 28, -1.5],
    ];
    for (const [n, x, z] of zones) c.fillText(n, X(x), Z(z));

    // compass rose
    c.strokeStyle = 'rgba(126,231,135,0.4)';
    c.fillStyle = 'rgba(126,231,135,0.75)';
    c.beginPath(); c.moveTo(W - 42, 54); c.lineTo(W - 36, 70); c.lineTo(W - 42, 65); c.lineTo(W - 48, 70); c.closePath(); c.fill();
    c.font = '600 11px monospace'; c.fillText('N', W - 42, 44);
  }

  /* ---------------------------------------------------------------- loop */
  update(dt) {
    if (!this.visible) return;
    this.t += dt;
    this.detailYaw += dt * 0.42;
    const w = WEAPONS[this.selected];
    if (w) this.studio.draw($('gunRender'), w, this.detailYaw, 0.15 + Math.sin(this.t * 0.5) * 0.10);
  }

  show(v) {
    this.visible = v;
    $('menu').classList.toggle('hidden', !v);
    if (v) this.drawTacMap(this.g.map);
  }
}
