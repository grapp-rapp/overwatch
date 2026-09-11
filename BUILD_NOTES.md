# BUILD NOTES — OVERWATCH: BLACKOUT

What this is, how it was verified, what broke along the way, and what is still
imperfect. Numbers below are measured, not estimated; where a number is noisy I
say so and give the spread.

---

## 1. How to run it

No build step. It is a static site.

```bash
npm start          # node tools/serve.mjs  → http://localhost:8099
```

Any static host works — the whole game is `index.html`, `src/`, and `assets/`
(3.5 MB, of which 2.1 MB is the character model). There is no bundler, no
transpiler and no server-side anything; ES modules are loaded natively through
an import map, and three.js is vendored into `assets/lib/` so nothing is fetched
from a CDN at play time.

The one server requirement is that `.glb` is served with a sensible content type
and modules with `text/javascript` — `tools/serve.mjs` does both, as does any
normal static host.

---

## 2. Cold load

**Measured: 2.7 s – 6.0 s from navigation to the interactive loadout screen**
across repeated fresh loads on this machine. Budget was 10 s.

Stage breakdown from a representative load (logged by `progress()` in
`src/main.js`):

| Stage | Time |
|---|---|
| Renderer init | 24 ms |
| Procedural terrain, textures, navmesh, cover | 1138 ms |
| Lights | 3 ms |
| Character model download + parse (2.1 MB) | 184 ms |
| Audio synthesis (10 weapons × 5 variants + footsteps, impacts, mechanics, FX) | 2286 ms |
| Effects, viewmodel, HUD, menu | 369 ms |
| **Total** | **4012 ms** |

Two things were fixed to get here:

- **Boot originally hung forever** in a hidden tab. `progress()` awaited
  `requestAnimationFrame`, which a backgrounded tab throttles to a standstill.
- **Boot then took 12.5 s.** The replacement yielded with `setTimeout(0)`, which
  a hidden tab clamps to ~1 s — eleven yields became nine seconds of nothing.
  Now it yields through a `MessageChannel` round trip (`yieldToBrowser()` in
  `src/core/util.js`), which is a task, not a timer, and is never throttled.
- Non-critical audio banks (distant-report variants, rotor, jet, ambience,
  large explosions) are baked **after** the menu is up, in the background.

---

## 3. Frame time

Target: 1920×1080, 60 fps. Rendered 1:1 — device pixel ratio is pinned to 1, so
1080p means 1080p and not 2400×1350.

Measurement method: `testPerformance()` in `tools/qa-browser.js`. It puts every
actor alive on the map, forces every bot to pull the trigger **every frame**
(~370 rounds/second — roughly twelve times a real firefight), discards 90 warm-up
frames so shader compilation is not counted as frame time, quiesces the vsync
loop so it does not contend with the measurement, then times 300–400 stepped
frames of the complete loop: AI, physics, animation, hit resolution, effects,
HUD, shadow pass and draw.

| Configuration | Median | Mean | p95 | Draw calls | Triangles |
|---|---|---|---|---|---|
| **Default roster — 9 actors** | **13.3 ms → 75 fps** | 13.7–16.2 ms | 22–30 ms | 196 | 135 k |
| Maximum roster — 15 actors | 22.8 ms → 44 fps | 23.4–25.3 ms | 40 ms | 295 | 226 k |

**The default configuration holds 60 fps with headroom. The maximum roster
(9 hostiles + 5 friendlies + you, all firing continuously) does not** — it sits
around 44 fps in this environment.

Honest caveat on the environment: this was measured inside an Electron preview
pane sharing a GPU with the agent's own browser and other processes. Repeated
identical measurements of the same render varied between 8 ms and 17 ms — a ±50%
spread — so treat the absolute numbers as indicative and the *relative*
improvements below as the reliable part.

### What the optimisation actually bought

Starting point was 33.3 ms (30 fps) at max roster with 924 draw calls.

| Change | Effect |
|---|---|
| Merge each character's helmet/vest/holster into one mesh per material | 924 → 419 draw calls |
| Consolidate weapon materials (blued + dark + rails are one black metal) | fewer submeshes per gun |
| Pin device pixel ratio to 1 | 2400×1350 → 1920×1080 of fill |
| Shadow map 2048→1024, frustum 84×68 m → 52×44 m following the player, refreshed at 30 Hz | shadow pass ~10 ms → ~4.7 ms |
| Manual frustum culling of skinned operators (they carry `frustumCulled = false` because skinned bounds go stale, so three.js was drawing every soldier including those behind you) | ~40% fewer character draws |
| HUD minimap + compass repaint at 30 Hz | full canvas repaints halved |
| AI target acquisition at 15 Hz, staggered across the roster | ~2 ms of AI |
| **Weapon geometry prototypes cached and cloned** | removed a **1.7-second** hitch that occurred on every respawn, because `spawn()` was rebuilding the soldier's gun from extrusions each time |
| Allocation removed from the firing path; settled shell casings stop raycasting | p99 43 ms → 29 ms, max 1079 ms → 43 ms |
| Shadow casting stops at 12 m; visor sub-mesh dropped past 18 m | 335 → 295 draw calls |

Net: **33.3 ms → 22.8 ms at max roster, 924 → 295 draw calls, and the multi-hundred-millisecond hitches are gone.**

---

## 4. How the game was tested

A pointer-locked FPS cannot be driven by synthetic mouse events here — the
embedded pane refuses pointer lock outright. So instead of faking input, the
harness (`tools/qa-browser.js`) **drives the simulation through the same
functions the input layer calls**. Every assertion below exercises real game
code: real raycasts against real animated capsules, real collision, real damage.

`window.__step(dt)` runs one complete frame of the real loop with a fixed
timestep, so a whole match can be simulated without depending on vsync.

Run it from the console on a loaded page:

```js
const QA = await import('/tools/qa-browser.js');
await QA.runAll();
```

### Results

| Test | Result | Detail |
|---|---|---|
| Cold boot | **PASS** | 2.7–6.0 s across repeated fresh loads, budget 10 s |
| Ballistics table | **PASS** | Damage falloff monotonic for all 10 weapons; **8 distinct time-to-kill values** at 10 m, so the guns are genuinely different and not reskins |
| Recoil is learnable | **PASS** | Across 24 runs per weapon, the run-to-run spread of the 10th shot's position is **3.2%–6.4%** of the pattern's own displacement. The pattern dominates the noise, which is what makes it something you can learn to hold |
| Line of sight matches the bullet raycast | **PASS** | 3,996 random sightlines, **0 mismatches** between what the AI's LOS test says and where a bullet actually stops. 87% of random cross-map sightlines are blocked — the map has real cover |
| Hit zones follow the skeleton | **PASS** | Probes at 1.68 / 1.35 / 1.02 / 0.55 m resolve to `head` / `chest` / `gut` / `legRU` against the *animated* capsules |
| Every weapon fires, cycles, reloads, registers | **PASS** | All 10. Damage per shot matches the design table exactly (VK-71 33, GRAD-74 38, HAMMER 35, KESTREL 58, HAND CANNON 64, M9 28) |
| Spawn safety | **PASS** | 600 spawn selections: **0 inside geometry, 0 in an enemy's line of sight** |
| AI behaviour | **PASS** | 8 bots, all move, 4–6 hold live paths, 429 cover points on the map, states observed across runs: PATROL / ALERT / PUSH / ENGAGE / COVER / FLANK. **0 bots ever fire without line of sight** |
| Map connectivity and wedges | **PASS** | 66-leg scripted route, **0 legs with no route**; 1,701 standable cells swept, **0 from which the capsule cannot escape** |
| Killcam replay | **PASS** | 200 recorded frames over 9.9 s, 82 shot events, camera travels 19.8 m riding the killer |
| Full match, end to end | **PASS** | See below |

### Every control, through the real input path

The tests above drive gameplay functions directly. This one drives the *input
layer* — it pushes key codes and mouse buttons into `Input` and lets
`updateActor` read them exactly as it does from a real keyboard, so the binding,
the gating and the state machine are all exercised:

| Control | Result |
|---|---|
| W / S / D | 3.84 m forward, 3.55 m back, 3.85 m right in one second |
| Shift + W | Sprint engages, stance reads SPRINT |
| Ctrl | Crouch reaches 1.0, eye height drops 1.63 m → 1.08 m, stance reads CROUCH |
| Space | Jump apex 0.83 m — above the 0.55 m window sill, below the 1.1 m centre pad |
| LMB | Fires, magazine counts down, shots register |
| RMB | ADS reaches 1.0, camera FOV 85° → 46° |
| R | Reload completes, magazine refilled from reserve (210 → 198) |
| 2 then 1 | Swaps to the M9 SIDEARM and back to the VK-71 |
| G (hold, release) | Cooks while held, throws on release, count 2 → 1, HUD updates. The frag flies a 3.73 m apex arc over 20.4 m, bounces, and detonates on its fuse |
| V | Melee swing registers |
| Tab | Scoreboard shows |

### The full match

7,133 frames — 119 seconds of simulated play — 9 actors, REGULAR difficulty,
score limit 25. Final score **26–14, VICTORY**. Every required event occurred:

`playerShot · playerHit · playerKill · playerDamaged · playerDied · killcam ·
respawned · reload · grenade · hitmarker · adsUsed · botKill · result`

Final scoreboard, every operator scoring:

```
A YOU        3/3      B IRON-01     3/4
A STORM-01   1/6      B REAPER-02   2/7
A KILO-01    3/3      B ASH-9       1/4
A HAVOC-11  19/3      B GHOST-02    0/5
                      B ECHO-X      7/5
```

Killstreaks were exercised separately: all five spawn and run; UAV goes online,
the attack helicopter and stealth bomber both damage hostiles, the airstrike
drops its string of bombs along the painted line, and the chopper gunner takes
over the camera.

Explosives were verified on open ground with everything else cleared: **165 dmg
at 0 m, 88 at 3 m, 42 at 5.5 m, 0 at 7.5 m** (radius 7.4), **0 through a compound
wall**, and a thrown frag flies a real ballistic arc, bounces, settles and
detonates on its fuse.

The sniper's breath mechanic was verified as a feature, not an accident: firing
the LONGBOW at 40 m, **4 of 8 shots hit while breathing normally and 7 of 8 with
the breath held**, at 105 damage per hit.

---

## 5. Map walk

`testMapWalk()` walks a 66-leg scripted route: the full perimeter, the road end
to end, over the centre pad, through both compounds at ground level, **up both
staircases and across both first floors**, into both warehouses and **up onto
both catwalks**, and up onto the stacked containers. Each leg is navigated the
way a player would — ask the navmesh for a route, then steer the real capsule
through the real collision code.

Two claims are reported separately on purpose:

- **Connectivity and wedges are properties of the map, and they gate the pass.**
  0 legs without a route. 1,701 standable cells swept by trying to walk out in
  8 directions from each — **0 cells the capsule cannot leave**. Floor heights
  reached span 0 m to 4.62 m, so the route genuinely visits the upper floors.
- **Traversal is a property of the harness's steering**, which is a plain
  seek-the-waypoint controller with a hop. It completes **60 of 66 legs (91%)**.
  The 6 it does not finish are descents and tight interior turns where the dumb
  controller oscillates; the route exists and a player walks it.

### Stuck geometry found, and what was done

Every one of these was a real defect, found by the walk and fixed:

1. **Both compound staircases were invisible to navigation.** Twelve 0.47 m
   treads cleared the 0.46 m step-up but were narrower than one navigation cell
   plus the agent's diameter, so no node ever sat on a tread. The first floors
   were walkable islands: the player could climb them and **no bot ever could**.
   Rebuilt as nine 0.92 m treads at a 0.40 m rise, running the long way down the
   west side. Both upper floors are now reachable — verified by pathing.
2. **The nav sampler disagreed with the player's own collision.** It required a
   single box to cover the whole agent disc, and it counted the *next stair
   tread* as a headroom obstruction. Both rules now match `groundHeight()`:
   support is any overlap, and anything low enough to step onto is not an
   obstacle.
3. **The centre pad's ramp treads were 0.55 m** — same problem, so the pad was
   an island. Widened to 0.95 m.
4. **The catwalk crate stack had 0.9 m risers**, double the step-up, so it was a
   player-only jump route. Replaced with a six-tread stair, and the guard rail
   was gapped where the stair lands (a rail across the landing blocked headroom
   and made it a staircase to nowhere).
5. **The container stack access** had the same 0.9 m crate problem. Rebuilt as a
   six-tread flight.
6. **Elevated surfaces were graph islands.** A container roof's nodes sit a cell
   back from the edge, so they were never grid-adjacent to the ground beside
   them: a bot that reached one could never path off it. Added explicit drop and
   mantle links (fall up to 2.85 m, mantle up to 1.15 m), with a clearance test
   that traces the *actual* movement — out horizontally at the upper level, then
   straight down — because tracing between the two surfaces passes through the
   ledge and rejects every legitimate drop. Navmesh components: **39 → ~10**,
   with 91% of walkable nodes in one connected component.
7. **Players could stand on roofs.** `groundHeight()` ignored the `standable`
   flag, so anything a body touched was a floor. It now respects it, which keeps
   the player and the AI in agreement about where a body can be.
8. **Upper-floor window sills were 0.80 m** — vaultable only just, and a mover
   could stall half on the ledge. Lowered to 0.55 m: still above the step-up so
   it must be vaulted, comfortably inside a jump. Bots now vault them (they set
   `wantJump` when the next waypoint is above the step-up allowance).

---

## 6. Other bugs found and fixed during the build

These are the ones worth recording, because each was a real defect in shipped
behaviour rather than a typo:

- **The kick from a shot was being applied to that shot.** The round left the
  barrel *after* the gun moved, so the first shot of every magazine missed its
  own crosshair — by 5° on the bolt gun, which made the sniper unusable and the
  hand cannon do literally zero damage in testing. `tryFire()` now snapshots the
  aim offset at the instant the trigger breaks, and the shot is resolved along
  that; the kick displaces the *next* round.
- **Centre-mass shots were being credited to the forearm.** An operator carries
  the weapon across the chest, so a clean chest shot geometrically strikes the
  arm first and got the 0.9× limb multiplier — the same aim producing two
  different times-to-kill for no visible reason. A head or torso capsule within
  0.42 m behind a limb hit now takes the credit.
- **Shadows never rendered at all.** With `shadowMap.autoUpdate = false`, the
  flag three.js actually checks is `renderer.shadowMap.needsUpdate`; the code
  was setting `light.shadow.needsUpdate`, which does nothing. Fixed — and then
  the lighting balance had to change too, because at hemisphere 1.05 against a
  2.55 sun the shadows were rendering correctly and were simply invisible. Now
  0.80 / 3.4, with interior fixtures scaled for physical falloff.
- **Contact shadows were invisible on dark ground** at 52% black. Raised to 68%
  with a tighter, darker core.
- **Match end and killcam scheduling used wall-clock `setTimeout`.** In a
  backgrounded tab the match would never end; in a synchronous simulation the
  timers never fired at all. All deferred work now runs on game time through
  `game.after(seconds, fn)`.
- **The A\* silently reported "no path" on long routes.** A linear-scan open set
  with an O(n) membership test and a fixed 9,000-iteration cap ran out of budget
  before reaching the goal on an 11 k-node graph. Replaced with a binary heap.
- **`mirrored()` looped forever.** It iterated `this.boxes` while pushing to it,
  so the bound outran the index. This hung the whole boot.
- **A gunner operator could be shot while riding the helicopter**, producing a
  killcam and a gunner reticle drawn on top of each other. Gunner operators are
  now out of play — not damageable, not targetable — and the killcam clears every
  competing overlay when it starts.
- **The killcam looked out through the killer's own head.** The camera sits at
  their eye socket, so their helmet, arms and weapon filled the lens. The
  viewer's body is now hidden for the duration and the camera is nudged 16 cm
  forward of the eye.
- **AI could track a target through a wall for up to one perception tick** after
  acquisition was throttled to 15 Hz. The expensive full scan is still throttled,
  but the *current* target is re-verified with a single raycast every frame, so
  the moment you break line of sight the bot loses you.
- **Non-unit quaternions from degenerate IK axes** were leaking scale into the
  skeleton, shrinking the weapon toward zero over time.
- **The weapon socket was 100× too small.** A Mixamo armature carries a cm→m
  scale on its bones; sockets now divide out each bone's own measured scale.
- **The rig faces −Z, not +Z.** Detected at load from the hip positions rather
  than hard-coded, so another Mixamo export drops straight in.
- **Bone names arrive sanitised.** `mixamorig:Hips` becomes `mixamorigHips`
  through GLTFLoader; bones are indexed by unprefixed suffix.

---

## 7. Screenshots

In `qa/`, all captured at 1920×1080 from the running game. The capture pipeline
(`tools/qa-capture.js`) reads back the WebGL buffer and composites the live HUD
DOM over it through an SVG `foreignObject`, so these are what a player sees, not
a 3D-only render.

| File | What it shows |
|---|---|
| `01-loadout.jpg` | Custom loadout: primary/secondary/lethal with 3D renders, pickers, aggregate stat bars, loadout summary |
| `01b-armoury.jpg` | Weapon grid with per-gun renders and stats; detail panel with STK/TTK table |
| `01c-briefing.jpg` | Tactical map drawn from the real collision data, spawn markers, operation parameters, difficulty, killstreak list |
| `02-spawn-view.jpg` | In-match first person: viewmodel, minimap with facing cone, compass, ammo, health, killstreak rail, and a hard cast shadow across the road |
| `03-enemy-midstride.jpg` | Hostile at 3.3 m at full run — rear leg extended with the foot lifted, front leg driving, camo body, helmet with faction band, plate carrier, holster, weapon in both hands, torso twisted independently of the legs, contact shadow under the planted foot |
| `04-sniper-scope.jpg` | LONGBOW .408 through the 8× optic (camera FOV 8° vs 85°): lens vignette, mil-dot ladder, a hostile at 46 m, bullet-hole decals on a container |
| `05-hitmarker.jpg` | Hitmarker on a hostile at 10 m, muzzle flash on the barrel, ammo counter stepped down |
| `06-killcam.jpg` | First-person killcam from ECHO-11's eyes, letterboxed, with the killer's name, weapon and respawn countdown |
| `10-punch-guard.jpg`, `10-punch.jpg` | The punch: your bare fist raised in the guard at the lower left, then landing under the crosshair with the gun dropped out of view; rolled WOODLAND sleeve |
| `11-legs.jpg`, `11-legs-walk.jpg` | Looking down: your own legs and boots (the legs-only cut of your body), standing and mid-stride, in WOODLAND |
| `12-skins.jpg` | The SKINS tab: fifteen patterns, the headshot bank, prices, and TIGER STRIPE previewed on your primary |
| `13-death-0.3s.jpg` to `13-death-30s.jpg` | A headshot kill, frame by frame: the drop, blood starting at the head (1.5 s), the body fading (2.7 s) and gone (3.6 s) while the pool keeps spreading (8 s), then dried and fading (30 s) |

I looked at every one. The characters read as rigged, textured humans with gear
and real stride, not as primitives, and nothing slides without moving its legs.

---

## 8. Known limitations

Stated plainly rather than buried:

- **The maximum roster does not hold 60 fps** in this environment (~44 fps at 15
  actors, all firing every frame). The default 9-actor configuration measured
  75 fps median at the time; a 2026-09-10 re-measurement at a true 1080p did
  not reproduce that (see Frame time, re-measured, at the end). The hostile-count slider goes to 9 and the honest answer is
  that the top of that range costs frame rate.
- **The QA walker fails 6 of 66 route legs.** The routes exist and the map has no
  wedges; the failures are the test's steering, not the level.
- **Standalone shipping-container roofs have no stair.** They are deliberate
  jump-up perches — a player can reach them, and drop links let the AI leave one
  if it ends up there, but bots will not path *up* onto them.
- **One third-party asset.** Everything else — every texture, every weapon,
  every sound, the whole map — is generated by this project's code at runtime.
  See `ASSETS.md`.
- **Pointer lock is required for mouse look.** Where a browser refuses it the
  game detects that and stays playable on the keyboard rather than trapping the
  player behind a pause card, but mouse look is lost.
- The recoil, damage and mobility tables are tuned by analysis and simulation
  (time-to-kill spreads, learnability measurements), not by hundreds of hours of
  human play. They are internally consistent and measurably distinct; they are
  not playtested to the standard a shipped multiplayer game would need.

### Post-release fix: inverted strafe axis

Reported after shipping: A and D moved the player the wrong way round. Forward
and back were correct, which is what narrowed it down.

The movement basis in `updateActor` built the lateral axis as
`(cos yaw, 0, -sin yaw)`. The correct screen-right is `cross(forward, up)` =
`(-cos yaw, 0, sin yaw)` — the exact negative. Verified against the live camera
matrix rather than by eye: at yaw 2.226 the camera's column 0 (screen right) was
`(0.610, 0, 0.793)` while the movement code produced `(-0.610, 0, -0.793)`.
The forward vector matched the camera look direction exactly, which confirmed
only the lateral axis was wrong.

The QA suite missed it because the control test measured the *distance*
travelled for each key, not its direction relative to the camera — `strafeRight
3.85 m` is true whichever way you go. It now asserts the sign of the
displacement projected onto the camera basis.

`_strafeSign`, which drives the lean-into-the-strafe view roll, projected onto
the same wrong axis, so it was flipped in step to keep the roll reading the same
way relative to the key pressed.

This is now a standing test — `testControls()` in the harness, run as part of
`runAll()`. It holds each key for 40 frames through the real `Input` object,
projects the resulting displacement onto the live camera basis, and asserts the
*sign*, not just the magnitude:

| Key | Distance | Along camera screen-right | Along look direction | Roll sign |
|---|---|---|---|---|
| D | 2.74 m | **+2.74** | 0.00 | +1.00 |
| A | 2.74 m | **-2.74** | 0.00 | -1.00 |
| W | 2.74 m | 0.00 | **+2.74** | 0 |
| S | 2.74 m | 0.00 | **-2.74** | 0 |

One wrinkle worth recording: `deploy()` requests pointer lock, and the rejection
that sets `lockUnavailable` arrives as a task. Driving keys synchronously in the
same tick meant the input layer was still gated and the player did not move at
all, so the test yields once before it starts.

### Knife-edge hit-zone probe

Adding the control test surfaced a flake in `testHitZones`, which fired a single
ray straight down the centreline at knee height. With capsules welded to real
bones, an idle stance has the legs apart — measured, the thighs sit at roughly
-0.30…-0.22 and 0.00…+0.08 lateral, with a clean gap between them — so that ray
passes between the knees about as often as it clips one. The miss was correct
behaviour being asserted as a failure.

It now sweeps a nine-ray lateral fan at knee height and requires that some ray
finds a leg and that *no* ray at knee height ever comes back as head or torso,
which is the property actually worth guarding.

Full suite after both changes: **12 of 12 pass.**

---

## Material pass: nothing in the map is flat colour any more

Reported after playing: *"elements are metal and then you have random cubes or
things that look plastic."*

Fair. The map's box materials split into two classes. Walls, floors, roofs and
the warehouse cladding ran through `materialFrom()` — an fBm albedo, a
roughness map, and a normal map derived from the same height field by a Sobel
filter. The rest — `paintA/B/C`, `sandbag`, `rubber` — were bare
`MeshStandardMaterial({ color, roughness })` with no maps at all. Every shipping
container, crate, barrel, sandbag nest and the wrecked truck was a flat tinted
slab standing next to a wall with real surface detail, which is exactly what
reads as plastic.

**What changed**

`containerSteel()` is a new bake: trapezoidal corrugation on a 32 px pitch
(0.25 m at the 2 m tile, close to the real thing), a riveted rail every 128 px,
paint worn through on the rib crests weighted by an fBm wear field, and rust
blooming out of the wear. It is baked bright and near-neutral so the per-crate
colour tint multiplies over it cleanly, and the tints were pre-divided by the
panel's mean albedo so the crates land on the colours the map was laid out with.

`burlap()` is the second new bake — woven hessian over lumpy overfilled bags,
courses offset the way they actually stack, seams pressed in between them.
Sandbags are still not metal, deliberately; they were just never meant to be
plastic either.

Two things in the pipeline had to grow to support it:

- **A metalness channel.** `bake()` now optionally emits one, and
  `materialFrom()` binds it. Rust and worn paint are dielectric; without the map
  the whole panel answers light identically and the corrosion reads as a printed
  decal rather than as corrosion.
- **Texture rotation.** Fuel drums are the same corrugated panel turned a
  quarter turn, so the ribs hoop the barrel instead of running down it — a free
  second material off one bake. Four map props that were "small containers"
  became `drumA` / `drumB`.

Also cached: the Sobel pass is the expensive part of `materialFrom()`, and five
materials now share the container bake. The normal canvas is memoised on the
bake rather than recomputed per tint. Two new 256² bakes cost roughly 0.9 s of
boot; cold boot went 3.9 s → 4.7 s, still well inside the 10 s budget.

**Two tuning passes, both from looking at the render rather than the code.**
The first version baked the full crest-to-valley contrast into the albedo and
the container read as a wire grille — and stayed a grille when the sun moved,
which is the tell that shading is painted on rather than lit. Dropping the
albedo contribution from 42 to 15 and letting the normal map carry it fixed the
shape. The second pass fixed a hard specular sparkle that crawled across the
panel: roughness had been set to 0.32 for a showroom finish, against 0.40+ on
the warehouse cladding that already looked right. Matching it — 0.44 base — and
easing `normalScale` from 1.45 to 1.10 settled it.

---

## The airstrike is now a team asset, not a killstreak

Requested: drop the generic air strikes; give each team exactly one airstrike
for the match; it only hurts the opposite team, and only where they are in the
open.

**Removed** from the streak ladder: `strike` (5 kills) and `bomber` (9 kills).
What is left is UAV at 3, attack helicopter at 7, chopper gunner at 11 — and
key `6` is freed for the new asset.

**`TEAM_STRIKE`** is deliberately not in `STREAKS`. It is spent per *team*, not
per player, tracked in `game.teamStrikeUsed = { A, B }` and reset with the
match. The flag is set before the jets fly: the run takes several seconds, and
without that a player could open the tac-map twice and buy two.

**The two damage rules** are options on `explode()`:

- `enemiesOnly` skips anyone on the owner's team, the caller included.
- `openSkyOnly` skips anyone with geometry overhead. The test is
  `underOpenSky()` — a ray straight up from the victim's head. That is the
  honest check: it is the same geometry the bombs would have to fall through,
  and it costs one raycast per victim per blast.

`scheduleExplosion()` carries the options through the blast queue so the shape
of an airstrike blast is decided where the strike is defined, not where it
detonates. Nothing else in the game passes them, so grenades and rockets still
hurt everyone the way they always did.

**The enemy side plays it properly.** `updateEnemyStrike()` re-evaluates every
3 s after the opening 35 seconds. It only considers targets who are *actually*
exposed — dropping it on a man indoors would waste the side's one shot — and
picks the tightest cluster of them, holding for two or more unless the match is
nearly over. Some matches it never comes, which is correct.

### Verified

Three actors staged around one aim point, every AI made inert so nothing but the
strike could do damage, health sampled *during* the run — a body killed by it
respawns on full health inside the same window, which reads as "unharmed" if you
only look afterwards:

| | damage taken |
|---|---|
| Enemy standing in the open | **100 — killed** |
| Enemy under cover, 2.5 m away | **0** |
| Friendly in the open, inside the blast | **0** |
| The caller | **0** |

The same blast with no rules applied, as a control: 166 / 105 / 130. So cover
and team are doing the work, not distance.

End to end through the real input layer: key `6` opens the tac-map titled
"TEAM AIRSTRIKE — YOUR TEAM'S ONLY STRIKE", a click confirms and puts two jets
in the air, the rail entry flips READY → SPENT, and pressing `6` again is
refused with a banner. Over 110 seconds of ordinary match the enemy called
theirs once, at t=43 s, and neither side got a second.

`testTeamAirstrike()` now asserts all seven properties as part of `runAll()`,
and restores the match afterwards — it pins four bodies in a corner and spends a
side's strike, and the first version of it quietly poisoned every test that ran
after it.

**Full suite: 13 of 13 pass.** Cold boot 3.8–4.7 s. Frame time at the default
9 actors: 9.07 ms median - but measured at the preview pane size, not 1080p; see Frame time, re-measured, at the end. Full match
7,830 frames, 20–17 VICTORY.

---

## Melee: it was there, it just almost never landed

Reported: *"melee doesn't work."*

The key was bound and a handler ran on every press. The old control check even
logged `melee: meleeT active` - the same mistake as the strafe test: it checked
that the timer started, not that anything got hit.

Measured with an enemy staged in front and V pressed through the real input
layer, the original version landed **6 of 10** swings. It fired one infinitely
thin ray, 2.1 m long, down the crosshair. A target 0.25 m off-centre at arm's
length (about 12 degrees) was a miss, and so was looking slightly up at a head.
There was no swing animation at all, and a miss played a quiet click - so from
the player's side, pressing V did nothing.

**What changed**

- **A cone, not a ray.** `resolveMelee()` tests each enemy's head, chest and
  hips: within 2.3 m of the eye, inside 28 degrees of the look direction, with
  clear line of sight so nothing lands through a wall. Most centred wins.
- **The hit lands at contact.** `startMelee()` plays the swing and resolves it
  `MELEE_HIT_K` of the way through (0.156 s), where the weapon arrives.
- **A real swing.** `meleeCurve()` in `util.js` is one wind-up/strike curve
  shared by the viewmodel and the third-person body, so the swing you see is the
  swing the killcam shows.
- **Feedback.** Two new synthesised sounds: a whoosh on every swing (noise
  through a state-variable band-pass swept with the swing's speed - the existing
  biquad resets when retuned, and clicked) and a thud on a hit. Hitmarker and a
  camera punch on contact; a swing into a wall sparks and sounds like the wall.
- **It behaves like a melee.** It breaks sprint, drops the sights, and aborts a
  reload. `interruptReload()` is new on `WeaponState`: rounds only move into the
  magazine when a reload completes, so abandoning one costs time, never ammo.

**Verified**, through the real input layer:

| | result |
|---|---|
| Should connect: centre, 12 and 21 degrees off, looking up, 0.8-2.2 m, crouched target | **12 / 12** |
| Should miss: 2.9 m away, 40 degrees off, looking at the sky | **3 / 3 missed** |
| Swing through a wall | **missed** |
| Key press to damage | **183 ms** |
| Melee mid-reload | reload aborted; magazine 10, reserve 210 unchanged |

`testMelee()` asserts all of it as part of `runAll()`.

---

## Blood, with a toggle

Requested: a toggle for realistic blood that goes away after 5 seconds.

**BLOOD** is a new settings checkbox, on by default. Every body hit - bullet or
melee - goes through `effects.bloodHit()`, so the toggle lives there.

With blood on, a hit produces:

- **Spray.** A short mist back toward the shooter, a cone of droplets out along
  the round's path that falls under gravity, and a slower fine mist.
- **Splatter on the world.** A ray from the wound along the round's path; a
  surface within 2.4 m gets a splatter decal stretched along the travel - a
  square hit leaves a burst, a grazing one a streak. Plus drips on the ground.
- **A pool under the body** once it has come to rest - a second after the kill,
  under the hips - spreading out over 1.6 s.

Every mark holds for 3.5 s, fades over the last 1.5 s, and is gone at 5.0 s.

It is built to look like blood rather than red paint. The decals use a lit,
low-roughness standard material, so blood goes dark in shade and takes a wet
sheen in the sun, where an unlit decal glows. The procedural atlas colours each
pixel by thickness: nearly black where it is deep, thin bright red only at the
edge. Per-instance fade and atlas tile are injected into the standard shader
rather than a custom one, so fog, tone mapping and shadows match the world.

With blood off a hit shows a small grey puff of fabric, so it still reads, and
switching off mid-match wipes everything already on the map.

**Verified**, through the real checkbox:

| | result |
|---|---|
| 3 hits in front of a wall | 6 marks: 3 on the wall, 3 on the ground |
| One wall mark's opacity at 3.0 / 4.5 / 5.05 s | **0.92 / 0.30 / gone** |
| A kill | a pool under the body, gone 5 s later |
| Checkbox off | 2 marks on the map -> 0; a hit while off leaves 0 |

`testBlood()` asserts all ten of these as part of `runAll()`.

### A tooling note

Three file writes in this pass failed with the same shell error - `unexpected
EOF while looking for matching '` - and wrote nothing. The only thing they had
in common was size: each was a single shell command over about 8 KB, and every
write under that size succeeded. Splitting them up fixed it.

---

## Frame time, re-measured - and two measurement errors of my own

Checking whether blood costs frame rate turned up two frame-time numbers in
these notes that were not measuring what they said.

**1. The "109 fps" in the airstrike section was not 1080p.** It was taken on a
fresh page in the preview pane, and the pane renders at its own size - roughly
800 px wide - not 1920x1080, which is the brief's target.

**2. The suite's frame-time line had been passing without drawing anything.**
`runAll()` switches rendering off to run fast, and `testPerformance()` passed on
mean frame time alone, so inside the suite it timed the simulation (0 draw
calls, 0 triangles) and reported a pass. It now forces rendering on and the
renderer to 1920x1080 for the measurement, restores both afterwards, and will
not pass if nothing was drawn.

A third trap made the numbers jump around: the screenshot tool resized the real
renderer and never put it back, so a measurement taken after a capture was at
1080p and one taken before it was not. `restoreCaptureSize()` now exists.

**Measured properly** - fresh load, renderer at 1920x1080, 9 actors, every bot
firing every frame, blood on / off / on in one session:

| Run | Median | p95 | Draw calls |
|---|---|---|---|
| Blood on | 18.9 ms (53 fps) | 36.2 ms | 251 |
| Blood off | 23.8 ms (42 fps) | 33.3 ms | 250 |
| Blood on | 22.2 ms (45 fps) | 34.1 ms | 201 |

- **Blood costs nothing measurable.** The blood-off run was the slowest of the
  three; the run-to-run spread is bigger than anything blood does. It is one
  extra draw call.
- **At a true 1920x1080 this does not hold 60 fps today** - 42 to 53 fps median.
  Section 3 recorded 13.3 ms (75 fps) at 1080p. These numbers cannot say whether
  that is a real regression or this environment: section 3 already notes
  identical renders here varying by +/-50%, and today's view had more of the map
  in frame (182k triangles against 135k). What they do say is that 60 fps at
  1080p cannot be claimed on this measurement. Treat it as open.

### Test isolation, and where the suite stands

One more flake turned up on a re-run: **team airstrike** failed once, having
passed every run before. Its strike call had been refused. A strike can only be
called in a live match with the player alive, and the player had been shot
during the controls test just before it - which left the bots active - and was
watching a killcam. The game was right; the test was not isolated.
`ensureLive()` in the harness now ends any killcam through the game's own
`endKillcam()`, respawns the player through `spawn()`, starts a fresh match if
the last one ended, and yields once for the pointer-lock refusal. It runs at the
start of the controls, airstrike, melee and blood tests and before the
frame-time run, and the controls test now holds the bots inert while it probes.

**Two fresh-load runs of `runAll()`, identical results: 14 of 15 pass.** Every
functional test passes on both - including team airstrike, melee and blood.

The one failure is frame time, now a real rendered 1920x1080 measurement:

| Run | Mean | Median | p95 | Draw calls |
|---|---|---|---|---|
| 1 | 17.6 ms | 11.1 ms | 38.2 ms | 103 |
| 2 | 17.9 ms | 14.7 ms | 30.4 ms | 119 |

A typical frame fits the 16.7 ms budget; the mean does not, because of a heavy
tail of 30-38 ms frames. Against "a locked 60 fps at 1080p" that is a fail, and
it is recorded as one. It is tracked as separate follow-up work.

---

## Three new maps: TIMBERLINE, WHITEOUT, FOUNDRY

Requested: a forest map and two more.

### How maps work now

Dustline was hard-wired. Its size was a set of global constants read by the
minimap, the tactical map and the airstrike selector; `main.js` built exactly
one map and gave it Dustline's sky; the AI's hotspots and the tactical map's
zone labels were Dustline coordinates typed into `game.js` and `menu.js`.

A map is now a definition in `src/world/maps/`: size, layout, an optional
decorative pass, sky and light, extra surfaces, zone names, AI hotspots, and
the high ground the map walk must prove reachable. `GameMap` builds from one;
`main.js` caches built maps and swaps sky, fog, sun and exposure on a switch;
the briefing draws a cheap layout-only preview of maps not yet built. The new
surfaces (`biomes.js`) and props (`props.js`) are generated only when a map
that needs them loads, so boot did not move (1.2-1.8 s).

Trees, rocks, tanks and domes cannot be boxes, and everything that has to
agree - collision, bullets, sight, the navmesh - only understands boxes. So a
prop is a box for all of those, usually invisible, plus an instanced shape for
the eye, authored at unit size so a rock is scaled to exactly the box that
stops you. Round things get three boxes whose corners sit on the circle, so
nobody stops against air at the corner of a tank.

### Bugs the new maps exposed

- **A bot spawned in the other team's base** (Timberline: 400 of 800 spawn
  picks visible to an enemy). New actors start "alive" at the map origin and
  are placed one at a time, so the first were scored against enemies still
  standing at the centre. Timberline's road runs straight to it, every team-A
  spawn read as "enemy in view", and a bot fled to team B's side. Actors now
  count only once placed. Latent on Dustline, whose centre is walled off.
- **The navigation grid was not symmetric.** It started at the west edge in
  0.7 m cells, and 62 m is not a multiple of 0.7, so mirrored geometry fell
  differently on each half: a 1.3 m door on Foundry had walkable cells on the
  west office and none on its mirror, so no bot could enter the east office
  or reach the south catwalk. The grid is now symmetric about the origin, and
  every new doorway and stair gap is at least 1.6 m - with 0.7 m cells and a
  0.4 m-radius body, 1.5 m stays passable at any alignment. Dustline's grid
  moved half a metre; its map walk, AI and spawn tests still pass.
- **Spawn-to-spawn sightlines.** Timberline's logging road and Whiteout's
  cleared track were each one straight lane from spawn to spawn. A head-high
  saw house and log stacks, and track-end containers, now put something in
  every straight line down them.
- **Pine branches at head height.** The first pines started their skirts at
  1.9 m, and every view in the woods had a dark cone pressed into the top of
  it. They now start above 3 m.
- **The blood test picked a post.** On Whiteout the first surface ahead was a
  0.2 m radar leg, and splatter missed it. The test now requires the same
  face 0.6 m either side and lower down.

### Verified, per map

`runMaps()` runs the map-shaped tests on every registered map, each on a fresh
deploy. A map without an authored walking route gets one generated: floor
points spread over the whole map by farthest-point sampling, then every
must-reach high point (tower tops, catwalks, lab floors) and back down.

| | Dustline | Timberline | Whiteout | Foundry |
|---|---|---|---|---|
| Spawn safety, 800 picks | 0 bad | 0 bad | 0 bad | 0 bad |
| Sight vs bullet raycast, 3,996 lines | 0 mismatches | 0 | 0 | 0 |
| Map walk: unreachable / wedge cells | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| AI, controls, airstrike, melee, blood | pass | pass | pass | pass |
| Frame time at 1080p, mean | 20.8 ms | 24.0 ms | 21.3 ms | 21.1 ms |

Frame time misses the 16.7 ms budget on every map, Dustline included - the
same open issue as above, tracked separately. Timberline is the heaviest, and
the cost is foliage: canopies cover much of the screen, several layers deep.
Props are batched by map quadrant so batches behind the camera are culled,
trees beyond the edge cast no shadow, and foliage uses a Lambert material with
its albedo only; that took Timberline from about 40% slower than Dustline to
about 15%. Turning shadows off there saves only ~3 ms, so the shadow pass is
not where the time goes.

## First person: a fist for the punch, legs when you look down

**The punch showed the gun.** Melee used to shove the rifle itself forward, so
what you saw was a gun lunging at the target. Now the gun drops down and right
out of view (0.24 m, measured by the harness) and a gloved left fist comes up
from below the screen into a guard at the lower left, jabs out to just under the
crosshair and falls away. It rides the same `meleeCurve` as the third-person
swing and the hit test, so the damage still lands as the fist arrives. The fist
is procedural (`buildFist` in `src/weapons/viewmodel.js`): rounded boxes merged
into one glove (back of the hand, four knuckles, thumb, wrist, cuff), a hard
knuckle guard, and a sleeve that wears your skin. The forearm is aimed at a fixed
shoulder point every frame, so it always reads as an arm, and the fist turns
from thumb-up in the guard to palm-down on impact.

**Looking down showed only your shadow.** Your operator sat on a layer the
camera never drew, because the camera is inside its head. Now:

| Layer | What | Your camera in play | Killcam | Shadow pass |
|---|---|---|---|---|
| 3 | gear at the waist | drawn | drawn | yes |
| 4 | your third-person gun | hidden | drawn | yes |
| 5 | the whole body, visor, gear above the waist | hidden | drawn | yes |
| 6 | legs-only cut of the body | drawn | hidden | no |

The legs-only cut is built once from the skinned mesh by skin weight: a triangle
stays if all three of its vertices are dominated by a hip or leg bone. It shares
every vertex attribute with the body (only the index buffer is new) and is bound
to the same skeleton, so it animates for free. It is 34% of the body's
triangles. Looking down also eases the body back by up to 0.24 m, so you see
legs and boots rather than straight down into the waist.

**Two bugs on the way.**

- *Dressing the wrong operator.* The skin and the first-person setup were applied
  at deploy, before `startMatch` built a fresh operator for you, so in play the
  camera sat inside an untouched head and torso (black arcs across the first
  punch captures). The harness caught it (`clipped: false`). The operator is now
  dressed after the match builds it, and the draw re-dresses it if it is ever
  rebuilt.
- *Clipping cost 2-3 ms.* The first version drew the whole body with a clipping
  plane at the waist. It looked right and was expensive: head and torso wrap the
  camera, so all of their triangles were rasterised and then discarded pixel by
  pixel, and drawing both sides made it worse. A controlled benchmark (same
  pose, main pass only, 1920x1080, 40-frame samples interleaved off/on, median
  of 8 each) put a number on it:

| Pose | clipped whole body | legs-only mesh |
|---|---|---|
| level | +3.34 ms (14.85 -> 18.19) | +0.23 ms (15.30 -> 15.53) |
| looking down | +1.83 ms (13.73 -> 15.56) | +0.92 ms (13.87 -> 14.79) |

The +0.9 ms looking down is the legs genuinely covering a slice of the screen.
Levelled, they cost nothing measurable.

## Skins

Fifteen, on a new SKINS tab: five free (STANDARD ISSUE, WOODLAND, DESERT,
ARCTIC, URBAN DIGITAL) and ten bought with headshots (TIGER STRIPE 1, NIGHT OPS
2, CARBON 2, RED DRAGON 3, JUNGLE 3, DEEP OCEAN 4, VOLCANIC 5, NEON SYNTH 6,
CHROME 8, GOLD 10).

**Currency.** Each headshot kill you make banks one headshot (`awardHeadshot()`
from `Game.killActor`), kept in localStorage under `obk.profile.v1` with the
unlocked list and the equipped skin. Unlocking spends; equipping is free. The
kill banner reads `HEADSHOT · +1 BANKED (n)` and the result screen shows
`HEADSHOT BANK +k -> n`.

**What a skin dresses.** Guns: the materials a real camo covers (polymer,
furniture, the blued receiver, the magazine), picked by material rather than by
name - anything with metalness 0.88 or more, transparent or emissive stays
factory, so bore, bolt, slide and glass never take paint. That covers the
viewmodel gun, your third-person gun and the menu previews. The fist: a camo
sleeve and a glove in the skin's colour. Your operator: camo over the fatigues'
own cloth texture, gear in the skin's colour. Never a bot.

**How the camo is drawn.** Neither the guns nor the body have UVs laid out for
a pattern, so the camo is projected: sampled on three planes from each mesh's
object-space position (the bind pose, on the skinned body, so it moves with the
cloth) and blended by the normal - `withCamo` in `src/game/camo.js`, an
`onBeforeCompile` patch on the standard material. The patterns are 256 px
tileable canvases built from value noise. VOLCANIC and NEON SYNTH add their
brightest colours as emission; CHROME and GOLD are metalness 1 against a small
painted studio gradient, because neither the viewmodel nor the menu scene has a
sky to reflect.

**Cloth came out black.** A pattern multiplied over the Soldier's own dark cloth
texture is two darks multiplied. Every pattern now records its mean linear
luminance when it is generated, and cloth lifts it to a mean of 0.3 (gain capped
at 6): woodland reads as cloth, arctic is left alone, NIGHT OPS stays dark.

**The preview drifted out of frame.** The menu's weapon studio measured the
model where the previous draw had left it, so offset and rotation fed back into
the next frame. Drawn once a frame it only wobbled; the skins preview draws the
same gun a second time at another angle, and the offset random-walked about 8 m
off screen. It now measures in model space on every draw.

**Verified** (`testSkins`): 5 free and 10 paid; unlocking with an empty bank is
refused; a body-shot kill through the real kill path banks nothing and a
headshot kill banks exactly one; a locked skin cannot be equipped; the camo
lands on poly, darkmetal and magazine and not on steel, slide or lens; the
sleeve, the suit, the legs cut and your third-person gun wear it and no other
operator does; every one of the 15 skins is drawn for a frame with zero shader
errors. `testFirstPerson`: 35 frames of fist per punch, reaching the centre,
gone afterwards; the gun down 0.24 m whenever the fist is out; layers exactly as
in the table above; the legs cut 34% of the body and casting no shadow of its
own; no other operator touched.

## Repository size: the GitHub upload

The browser upload to GitHub failed with "file too large". The project was
54 MB, 50 MB of it the 20 QA screenshots as 1080p PNGs (2-4 MB each). No single
file was near GitHub's 25 MB per-file browser limit, but a zip of the folder
was. The screenshots are now JPEG (49.5 MB of PNG became 5.2 MB), the capture
tool writes JPEG at quality 0.88, and the dev server saves a JPEG data URL as
`.jpg`. The whole project is now about 11 MB in 73 files; the largest file is
`Soldier.glb` at 2.1 MB.

**Limits.** The legs cut ends in an open hem at the waist; look straight down
and you can see into it. The headshot bank lives in the browser's localStorage,
so clearing site data or switching browser starts it again, and nothing stops a
player editing it - it is a single-player unlock, not an economy.

## Full suite after this round

`runAll` on DUSTLINE: 16 of 17 pass - cold boot, ballistics, recoil, line of
sight, hit zones, every weapon, spawn safety, AI, map walk, killcam, controls,
team airstrike, melee, blood, first-person, skins. Frame time fails the 16.7 ms
budget, as it did before this round (this run: 17.45 ms mean, 16.29 ms median,
30.1 ms p95 at 1920x1080); that work is tracked on its own. `testFirstPerson`
also passes on TIMBERLINE, where deploying builds you a fresh operator.

## A real hand, no chopper gunner, bodies that go, blood that stays

**The hand.** The punch showed a glove of rounded boxes with a knuckle plate;
it read as a gauntlet, not a hand. `buildFist` in `src/weapons/viewmodel.js`
now builds a fist the way a hand is built: the back of the hand and palm as one
block (narrower at the wrist, domed on top, four tendons raised toward the
knuckles); four fingers of three capsule phalanges each - down from the
knuckle, back under the palm, tip tucked in - with their own lengths and a
slight curl toward the middle; knuckle heads; the thumb's muscle and three
thumb segments wrapped across the front of the index and middle fingers, with
a nail; an oval wrist, a bare forearm, and a sleeve rolled to mid-forearm. One
mesh, one material: each part carries a colour multiplier (knuckles and
fingertips redder, the nail paler) over the skin tone, with a little sheen.
Six tones on the SKINS tab under YOUR HAND, saved with the profile. The skins'
glove colours are gone; a skin now dresses the sleeve.

**The chopper gunner is gone.** The 11-kill streak put you on the helicopter's
minigun. Removed: the streak, its icon and key, the helicopter's gunner branch,
`_updateGunner`, `enterGunner` and `exitGunner`, every `inGunner` check
(damage, melee and bot targeting, the reticle, gunshot audio, the viewmodel and
the first-person legs), and the thermal overlay's markup, CSS and HUD methods.
The attack helicopter stays at 7 kills.

**Bodies go after three seconds.** A body used to lie there until its owner
respawned. It now lies 2.3 s and has faded out by 3.0 s (`CORPSE_HOLD`,
`CORPSE_FADE` in `src/chars/characters.js`); its blood stays. The fade swaps in
transparent copies of that operator's own materials, made once and kept, so the
gear and weapon materials everyone shares never change and nobody alive pays for
blending; `revive()` puts the solid ones back. The fall changed too: it eased
to a stop with up to 1.6 rad of spin on a headshot, which read as the body
rolling over. It now accelerates into the ground (0.72 s) and bounces once, with
at most 0.6 rad of turn.

**Blood pools spread.** A pool used to be one decal scaled up over 1.6 s and
gone, like every mark, after 5 s. Now a body bleeds from the hips, and from the
head as well on a headshot, 0.85 s after it drops. `makePoolTexture` stores,
for every texel, when the front reaches it (a few angular harmonics for the
lobes, fbm for the ragged edge, none at the centre so it starts as a round
well); the pool shader draws whatever the front has passed, with an
anti-aliased edge that stays sharp as it grows - scaling a decal blurs its edge
with it. Thin at the front, the blood is red and more see-through; deep behind
it, near black. Fresh it is glossy; between 8 and 32 s it dries darker, browner
and duller; it fades out over the last 20 s of 45. Splatters and drips now last
12 s, fading over the last 5.

A pool only spreads as far as the ground stays level (eight directions at
growing radii, up to 0.8 m), so it never hangs off a ledge or runs up a wall;
up against a crate it moves up to 0.28 m to the open side. The first version
mirrored the sky so strongly that a pool seen from a few metres read as a grey
patch; the environment reflection is now 0.45 and fresh roughness 0.16, a wet
sheen that keeps the red.

**Two harness bugs on the way.** `ensureLive` waited a fixed 80 ms for the
pointer-lock refusal that lets keys through; a fresh browser tab refused more
slowly, so V was pressed before the game took keys and the fist test saw 0
frames. It now waits for the verdict. And the capture tool yields while it
saves a file, during which the game's own frame loop kept running, so a "hit"
frame was really taken after the punch had ended; this round's captures pause
that loop (`__benchmark`).

**Verified.** `testBlood`, 15 checks: splatter at 0.92 at 6 s, 0.37 at 10 s,
gone at 12.05 s; the pool under the body, its front at 0.21 at 1.4 s and 0.91 at
7.4 s, reach 0.8 m; the body visible at 1.4 s and gone at 3.4 s while the pool
stays; the pool at full opacity at 20 s and gone by 46 s; the body solid again
on respawn; the toggle still wipes and blocks everything. `testFirstPerson`:
35 frames of fist, reaching the crosshair. `runAll` on DUSTLINE: 16 of 17 pass;
frame time fails the budget as before (21.78 ms mean this run, 17.45 ms last
round - this number moves by several ms between runs in this browser; the round
adds one instanced draw call for pools, and blending only while a body fades).
