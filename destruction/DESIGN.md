# Destruction — design and module contracts

A browser sandbox where the viewer brings military weapons to celebrated-looking architecture and
watches the structures fail the way real materials fail. Concrete chips, cracks, spalls and
exposes its rebar under sustained rifle fire; steel dents, bends, heats and finally tears; glass
cracks or dices; buildings lose columns and collapse progressively. The look is architectural
photography at golden hour: clean, restrained, material-rich — and then wrecked.

**The physics is the product.** Every number the simulation shows (crater depth, ballistic limit,
residual velocity, overpressure) comes from a published engineering model, not from tuning for
spectacle. Spectacle comes from resolution, lighting and particles, not from exaggerated numbers.

Stack: TypeScript, Three.js r186 (WebGLRenderer + EffectComposer), Rapier 3D 0.20 (WASM, rigid
bodies), Vite 8. No other runtime dependencies. Node 22.18+ runs `.ts` directly for tests/scripts.

---

## 1. Architecture

```
src/
  core/        rng.ts (seeded), events.ts (typed bus), noise.ts (3D gradient noise), units.ts
  physics/
    materials.ts            engineering material table (SI units)
    PhysicsWorld.ts         Rapier wrapper: bodies, owners, contact-force events, body budget
    ballistics/             [M1] ammo table, flight, terminal ballistics, blast, fragments
  destructibles/
    Destructible.ts         the interface everything hittable implements
    Registry.ts             spatial queries for projectiles and blasts
    voxel/                  [M2] brittle elements: concrete, stone, brick (+ rebar)
    steel/                  [M3] steel plates (XPBD shell) and beams (plastic hinges)
    glass/                  [M4] glass panes
    terrain/                [M5] ground heightfield (soil/pavers) with craters
  systems/                  [M1] ProjectileSystem, BlastSystem
  weapons/                  [M1] arsenal table + WeaponController
  render/                   [M5] Pipeline (sky, IBL, shadows, post), shared render helpers
  fx/                       [M5] particles, explosions, tracers, impacts, camera shake
  audio/                    [M6] procedural WebAudio
  player/ ui/               [M6] fly camera + input, HUD, telemetry, menus
  structure/                [M7] StructureGraph: supports, load flow, progressive collapse
  scenes/                   [M7] the architecture
  app/
    contracts.ts            ALL cross-module interfaces (read this first)
    Simulation.ts           context, fixed-step loop, scene loading
    harness.ts              window.__sim scripting API
  dev/sandboxKit.ts         scaffolding for sandbox pages
sandbox/*.html              one visual test page per module
scripts/shot.ts             headless screenshots / scripted scenarios (Playwright + SwiftShader)
test/*.test.ts              node:test unit tests (pure logic, no DOM)
```

### Data flow of one shot

1. `WeaponController` (M1) spawns a projectile via `ctx.projectiles.spawn()` and emits `shot`.
2. `ProjectileSystem` (M1) integrates flight (gravity, drag, rocket thrust, guidance) each fixed
   step and ray-casts the swept segment through `ctx.registry.raycast()`.
3. On a hit it asks the target `probe(hit, dir, maxDepth)` for the run of material along the shot
   line, then calls the terminal-ballistics resolver (M1, pure functions) which returns an
   `ImpactEvent` — outcome, depth, crater/tunnel/spall sizes, residual speed, energy, momentum.
4. It calls `target.applyImpact(event)` (the target *realises* the result: carves voxels, dents
   the plate, cracks the pane) and emits `impact` (FX, audio, HUD react).
5. Perforation / ricochet continue the projectile; explosive fills call `ctx.blasts.detonate()`.
6. `BlastSystem` (M1) finds destructibles in range, and when the shock front reaches each one
   (arrival time from Kingery–Bulmash) calls `applyBlast(load)`; it throws fragments as
   projectiles, pushes rigid bodies, and emits `blast`.
7. Destructibles that lose material call `ctx.structure.touch(this)`; the StructureGraph (M7)
   re-checks supports and loads and releases what can no longer stand. Released material becomes
   Rapier rigid bodies that fall, collide, crack further and raise `debrisContact` events.

### Loop (`Simulation`)

Fixed step `FIXED_DT = 1/60` s, shrunk proportionally in slow motion (`ctx.time.scale`), so every
`fixedUpdate(dt)` must accept any dt in (0, 1/60]. Order per fixed step: systems (weapons →
projectiles → blasts) → Rapier step → every destructible's `fixedUpdate` → structure graph →
registry sweep. Per rendered frame: every destructible's `frameUpdate` → systems' `frameUpdate`
→ render. `Simulation.advance(seconds)` steps deterministically without rendering (tests).

**Never cache `ctx.physics.world`** — scene loads replace the Rapier world. Cache `ctx.physics`.

---

## 2. Module ownership and conventions

| Module | Owns (only edit these) | Exposes |
| --- | --- | --- |
| M1 ballistics | `src/physics/ballistics/**`, `src/systems/**`, `src/weapons/**`, `test/ballistics*.test.ts`, `sandbox/ballistics.html`, `src/dev/ballistics-sandbox.ts`, `PHYSICS.md` | `installBallistics(sim)` in `src/systems/index.ts`; `createWeaponController(sim)` in `src/weapons/index.ts` |
| M2 voxel | `src/destructibles/voxel/**`, `test/voxel*.test.ts`, `sandbox/voxel.html`, `src/dev/voxel-sandbox.ts` | `createVoxelElement(ctx, spec)` in `src/destructibles/voxel/index.ts` |
| M3 steel | `src/destructibles/steel/**`, `test/steel*.test.ts`, `sandbox/steel.html`, `src/dev/steel-sandbox.ts` | `createSteelPlate(ctx, spec)`, `createSteelBeam(ctx, spec)` in `src/destructibles/steel/index.ts` |
| M4 glass | `src/destructibles/glass/**`, `test/glass*.test.ts`, `sandbox/glass.html`, `src/dev/glass-sandbox.ts` | `createGlassPane(ctx, spec)` in `src/destructibles/glass/index.ts` |
| M5 render+fx | `src/render/**` (keep `BasicPipeline.ts` working), `src/fx/**`, `src/destructibles/terrain/**`, `sandbox/fx.html`, `src/dev/fx-sandbox.ts` | `Pipeline` class in `src/render/Pipeline.ts`; `installFx(sim)` in `src/fx/index.ts`; `createTerrain(ctx, opts)` in `src/destructibles/terrain/index.ts` |
| M6 audio+ui | `src/audio/**`, `src/ui/**`, `src/player/**`, `sandbox/ui.html`, `src/dev/ui-sandbox.ts` | `installAudio(sim)`, `installPlayer(sim, weapons)`, `installHud(sim, weapons)` |
| M7 structure+scenes | `src/structure/**`, `src/scenes/**`, `src/app/elements.ts` | `installStructure(sim)`, `SCENES` |
| Integrator | `src/main.ts`, `src/app/**` except `elements.ts`, `index.html`, `README.md`, package files | the app |

Rules for every module:

- **Edit only files you own.** If a shared contract (`src/app/contracts.ts`, `Destructible.ts`,
  `types.ts`, `materials.ts`, `PhysicsWorld.ts`, `Simulation.ts`) blocks you, do not change it:
  work around it locally and report the needed change in your final answer.
- **No new npm dependencies.** Three.js addons (`three/addons/...`) are fine.
- **Do not commit** and do not touch git state; the integrator commits.
- TypeScript must be *erasable* (Node runs it by type stripping): no `enum`, no `namespace`, no
  constructor parameter properties, `import type` for type-only imports, and **every relative
  import ends in `.ts`**.
- Typecheck with `npx tsc -p . --noEmit` and filter for your paths (other modules may be mid-edit).
- Unit tests: `node --test test/<yours>.test.ts`. Pure logic modules must not touch the DOM at
  import time so they stay testable under Node.
- Allocate nothing per bullet in hot paths where it's easy to avoid (reuse temp vectors).
- Every `THREE` geometry/material/texture you create must be disposed in `dispose()`.
- Keep the physics honest: cite the model (name + source) in a comment next to each formula.

### Visual checks

`node scripts/shot.ts sandbox/<yours>.html --out .shots/<yours>/overview.png` saves a headless
screenshot (SwiftShader WebGL: slow but faithful). For scripted scenes pass
`--scenario .tmp/<name>.mjs` (see the header of `scripts/shot.ts`); scenarios drive
`window.__sim` (see `src/app/harness.ts`): `setCamera`, `fire({ammo, from, at, count, spreadMOA})`,
`detonate({at, tntKg, kind})`, `advance(s)`, `impacts()`, `stats()`, and full access to
`__sim.sim.ctx`. Look at your screenshots (they are PNG files you can read) and iterate until the
result looks like a photograph of the real thing. Put throwaway files in `.tmp/` (git-ignored).

Sandboxes that need projectiles before M1 exists can call `target.applyImpact()` /
`applyBlast()` directly with hand-built `ImpactEvent` / `BlastLoad` objects. Once
`src/systems/index.ts` exists, sandboxes should `install: (sim) => installBallistics(sim)`.

---

## 3. Physics models (what "realistic" means here)

M1 implements these as pure, unit-tested functions and documents them in `PHYSICS.md`. Other
modules only realise the numbers.

**Exterior ballistics.** Point-mass trajectory, gravity + quadratic drag
`F = ½ ρ Cd A v²` (Cd from the ammo table, Mach-dependent G7-like curve optional), rocket
thrust during burn, and a scripted (cosmetic) top-attack loft arc for Javelin. Tracers visible; slow projectiles
(RPG ≈ 115→295 m/s) visibly fly.

**Terminal ballistics — brittle targets (concrete/stone/brick).** Modified NDRC (Kennedy 1976)
penetration depth for hard projectiles, with nose factor N, fc of the damaged material, and a
deformable-core reduction for lead-core ball. Perforation and scabbing limits from the NDRC /
Kennedy e/d and hs/d relations. Front crater: cone ~2–3 d deep and 4–10 d wide (wider for small
calibres in brittle material). Rear scab (spall) crater when the wall is thinner than the scabbing
limit, even without perforation. Microcrack damage zone ~3–5 crater radii that weakens later hits
(effective fc × (1 − 0.8 D)), so a burst on one spot keeps deepening — the signature behaviour.
Long rods at > 1.2 km/s: hydrodynamic (Alekseevskii–Tate) with target resistance from fc.

**Terminal ballistics — steel.** Small arms / AP: ballistic limit from Lambert–Jonas / Thor-type
relations scaled by target hardness (BHN / UTS) and obliquity (t / cos θ); residual velocity by
Recht–Ipson `Vr = a (V^p − Vbl^p)^(1/p)`. Lead-core ball on hard steel: splash (shatter) with
fragments and a shallow dent. Long rods: Lanz–Odermatt `P/L = a·(1/tanh(b0 + b1 L/D))·cos^m θ ·
√(ρp/ρt)·exp(−c σt / (ρp v²))` with rod erosion. HEAT: jet penetration rated in RHA, scaled to
other materials by `√(ρ_RHA/ρ_t)` hydrodynamics with a strength factor; narrow hole (~0.2 cone
diameter in steel), behind-armour debris cone. HESH/contact charges: scabbing from `contactDamage`.
Ricochet above a critical obliquity that depends on projectile type and velocity.

**Blast.** Kingery–Bulmash fits (UFC 3-340-02) for incident/reflected overpressure, impulse and
arrival time vs scaled distance Z = R / W^(1/3); TNT equivalence per filler; thermobaric = larger
impulse (long positive phase). Shock arrival is delayed by distance, so windows fail in a ring
that expands outward. Contact charges: empirical crater/breach/spall relations (e.g. McVay /
UFC 3-340-02 spall & breach curves). Fragments: Gurney velocity + Mott mass distribution, a few
dozen representative fragments per shell thrown as real projectiles (they pock concrete and
riddle glass). Pressure–impulse damage numbers for panes, walls and slabs.

**Material response.**
- *Brittle* (M2): continuum damage in voxels; material removed where damage saturates; islands
  not connected to supports fall as rigid bodies; big failures fracture into Voronoi-like chunks;
  rebar holds shape, is exposed, bends in blasts and can be cut.
- *Ductile* (M3): XPBD with elastic-perfectly-plastic constraints (rest shape updates past yield),
  plastic-strain accumulation and fracture at the material's elongation, plastic work heats the
  metal (visible glow that cools). A tank round dents and bends a steel member; repeated hits at
  the same place accumulate strain and thin the section until it tears through.
- *Glass* (M4): tempered dices completely on any fracture (crack front ~1.5 km/s is visible in
  slow motion); annealed breaks into large radial shards; laminated cracks in place (spider web)
  and sags, holding shards until heavily damaged.
- *Structure* (M7): supports, gravity-load flow, crushing and buckling checks, progressive
  collapse with realistic timing.

### Calibration targets (unit tests must hit these within the stated tolerance)

| Case | Expected | Tolerance |
| --- | --- | --- |
| 5.56 M855 @ 900 m/s into C40 concrete, single hit | crater depth 15–40 mm, crater Ø 40–90 mm | range |
| 7.62×51 M80 @ 830 m/s into C40 | depth 25–60 mm | range |
| .50 M2 AP @ 880 m/s into C40 | depth 100–200 mm | range |
| 5.56 M855 @ 900 m/s vs mild steel S355, 0° | perforates ≤ 6 mm, stopped by ≥ 10 mm | — |
| 7.62 M61/M993 AP vs RHA @ 100 m | perforates 8–15 mm class | ±30 % |
| .50 M2 AP vs RHA @ 100 m | ≈ 20–25 mm | ±25 % |
| 30 mm PGU-14 API (A-10) vs RHA @ 500 m | ≈ 55–70 mm | ±25 % |
| 120 mm M829A3/A4 APFSDS vs RHA @ 2 km | ≈ 650–800 mm | ±15 % |
| PG-7VL HEAT vs RHA | ≈ 500 mm; vs concrete ≈ 1.2–1.8 m | ±15 % |
| Javelin vs RHA | ≈ 750–800 mm | ±15 % |
| 1 kg TNT, R = 5 m: normally reflected overpressure (incident ≈ 30 kPa) | ≈ 70 kPa (Kingery–Bulmash) | ±20 % |
| 1 kg TNT, R = 5 m: arrival time | ≈ 8–9 ms | ±20 % |
| Annealed 6 mm window 1.5 × 1 m fails at | ≈ 3–7 kPa reflected | range |

---

## 4. Element behaviour and representation

### M2 — brittle voxel elements (`createVoxelElement(ctx, spec: VoxelElementSpec)`)

- **Grid.** Element-local voxel grid (default 0.025 m; coarsen automatically so one element stays
  under ~3 M voxels). Sparse 16³ chunks: EMPTY / FULL (implicit) / MIXED (Uint8 density, Uint8
  damage, Uint8 soot). Initial density from the shape SDF so round columns are round.
- **Rendering.** Undamaged chunks render through the analytic base mesh (box/cylinder/SDF surface
  mesh at modest resolution) whose fragment shader discards fragments inside chunks that have
  been damaged (a small chunk-state DataTexture, also used by the depth/shadow material).
  Damaged chunks render with Surface Nets meshes (smooth gradient normals), drawn through one
  `THREE.BatchedMesh` per element; untouched box-face quads are merged into rim-preserving fans.
  Debris pieces draw through per-family BatchedMeshes (concrete ≥ 0.3 m with shadows, smaller
  pieces without, baked exposed rebar) and show their convex hull until meshed. Make the two meet
  without cracks: a chunk owns the Surface Nets quads whose minimum cell lies in it, so it covers
  cell centres [c0, c0+N]; the discard region is offset by half a voxel to match. Remesh at most
  a few ms per frame (priority queue by distance to camera).
- **Look.** Object-space triplanar PBR in a `MeshStandardMaterial.onBeforeCompile` shader with
  procedurally generated textures (canvas/DataTexture at startup): board-formed concrete with
  timber-grain imprint, form-tie holes on a ~60×90 cm grid and subtle panel seams (Tadao Ando);
  smooth concrete; marble with veins; travertine with voids; granite speckle; onyx translucency
  feel; brick with mortar joints. Vertex attributes carry damage (dark micro-cracks, rougher),
  exposure depth (fresh fractured interior is lighter, rougher, shows aggregate) and soot.
- **Impacts.** Irregular (noise-perturbed) cone crater + tunnel + rear spall exactly as sized by
  the ImpactEvent; damage field around it; chips, dust (via `ctx.fx`); rebar hits spark.
- **Rebar.** Bars per `RebarSpec`, instanced only in chunks that got damaged (hidden inside
  concrete otherwise). Contribute steel to `probe()` where the shot line crosses them. Can be nicked,
  cut after enough damage, and bent (permanent) by blast impulse where exposed. Bars spanning a
  breach stay visible.
- **Blast.** Use `load.contactDamage()` for contact charges and `load.damageAt()` per surface
  patch otherwise: crater, breach, rear spall, damage field, soot; throw debris outward.
- **Fracture & collapse.** After material loss, check connectivity from anchors (coarse grid
  flood fill). Unanchored islands become dynamic `VoxelElement`s (same class, rigid-body mode) —
  still shootable. Large islands split into Voronoi-like chunks (noise-perturbed boundaries,
  denser near the impact), each a rigid body with a convex-hull collider. Cantilever rule: an
  anchored island whose geodesic distance from its anchors exceeds ~k·thickness breaks off at that
  distance. Column crushing: per-slice remaining area × fc vs imposed load. Hard landings
  (contact force events) crack debris further (bounded by a minimum chunk size and a body budget).
  Static elements use Rapier voxel colliders (coarse, updated with `setVoxel`), so debris can fall
  through holes.

### M3 — steel (`createSteelPlate`, `createSteelBeam`)

- **Plate.** XPBD particle sheet (~5 cm spacing, capped ~2 500 particles): stretch + shear +
  bending constraints with plastic rest-state updates, plastic-strain accumulation, tearing at
  `fractureStrain`, edge welds that can break. Sleeps when still; wakes on impact/blast. Rendered
  as a thick shell (both faces + rim at tears) with a steel PBR look per finish (mill scale,
  painted, Corten patina, polished, armour). Heat from plastic work → blackbody emissive that
  cools (Newtonian cooling). Holes and petalling from perforation; bulge on the rear face.
- **Beam.** Node chain along the axis (~0.1–0.2 m) with axial + bending constraints, plastic
  hinges (moment > Mp = Z·fy), section damage from hits (reduces A and Mp locally; perforations
  are drawn as holes), local flange dents, P-δ buckling under the imposed axial load, severing.
  Rendered by sweeping the real profile (I/H, cruciform, tube, box) along the smoothed deformed
  axis. A released beam becomes a rigid body (compound collider) with its bent shape frozen.

### M4 — glass (`createGlassPane`)

Physically based thin glass (env reflections + Fresnel, subtle tint; no transmission pass).
Bullet holes with crushed halos and radial + concentric crack networks drawn into a per-pane
texture. Tempered: any fracture propagates across the whole pane (animate the front at ~1.5 km/s
sim time) and the pane collapses into ~1 cm dice (instanced, simple ballistic motion, settle on
the ground). Annealed: large sharp radial shards (convex rigid bodies). Laminated: spider-web
cracks, stays in the frame, sags with damage, tears out when heavily hit. Blast via
`load.damageAt()` → shards thrown with the pressure impulse.

### M5 — rendering, environment, FX, terrain

- Golden-hour physical sky (three `Sky` addon) + PMREM environment, sun shadows (cascaded or
  fitted to the camera), ACES/AgX tone mapping, GTAO ambient occlusion, bloom for fire/hot
  metal/tracers, SMAA/FXAA, subtle fog/aerial perspective. Quality levels 0/1/2.
- Terrain: large ground heightfield (stone paver plaza near the buildings, grass/soil beyond) with
  blast craters, scorch, and a Rapier heightfield collider; hides BasicPipeline's `basic-ground`
  and calls `ctx.physics.removeDefaultGround()`.
- FX reacting to events: material-specific impacts (concrete dust & chips, steel sparks, glass
  glitter, stone flakes), muzzle flash, tracers and rocket exhaust/smoke trails, explosions
  (flash, fireball, shock ring, dust skirt, lingering smoke column, debris), sparks, camera
  shake by overpressure at the camera. GPU-instanced; budget ~20 k particles.

### M6 — audio, player, HUD

- Procedural WebAudio: per-weapon report (calibre-scaled), supersonic crack, explosions with
  distance delay (343 m/s) and air absorption, material impacts (modal synthesis for metal),
  glass, debris clatter from `debrisContact`, outdoor slap-back reverb. Master limiter, mute.
- Player: free-fly camera (pointer lock, WASD, Q/E or Space/Ctrl, Shift fast), ADS zoom (right
  mouse), weapon keys 1–9/wheel, ammo cycle, slow motion, charge placing/detonation, bullet cam for
  slow projectiles; touch controls on phones.
- HUD: weapon + ammo card with real specs, crosshair, telemetry of the last impacts (material,
  speed, obliquity, outcome, depth, residual speed, energy) — the physics made visible.

### M7 — structure and scenes

StructureGraph (supports, load flow, failure propagation with realistic delays) and 4–5 scenes of
refined architecture, each built from the element factories:
proving ground (calibration targets), a Tadao-Ando-like concrete chapel with a light cross, a
Mies-like pavilion (travertine, chrome cruciform columns, glass, onyx wall, thin roof slab), a
steel-frame tower with glass curtain wall, a Doric marble temple with drum columns.

---

## 5. Performance budget (mid-range laptop GPU, 1080p, quality 1)

60 fps idle and under small-arms fire; ≥ 30 fps during a large collapse. Remeshing ≤ 4 ms/frame
amortised. ≤ 900 dynamic bodies (PhysicsWorld enforces). ≤ 20 k particles. Draw calls < 800.
