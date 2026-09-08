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
| `01-loadout.png` | Custom loadout: primary/secondary/lethal with 3D renders, pickers, aggregate stat bars, loadout summary |
| `01b-armoury.png` | Weapon grid with per-gun renders and stats; detail panel with STK/TTK table |
| `01c-briefing.png` | Tactical map drawn from the real collision data, spawn markers, operation parameters, difficulty, killstreak list |
| `02-spawn-view.png` | In-match first person: viewmodel, minimap with facing cone, compass, ammo, health, killstreak rail, and a hard cast shadow across the road |
| `03-enemy-midstride.png` | Hostile at 3.3 m at full run — rear leg extended with the foot lifted, front leg driving, camo body, helmet with faction band, plate carrier, holster, weapon in both hands, torso twisted independently of the legs, contact shadow under the planted foot |
| `04-sniper-scope.png` | LONGBOW .408 through the 8× optic (camera FOV 8° vs 85°): lens vignette, mil-dot ladder, a hostile at 46 m, bullet-hole decals on a container |
| `05-hitmarker.png` | Hitmarker on a hostile at 10 m, muzzle flash on the barrel, ammo counter stepped down |
| `06-killcam.png` | First-person killcam from ECHO-11's eyes, letterboxed, with the killer's name, weapon and respawn countdown |

I looked at every one. The characters read as rigged, textured humans with gear
and real stride, not as primitives, and nothing slides without moving its legs.

---

## 8. Known limitations

Stated plainly rather than buried:

- **The maximum roster does not hold 60 fps** in this environment (~44 fps at 15
  actors, all firing every frame). The default 9-actor configuration does, at
  75 fps median. The hostile-count slider goes to 9 and the honest answer is
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
9 actors: 9.07 ms median, 109 fps, 250 draw calls, 182k triangles. Full match
7,830 frames, 20–17 VICTORY.
