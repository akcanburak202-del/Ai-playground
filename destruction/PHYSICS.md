# Destruction — physics of the ballistics module (M1)

## Özet (Türkçe)

Bu belge, oyundaki mermilerin ve patlamaların yapı malzemelerine ne yaptığını hesaplayan fizik
modellerini anlatır. Silahlar yalnızca açık kaynaklardaki kamuya açık referans değerlerle (kalibre,
kütle, namlu çıkış hızı, belirtilen delme değeri) tanımlanır; mühendislik derinliği silah
tasarımında değil, **malzeme tepkisindedir**: beton için değiştirilmiş NDRC (Kennedy 1976) nüfuz
derinliği, delme ve arka kavlama sınırları, hasar gördükçe zayıflayan beton (aynı noktaya atılan
mermiler krateri giderek derinleştirir); çelik için Lambert–Jonas balistik sınırı ve Recht–Ipson
kalıntı hızı; uzun çubuk mermiler için Lanz–Odermatt ve Alekseevskii–Tate; oyuk dolgu (HEAT)
jetleri için RHA eşdeğeri yoğunluk ölçeklemesi; patlamalar için Kingery–Bulmash eğrileri (basınç,
itki, varış zamanı — şok cephesi mesafeyle gecikerek ulaşır, camlar dışa doğru genişleyen bir
halka halinde kırılır), temas şarjları için McVay/UFC 3-340-02 kavlama ve delinme eşikleri, cam,
betonarme, tuğla ve çelik levhalar için basınç–itki (P–I) hasar sayıları, parçalar için Gurney
hızı ve Mott kütle dağılımı. Uçuş oyun seviyesinde tutulmuştur: yerçekimi, hava direnci, roketlerde
basit motor itkisi; üstten saldırı fırlatıcısının yayı ise hiçbir güdüm algoritması içermeyen,
tamamen görsel, önceden çizilmiş bir eğridir. Tasarım belgesindeki (DESIGN.md §3) bütün kalibrasyon
hedefleri birim testleriyle doğrulanır; tek fark, "1 kg TNT, 5 m: ≈70 kPa" değerinin gelen (yan)
basınç değil, yansıyan basınç olmasıdır — bu aşağıda açıklanmıştır.

---

## 0. Scope and conventions

* SI units everywhere (m, kg, s, Pa, J). Pure functions live in `src/physics/ballistics/*`
  (`penetration.ts`, `blast.ts`, `flight.ts`, `fragments.ts`, `ammo.ts`, `calibration.ts`); the
  systems that drive them are `src/systems/ProjectileSystem.ts` and `src/systems/BlastSystem.ts`;
  the viewer's weapon is `src/weapons/WeaponController.ts` with the table in `src/weapons/arsenal.ts`.
* Weapons are described only by public reference figures (calibre, mass, muzzle velocity, rated
  penetration from open encyclopedic sources) — see `ammo.ts` `source` fields. The engineering in
  this module is the **response of building materials** to what arrives.
* Every number a target realises comes from one of the models below; element modules (voxel,
  steel, glass, terrain) only realise the `ImpactEvent` / `BlastLoad` they are handed.
* Each model states its validity range; outside it the code clamps or extrapolates as noted.
* "Game-level estimate" marks the few constants that are not from a published relation. They are
  listed in §10 so nobody mistakes them for data.

---

## 1. Exterior ballistics (`flight.ts`)

**Point mass with gravity and quadratic drag.**
`m dv/dt = m g − ½ ρ C_d(M) A |v| v`, ρ = 1.225 kg/m³, A = π d²/4.

* `C_d(M) = C_d,muzzle · G7(M) / G7(M_muzzle)` — the round's published G7 ballistic coefficient
  gives C_d at the muzzle Mach number (e.g. M855: BC_G7 ≈ 0.151 lb/in² → C_d ≈ 0.31 at Mach 2.6),
  the standard G7 table (McCoy 1999, *Modern Exterior Ballistics*) carries it to other Mach numbers.
  Casing fragments use a tumbling blunt-body curve (C_d ≈ 0.8 subsonic → 1.26 at Mach 1.5;
  Hoerner 1965, *Fluid-Dynamic Drag*, ch. 16).
* Integrator: explicit gravity/thrust, then the exact 1-D drag decay v' = v / (1 + k v Δt)
  (k = ½ρC_dA/m). Unconditionally stable for any Δt ≤ 1/60 s (slow motion), energy never grows
  (unit-tested).
* **Rocket boost** (`RocketMotor`): constant thrust between `ignitionDelay` and
  `ignitionDelay + burnTime`, along the velocity (fin-stabilised rounds weathercock), propellant
  mass burnt off linearly (Tsiolkovsky mass flow). PG-7VL: booster 115 m/s, sustainer lights at
  ≈ 11 m, peak ≈ 297 m/s (model) vs ≈ 295 m/s published.
* **Top-attack launcher: a scripted cosmetic arc, not guidance.** `LoftPath` is a cubic Bézier from
  the launch point to the aimed point (apex H = clamp(0.35 R, 6 m, 150 m) above the higher end,
  dive handle a quarter-range short of the target → ≈ 55° final dive). Nothing is sensed or steered.
  Only the *speed along the curve* is simulated (motor, drag, along-path gravity), so the missile
  visibly soft-launches, speeds up and noses over. Past the end of the curve it flies ballistically
  along the final tangent so the last step sweeps through the aimed surface.
* **Indirect fire** (`planArrival`): the last seconds of an artillery/bomb trajectory are integrated
  *backwards* from the aimed point with the published impact speed and descent angle (M795:
  340 m/s at 60°; Mk 82/BLU-109 bodies: ≈ 285 m/s at 75°). The backward step is the exact algebraic
  inverse of the forward step, so the round lands on the plan (unit-tested to < 5 cm).
* Validity: flat-fire ranges up to a few km, standard sea-level atmosphere, no wind, no spin drift.

---

## 2. Terminal ballistics — brittle targets (concrete, stone, brick) (`penetration.ts`)

**Modified NDRC penetration** (NDRC 1946; Kennedy 1976, *Nucl. Eng. Des.* 37):

```
G = (180 / √f_c) · N · (W/d) · (V / 1000 d)^1.8          (imperial: lb, in, ft/s, psi)
x/d = 2 √G            for G ≤ 1   (x/d ≤ 2)
x/d = G + 1           for G > 1
```

* N = nose factor (0.72 flat … 1.14 sharp ogive), f_c = **damaged** strength f_c · s, where the
  target's probe reports s = 1 − 0.8 D (micro-crack damage D from earlier hits; DESIGN §3). Depth
  grows as f_c^−½ (deep) or f_c^−¼ (shallow), so a burst on one spot keeps digging — the signature
  behaviour.
* Validity: rigid projectiles, V ≲ 1 km/s. Above 1 km/s the nose erodes and NDRC over-predicts; the
  code continues depth ∝ V instead of V^1.8 (`NDRC_VMAX`). Long rods above ≈ 1.3 km/s go to
  Alekseevskii–Tate (§4).
* **Deformable (lead-core) bullets** flatten on concrete: x × (0.4 + 0.45 h), h = hard-core mass
  fraction (M855 steel tip: h = 0.18 → ×0.48). *Fit* to published rifle-into-concrete crater
  depths (the calibration table rows for M855/M80); NDRC itself is for hard missiles.
* **Perforation and scabbing limits** (Kennedy 1976):
  `e/d = 3.19 (x/d) − 0.718 (x/d)²` (x/d ≤ 1.35), `1.32 + 1.24 x/d` (1.35 … 13.5);
  `h_s/d = 7.91 (x/d) − 5.06 (x/d)²` (x/d ≤ 0.65), `2.12 + 1.36 x/d` (0.65 … 11.75).
  A wall thinner than e is perforated; the ballistic limit is the speed whose e equals the wall,
  then **Recht–Ipson** (1963) `V_r = a (V^p − V_bl^p)^(1/p)` with a = 1, p = 2.
  A wall thinner than h_s but thicker than e gets a rear scab (depth ∝ how far inside the limit).
* **Crater** (front cone): volume from the energy *absorbed* in the target,
  `V = E_abs · w / (4 σ)`, σ = f_c · s (fragmentation energy density ≈ 4 f_c), w = 1 for short
  penetrations, √(6d/x) for deep tunnels; cone depth min(x, 2.5–3 d); radius clamped to
  [d, 12 d]. Tunnel radius 0.55–0.6 d for bullets, 1.5 d for eroding long rods (cavity ≈ 3 d:
  game-level estimate). Micro-crack zone `damageRadius = max(4 r_crater, 3 d)` (DESIGN: 3–5 crater
  radii). Exit scab on perforation: punching cone with ≈ 60° half-angle, radius ≥ 1.7 × scab depth.
* **Multi-material runs**: the probe returns concrete → rebar → concrete segments; each segment
  is consumed with its own model (rebar = steel, Lambert–Jonas; a heavily nicked bar reports its
  remaining area fraction as strength). Only the last segment "sees" the free rear face (Kennedy
  perforation); earlier ones are semi-infinite.
* **Soil** (terrain, loose ground): Young (1997, SAND97-2426):
  `D = 0.000018 S N K (m/A)^0.7 (V − 30.5)` (V ≥ 61 m/s),
  `D = 0.0008 S N K (m/A)^0.7 ln(1 + 2.15·10⁻⁴ V²)` (V < 61 m/s; SI units — the English-unit form's
  2·10⁻⁵ is for V in ft/s, an earlier draft had mixed the two and under-predicted slow impacts ~10×),
  K = 0.46 m^0.15 for m < 182 kg, S = 5.

## 3. Terminal ballistics — steel (plates, beams, rebar)

* **Ballistic limit**: Lambert–Jonas (Lambert 1978, ARBRL-MR-02828) for RHA,
  `V_L = 4000 (L/D)^0.15 √(f(z) D³ / m)`, f(z) = z + e^(−z) − 1, z = (t/D) sec^0.75 θ
  (D cm, m g, V m/s). Other steels: × √(σ_u / σ_u,RHA) (plugging / hole-growth energy ∝ flow
  stress; Recht 1978, Woodward 1990) × strength factor s from the probe. Obliquity raises the
  effective thickness through sec^0.75 θ and the line-of-sight path.
* AP rounds: the jacket strips in the first plate and the hard core (its own d, L) does the work.
  For that first plate the whole bullet's mass stands behind the core (the jacket's momentum is
  handed to the core as it strips; using the full mass on the core diameter is what reproduces the
  TM 43-0001-27 plate figures); from the second plate on the round flies as its core alone.
  Lead-core ball: V_bl × (1 + 0.4 (1 − h)) (flattening; *fit* to "M855 perforates ≤ 6 mm, stopped
  by ≥ 10 mm mild steel"); a ball round stopped by the first steel it meets **splashes** (outcome
  `shatter`, shallow dent, 40 % of the energy leaves with the splash).
* Residual velocity: Recht–Ipson with a = m / (m + m_plug) for blunt noses and fragments
  (plug = ρ π d²/4 t cos θ).
* Hole ≈ 1.05–1.4 d (petalling on thin plates), plastic zone from `E_abs = σ_y ε̄ π r² t`, ε̄ ≈ 0.05.
* Validity: sub-ordnance to ordnance velocities (≈ 300–1 800 m/s), L/D ≲ 10 (bullets, AP cores);
  long rods use §4.

## 4. Long rods (APFSDS)

* Into steel: **Lanz–Odermatt** perforation limit (Lanz & Odermatt 1992, 13th Int. Symp.
  Ballistics; W/DU coefficients a = 0.994, b0 = 0.283, b1 = 0.0656, c = 4.024, m = −0.224):
  `P/L = a · (1/tanh(b0 + b1 L/D)) · cos^m θ · √(ρ_p/ρ_t) · exp(−c σ_T / (ρ_p v²))`,
  σ_T = 5.0 GPa × (BHN/280) for steels (c σ_T ≈ 20 GPa for RHA reproduces the Hohler–Stilp W/RHA
  data: P/L ≈ 0.95 at 1.5 km/s). The rod erodes in proportion to the fraction of the limit used;
  its tail decelerates by the Tate relation.
* Into concrete / soil / glass: **Alekseevskii–Tate** eroding-rod equations (Alekseevskii 1966;
  Tate 1967, *J. Mech. Phys. Solids* 15) integrated in time:
  `½ ρ_p (v − u)² + Y_p = ½ ρ_t u² + R_t`, `dv/dt = −Y_p / (ρ_p l)`, `dl/dt = −(v − u)`;
  rigid-body penetration once ½ρ_t v² + R_t < Y_p. Concrete resistance from the Forrestal et al.
  (1994, *Int. J. Impact Eng.* 15) cavity-expansion fit `R_t = S f_c`, S = 82.6 f_c^−0.544
  (f_c in MPa; 444 MPa for C40). Y_p = 1.4 GPa (DU/W), 1.0 GPa (steel).
* Validity: 1.2–2.0 km/s, L/D 10–40.

## 5. Shaped-charge (HEAT) jets

* Each round carries its published RHA rating (PG-7VL 500 mm, M830A1 480 mm, Javelin 780 mm, …).
  Hydrodynamic jet penetration scales as √(ρ_jet/ρ_t) (Birkhoff et al. 1948, *J. Appl. Phys.* 19),
  so one metre of material costs `√(ρ_t/ρ_RHA) / f_s` metres of RHA capacity, with a strength
  factor `f_s = clamp((Y_RHA/Y_t)^0.16, 0.8, 2.2)` (fit: ≈ 3× the RHA rating in C40 — the "1.2–1.8 m
  of concrete" of an RPG-7). Capacity is consumed segment by segment along the line of sight;
  after a perforation the jet loses coherence with free flight distance s: × (1 − s / 30 CD).
* Hole ≈ 0.2 CD in steel (clean), ≈ 0.5 CD tunnel with a ≈ 2.4 CD entry crater in concrete.
  Behind-armour debris: 6–10 fragments in a 28–35° cone at 0.15–1.5 km/s (Held 1999, *Propellants
  Explos. Pyrotech.* 24), flown as real projectiles.
* Event order per HEAT hit: tandem precursor jet (if any) → main jet `impact` events (agent `jet`)
  through every target in line → follow-through charge (ASM 509) → the warhead's blast. The blast
  is a normal air blast of the full fill; as a **contact** load only `SHAPED_CONTACT_COUPLING` = 0.25
  of it acts on the struck face (game-level estimate: stand-off + energy spent on the liner),
  so the jet makes the hole and the blast leaves a modest entry crater ("small blast").

## 6. Ricochet

Tate-type critical grazing angle (Tate 1979, *J. Phys. D* 12): `tan³β_c ∝ Y_t / (ρ_p v²)`, scaled
from observed thresholds on RHA (long rods ≈ 12° at 1.5 km/s; AP and steel-bodied shells ≈ 20° and
lead ball ≈ 30° at 850 m/s; fragments ≈ 25° at 1 km/s). The edge is smoothed ±15 % so it is
stochastic. Out-going grazing angle 0.3–0.5 of the incoming one, speed × (0.9 − 0.6 sin β); a
round that has skipped twice is considered tumbling and stops at the next graze (a live
delay-fuzed charge still fires where it stops, as it does in a round that only just gets through
a target). Impact-fuzed and shaped-charge rounds never ricochet (graze-sensitive fuzes function).

## 7. Blast (`blast.ts`, `BlastSystem.ts`)

* **Kingery–Bulmash** hemispherical surface-burst fits (Kingery & Bulmash 1984, ARBRL-TR-02555),
  in the polynomial-in-ln Z form of Swisdak (1994, 26th DoD Explosives Safety Seminar) — the curves
  of UFC 3-340-02 fig. 2-15: incident and normally reflected peak pressure, incident and reflected
  specific impulse, arrival time, positive-phase duration vs Z = R / W^⅓. Outside the table:
  clamp below Z_min; log-log continuation above; normally reflected pressure beyond Z = 40 from the
  Rankine–Hugoniot relation `P_r = 2 P_s (7 P_0 + 4 P_s)/(7 P_0 + P_s)` (→ 2 P_s acoustic limit).
  Segment joints are continuous to < 3 % (unit-tested).
* Free-air bursts: W_hemi = W / 1.8 (ground-reflection factor 1.8, UFC 3-340-02 §2-13), blended
  with scaled height of burst; charges on a surface (contact, HESH, impact-fuzed) use W.
* **Oblique reflection** (Randers-Pehrson & Bannister 1997, ARL-TR-1310; the ConWep/LS-DYNA form):
  `P(α) = P_i (1 + cos α − 2 cos² α) + P_r cos² α`, P_i on faces turned away.
* Thermobaric fills: same peak per TNT-e, impulse and duration × 1.75 (game-level estimate from
  published "long positive phase" descriptions). Fireball radius 1.75 W^⅓ (Baker et al. 1983).
* **Shock-arrival scheduling**: `BlastSystem` emits `blast` at detonation, then delivers
  `applyBlast` to each destructible, each rigid-body impulse and the camera shake **when the front
  reaches it** (KB arrival time, in simulation time), so slow motion shows windows failing in an
  expanding ring. The detonation carries the moment *inside* the fixed step at which the shell
  struck (or its fuze ran out), so arrival times are not rounded up by a step: a load is applied at
  the end of the step in which its front arrives — never before it — and the contact target of a
  shell or charge is loaded in the same step as the detonation. Casing fragments are thrown from
  that moment too (their first flight step catches up with the clock).
* Occlusion: a target whose line to the charge is blocked by another destructible gets 0.3 × the
  pressure/impulse (diffraction; game-level estimate).
* Rigid bodies: impulse `J = i_r · π r_eq²` along the outward direction, capped at Δv 400 m/s.
* Camera shake: `0.3 log10(P_s,camera / 300 Pa)` clamped to [0, 1], delivered at arrival.

### 7.1 Contact and near-contact charges (`contactDamage`)

* Concrete/stone/brick (McVay 1988, "Spall damage of concrete structures", USAE WES TR SL-88-22;
  UFC 3-340-02 spall & breach thresholds): with T* = T / W^⅓ (m/kg^⅓), **breach** for
  T* < 0.18 and **rear spall** for T* < 0.33 (normal-strength concrete), both × (f_c/40 MPa)^−¼ so
  weaker masonry fails at larger T*; HESH × 1.2 / 1.3. Front crater radius 0.30 W^⅓, depth
  0.12 W^⅓; spall velocity 5–150 m/s growing with how far inside the threshold the wall is.
  Buried (delay-fuzed) charges are tamped: × (1 + 2.6 · min(1, depth / 0.3 W^⅓)), up to the
  FM 5-250 tamping factor 3.6.
* Steel: holed for t < 0.020 W^⅓ √(510 MPa/σ_u) (FM 5-250 steel-cutting rule P = 3/8 A applied to
  the charge perimeter); rear scab for t < 0.09 W^⅓ √(1100 MPa/σ_u) (≈ 1.3 calibres for a 120 mm
  HESH) with a scab about the squashed-charge footprint; dish depth from **Nurick & Martin** (1989,
  *Int. J. Impact Eng.* 8): `δ/t = 0.480 φ + 0.277`, `φ = I (1 + ln(R/r0)) / (π R t² √(ρ σ_y))`,
  I ≈ 1 000 N·s per kg TNT (half the (8/27) W D momentum of a slab charge on a rigid wall).
* Glass in contact: always holed. Soil: crater 0.4 W^⅓ × 0.2 W^⅓ (Cooper 1996).

### 7.2 Pressure–impulse damage (`damageAt`)

`(P/P0 − 1)(I/I0 − 1) = ψ`, ψ = 0.3 (Baker et al. 1983, the SDOF P–I shape of PDC-TR 06-08).
The damage number is < 1 below the onset curve (P0, I0), 1 → 2 interpolated logarithmically
between onset and the severe curve (P0b, I0b), 2 + log₂(scale) beyond.

| Member | Onset (1) | Severe / breach (2) | Basis |
| --- | --- | --- | --- |
| Glass (1.5 × 1 m) | P0 = 4.5 kPa · (t/6 mm)² · GTF (tempered 4, laminated 1.1), I0 = 2 P0/ω, ω = 2π·21 Hz·(t/6 mm) | 2 × onset (laminated 3× more: interlayer holds) | ASTM E1300 load resistance; first mode of the pane |
| Concrete, stone, brick walls | elastic SDOF of a 3 m one-way strip: R_cr = 8 f_t h²/(6 L²), k = 384 E I/(5 L⁴), P0 = R_cr/2, I0 = x_cr √(0.78 m k) | RC: 20 P0 / 48 I0 (local breach); masonry/stone: 10 P0 / 24 I0 | Biggs 1964; PDC-TR 06-08 SDOF |
| Steel plates | P0 = 6 σ_y t²/a² (a ≈ 1 m, yield line), I0 from Nurick–Martin φ = 1.5 | 4 P0, φ = 25 (tearing) | Nurick & Martin 1989 |

## 8. Fragments (`fragments.ts`)

* Initial speed: **Gurney** cylinder `V = √(2E) / √(M/C + ½)` (Gurney 1943, BRL-405), √(2E) per
  filler (TNT 2 440 m/s, Comp B ≈ 2 700 m/s). M795: 1 277 m/s. The shell's own velocity is added.
* Masses: **Mott** (1947, *Proc. R. Soc. A* 189; NAVORD Report 2022) distribution
  N(> m) = N0 exp(−√(m/μ)), `√μ = B t^(5/6) d_i^(1/3) (1 + t/d_i)` (lb, in; B = 0.0646 for TNT),
  each fragment ≤ 5 % of the casing. (The earlier draft had t^(5/16) — a typo that breaks the
  units of B; fixed.)
* A few dozen *representative* fragments (`14 · M_casing^⅓`, 4–64) with their true sampled mass and
  speed fly as real projectiles (blunt-body drag, presented area 0.0047 m^⅔ · m^⅔) and are resolved
  like any other round: they pock concrete, hole thin sheet and riddle glass.

## 9. Fuzes and flow of one shot (`ProjectileSystem.ts`)

* **Impact** fuze: detonates on the struck surface, 0.5 calibre off the face, as a contact load on
  that target. HEAT: jet(s) first, then the blast (§5).
* **Delay** fuze: starts on first contact. If it runs out inside the material the round is buried
  there — position from uniform deceleration, `x/x_run = (2 v0 f + (v1 − v0) f²)/(v0 + v1)` — and
  fires when the remaining delay has elapsed in sim time (BLU-109 ≈ 15 ms after contact); a round
  that stops before its delay waits embedded; one that perforates carries its fuze into the next
  flight (M908 ≈ 0.55 m behind a plate). Mk 211's small charge fires once and the core flies on.
* **Self-destruct** timers (RPG-7 grenades, 4.5 s).
* Every hit: `probe()` → pure resolver → `target.applyImpact(ev)` → `impact` event; perforation and
  ricochet continue within the same fixed step (up to 8 interactions per step), so one round can
  chain through several targets. A target whose ray test reports a surface but whose probe finds
  no material on the shot line (the rim of a hole) is passed without an event.
* **Timing inside the step.** The sweep keeps track of time along the segment flown in the step,
  so every `impact` event, detonation and fuze carries the moment it happened (a 5.56 round
  reaching a wall 20 m away is stamped 22.8 ms, not at the 33.3 ms step boundary; BLU-109 fires
  exactly 15 ms after contact). Rounds fired at a cyclic rate leave at their own time inside the
  step (`spawnAt`), whichever order the weapon and projectile systems run in.

---

## 10. Calibration (DESIGN.md §3) — model output vs reference

Produced by `calibrationRows()` (`src/physics/ballistics/calibration.ts`), asserted in
`test/ballistics.test.ts`. Speeds at range come from the flight model (§1).

| Case | Reference (source) | Tolerance | Model | ✓ |
| --- | --- | --- | --- | --- |
| 5.56 M855 @ 900 m/s → C40, depth | 15–40 mm | range | 32.9 mm | ✓ |
| 5.56 M855 @ 900 m/s → C40, crater Ø | 40–90 mm | range | 47.7 mm | ✓ |
| 7.62 M80 @ 830 m/s → C40, depth | 25–60 mm | range | 32.2 mm | ✓ |
| .50 M2 AP @ 880 m/s → C40, depth | 100–200 mm | range | 169.6 mm | ✓ |
| M855 @ 900 m/s vs S355 6 mm | perforates | — | perforates, 664 m/s out | ✓ |
| M855 @ 900 m/s vs S355 10 mm | stopped | — | splashes (dent 1.9 mm) | ✓ |
| M855 vs S355 perforation limit | 6–10 mm | — | 9.7 mm | ✓ |
| 7.62 M993 AP vs RHA @ 100 m (817 m/s) | 8–15 mm class (open sources) | ±30 % | 13.9 mm | ✓ |
| .50 M2 AP vs RHA @ 100 m (842 m/s) | ≈ 20–25 mm (TM 43-0001-27: 22 mm at 100 yd) | ±25 % | 21.4 mm | ✓ |
| 30 mm PGU-14 API vs RHA @ 500 m (853 m/s) | ≈ 55–70 mm (GD-OTS: 69 mm) | ±25 % | 55.9 mm | ✓ (low end) |
| 120 mm M829A4 vs RHA @ 2 km (1 437 m/s) | ≈ 650–800 mm (open estimates) | ±15 % | 732 mm | ✓ |
| PG-7VL HEAT vs RHA | ≈ 500 mm | ±15 % | 500 mm | ✓ |
| PG-7VL HEAT vs C40 | ≈ 1.2–1.8 m | ±15 % | 1.50 m | ✓ |
| Javelin vs RHA | ≈ 750–800 mm | ±15 % | 780 mm | ✓ |
| 1 kg TNT free air, R = 5 m: **reflected** overpressure | ≈ 70 kPa (DESIGN, see note) | ±20 % | 69.6 kPa | ✓ |
| 1 kg TNT free air, R = 5 m: incident overpressure | ≈ 29 kPa (Kinney & Graham 1985) | ±20 % | 31.1 kPa | ✓ |
| 1 kg TNT free air, R = 5 m: arrival time | ≈ 8–9 ms | ±20 % | 9.1 ms | ✓ |
| 1 kg TNT surface burst, R = 5 m: incident | ≈ 43 kPa (UFC 3-340-02 fig. 2-15) | ±20 % | 43.2 kPa | ✓ |
| Annealed 6 mm pane 1.5 × 1 m fails at | ≈ 3–7 kPa reflected (ASTM E1300 scale) | range | 4.7 kPa | ✓ |
| Tempered 6 mm pane fails at | ≈ 4 × annealed | 12–28 kPa | 18.9 kPa | ✓ |

**Note — the 70 kPa target.** DESIGN.md lists "1 kg TNT, R = 5 m: incident overpressure ≈ 70 kPa
(Kingery–Bulmash)". No published model gives that: the free-air *incident* (side-on) peak is
29 kPa (Kinney–Graham) / 31 kPa (KB with the 1.8 reflection factor), and 43 kPa even for a charge
lying on the ground. ≈ 70 kPa is the **normally reflected** peak on a wall facing the charge.
Rather than distort the KB fits, the tests assert both: reflected ≈ 70 kPa and incident ≈ 29 kPa.

### 10.1 Further model outputs (single hits, pristine material)

| Round @ speed | C40 depth mm | crater Ø × depth mm | damage zone r mm | perforates C40 up to | S355 up to | RHA up to |
| --- | --- | --- | --- | --- | --- | --- |
| M855 @ 900 | 33 | 48 × 17 | 95 | 48 mm | 9.7 mm | 6.1 mm |
| M80 @ 830 | 32 | 58 × 23 | 116 | 50 mm | 10.9 mm | 6.9 mm |
| 57-N-323S LPS @ 825 | 42 | 57 × 24 | 115 | 63 mm | 11.7 mm | 7.4 mm |
| M33 ball @ 887 | 110 | 93 × 39 | 187 | 153 mm | 23.9 mm | 14.9 mm |
| M2 AP @ 880 | 170 | 94 × 32 | 188 | 227 mm | 39.0 mm | 22.7 mm |
| M995 AP @ 1 000 | 69 | 45 × 14 | 89 | 93 mm | 22.3 mm | 12.4 mm |
| M993 AP @ 910 | 82 | 56 × 20 | 112 | 112 mm | 29.0 mm | 16.1 mm |
| PGU-14 API @ 1 013 | 410 | 207 × 75 | 414 | 548 mm | 137 mm | 72 mm |
| M829A4 @ 1 555 | > 3 000 | 528 × 55 | 1 056 | > 3 m | 973 mm | 790 mm |

Contact charges on the struck member (`contactDamage`):

| Charge | Front crater | Breach | Rear spall |
| --- | --- | --- | --- |
| 1 × M112 C4 (0.76 kg TNT-e) on 250 mm C40 | Ø 0.55 m × 110 mm | — | Ø 0.73 m × 67 mm @ 27 m/s |
| 4 × M112 (3.06 kg) on 250 mm C40 | Ø 0.87 m × 174 mm | Ø 0.47 m | Ø 1.38 m, full depth @ 57 m/s |
| 155 mm M795 (10.8 kg) on 250 mm C40 | Ø 1.33 m | Ø 1.36 m | Ø 2.29 m @ 83 m/s |
| PG-7VL warhead (1.2 kg, shaped, 25 % coupled) on 250 mm C40 | Ø 0.40 m × 80 mm | — | — (the jet holes it) |
| M830A1 (1.6 kg, shaped) on 20 mm S355 | dish Ø 0.18 m × 12 mm | — | scab Ø 0.12 m × 8 mm |
| 1.6 kg bare HE on 20 mm S355 | dish Ø 0.28 m × 33 mm | Ø 0.12 m | — |
| L31A7 HESH (4.8 kg) on 100 mm RHA | dish 14 mm | — | scab Ø 0.29 m × 34 mm @ 126 m/s |
| 1 kg on 240 mm brick | Ø 0.81 m | Ø 0.33 m | full depth @ 56 m/s |

P–I damage distances (charge 1.2 m above ground, surface-burst equivalent, face-on):

| Charge | annealed 6 mm breaks within | tempered 6 mm | laminated cracks / tears | 250 mm RC cracks / severe | 240 mm brick cracks / severe | 12 mm steel yields / tears |
| --- | --- | --- | --- | --- | --- | --- |
| 1 kg TNT | 8.5 m | 2.5 m | 7.8 / 1.7 m | 5.5 / 0.31 m | 13.6 / 0.92 m | 1.15 / 0.30 m |
| 10.8 kg TNT (155 mm) | 37 m | 10.7 m | 34 / 7.0 m | 21 / 1.1 m | 59 / 3.7 m | 4.4 / 0.65 m |

Exterior ballistics (flat fire, speed m/s at 100 / 300 / 500 / 1 000 / 2 000 m): M855
799/608/440/273/157; M80 764/623/495/305/202; M33 839/747/661/468/287; PGU-14 980/916/853/708/456;
M829A4 1 549/1 537/1 525/1 495/1 437.

---

## 11. Integration check on the ballistics range (`sandbox/ballistics.html`)

The range uses the real element modules: two 3 × 2.5 × 0.25 m RC walls (C40, Ø12 @ 150 mm both
faces, 30 mm cover; `createVoxelElement`), a 12 mm and a 20 mm S355 plate (`createSteelPlate`), an
HEB 300 column under 1.5 MN (`createSteelBeam`), five framed 6 mm annealed 1.5 × 1 m windows at
8/16/28/45/70 m from wall B (`createGlassPane`), terrain, the production `Pipeline` and `installFx`.
Scenario: `node scripts/shot.ts sandbox/ballistics.html --scenario <file>.mjs` (`window.__range`
helpers — zeroed firing, impact/blast logs, window forecast; `window.__sim` generic harness).
Screenshots of the final run are in `.shots/ballistics/`. Results:

* **5.56 M855, 150-round burst on one spot of wall A from 25 m** (`__sim.fire`, 3 MOA ≈ 2.2 cm σ):
  single hit embed 31–33 mm, crater Ø 46–48 × 17 mm (table). Deepest point below the face after
  10/20/…/150 rounds: 55, 68, 79, 102, 106, 122, 133, 154, 161, 177, 186, 211, 229, 233, 233 mm —
  it deepens every burst; per-round runs lengthen from 31 to 35–38 mm as damage lowers f_c; the
  mesh is exposed, bars are struck (Lambert–Jonas, "DURDU" on a bar), nicked and finally cut;
  the first rounds pass through between rounds 131 and 140 (with a 2.5 cm σ group: round 165 of 250;
  with a tight 8 mm group: round ≈ 99). FM 3-06.11 quotes ≈ 250 rounds of 5.56 to open a loophole in
  20 cm of reinforced concrete — the same order.
* **.50 M2 AP on 12 mm S355, 30 m:** 3 × perforation, 867 → 789 m/s (V_bl 359 m/s), Ø 13 mm holes.
* **120 mm M830A1 HEAT-MP on 20 mm S355:** jet event first (perforates, ≈ 17 mm RHA-e used,
  461 mm RHA left), then the shaped blast (contact damage number 3.96: dish and soot), and ≈ 30 body
  fragments that splash/embed on the plate. **M908 HE-OR:** the 11 kg steel-nosed body perforates
  20 mm steel (V_bl 138 m/s ≪ 1 404 m/s; Ø 0.2 m hole) and its 0.4 ms delay fires it ≈ 0.55 m behind
  the plate; the second round goes through the first hole and skips off the ground 150 m down range
  (0.4° graze, ricochet as a steel-bodied shell). *No "dent first, perforate after repeats" regime
  exists for 120 mm rounds against 20 mm plate: every published model perforates it on the first
  hit.* Dent-then-tear accumulation is what small arms and fragments do here (M855 splashes on
  10 mm, 120 mm body fragments shatter/embed on 20 mm).
* **HEB 300 column:** M908 perforates the front flange (19 mm) and the HEAT round holes it; the
  column shows the holes, soot and a permanent bow. Down the web plane the probe reports flange +
  262 mm of web + flange and the M908 still gets through (640 m/s out). Rear flanges are *not*
  struck after a front-flange perforation because of a steel-module ray-test issue (report).
* **M829A4 APFSDS through wall A, 60 m:** perforates 258 mm in one hit, 1 550 → 1 530 m/s, rod
  800 → 736 mm, front crater Ø 0.47 m, rear scab Ø 0.61 m, 66 mm tunnel (Tate, R_t = 444 MPa).
* **RPG-7 PG-7VL from 80 m:** visibly flies 0.54 s (115 m/s, sustainer from 0.1 s, 199 m/s at the
  wall); the jet perforates the 25 cm RC wall (≈ 97 mm RHA-e used, 401 mm left) and the warhead's
  coupled blast leaves a Ø ≈ 0.4 m entry crater with exposed bars. Aimed with the sight's
  superelevation (≈ 1°); un-zeroed it drops 1.3 m and strikes the ground 4 m short, as a real one does.
* **C4:** one M112 block on wall A: crater, rear spall with exposed mesh, **no breach**
  (T* = 0.27 m/kg^⅓ > 0.18); four blocks on wall B: **breach** (Ø ≈ 0.5 m hole, bent bars,
  Ø ≈ 1.4 m rear spall); the 8 m window (P–I 2.03) breaks.
* **155 mm M795 onto wall B:** breach, most of the wall's upper half blown out with the mesh bent
  outward; windows at 8, 16 and 28 m are loaded 17, 33 and 68 ms after the burst (KB: 9.8, 29.5,
  62 ms; one 1/60 s step of quantisation) and break; 45 m (P–I 0.82) and 70 m (0.51) stay intact —
  exactly as `__range.windowForecast` predicted.
* **Top-attack launcher, 120 m onto wall B:** scripted loft to ≈ 30 m, 2.0 s flight, 28 → 130 m/s,
  strikes from above.

## 12. Known limitations and estimates (not from a published relation)

* `SHAPED_CONTACT_COUPLING = 0.25`, occlusion factor 0.3, thermobaric × 1.75, the ricochet anchor
  angles, the lead-ball deformation factors, the glass ballistic limit (0.3 × Lambert–Jonas of the
  same thickness of RHA) and the 1.5 d rod cavity are game-level estimates chosen to match open
  descriptions/photographs; they are isolated as named constants.
* Rigid-projectile NDRC above 1 km/s is extended linearly in V (`NDRC_VMAX`); long rods leave it.
* P–I curves treat every member as a 3 m one-way strip (walls) or a 1.5 × 1 m pane (glass); the RC
  "severe" curve stands for *local* breach as the voxel element realises it, deliberately heavier
  than the PDC-TR 06-08 global-flexure "heavy damage" limit (≈ 2.4 kPa·s / 55 kPa for 25 cm).
* Probes along a thin plate edge-on (e.g. down the web of an I-section) report the whole path as
  steel; the resolver then treats it as a thick plate (see the report to M3).
* Blast loads, body impulses and camera shake are *applied* at the end of the fixed step in which
  the front arrives (≤ 1/60 s after the exact KB arrival at normal speed, finer in slow motion);
  the arrival times themselves are computed from the exact detonation moment.
