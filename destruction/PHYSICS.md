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
betonarme, tuğla ve çelik levhalar için basınç–itki (P–I) hasar sayıları (betonarme duvarlar için
donatılı kesitin tek serbestlik dereceli SDOF modeli ve PDC-TR 06-08 hasar sınırları: 25 cm'lik bir
duvarı 10 m'deki 4 kg TNT çatlatmaz, temas hâlindeki 4 kg deler), kapalı mekânda patlamalar için
yarı-statik gaz basıncı (UFC 3-340-02, W/V), parçalar için Gurney hızı ve Mott kütle dağılımı.
Betona gömülmek için yapılmış HE-OR mermisi kalın/sert çeliğe çarptığında gövdesi çöker (Tate'in
rijit uç koşulu ve gövde ezilme yükü > levha tıkaç kuvveti): mermi yüzeyde parçalanır, çelikte
7–18 mm'lik bir göçük ve 16 kN·s'lik itki bırakır, dolgu göçükte patlar — tekrarlanan isabetler
önce ezer ve eğer, incelmiş levhayı sonra yırtar. Her mermi hedeflerin ışın testine kendi yarıçapını
taşır: kendinden dar bir delikten geçemez, deliğin kenarına çarpar. Uçuş oyun seviyesinde tutulmuştur: yerçekimi, hava direnci, roketlerde
basit motor itkisi; üstten saldırı fırlatıcısının yayı ise hiçbir güdüm algoritması içermeyen,
tamamen görsel, önceden çizilmiş bir eğridir. Tasarım belgesindeki (DESIGN.md §3) bütün kalibrasyon
hedefleri birim testleriyle doğrulanır. "1 kg TNT, 5 m: ≈70 kPa" satırı **yansıyan** (duvara dik
çarpan) basınçtır; aynı noktada serbest havadaki gelen (yan) basınç ≈30 kPa'dır, yere yakın
patlamada daha yüksektir (≈43 kPa). HUD bu iki değeri `blastAt` üzerinden ayrı ayrı gösterir.

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
* **Capped HE shells** (M908 HE-OR: a hardened 1.2 kg steel nose cap on a thin HE body): against
  steel only the cap is the penetrator (Lambert–Jonas with the cap's mass, calibre and length
  m/(ρ π d²/4)) — *if the body holds* (next item). The whole round's momentum goes into the
  member (perforation: m(v − v_r); stopped: outcome `shatter`, all of m v). Into concrete NDRC
  still sees the whole round (it is built to dig).
* **Shell break-up on steel** (`shellBreakup`; every steel-cased HE/HESH/thermobaric round that
  reaches a target kinetically: M908, delay-fuzed bombs, follow-through charges). An HE-OR is made
  to defeat concrete; on thick or hard steel its nose and body break up and the charge fires on the
  face. Three steps, only on a *struck steel face* (a bar inside concrete is cut, not plugged):
  1. *No rigid nose on steel* (Tate 1967, *J. Mech. Phys. Solids* 15): a penetrator whose flow
     stress Y_p is below the target resistance R_t deforms at every speed. R_t = 2.7 GPa (S355),
     5 GPa (RHA) (the Lanz–Odermatt σ_T of §4) against Y_p ≈ 1.2 GPa for a hardened nose
     (`SHELL_NOSE_STRENGTH`, estimate ≈ HRC 40). Concrete (R_t = 0.44 GPa, Forrestal) does not
     meet the condition, so **concrete behaviour is unchanged** (C40 perforation limit 3.4 m).
  2. *Body strength*: the deforming nose is only driven as hard as the thin body behind it can push.
     The force to plug the plate, `F_plug = τ π d t_los` with τ = 0.6 σ_u (Recht & Ipson 1963
     plugging; von Mises τ ≈ σ/√3), is compared with the body's crush load `F_crush = A_wall σ_case`,
     A_wall = casing mass / (ρ · 0.6 L) (the casing geometry of `fragments.ts`), σ_case ≈ 1 GPa
     (`SHELL_CASE_STRENGTH`, estimate for quenched-and-tempered shell steel). M908: 16 cm² →
     1.6 MN; S355 plugs at 77 MN/m × t (1.5 MN for 19 mm, 3.1 MN for 40 mm), RHA at 166 MN/m × t.
     The line-of-sight thickness is used, so obliquity loads the body harder (19 mm at 60° breaks it).
  3. *Nose depth*: the nose alone then erodes into the plate — Alekseevskii–Tate (§4) with the nose
     as a short rod (cap 1.2 kg → L = 30 mm, L/D 0.38; a round without a cap: 15 % of its casing
     steel, estimate). This is Tate's primary penetration (a lower estimate for L/D < 1, where
     after-flow adds some): 17.5 mm in S355, 7.3 mm in RHA at 1.4 km/s. The plate absorbs the Tate
     share u/v of the nose's energy (the interface force does F·u of work on the target and
     F·(v − u) eroding the nose): 40 % on S355, 25 % on RHA (475 / 298 kJ of the cap's 1.18 MJ).
  Outcome `shatter`: dent of the nose depth, all of m v (16 kN·s) into the member, and the delay
  fuze fires in the dent (tamping 1.1). *Cross-check:* the collapsing body behind the nose (10 kg
  in 3.9 L, mean density ≈ 2.6 t/m³) arrives with a stagnation pressure ½ρv² = 2.6 GPa at 1.4 km/s
  — below R_t of either steel, so the debris cannot follow the nose in: it splashes (and hands over
  its momentum), whereas into concrete (0.44 GPa) it can. A plate the body *can* plug (thin, or
  weakened by earlier hits: the probe's strength factor scales τ and R_t) is punched through as
  before and the round flies on to its delay; that is the dent → tear progression of repeated hits
  on heavy steel. M908 at 1.4 km/s, square-on: perforates S355 up to 21 mm (18 / 15 / 11 mm at
  30 / 45 / 60°), RHA up to 10 mm; breaks up on anything thicker (was: 124 mm S355, 78 mm RHA with
  the rigid-cap model, which perforated the 40 mm box girder and 50 mm RHA at the first hit).
  Impact-fuzed HESH and HEAT-MP never reach the resolver: their fuzes function on the face (HEAT:
  jet first, §5), i.e. they "break up" there by design.
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
* **Loose rigid bodies** (`bodyBlastImpulse`): the reflected impulse is integrated over the
  presented disc π r_eq² (four equal-area rings, oblique reflection per ring) at the body's own
  standoff s = R − r_eq (never inside the charge radius 0.053 W^⅓); a finite body only feels the
  reflected pressure until it clears, `t_c ≈ 4S/((1 + S/G)U) ≈ 2 r_eq / 400 m/s` (UFC 3-340-02
  §2-15.3), so `i = i_s + (i_r − i_s) min(1, t_c/t_d)`; and inside the fireball (products
  near-field) the push is bounded by the momentum the charge can put into the solid angle the body
  subtends: a Gurney sphere with a linear velocity profile carries ≈ W √(2E) of outward momentum
  (Gurney 1943), doubled at most by reflection, so `J ≤ W √(2E) (1 − cos α)`. The bound relaxes
  between 0.5 and 1.5 fireball radii where the air shock takes over. Δv is also capped at 400 m/s.
  *Fix:* the earlier `i_r(point) · π r_eq²` evaluated the impulse at a point up to 0.9 R inside a
  large body next to the charge, i.e. almost on the charge, and applied that over its whole
  cross-section: a 2.3 kg column charge threw a 12 t roof strip ≈ 4 m up. Now: Δv ≈ 0.1 m/s.
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
between onset and the severe curve (P0b, I0b), 2 + log₂(scale) beyond. P and I are the
*reflected* (oblique) values on the face.

**Walls and slabs** are a one-way strip of span L = 3 m, simply supported, as an
elastic–perfectly-plastic SDOF (Biggs 1964, ch. 5; UFC 3-340-02 §3-19). For a peak deflection x_m:

```
impulsive asymptote      I = √(2 K_LM m R_u (x_m − x_y/2))      K_LM = 0.66 (plastic, Biggs table 5.1)
quasi-static asymptote   P = R_u (1 − x_y / (2 x_m))            x_y = R_u / k,  m = ρ h
```

Damage number 1 = PDC-TR 06-08 B2 (moderate: visible cracks, some permanent deflection),
2 = B4 (hazardous: failure — local breach or blow-out). B1 (μ = 1, "no visible damage") is below 1.

| Member | R_u | k | x_m (1 / 2) | Basis |
| --- | --- | --- | --- | --- |
| Reinforced concrete (`concrete`, `concrete_hs`) | 8 M_p/L², M_p = A_s f_dy (d − a/2), a = A_s f_dy/(0.85 f'_dc), d = 0.85 h, A_s = 0.3 % of d per face, f_dy = 1.1·1.17·500 MPa, f'_dc = 1.19 f_c; ≥ cracking f_t h²/6 | 384 E I_a/(5L⁴), I_a = (I_g + I_cr)/2 | support rotation 2° / 10° | UFC 3-340-02 eq. 4-1/4-2, tables 4-1/4-2 (SIF, DIF), §4-11; PDC-TR 06-08 |
| Masonry and stone (unreinforced) | rigid arching, crushed hinges 0.1 h: 8·0.0765 f_m h²/L²; ≥ cracking | 384 E I_g/(5L⁴) | 1.5° / 8°, ≤ 0.5 h (snap-through) | McDowell, McKee & Sevin 1956; PDC-TR 06-08 |
| Glass (1.5 × 1 m) | P0 = 4.5 kPa · (t/6 mm)² · GTF (tempered 4, laminated 1.1), I0 = 2 P0/ω, ω = 2π·21 Hz·(t/6 mm); severe 2 × onset (laminated 3× more) | | | ASTM E1300; first mode of the pane |
| Steel plates | P0 = 6 σ_y t²/a² (a ≈ 1 m), I0 from Nurick–Martin φ = 1.5; severe 4 P0, φ = 25 | | | Nurick & Martin 1989 |

Resulting asymptotes (onset / severe):

| Member | P0 | I0 | P0b | I0b |
| --- | --- | --- | --- | --- |
| RC C40 200 mm | 47 kPa | 1.24 kPa·s | 48 kPa | 2.8 kPa·s |
| RC C40 250 mm | 73 kPa | 1.74 kPa·s | 75 kPa | 4.0 kPa·s |
| RC C40 300 mm | 106 kPa | 2.3 kPa·s | 108 kPa | 5.2 kPa·s |
| RC C40 400 mm | 190 kPa | 3.6 kPa·s | 193 kPa | 8.0 kPa·s |
| Brick 230 mm | 38 kPa | 0.93 kPa·s | 42 kPa | 1.7 kPa·s |
| Brick 600 mm | 281 kPa | 4.1 kPa·s | 291 kPa | 9.6 kPa·s |
| Travertine 200 mm | 148 kPa | 1.9 kPa·s | 157 kPa | 3.2 kPa·s |

A short pulse (triangular, 10 ms) must peak at ≈ 0.4–0.7 MPa to crack 250 mm RC. The quasi-static
asymptotes of the two curves nearly coincide (elastic–perfectly-plastic: once a sustained load
exceeds R_u the deflection is unbounded) — that is what a confined detonation's gas pressure
meets (§7.3). *Fix:* the earlier model placed onset at elastic **cracking of plain concrete**
(f_t, no reinforcement: 16 kPa / 107 Pa·s for 250 mm) and interpolated logarithmically to a
local-breach curve 20–48× higher, so a 4 kg charge "cracked" 25 cm RC out to 12–20 m and a
0.6 m brick block 7–9 m away was breached. Unit tests now pin: 4 kg at 5 m → no damage on 25 cm RC
(D = 0.17), at 10–12 m → D < 0.1, at 1 m → cracked, at 0.5 m → breached; the 0.6 m brick block at
7–9 m → D < 0.05; contact → breach by `contactDamage` (T* = 0.16 < 0.18).

### 7.3 Confined detonations: quasi-static gas pressure

Inside a room the detonation products and heated air cannot expand freely: after the shock
reverberations a **quasi-static gas pressure** loads every surface of the enclosure for tens to
hundreds of milliseconds (UFC 3-340-02 ch. 2, fig. 2-152).

* **Confinement** (`BlastSystem.measureEnclosure`, per detonation): 6 axis rays first (fewer than
  5 meeting a surface within 15 m → open air, done); then 64 rays on a Fibonacci sphere. A ray that
  meets a solid destructible or the ground plane bounds the room; one that escapes, or meets
  glazing (which fails long before the walls), is an opening. Volume `V ≈ Σ ΔΩ r³/3`, vent area
  `A ≈ Σ ΔΩ r²` over the openings (escaped rays at the mean wall distance), closed fraction ≥ 0.5.
  Targets met by a ray are the enclosure — minus anything standing *in* the room (compact in
  plan, ≤ 0.3 × the room radius, with the room's own boundary behind it: a column is pressed
  from all sides, no net gas load) — plus panels in plain view that do not stand in the room (the
  ones the 64 rays happened to miss, e.g. the chapel's altar panels). Charges under 0.01 kg are
  not probed; a probe is reused for detonations within 1 m and 0.5 s (cannon HE bursts).
* **Pressure**: Weibull (1968) closed-chamber fit, `Δp_QS = 2.25 MPa · (W/V)^0.72` (W kg TNT,
  V m³; the curve of UFC 3-340-02 fig. 2-152, NATO AASTP-1). 12 kg in the 616 m³ chapel → 132 kPa.
  Thermobaric fills afterburn in the room air: W × 1.75 (estimate) → 203 kPa.
* **Venting**: full pressure for a scaled vent area A/V^⅔ ≤ 0.15, none from 0.6 up (smoothstep;
  game-level reading of UFC 3-340-02 §2-15). Blow-down: choked outflow,
  `τ = V / (0.578 C_d A c)`, C_d = 0.6, c = 20.05 √T of the heated gas (Kinney & Graham 1985,
  ch. 13). Impulse `i_gas = P τ (1 − e^(−t_cap/τ))` with t_cap = 50 ms (walls that fail vent the
  room; the storey-height members here, T ≈ 20–30 ms, are well into their quasi-static regime by
  then).
* **Load**: faces of enclosure members that are turned to the charge and within 1.1 × the room
  radius: `reflectedImpulseAt += i_gas`, `reflectedPressureAt = max(P_r, P_QS)`,
  `overpressureAt = max(P_s, P_QS)`, and `damageAt = max(D(P_r, i_r), D(P_QS, i_r + i_gas))` (the
  long-duration load read on the same P–I curve, where its quasi-static asymptote governs).
  Loose bodies get no gas push (uniform pressure has no resultant).
* **Chapel check** (real app, 12 kg thermobaric at the centre): measured V = 594 m³ (true 616),
  closed 1.0, P_QS = 203 kPa, i_gas = 10.1 kPa·s; damage numbers 2.3–2.4 on the long walls, the
  entrance wall, the altar panels and the roof (before: local breach near the charge only). A
  plain 12 kg HE charge gives 132 kPa → D ≈ 1.2 on the 300 mm walls (cracked, not blown out).

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
  chain through several targets. **Projectile radius:** every segment ray carries the round's
  presented radius (`presentedRadius`: half the calibre; a long rod's diameter; the hard core
  once an AP bullet has stripped its jacket in a plate; a fragment's presented-area diameter) as
  `Destructible.raycast(…, radius)`, and HEAT jets carry ≈ 0.025 CD (a jet a few mm thick opens a
  hole ≈ 0.2 CD in steel; Walters & Zukas 1989): a hole narrower than the round is solid to it, so
  repeated tank rounds at one spot strike the rim of the earlier hole instead of slipping through
  a jet hole a tenth of their calibre. (The element modules implement the test; `SlabTarget`
  samples the round's footprint — centre and eight rim points — for the shallowest removed depth.)
  A target whose ray test reports a surface but whose probe finds
  no material on the shot line (the rim of a hole) is passed without an event.
* **Timing inside the step.** The sweep keeps track of time along the segment flown in the step,
  so every `impact` event, detonation and fuze carries the moment it happened (a 5.56 round
  reaching a wall 20 m away is stamped 22.8 ms, not at the 33.3 ms step boundary; BLU-109 fires
  exactly 15 ms after contact). Rounds fired at a cyclic rate leave at their own time inside the
  step (`spawnAt`), whichever order the weapon and projectile systems run in.
* **Event bookkeeping.** Every `impact` carries `projectileId` (the round; for HEAT jets, the
  round that fired them), `priorPerforations` (targets it had already gone through: 0 = primary
  hit) and `targetThickness` (line-of-sight run × cos obliquity, only when the probe found the rear
  face).
* **Weapon controller.** Each weapon keeps its own reload/cycling timer (real reload ×
  `PLAY_RELOAD_SCALE` = 0.4), which keeps running while it is holstered: switching from the tank
  gun to the RPG does not carry the gun's reload over. A press on a single-shot weapon that is
  still reloading fires the moment it is ready if the trigger is still held; one round per press.
  `triggerDown` reports the held trigger.

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

**Note — the 70 kPa row is the reflected value.** "1 kg TNT, R = 5 m: ≈ 70 kPa" is the
**normally reflected** peak on a wall facing the charge (69.6 kPa here). The **incident** (side-on)
overpressure at the same point is ≈ 30 kPa for a free-air burst (29 kPa Kinney–Graham, 31 kPa KB
with the 1.8 ground-reflection factor) and higher for a surface burst (43 kPa for a charge lying on
the ground, UFC 3-340-02 fig. 2-15). The tests assert both. The HUD's blast readout comes from
`blastAt`, whose `ps` is incident and `pr` normally reflected — label them that way.

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

P–I damage distances (charge 1.2 m above the ground — the free-air/surface blend of §7 — wall
face-on; `damageAt` ≥ 1 / ≥ 2):

| Charge | annealed 6 mm breaks within | tempered 6 mm | laminated 7.6 mm cracks / tears | 200 mm RC D1 / D2 | 250 mm RC D1 / D2 | 240 mm brick D1 / D2 | 12 mm steel yields / tears |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 kg TNT | 6.8 m | 2.0 m | 5.0 / 1.1 m | 0.64 / 0.37 m | 0.50 / 0.30 m | 0.75 / 0.49 m | 0.94 / 0.15 m |
| 4 kg TNT | 17.9 m | 5.2 m | 12.9 / 2.8 m | 1.55 / 0.86 m | 1.21 / 0.69 m | 1.83 / 1.18 m | 2.3 / 0.35 m |
| 10.8 kg TNT (155 mm) | 35 m | 10.0 m | 25 / 5.4 m | 2.9 / 1.6 m | 2.3 / 1.3 m | 3.5 / 2.2 m | 4.2 / 0.61 m |

Closer than ≈ 0.3 m the voxel elements treat the charge as a contact charge (§7.1).

Tank rounds against heavy steel (what the steel elements are handed; M908/M829A4 kinetic at
1 400/1 550 m/s; blasts on the face at 0.5 calibre (5 cm for the shaped charge); ∫i_r is the
reflected impulse integrated over the face):

| Target | M908 HE-OR kinetic | M908 blast (1.6 kg) | M830A1 HEAT-MP | L31A7 HESH (4.8 kg) |
| --- | --- | --- | --- | --- |
| S355 50 mm | **breaks up** (plug 3.9 MN > body 1.6 MN): dent 17.5 mm, 16.0 kN·s, 475 kJ | dish 17.5 mm, scab Ø171 × 18 mm @ 77 m/s; ∫i_r 1.3 kN·s over Ø0.3 m, 1.7 kN·s over 1 m² | jet Ø15 mm through; blast (25 %) dish 4.9 mm | dish 44 mm, scab Ø389 × 22 mm @ 191 m/s; ∫i_r 3.5 kN·s over Ø0.3 m, 4.8 kN·s over 1 m² |
| S355 100 mm | breaks up: dent 17.5 mm, 16.0 kN·s | dish 8.7 mm | jet through; dish 2.4 mm | dish 24 mm, scab Ø340 × 39 mm @ 158 m/s |
| RHA 50 mm | breaks up: dent 7.3 mm, 16.0 kN·s, 298 kJ | dish 10.7 mm, scab Ø141 × 15 mm | jet through; dish 3.0 mm | dish 29 mm, scab Ø366 × 21 mm @ 176 m/s |
| RHA 100 mm | breaks up: dent 7.3 mm, 16.0 kN·s (was 42 mm with the rigid cap) | dish 5.3 mm (then fires tamped in the dent) | jet through; dish 1.5 mm | dish 14.5 mm, scab Ø294 × 34 mm @ 126 m/s |
| HEB 300 flange 19 mm | perforates (plug 1.5 MN < body 1.6 MN), Ø112 mm, 0.3 kN·s | breach Ø128 mm, dish 34 mm | jet Ø15 mm; dish 12.9 mm, scab Ø123 mm | dish 84 mm, scab Ø420 × 9 mm @ 212 m/s |
| HEB 500 flange 28 mm | breaks up: dent 17.5 mm, 16.0 kN·s | dish 27.5 mm, scab Ø199 × 12 mm | dish 8.7 mm | dish 61 mm, scab Ø411 × 13 mm @ 206 m/s |

The HESH and HE contact impulses (Nurick–Martin I ≈ 1 000 N·s per kg: 1.6 / 4.8 kN·s) and the
∫i_r over the face (1.7 / 4.8 kN·s over 1 m²) agree; both are of the order of the momentum needed
to bend a heavy member (a 4 m HEB 300 column is 470 kg: 4.8 kN·s ≈ 10 m/s of section velocity at
the hit point before the plastic hinges absorb it). The shell body's own momentum (M908:
16 kN·s) reaches the member through the kinetic event (above) and its casing fragments.

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
  fragments that splash/embed on the plate. **M908 HE-OR:** the hardened nose cap perforates
  20 mm steel (cap-only Lambert–Jonas, see §3; Ø 0.1 m hole; plug force 1.5 MN is under the body's
  1.6 MN crush load) and its 0.4 ms delay fires it ≈ 0.55 m behind the plate; against thicker or
  harder steel the body breaks up on the face (§3, shell break-up: all 16 kN·s into the plate, a
  7–18 mm nose dent) and fires in the dent. A second round down the same line passes a hole wider
  than itself (the Ø112 mm cap hole) and skips off the ground 150 m down range (0.4° graze,
  ricochet as a steel-bodied shell); it strikes the rim of a narrower one (radius, §9). *No "dent first, perforate after repeats" regime
  exists for 120 mm rounds against 20 mm plate: every published model perforates it on the first
  hit.* Dent-then-tear accumulation is what small arms and fragments do here (M855 splashes on
  10 mm, 120 mm body fragments shatter/embed on 20 mm).
* **HEB 300 column:** M908 perforates the front flange (19 mm) and the HEAT round holes it; the
  column shows the holes, soot and a permanent bow. Down the web plane the probe reports flange +
  262 mm of web + flange: the M908 body breaks up on that 300 mm run (it got through, 640 m/s out,
  with the rigid-cap model). Rear flanges are *not*
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

### 11.1 Tank rounds on the range's steel stand, realised by the steel elements

`node .tmp/qa/ballistics/stand.ts` (Node, real Rapier world, `installBallistics` and the steel
module's `createSteelPlate` / `createSteelBeam`; three rounds from 25 m at one aim point, 1 s
between rounds; beams pinned at both ends as on the piers). "Handed over" is the `ImpactEvent` /
`BlastLoad` from this module, "realised" what the element made of it (plate: largest particle
displacement, thinnest triangle; beam: node displacement = bow, dish patches, torn).

| Round → member | Handed over, hit 1 | Realised, hits 1 → 2 → 3 |
| --- | --- | --- |
| M908 → RHA 50 mm | break-up: dent 7.4 mm, 16.0 kN·s, 301 kJ; 1.6 kg contact: dish 11 mm, scab Ø146 × 15 mm @ 58 m/s | hit 2 break-up again (run 29 mm, dent 24 mm), plate torn (32 → 117 triangles); hit 3 passes the tear |
| M908 → RHA 100 mm | break-up: dent 7.4 mm, 16.0 kN·s; contact dish 5.6 mm, no scab | dents 7.4 → 9.1 → 11.6 mm, run 100 → 92 → 83 mm, displacement 25 → 38 → 217 mm |
| M908 → HEB 300 flange 19 mm | perforates both flanges (plug 1.5 MN < body 1.6 MN), Ø112 mm holes, 0.3 kN·s each; fires 0.55 m behind | rear-flange dish 18.5 mm; hits 2–3 pass the Ø112 mm hole (wider than the round) |
| M908 → box 500×400×40 | break-up: dent 17.5 mm, 16.0 kN·s, 478 kJ; contact dish 24 mm, scab Ø193 × 16 mm @ 87 m/s | bow 39 → 63 → 70 mm; face dish 210 mm (hit 1) → torn (hit 2) |
| L31A7 HESH → RHA 50 mm | contact 4.8 kg: dish 29 mm, scab Ø366 × 21 mm @ 176 m/s | thickness 51 → 29 → 18 %, torn at hit 2 |
| L31A7 HESH → RHA 100 mm | dish 14.5 mm, scab Ø294 × 34 mm @ 126 m/s | thickness 67 → 41 → 24 %, displacement 6 → 15 → 27 mm |
| L31A7 HESH → HEB 300 flange | dish 84 mm, scab Ø420 × 9 mm @ 212 m/s | dish 84 → 150 mm torn; bow 49 → 116 → 123 mm |
| L31A7 HESH → box | dish 49 mm, scab Ø399 × 18 mm @ 198 m/s | dish 49 → 95 mm torn (hit 2); no bow |
| M830A1 HEAT-MP → RHA 50 / 100 mm | jet Ø15 mm through (50 / 100 mm RHA used); 25 % blast dish 3.0 / 1.5 mm | hits 2–3: the jet threads its own hole, the 80 mm round strikes the rim and fires on the face again |
| M830A1 → HEB 300 flange | jet through both flanges; dish 12.9 mm, scab Ø123 × 8 mm | flange dish 12.9 → 21.8 mm torn (hit 2) |
| M830A1 → box | jet through both walls; dish 6.1 mm, scab Ø97 × 13 mm | dish 6 → 11 → 19 mm, thickness loss 13 → 24 → 31 mm |
| 2.3 kg contact on tower HEB 200 flange (0.8 MN) | P_r 847 MPa, i_r 147 kPa·s at the face; flange 15 mm: breach Ø192 mm (limit 26 mm), crater Ø317 mm; 9 mm web in contact would breach Ø224 mm | section area → 0, column severed and failed at the first charge |

The progression the stand is built to show — dent and bend first, tear on a later hit — appears
for HESH on every member, HE-OR on the box girder and the armour, and HEAT-MP's blast on the
flanges. The HE-OR's first-hit face dish on the box (210 mm, the steel module's Nurick–Martin dish
for the 16 kN·s of the shell's own momentum) is the largest number in the table: see the report to
M3 on spreading a `shatter` event's momentum over the splash footprint.

## 12. Known limitations and estimates (not from a published relation)

* Confined detonations: the vent-area smoothstep (A/V^⅔ 0.15 → 0.6), the 50 ms gas-duration cap
  and the thermobaric × 1.75 gas factor are game-level estimates; rooms are probed with 64 rays
  to 15 m (larger halls are treated as open).
* P–I walls assume 0.3 % reinforcement per face for every `concrete` element (the damage query
  does not know the element's bars) and a 3 m one-way span (taller walls are weaker in reality).
* `SHAPED_CONTACT_COUPLING = 0.25`, occlusion factor 0.3, thermobaric × 1.75, the ricochet anchor
  angles, the lead-ball deformation factors, the glass ballistic limit (0.3 × Lambert–Jonas of the
  same thickness of RHA) and the 1.5 d rod cavity are game-level estimates chosen to match open
  descriptions/photographs; they are isolated as named constants.
* Rigid-projectile NDRC above 1 km/s is extended linearly in V (`NDRC_VMAX`); long rods leave it.
  A thin-walled HE shell at 1.4 km/s (M908) would in reality not survive a 2.7 m NDRC run through
  C40 either (the body-strength argument of §3 predicts break-up in thick concrete too); concrete
  was deliberately left unchanged this round (the round is made for it; 1.2 m obstacles).
* Shell break-up: `SHELL_NOSE_STRENGTH` 1.2 GPa, `SHELL_CASE_STRENGTH` 1 GPa and the 15 % nose
  share of rounds without a cap are estimates; the Tate nose depth is the primary penetration only.
* Impact-fuzed shells (HESH, HEAT-MP, PD-fuzed HE) hand the member no kinetic event: their body's
  momentum (HESH 11.5 kN·s, HEAT-MP 16 kN·s) reaches it only through the representative casing
  fragments, which carry a small part of the casing mass.
* P–I curves treat every member as a 3 m one-way strip (walls) or a 1.5 × 1 m pane (glass). The
  RC/masonry curves are *global* (flexural) response limits; very close charges are local
  problems (spall/breach), handled by `contactDamage` inside ≈ 0.3 m and only approximately by the
  steep near-field reflected impulse between 0.3 m and ≈ 1 m.
* Probes along a thin plate edge-on (e.g. down the web of an I-section) report the whole path as
  steel; the resolver then treats it as a thick plate (see the report to M3).
* Blast loads, body impulses and camera shake are *applied* at the end of the fixed step in which
  the front arrives (≤ 1/60 s after the exact KB arrival at normal speed, finer in slow motion);
  the arrival times themselves are computed from the exact detonation moment.
