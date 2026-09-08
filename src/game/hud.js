/* ============================================================================
   HUD.

   DOM + 2D canvas over the WebGL surface. The minimap and compass are canvases
   (they redraw every frame); everything else is DOM that only touches the
   document when a value actually changes, so a full match costs almost nothing
   in layout.

   The reticle is generated per weapon and its gap tracks live spread, so the
   crosshair is an honest readout of your cone rather than decoration.
   ========================================================================== */
import { clamp, lerp, fmtTime, wrapPi } from '../core/util.js';
import { STREAKS, STREAK_ICONS, TEAM_STRIKE } from './killstreaks.js';
import { MAP_W, MAP_D, HALF_W, HALF_D } from '../world/map.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

export class HUD {
  constructor(game) {
    this.g = game;
    this.el = {
      hud: $('hud'), reticle: $('reticleSvg'), hitmark: $('hitmarker'),
      scoreA: $('scoreA'), scoreB: $('scoreB'), timer: $('matchTimer'), mode: $('matchMode'),
      minimap: $('minimapCv'), compass: $('compassCv'), mmUav: $('mmUav'),
      killfeed: $('killfeed'), healthFill: $('healthFill'), healthNum: $('healthNum'),
      stance: $('stance'), armor: $('armor'),
      wName: $('wName'), wMag: $('wMag'), wRes: $('wRes'), wFire: $('wFire'), wLethal: $('wLethal'),
      streakRail: $('streakRail'), dmgDirs: $('dmgDirs'), hurtVig: $('hurtVig'), lowHp: $('lowHp'),
      scope: $('scope'), scopeSvg: $('scopeSvg'), banner: $('banner'), toast: $('streakToast'),
      scoreboard: $('scoreboard'), killcam: $('killcam'), kcKiller: $('kcKiller'),
      kcWep: $('kcWep'), kcCount: $('kcCount'), fps: $('fps'),
      gunnerHud: $('gunnerHud'), gunnerSvg: $('gunnerSvg'), ggTime: $('ggTime'),
      strikeSel: $('strikeSel'), strikeCv: $('strikeCv'), ssTitle: $('ssTitle'),
    };
    this.mm = this.el.minimap.getContext('2d');
    this.cp = this.el.compass.getContext('2d');
    this.cache = {};
    this.dmgIndicators = [];
    this.hitmarkTimer = 0;
    this.bannerTimer = 0;
    this.toasts = [];
    this.kf = [];
    this._buildStreakRail();
    this._buildScope();
    this._buildGunner();
    this._reticleKind = null;
    this.mmZoom = 3.1;
  }

  /* ---------------------------------------------------------------- setup */
  _buildStreakRail() {
    const rail = this.el.streakRail;
    rail.innerHTML = '';
    this.streakEls = STREAKS.map(s => {
      const d = document.createElement('div');
      d.className = 'sk';
      d.innerHTML = `<svg class="sk-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${STREAK_ICONS[s.icon]}"/></svg>
        <div class="sk-body"><div class="sk-nm">${s.name}</div><div class="sk-tr"><div class="sk-fl"></div></div></div>
        <div class="sk-key">${s.key}</div>`;
      rail.appendChild(d);
      return { el: d, fill: d.querySelector('.sk-fl'), def: s, ready: false };
    });
    /* The airstrike sits on the same rail but is not a streak: no progress bar,
       because there is no progress to make — your side either still has it or
       has spent it. */
    const t = document.createElement('div');
    t.className = 'sk team';
    t.innerHTML = `<svg class="sk-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${STREAK_ICONS[TEAM_STRIKE.icon]}"/></svg>
      <div class="sk-body"><div class="sk-nm">${TEAM_STRIKE.name}</div>
        <div class="sk-sub" id="tsState">READY</div></div>
      <div class="sk-key">${TEAM_STRIKE.key}</div>`;
    rail.appendChild(t);
    this.teamStrikeEl = { el: t, state: t.querySelector('#tsState'), ready: null };
  }

  /** @param ready is our side's one strike still in hand */
  setTeamStrike(ready) {
    const t = this.teamStrikeEl;
    if (!t || t.ready === ready) return;
    t.ready = ready;
    t.el.classList.toggle('ready', ready);
    t.el.classList.toggle('spent', !ready);
    t.state.textContent = ready ? 'READY' : 'SPENT';
  }

  _buildScope() {
    const s = this.el.scopeSvg;
    s.innerHTML = `
      <defs>
        <radialGradient id="scopeVig">
          <stop offset="0.60" stop-color="#000" stop-opacity="0"/>
          <stop offset="0.74" stop-color="#000" stop-opacity="0.55"/>
          <stop offset="0.80" stop-color="#000" stop-opacity="1"/>
        </radialGradient>
        <mask id="scopeHole">
          <rect width="1000" height="1000" fill="#fff"/>
          <circle cx="500" cy="500" r="368" fill="#000"/>
        </mask>
        <radialGradient id="lensGlow">
          <stop offset="0.72" stop-color="#7fd6ff" stop-opacity="0"/>
          <stop offset="0.97" stop-color="#7fd6ff" stop-opacity="0.16"/>
          <stop offset="1" stop-color="#7fd6ff" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="1000" height="1000" fill="#000" mask="url(#scopeHole)"/>
      <circle cx="500" cy="500" r="384" fill="url(#scopeVig)"/>
      <circle cx="500" cy="500" r="368" fill="url(#lensGlow)"/>
      <circle cx="500" cy="500" r="369" fill="none" stroke="#0d0f10" stroke-width="7"/>
      <g stroke="#0b0d0c" stroke-width="1.6" fill="none" opacity="0.95">
        <line x1="132" y1="500" x2="430" y2="500"/><line x1="570" y1="500" x2="868" y2="500"/>
        <line x1="500" y1="132" x2="500" y2="430"/><line x1="500" y1="570" x2="500" y2="868"/>
      </g>
      <g stroke="#0b0d0c" stroke-width="2.4" fill="none">
        <line x1="470" y1="500" x2="530" y2="500"/><line x1="500" y1="470" x2="500" y2="530"/>
      </g>
      <circle cx="500" cy="500" r="2.6" fill="#0b0d0c"/>
      <g id="milDots" fill="#0b0d0c"></g>
      <g stroke="#0b0d0c" stroke-width="1.2" opacity="0.8">
        <line x1="500" y1="150" x2="500" y2="176"/>
        <line x1="500" y1="824" x2="500" y2="850"/>
      </g>
      <text x="500" y="905" text-anchor="middle" fill="#3d4a42" font-size="18"
        font-family="monospace" letter-spacing="4">8x</text>
      <g id="scopeBreath" opacity="0"><text x="500" y="150" text-anchor="middle" fill="#7ee787"
        font-size="17" font-family="monospace" letter-spacing="3">HOLD</text></g>`;
    // mil-dot ladder below centre for holdover
    const dots = s.querySelector('#milDots');
    for (let i = 1; i <= 5; i++) {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', 500); c.setAttribute('cy', 500 + i * 46);
      c.setAttribute('r', i % 2 ? 3 : 4.4);
      dots.appendChild(c);
      for (const sx of [-1, 1]) {
        const h = document.createElementNS(SVGNS, 'circle');
        h.setAttribute('cx', 500 + sx * i * 46); h.setAttribute('cy', 500);
        h.setAttribute('r', 3);
        dots.appendChild(h);
      }
    }
    this.scopeBreath = s.querySelector('#scopeBreath');
  }

  _buildGunner() {
    this.el.gunnerSvg.innerHTML = `
      <rect width="1000" height="1000" fill="#04120a" opacity="0.30"/>
      <g stroke="#8effa6" stroke-width="2" fill="none" opacity="0.9">
        <circle cx="500" cy="500" r="118"/>
        <line x1="500" y1="330" x2="500" y2="440"/><line x1="500" y1="560" x2="500" y2="670"/>
        <line x1="330" y1="500" x2="440" y2="500"/><line x1="560" y1="500" x2="670" y2="500"/>
        <path d="M300 300 L300 350 M300 300 L350 300 M700 300 L700 350 M700 300 L650 300
                 M300 700 L300 650 M300 700 L350 700 M700 700 L700 650 M700 700 L650 700"/>
      </g>
      <circle cx="500" cy="500" r="3" fill="#8effa6"/>
      <g opacity="0.5" stroke="#8effa6" stroke-width="1">
        ${Array.from({ length: 24 }, (_, i) => `<line x1="0" y1="${i * 42}" x2="1000" y2="${i * 42}"/>`).join('')}
      </g>`;
  }

  /* ---------------------------------------------------------------- reticle */
  setWeapon(def, lethalName, lethalCount) {
    this.set('wName', def.name);
    this.set('wFire', def.fire + (def.optic ? ' · ' + def.optic : ''));
    if (lethalName !== undefined) this.set('wLethal', lethalName + ' ×' + lethalCount);
    if (this._reticleKind !== def.reticle) {
      this._reticleKind = def.reticle;
      this._buildReticle(def.reticle);
    }
  }

  _buildReticle(kind) {
    const r = this.el.reticle;
    r.innerHTML = '';
    const mk = (tag, attrs) => {
      const e = document.createElementNS(SVGNS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      r.appendChild(e); return e;
    };
    this.retLines = [];
    if (kind === 'shotgun') {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const l = mk('line', { class: 'rl', x1: 0, y1: 0, x2: 0, y2: 0 });
        this.retLines.push({ el: l, ax: Math.cos(a), ay: Math.sin(a), len: 7 });
      }
    } else if (kind === 'sniper') {
      // scoped reticle lives in the scope overlay; hip-fire gets a wide cross
      for (const [ax, ay] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const l = mk('line', { class: 'rl', x1: 0, y1: 0, x2: 0, y2: 0 });
        this.retLines.push({ el: l, ax, ay, len: 9 });
      }
    } else {
      for (const [ax, ay] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const l = mk('line', { class: 'rl', x1: 0, y1: 0, x2: 0, y2: 0 });
        this.retLines.push({ el: l, ax, ay, len: kind === 'dot' ? 6 : 8 });
      }
      if (kind === 'dot' || kind === 'holo') mk('circle', { class: 'rdot', cx: 0, cy: 0, r: 1.6 });
    }
    this.retDotEl = r.querySelector('.rdot');
  }

  /** @param spreadPx radius in reticle units (viewBox -50..50 spans 120 px) */
  updateReticle(spreadPx, adsW, visible, hitTeam) {
    this.el.reticle.parentElement.style.opacity = visible ? (1 - adsW * 0.75) : 0;
    for (const l of this.retLines) {
      const g = spreadPx;
      l.el.setAttribute('x1', l.ax * g);
      l.el.setAttribute('y1', l.ay * g);
      l.el.setAttribute('x2', l.ax * (g + l.len));
      l.el.setAttribute('y2', l.ay * (g + l.len));
      l.el.style.stroke = hitTeam ? '#ff5b47' : '#e9fff0';
    }
    if (this.retDotEl) this.retDotEl.style.opacity = adsW > 0.5 ? 1 : 0.85;
  }

  hitmarker(headshot, kill) {
    const h = this.el.hitmark;
    h.className = '';
    h.classList.add('on');
    if (kill) h.classList.add('kill');
    else if (headshot) h.classList.add('hs');
    this.hitmarkTimer = kill ? 0.34 : 0.14;
    h.style.transform = 'translate(-50%,-50%) scale(' + (kill ? 1.35 : headshot ? 1.14 : 1) + ')';
  }

  /* ---------------------------------------------------------------- values */
  set(key, val) {
    if (this.cache[key] === val) return;
    this.cache[key] = val;
    const e = this.el[key];
    if (e) e.textContent = val;
  }

  setVitals(hp, maxHp, stance, plates) {
    const pct = clamp(hp / maxHp, 0, 1);
    if (this.cache.hpPct !== pct) {
      this.cache.hpPct = pct;
      this.el.healthFill.style.width = (pct * 100) + '%';
      this.el.healthFill.classList.toggle('low', pct < 0.35);
    }
    this.set('healthNum', Math.max(0, Math.ceil(hp)));
    if (this.cache.stance !== stance) {
      this.cache.stance = stance;
      this.el.stance.textContent = stance;
      this.el.stance.className = 'stance' + (stance === 'CROUCH' ? ' crouch' : stance === 'SPRINT' ? ' sprint' : '');
    }
    if (this.cache.plates !== plates) {
      this.cache.plates = plates;
      this.el.armor.innerHTML = '<i class="on"></i>'.repeat(plates) + '<i></i>'.repeat(3 - plates);
    }
    this.el.lowHp.style.opacity = pct < 0.32 ? 1 : 0;
  }

  setAmmo(mag, reserve, low) {
    this.set('wMag', mag);
    this.set('wRes', reserve);
    this.el.wMag.classList.toggle('lowammo', low);
  }
  setLethal(name, count) {
    this.set('wLethal', name + ' ×' + count);
    this.el.wLethal.classList.toggle('ready', count > 0);
  }

  setScore(a, b, timeLeft, modeText) {
    this.set('scoreA', a); this.set('scoreB', b);
    const t = fmtTime(timeLeft);
    if (this.cache.timer !== t) {
      this.cache.timer = t;
      this.el.timer.textContent = t;
      this.el.timer.classList.toggle('crit', timeLeft < 30);
    }
    this.set('mode', modeText);
  }

  setStreaks(kills) {
    for (const s of this.streakEls) {
      const p = clamp(kills / s.def.cost, 0, 1);
      const ready = kills >= s.def.cost;
      if (s._p !== p) { s._p = p; s.fill.style.width = (p * 100) + '%'; }
      if (s.ready !== ready) { s.ready = ready; s.el.classList.toggle('ready', ready); }
    }
  }

  /* ---------------------------------------------------------------- killfeed */
  addKill(killerName, killerTeam, victimName, victimTeam, weaponName, headshot, mine) {
    const d = document.createElement('div');
    d.className = 'kf' + (mine ? ' mine' : '');
    const kc = killerTeam === 'A' ? 'a' : 'b';
    const vc = victimTeam === 'A' ? 'a' : 'b';
    d.innerHTML = `<span class="n ${kc}">${killerName}</span>`
      + `<svg class="wi" viewBox="0 0 40 14" fill="none" stroke="#c9d6d1" stroke-width="1.3">
           <path d="M3 8h20l3-3h9M8 8v3M23 5v3M14 8v2"/></svg>`
      + (headshot ? '<span class="hs">HS</span>' : '')
      + `<span class="n ${vc}">${victimName}</span>`;
    this.el.killfeed.appendChild(d);
    this.kf.push({ el: d, t: 0 });
    while (this.kf.length > 6) { const o = this.kf.shift(); o.el.remove(); }
  }

  banner(text, sub, bad) {
    this.el.banner.innerHTML = `<div class="ban${bad ? ' bad' : ''}">${text}</div>`
      + (sub ? `<div class="ban sub">${sub}</div>` : '');
    this.bannerTimer = 2.6;
  }

  streakToast(def) {
    const d = document.createElement('div');
    d.className = 'stoast';
    d.innerHTML = `<svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round"><path d="${STREAK_ICONS[def.icon]}"/></svg>
      <b>${def.name}</b><i>READY · ${def.key}</i>`;
    this.el.toast.appendChild(d);
    this.toasts.push({ el: d, t: 0 });
  }

  damageDirection(angleRad) {
    const d = document.createElement('div');
    d.className = 'ddir';
    d.style.transform = `rotate(${angleRad}rad)`;
    d.innerHTML = `<svg viewBox="-100 -100 200 200"><path d="M-26 -76 L0 -94 L26 -76 L14 -68 L0 -76 L-14 -68 Z"/></svg>`;
    this.el.dmgDirs.appendChild(d);
    requestAnimationFrame(() => d.classList.add('on'));
    this.dmgIndicators.push({ el: d, t: 0 });
    this.el.hurtVig.style.opacity = 0.85;
  }

  /* ---------------------------------------------------------------- scope */
  setScope(on, breathHeld) {
    this.el.scope.classList.toggle('hidden', !on);
    if (this.scopeBreath) this.scopeBreath.setAttribute('opacity', breathHeld ? '1' : '0');
  }
  setGunner(on) { this.el.gunnerHud.classList.toggle('hidden', !on); }
  setGunnerTime(t) { this.set('ggTime', Math.ceil(t)); }

  /* ---------------------------------------------------------------- killcam */
  showKillcam(killerName, weaponName) {
    this.el.killcam.classList.remove('hidden');
    this.el.kcKiller.textContent = killerName;
    this.el.kcWep.textContent = weaponName;
  }
  setKillcamCount(n) { this.set('kcCount', Math.max(0, Math.ceil(n))); }
  hideKillcam() { this.el.killcam.classList.add('hidden'); }

  /* ---------------------------------------------------------------- board */
  showScoreboard(show) { this.el.scoreboard.classList.toggle('hidden', !show); }

  renderScoreboard(actors, scoreA, scoreB, limit, localActor) {
    const rows = (team) => actors.filter(a => a.team === team)
      .sort((x, y) => y.kills - x.kills || x.deaths - y.deaths)
      .map((a, i) => `<div class="sb-r${a === localActor ? ' me' : ''}">
        <span class="rk">${i + 1}</span><span class="n">${a.name}</span>
        <span class="v">${a.kills}</span><span class="v">${a.deaths}</span>
        <span class="v">${a.deaths ? (a.kills / a.deaths).toFixed(2) : a.kills.toFixed(2)}</span>
        <span class="st${a.alive ? '' : ' dead'}">${a.alive ? (a.streak >= 3 ? 'STREAK ' + a.streak : 'ALIVE') : 'DOWN'}</span>
      </div>`).join('');
    const hd = `<div class="sb-r hd"><span></span><span>OPERATOR</span><span class="v">K</span>
      <span class="v">D</span><span class="v">K/D</span><span class="st">STATUS</span></div>`;
    this.el.scoreboard.innerHTML = `
      <div class="sb-hd"><h3>TEAM DEATHMATCH</h3><span class="sb-sc">
        <span style="color:var(--acc)">${scoreA}</span> / <span style="color:var(--hos)">${scoreB}</span>
        &nbsp;<span style="color:var(--ink-faint)">→ ${limit}</span></span></div>
      <div class="sb-team a"><h4>ALLIED</h4>${hd}${rows('A')}</div>
      <div class="sb-team b"><h4>HOSTILE</h4>${hd}${rows('B')}</div>`;
    return this.el.scoreboard.innerHTML;
  }

  /* ---------------------------------------------------------------- draw */
  update(dt, st) {
    /* hitmarker */
    if (this.hitmarkTimer > 0) {
      this.hitmarkTimer -= dt;
      if (this.hitmarkTimer <= 0) this.el.hitmark.classList.remove('on');
    }
    /* banner */
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.el.banner.innerHTML = '';
    }
    /* toasts */
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.t += dt;
      if (t.t > 3.4) { t.el.remove(); this.toasts.splice(i, 1); }
      else if (t.t > 2.9) t.el.style.opacity = 1 - (t.t - 2.9) / 0.5;
    }
    /* killfeed ageing */
    for (let i = this.kf.length - 1; i >= 0; i--) {
      const k = this.kf[i];
      k.t += dt;
      if (k.t > 7) { k.el.remove(); this.kf.splice(i, 1); }
      else if (k.t > 6) k.el.style.opacity = 1 - (k.t - 6);
    }
    /* damage indicators */
    let anyDmg = false;
    for (let i = this.dmgIndicators.length - 1; i >= 0; i--) {
      const d = this.dmgIndicators[i];
      d.t += dt;
      if (d.t > 1.5) { d.el.remove(); this.dmgIndicators.splice(i, 1); }
      else { anyDmg = true; if (d.t > 0.8) d.el.classList.remove('on'); }
    }
    if (!anyDmg) this.el.hurtVig.style.opacity = 0;

    /* Both are full canvas repaints. Nothing on them changes meaningfully inside
       16 ms, so they run at half rate and give the frame budget back. */
    this._mapAcc = (this._mapAcc || 0) + dt;
    if (this._mapAcc >= 1 / 30) {
      this._mapAcc = 0;
      this.drawMinimap(st);
      this.drawCompass(st);
    }
  }

  drawMinimap(st) {
    const c = this.mm, W = this.el.minimap.width, H = this.el.minimap.height;
    c.clearRect(0, 0, W, H);
    const zoom = this.mmZoom;
    const cx = W / 2, cy = H / 2;
    const px = st.pos.x, pz = st.pos.z;
    const rot = -st.yaw;

    c.save();
    c.translate(cx, cy);
    c.rotate(rot);
    c.translate(-px * zoom, -pz * zoom);

    /* map footprint */
    c.fillStyle = 'rgba(20,30,26,0.55)';
    c.fillRect(-HALF_W * zoom, -HALF_D * zoom, MAP_W * zoom, MAP_D * zoom);

    /* structures */
    const boxes = this.g.map.boxes;
    c.lineWidth = 1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.solid || !b.vis) continue;
      const h = b.y1 - b.y0;
      if (h < 0.55) continue;
      if (b.y0 > 4.2) continue;
      if (b.x1 - b.x0 > 40 || b.z1 - b.z0 > 40) continue;
      c.fillStyle = h > 2.6 ? 'rgba(120,150,138,0.42)' : 'rgba(96,124,112,0.30)';
      c.fillRect(b.x0 * zoom, b.z0 * zoom, (b.x1 - b.x0) * zoom, (b.z1 - b.z0) * zoom);
    }

    /* actors */
    for (const a of st.actors) {
      if (!a.alive) continue;
      const mine = a.team === st.team;
      const shown = mine || a.mmVisible;
      if (!shown) continue;
      c.save();
      c.translate(a.pos.x * zoom, a.pos.z * zoom);
      c.rotate(a.yaw);
      c.fillStyle = a === st.self ? '#ffffff' : mine ? '#7ee787' : '#ff5b47';
      c.beginPath();
      c.moveTo(0, -5.2); c.lineTo(3.6, 4.0); c.lineTo(0, 2.0); c.lineTo(-3.6, 4.0);
      c.closePath(); c.fill();
      if (a.firingFlash > 0) {
        c.globalAlpha = clamp(a.firingFlash, 0, 1) * 0.8;
        c.strokeStyle = '#fff3b0'; c.lineWidth = 1.6;
        c.beginPath(); c.arc(0, 0, 8 + (1 - a.firingFlash) * 8, 0, 6.283); c.stroke();
        c.globalAlpha = 1;
      }
      c.restore();
    }

    /* markers */
    for (const m of st.markers || []) {
      c.save();
      c.translate(m.x * zoom, m.z * zoom);
      c.strokeStyle = m.color; c.lineWidth = 1.6;
      c.beginPath(); c.arc(0, 0, 6, 0, 6.283); c.stroke();
      c.beginPath(); c.moveTo(-9, 0); c.lineTo(9, 0); c.moveTo(0, -9); c.lineTo(0, 9); c.stroke();
      c.restore();
    }

    c.restore();

    /* facing cone */
    c.save();
    c.translate(cx, cy);
    const grd = c.createRadialGradient(0, 0, 2, 0, 0, 62);
    grd.addColorStop(0, 'rgba(126,231,135,0.30)');
    grd.addColorStop(1, 'rgba(126,231,135,0)');
    c.fillStyle = grd;
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, 62, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    c.closePath(); c.fill();
    c.restore();

    /* frame ring */
    c.strokeStyle = 'rgba(126,231,135,0.25)';
    c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, W * 0.47, 0, 6.283); c.stroke();

    this.el.mmUav.classList.toggle('on', !!st.uav);
  }

  drawCompass(st) {
    const c = this.cp, W = this.el.compass.width, H = this.el.compass.height;
    c.clearRect(0, 0, W, H);
    const yaw = st.yaw;
    const pxPerDeg = W / 150;             // 150 degrees across the strip
    const cx = W / 2;
    c.font = '600 15px Bahnschrift, "DIN Alternate", Segoe UI, sans-serif';
    c.textAlign = 'center';
    const CARD = [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW']];
    const heading = ((yaw * 180 / Math.PI) % 360 + 360) % 360;
    for (let deg = -80; deg <= 80; deg += 5) {
      const abs = ((heading + deg) % 360 + 360) % 360;
      const x = cx + deg * pxPerDeg;
      if (x < -20 || x > W + 20) continue;
      const card = CARD.find(k => Math.abs(((abs - k[0] + 540) % 360) - 180) > 179.5);
      if (card) {
        c.fillStyle = card[1] === 'N' ? '#ff8b7a' : '#d8e2df';
        c.fillText(card[1], x, 15);
        c.fillStyle = 'rgba(216,226,223,0.55)';
        c.fillRect(x - 0.5, 20, 1, 8);
      } else if (Math.round(abs) % 15 === 0) {
        c.fillStyle = 'rgba(216,226,223,0.30)';
        c.fillRect(x - 0.5, 22, 1, 6);
      } else {
        c.fillStyle = 'rgba(216,226,223,0.14)';
        c.fillRect(x - 0.5, 24, 1, 4);
      }
    }
    // centre index + numeric heading
    c.fillStyle = '#7ee787';
    c.beginPath(); c.moveTo(cx, 30); c.lineTo(cx - 5, 34); c.lineTo(cx + 5, 34); c.closePath(); c.fill();
    c.font = '600 12px "Cascadia Mono", monospace';
    c.fillStyle = '#7ee787';
    c.fillText(String(Math.round(heading)).padStart(3, '0'), cx, 13);
  }

  setFps(text) { if (this.el.fps.textContent !== text) this.el.fps.textContent = text; }
  show(v) { this.el.hud.classList.toggle('hidden', !v); }

  clear() {
    this.el.killfeed.innerHTML = '';
    this.el.dmgDirs.innerHTML = '';
    this.el.banner.innerHTML = '';
    this.el.toast.innerHTML = '';
    this.kf.length = 0; this.dmgIndicators.length = 0; this.toasts.length = 0;
    this.el.hurtVig.style.opacity = 0;
    this.hideKillcam();
    this.setScope(false);
    this.setGunner(false);
  }
}
