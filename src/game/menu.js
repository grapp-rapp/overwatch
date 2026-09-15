/* ============================================================================
   Pre-match: briefing, armoury, loadout, controls.

   Weapon renders are real 3D — a dedicated small WebGL context draws each gun
   model and blits it into the card canvases, so the picture in the armoury is
   literally the weapon you will be holding.
   ========================================================================== */
import { SKINS, SKIN_BY_ID, loadProfile, isUnlocked, unlockSkin, equipSkin, skinWeapon, currentSkin, rarity, RARITY } from './skins.js';
import { drawCamoThumb } from './camo.js';
import * as THREE from 'three';
import { PRIMARIES, SECONDARIES, WEAPONS, LETHALS, loadoutBars, stk, ttk } from '../weapons/defs.js';
import { buildWeapon, buildLethal } from '../weapons/models.js';
import { STREAKS, STREAK_ICONS, TEAM_STRIKE } from './killstreaks.js';
import { CONTROL_LEGEND } from '../core/input.js';
import { previewMap } from '../world/map.js';
import { MAPS, MAP_ORDER } from '../world/maps/index.js';
import { clamp, lerp } from '../core/util.js';

const $ = (id) => document.getElementById(id);
/* rocks and logs are invisible boxes behind a visible shape; on a map they are cover */
const isCover = (b) => (b.mat === 'rock' || b.mat === 'bark') && b.y1 - b.y0 < 2.5;

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
  draw(target, def, yaw, pitch, lethal, zoom = 1) {
    const w = target.width, h = target.height;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.renderer.setSize(w, h, false);
    }
    this.holder.clear();
    const m = this.model(def, lethal);
    this.holder.add(m);
    /* frame the model in its own space. Measuring it where the last draw left
       it fed that draw's offset and rotation back in; once the same gun was
       drawn twice a frame at two angles (armoury + skins preview) the offset
       random-walked until the gun left the frame entirely. */
    this.holder.rotation.set(0, 0, 0);
    m.position.set(0, 0, 0);
    this.holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    m.position.set(-centre.x, -centre.y, -centre.z);
    this.holder.rotation.set(pitch, yaw, 0);
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    const dist = radius / Math.tan((30 * Math.PI / 180) / 2) * 1.30 / zoom;
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
      map: 'dustline', primary: 'vk71', secondary: 'm9', lethal: 'frag',
      device: 'mouse', sensitivity: 1.0, adsMult: 0.75, fov: 85, volume: 0.7,
      invert: false, holdAds: true, holdSprint: true, shadows: true, blood: true,
    };
    this.selected = 'vk71';
    this.detailYaw = 0.7;
    this.t = 0;
    this.tab = 'briefing';
    this.visible = false;
    this._bind();
    this._buildStreakList();
    this._buildMapPicker();
    this._buildKeyList();
    this._buildGunGrid();
    this._buildSkins();
    this._buildPickers();
    this.selectGun('vk71');
    this.refreshLoadout();
    this.selectMap(this.cfg.map);
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
        this.tab = t.dataset.tab;
        if (t.dataset.tab === 'skins') this.refreshSkins();
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
    tg('tgBlood', 'blood');

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

  /* ---------------------------------------------------------------- maps */
  _buildMapPicker() {
    this._previews = {};
    const host = $('mapSel');
    host.innerHTML = MAP_ORDER.map(id => {
      const d = MAPS[id];
      return '<button class="map-b" data-map="' + id + '"><span class="sw" style="background:' +
        (d.swatch || '#7ee787') + '"></span><b>' + d.name + '</b><i>' + (d.blurb || '') + '</i></button>';
    }).join('');
    host.addEventListener('click', e => {
      const b = e.target.closest('.map-b'); if (!b) return;
      this.selectMap(b.dataset.map);
      this.g.audio && this.g.audio.play('uiSelect', { vol: 0.4 });
    });
  }

  /** The map for the next deploy: highlight it, name it, draw its layout. */
  selectMap(id) {
    if (!MAPS[id]) id = 'dustline';
    this.cfg.map = id;
    const d = MAPS[id];
    $('mapSel').querySelectorAll('.map-b').forEach(x => x.classList.toggle('active', x.dataset.map === id));
    $('opName').textContent = d.name;
    $('mapPill').textContent = (d.code || 'MP_' + d.name) + ' · ' + d.w + '×' + d.d + 'm';
    this.drawTacMap(this.previewOf(id));
  }

  /** The built map if it is the one loaded, otherwise a layout-only preview. */
  previewOf(id) {
    if (this.g.map && this.g.map.id === id) return this.g.map;
    return this._previews[id] || (this._previews[id] = previewMap(MAPS[id]));
  }

  /* ---------------------------------------------------------------- tacmap */
  drawTacMap(map) {
    const cv = $('tacmap'), c = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const pad = 22;
    const sx = (W - pad * 2) / map.W, sz = (H - pad * 2) / map.D;
    const s = Math.min(sx, sz);
    const ox = W / 2, oz = H / 2;
    const X = (x) => ox + x * s, Z = (z) => oz + z * s;

    c.clearRect(0, 0, W, H);
    // ground
    c.fillStyle = '#0d1412';
    c.fillRect(X(-map.halfW), Z(-map.halfD), map.W * s, map.D * s);
    // grid
    c.strokeStyle = 'rgba(126,231,135,0.055)'; c.lineWidth = 1;
    for (let x = -map.halfW; x <= map.halfW; x += 5) { c.beginPath(); c.moveTo(X(x), Z(-map.halfD)); c.lineTo(X(x), Z(map.halfD)); c.stroke(); }
    for (let z = -map.halfD; z <= map.halfD; z += 5) { c.beginPath(); c.moveTo(X(-map.halfW), Z(z)); c.lineTo(X(map.halfW), Z(z)); c.stroke(); }

    // tree crowns first, so buildings and cover sit on top of them
    c.fillStyle = 'rgba(46,92,60,0.50)';
    for (const it of map.insts || []) {
      if (it.kind !== 'pine' && it.kind !== 'oak') continue;
      if (Math.abs(it.x) > map.halfW || Math.abs(it.z) > map.halfD) continue;
      c.beginPath(); c.arc(X(it.x), Z(it.z), Math.max(2.5, 1.5 * it.sx * s), 0, 6.283); c.fill();
    }
    // structures, painted from the real collision boxes
    const sorted = map.boxes.filter(b => b.solid && (b.vis || isCover(b)) && b.y1 - b.y0 > 0.5 &&
      Math.abs(b.x0) < map.halfW + 2 && Math.abs(b.z0) < map.halfD + 2)
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
    c.strokeRect(X(-map.halfW), Z(-map.halfD), map.W * s, map.D * s);

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
    for (const [n, x, z] of map.zones || []) c.fillText(n, X(x), Z(z));

    // compass rose
    c.strokeStyle = 'rgba(126,231,135,0.4)';
    c.fillStyle = 'rgba(126,231,135,0.75)';
    c.beginPath(); c.moveTo(W - 42, 54); c.lineTo(W - 36, 70); c.lineTo(W - 42, 65); c.lineTo(W - 48, 70); c.closePath(); c.fill();
    c.font = '600 11px monospace'; c.fillText('N', W - 42, 44);
  }

  /* ---------------------------------------------------------------- skins */
  _buildSkins() {
    this.profile = loadProfile();
    this.skinSel = this.profile.skin;
    this.skinFilter = 'all';
    this._thumbQ = [];
    const grid = $('skinGrid'), frag = document.createDocumentFragment();
    this.skinCards = SKINS.map(s => {
      const el = document.createElement('div'), r = rarity(s);
      el.className = 'skcard r-' + r;
      el.dataset.skin = s.id;
      el.innerHTML = '<canvas width="150" height="54"></canvas><div class="gc-top"><span class="gc-name">' + s.name +
        '</span></div><span class="sk-tag"></span>';
      el.addEventListener('click', () => { this.selectSkin(s.id); this.g.audio && this.g.audio.play('uiClick', { vol: 0.4 }); });
      frag.appendChild(el);
      return { s, el, r, cv: el.querySelector('canvas'), tag: el.querySelector('.sk-tag'), drawn: false };
    });
    grid.appendChild(frag);
    /* hundreds of cards: a swatch is drawn only once its card scrolls into view */
    const byEl = new Map(this.skinCards.map(c => [c.el, c]));
    this._thumbObs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const c = byEl.get(e.target);
        if (e.isIntersecting && c && !c.drawn) { c.drawn = true; this._thumbQ.push(c); this._thumbObs.unobserve(e.target); }
      }
    }, { root: grid, rootMargin: '160px' });
    for (const c of this.skinCards) this._thumbObs.observe(c.el);
    const count = { all: SKINS.length };
    for (const c of this.skinCards) count[c.r] = (count[c.r] || 0) + 1;
    $('skFilter').innerHTML = ['all', 'owned', ...RARITY].map(k => '<button class="sk-chip r-' + k + (k === 'all' ? ' active' : '') +
      '" data-f="' + k + '">' + k.toUpperCase() + (count[k] ? ' <i>' + count[k] + '</i>' : '') + '</button>').join('');
    $('skFilter').querySelectorAll('.sk-chip').forEach(b => b.addEventListener('click', () => {
      this.skinFilter = b.dataset.f;
      $('skFilter').querySelectorAll('.sk-chip').forEach(x => x.classList.toggle('active', x === b));
      this.refreshSkins();
      grid.scrollTop = 0;
      this.g.audio && this.g.audio.play('uiClick', { vol: 0.35 });
    }));
    $('skBtn').addEventListener('click', () => this.buySkin());
    this.refreshSkins();
  }
  refreshSkins() {
    const p = this.profile = loadProfile(), f = this.skinFilter || 'all';
    $('hsBank').textContent = '◆ ' + p.headshots + (p.headshots === 1 ? ' HEADSHOT' : ' HEADSHOTS');
    const tab = document.querySelector('#tabs .tab[data-tab="skins"]');    // your bank, always in sight
    if (tab) tab.innerHTML = 'SKINS <b class="tab-bank">◆ ' + p.headshots + '</b>';
    for (const c of this.skinCards) {
      const own = isUnlocked(p, c.s.id), eq = p.skin === c.s.id, n = c.s.cost;
      c.el.classList.toggle('locked', !own);
      c.el.classList.toggle('equipped', eq);
      c.el.hidden = !(f === 'all' || (f === 'owned' ? own : c.r === f));
      c.tag.className = 'sk-tag ' + (eq ? 'eq' : own ? 'own' : 'cost');
      c.tag.textContent = eq ? 'EQUIPPED' : own ? (n ? 'OWNED' : 'FREE') : '◆ ' + n;
    }
    // the first cards are in view at once; the observer brings in the rest as you scroll
    let seen = 0;
    for (const c of this.skinCards) {
      if (c.el.hidden) continue;
      if (++seen > 24) break;
      if (!c.drawn) { c.drawn = true; this._thumbQ.push(c); if (this._thumbObs) this._thumbObs.unobserve(c.el); }
    }
    this.selectSkin(this.skinSel);
  }
  selectSkin(id) {
    const s = SKIN_BY_ID[id]; if (!s) return;
    this.skinSel = id;
    const p = this.profile, own = isUnlocked(p, id), eq = p.skin === id, n = s.cost, short = n - p.headshots, r = rarity(s);
    for (const c of this.skinCards) c.el.classList.toggle('active', c.s.id === id);
    $('skName').textContent = s.name;
    const pill = $('skCost');
    pill.className = 'pill r-' + r;
    pill.textContent = r.toUpperCase() + ' · ' + (!n ? 'FREE' : own ? 'OWNED' : '◆ ' + n);
    $('skDesc').textContent = s.desc;
    const b = $('skBtn');
    b.disabled = eq || (!own && short > 0);
    b.textContent = eq ? 'EQUIPPED' : own ? 'EQUIP' : short <= 0 ? 'UNLOCK · ◆ ' + n : 'LOCKED';
    $('skNote').textContent = own || short <= 0 ? '' : short + ' more headshot kill' + (short > 1 ? 's' : '') + ' to unlock';
  }
  buySkin() {
    const id = this.skinSel, p = loadProfile();
    if (!isUnlocked(p, id) && !unlockSkin(p, id).ok) return;
    equipSkin(p, id);
    this.g.audio && this.g.audio.play('uiClick', { vol: 0.6 });
    this.refreshSkins();
  }

  /* ---------------------------------------------------------------- loop */
  update(dt) {
    if (!this.visible) return;
    this.t += dt;
    this.detailYaw += dt * 0.42;
    const w = WEAPONS[this.selected];
    if (w && this.profile) skinWeapon(this.studio.model(w), currentSkin(this.profile));
    if (w) this.studio.draw($('gunRender'), w, this.detailYaw, 0.15 + Math.sin(this.t * 0.5) * 0.10);
    if (this.tab === 'skins') {
      // the previewed skin on your primary, then back to the one you wear
      const pw = WEAPONS[this.cfg.primary], sk = SKIN_BY_ID[this.skinSel];
      if (pw && sk) {
        skinWeapon(this.studio.model(pw), sk);
        this.studio.draw($('skinRender'), pw, this.detailYaw, 0.12 + Math.sin(this.t * 0.5) * 0.08, false, 1.5);
        skinWeapon(this.studio.model(pw), currentSkin(this.profile));
      }
      // swatches for the cards that have scrolled into view, a few a frame
      for (let k = 0; k < 4 && this._thumbQ.length; k++) { const c = this._thumbQ.shift(); drawSwatch(c.cv, c.s); }
    }
  }

  show(v) {
    this.visible = v;
    $('menu').classList.toggle('hidden', !v);
    if (v) { this.selectMap(this.cfg.map); if (this.skinCards) this.refreshSkins(); }
  }
}

/* a skin's card swatch: its real pattern, tinted the way the material tints it */
function drawSwatch(cv, s) {
  const ctx = cv.getContext('2d'), w = cv.width, h = cv.height, L = s.look || {};
  drawCamoThumb(s, cv);
  if (L.color !== undefined) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = '#' + L.color.toString(16).padStart(6, '0'); ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0.35, 'rgba(255,255,255,0)'); g.addColorStop(0.5, L.env ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.08)'); g.addColorStop(0.65, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}
