/* ============================================================================
   Input.

   Two pointer profiles, because a trackpad is not a small mouse:

     mouse     raw movementX/Y, no smoothing, no acceleration. 1 count = 1 angle.
     trackpad  short swipes need to cover 180 degrees, so we apply a mild
               acceleration curve above a velocity threshold and a 2-frame
               smoothing window to hide the coarse, bursty deltas trackpads emit.

   Everything else is a plain edge-triggered key map so gameplay code can ask
   "was this pressed this frame" without tracking its own history.
   ========================================================================== */
import { clamp } from './util.js';

export const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  swap: ['KeyQ', 'Digit3'],
  primary: ['Digit1'],
  secondary: ['Digit2'],
  lethal: ['KeyG', 'Digit4'],
  melee: ['KeyV', 'KeyF'],
  scoreboard: ['Tab'],
  streak1: ['Digit5'],
  streak2: ['Digit6'],
  streak3: ['Digit7'],
  fireMode: ['KeyB'],
  pause: ['Escape'],
  hold: ['KeyH'],          // hold breath while scoped
};

export const CONTROL_LEGEND = [
  { grp: 'MOVEMENT' },
  { k: 'W A S D', d: 'Move' },
  { k: 'SHIFT', d: 'Sprint (tactical)' },
  { k: 'CTRL / C', d: 'Crouch' },
  { k: 'SPACE', d: 'Jump / vault low cover' },
  { grp: 'COMBAT' },
  { k: 'LMB', d: 'Fire' },
  { k: 'RMB', d: 'Aim down sight' },
  { k: 'R', d: 'Reload' },
  { k: '1 / 2', d: 'Primary / Secondary' },
  { k: 'Q', d: 'Quick swap weapon' },
  { k: 'G', d: 'Throw lethal (hold to cook)' },
  { k: 'V', d: 'Melee' },
  { k: 'B', d: 'Cycle fire mode' },
  { k: 'H', d: 'Hold breath (scoped)' },
  { grp: 'KILLSTREAKS' },
  { k: '5 / 6 / 7', d: 'Call in earned streak' },
  { grp: 'SYSTEM' },
  { k: 'TAB', d: 'Scoreboard' },
  { k: 'ESC', d: 'Pause' },
  { k: 'SPACE', d: 'Skip killcam' },
  { k: 'F3', d: 'Toggle performance readout' },
];

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false,
                   leftReleased: false, rightReleased: false, wheel: 0 };
    this.locked = false;
    this.device = 'mouse';
    this.sensitivity = 1.0;
    this.adsMult = 0.75;
    this.invert = false;
    this.holdAds = true;
    this.holdSprint = true;
    this.enabled = true;

    this._smoothX = [0, 0]; this._smoothY = [0, 0];
    this._rawEvents = 0;
    this._bind();
  }

  _bind() {
    const kd = (e) => {
      if (!this.enabled) return;
      if (e.code === 'Tab' || (e.code === 'Space' && this.locked)) e.preventDefault();
      if (e.repeat) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    };
    const ku = (e) => { this.keys.delete(e.code); this.released.add(e.code); };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });

    const md = (e) => {
      if (!this.locked) return;
      e.preventDefault();
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
      if (e.button === 1) this.pressed.add('MMB');
    };
    const mu = (e) => {
      if (e.button === 0) { this.mouse.left = false; this.mouse.leftReleased = true; }
      if (e.button === 2) { this.mouse.right = false; this.mouse.rightReleased = true; }
    };
    window.addEventListener('mousedown', md);
    window.addEventListener('mouseup', mu);
    window.addEventListener('contextmenu', e => { if (this.locked) e.preventDefault(); });
    window.addEventListener('wheel', e => { if (this.locked) { e.preventDefault(); this.mouse.wheel += Math.sign(e.deltaY); } },
      { passive: false });

    window.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      let dx = e.movementX || 0, dy = e.movementY || 0;
      // guard against the huge spurious delta some browsers emit on lock
      if (Math.abs(dx) > 400 || Math.abs(dy) > 400) return;
      this._rawEvents++;
      if (this.device === 'trackpad') {
        // acceleration: fast swipes travel further, slow ones stay precise
        const sp = Math.hypot(dx, dy);
        const gain = 1 + clamp((sp - 6) / 26, 0, 1) * 1.5;
        dx *= gain; dy *= gain;
        // 3-tap moving average smooths the coarse deltas trackpads produce
        this._smoothX.push(dx); this._smoothY.push(dy);
        if (this._smoothX.length > 3) { this._smoothX.shift(); this._smoothY.shift(); }
        dx = (this._smoothX[0] * 0.22 + this._smoothX[1] * 0.33 + this._smoothX[2] * 0.45);
        dy = (this._smoothY[0] * 0.22 + this._smoothY[1] * 0.33 + this._smoothY[2] * 0.45);
        dx *= 1.35; dy *= 1.35;
      }
      this.mouse.dx += dx;
      this.mouse.dy += dy;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.onLockChange && this.onLockChange(this.locked);
      if (!this.locked) { this.mouse.left = this.mouse.right = false; this.keys.clear(); }
    });
    // Some embedded contexts (and some kiosk browsers) refuse pointer lock
    // outright. Rather than trapping the player behind a pause card they can
    // never dismiss, remember that and let the match run without it.
    document.addEventListener('pointerlockerror', () => {
      this.locked = false;
      this.lockUnavailable = true;
      this.onLockChange && this.onLockChange(false);
    });
  }

  requestLock() {
    if (this.locked || this.lockUnavailable) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: this.device === 'mouse' });
      if (p && p.catch) p.catch(() => {
        try { this.canvas.requestPointerLock(); } catch (e) { this.lockUnavailable = true; }
      });
    } catch (e) { this.lockUnavailable = true; }
  }
  exitLock() { if (this.locked) document.exitPointerLock(); }

  down(action) {
    const codes = ACTIONS[action];
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }
  hit(action) {
    const codes = ACTIONS[action];
    for (const c of codes) if (this.pressed.has(c)) return true;
    return false;
  }
  up(action) {
    const codes = ACTIONS[action];
    for (const c of codes) if (this.released.has(c)) return true;
    return false;
  }

  /** Look delta in radians for this frame. */
  lookDelta(adsWeight) {
    const base = 0.0022 * this.sensitivity;
    const mult = 1 - (1 - this.adsMult) * adsWeight;
    const x = this.mouse.dx * base * mult;
    const y = this.mouse.dy * base * mult * (this.invert ? -1 : 1);
    return { x, y };
  }

  /** Call once per frame AFTER gameplay has read the state. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
    this.mouse.leftPressed = this.mouse.rightPressed = false;
    this.mouse.leftReleased = this.mouse.rightReleased = false;
  }
}
