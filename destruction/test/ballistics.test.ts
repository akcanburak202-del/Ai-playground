/**
 * M1 terminal ballistics, exterior ballistics, blast and fragmentation: the DESIGN.md §3
 * calibration table plus physical sanity properties. Pure functions only (no Rapier, no DOM).
 *
 *   node --test test/ballistics.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Rng } from '../src/core/rng.ts';
import { MATERIALS, type MaterialProps } from '../src/physics/materials.ts';
import { AMMO, getAmmo } from '../src/physics/ballistics/ammo.ts';
import { calibrationRows, perforationLimit, slabHit, windowFailurePressure } from '../src/physics/ballistics/calibration.ts';
import { LoftPath, planArrival, speedAtRange, stepFlight, stepLoft, type FlightBody } from '../src/physics/ballistics/flight.ts';
import {
  criticalGrazingAngle, kennedyPerforation, kennedyScabbing, lambertLimit, lambertThickness, lanzOdermatt, ndrcDepth, ndrcVelocity,
  rechtIpson, resolveImpact, resolveJet, tatePenetration, youngDepth, type ResolvedImpact,
} from '../src/physics/ballistics/penetration.ts';
import {
  KB, SHAPED_CONTACT_COUPLING, blastAt, bodyBlastImpulse, contactDamage, createBlastLoad, gasLoad, hemisphericalCharge, obliqueReflection, piAsymptotes,
  piDamage, quasiStaticPressure, rangeForOverpressure, ventTimeConstant,
} from '../src/physics/ballistics/blast.ts';
import { fragmentAmmo, fragmentBudget, gurneyCylinder, mottScaleMass, sampleFragments } from '../src/physics/ballistics/fragments.ts';
import type { Destructible, RayHit } from '../src/destructibles/Destructible.ts';
import type { ProjectileState, ThicknessProbe } from '../src/physics/ballistics/types.ts';

const C40 = MATERIALS.concrete;
const S355 = MATERIALS.steel_s355;
const RHA = MATERIALS.rha;
const within = (v: number, lo: number, hi: number, what: string) => assert.ok(v >= lo && v <= hi, `${what}: ${v.toFixed(3)} not in [${lo}, ${hi}]`);
const mm = (m: number) => m * 1000;

// ─── DESIGN.md §3 calibration table ─────────────────────────────────────────────────────────

test('calibration: 5.56 M855 @ 900 m/s into C40 — depth 15–40 mm, crater Ø 40–90 mm', () => {
  const e = slabHit('m855', 900, C40, 2);
  assert.equal(e.outcome, 'embed');
  within(mm(e.depth), 15, 40, 'depth mm');
  within(mm(2 * e.craterRadius), 40, 90, 'crater Ø mm');
});

test('calibration: 7.62×51 M80 @ 830 m/s into C40 — depth 25–60 mm', () => {
  within(mm(slabHit('m80', 830, C40, 2).depth), 25, 60, 'depth mm');
});

test('calibration: .50 M2 AP @ 880 m/s into C40 — depth 100–200 mm', () => {
  within(mm(slabHit('m2ap', 880, C40, 2).depth), 100, 200, 'depth mm');
});

test('calibration: M855 @ 900 m/s vs S355 perforates 6 mm, stopped by 10 mm', () => {
  assert.equal(slabHit('m855', 900, S355, 0.006).outcome, 'perforate');
  assert.notEqual(slabHit('m855', 900, S355, 0.010).outcome, 'perforate');
  assert.notEqual(slabHit('m855', 900, S355, 0.012).outcome, 'perforate');
});

test('calibration: 7.62 M993 AP vs RHA @ 100 m — 8–15 mm class ±30 %', () => {
  const v = speedAtRange(getAmmo('m993'), 100);
  within(mm(perforationLimit('m993', v, RHA)), 8 * 0.7, 15 * 1.3, 'RHA mm');
});

test('calibration: .50 M2 AP vs RHA @ 100 m — ≈20–25 mm ±25 %', () => {
  const v = speedAtRange(getAmmo('m2ap'), 100);
  within(mm(perforationLimit('m2ap', v, RHA)), 20 * 0.75, 25 * 1.25, 'RHA mm');
});

test('calibration: 30 mm PGU-14 API vs RHA @ 500 m — ≈55–70 mm ±25 %', () => {
  const v = speedAtRange(getAmmo('pgu14'), 500);
  within(mm(perforationLimit('pgu14', v, RHA)), 55 * 0.75, 70 * 1.25, 'RHA mm');
});

test('calibration: 120 mm M829A4 APFSDS vs RHA @ 2 km — ≈650–800 mm ±15 %', () => {
  const v = speedAtRange(getAmmo('m829a4'), 2000);
  within(v, 1350, 1520, 'striking speed at 2 km');
  within(mm(perforationLimit('m829a4', v, RHA, 0, 3)), 650 * 0.85, 800 * 1.15, 'RHA mm');
});

test('calibration: PG-7VL HEAT ≈500 mm RHA and 1.2–1.8 m concrete (±15 %)', () => {
  within(mm(slabHit('pg7vl', 120, RHA, 3).depth), 500 * 0.85, 500 * 1.15, 'RHA mm');
  within(slabHit('pg7vl', 120, C40, 5).depth, 1.2 * 0.85, 1.8 * 1.15, 'concrete m');
});

test('calibration: Javelin ≈750–800 mm RHA (±15 %)', () => {
  within(mm(slabHit('javelin', 150, RHA, 3).depth), 750 * 0.85, 800 * 1.15, 'RHA mm');
});

test('calibration: 1 kg TNT at 5 m — Kingery–Bulmash overpressure and arrival time', () => {
  // Free-air burst of 1 kg = hemispherical surface burst of 1/1.8 kg (UFC 3-340-02 §2-13).
  const free = blastAt(1 / 1.8, 5);
  // DESIGN.md's ≈70 kPa is the normally *reflected* peak; the incident (side-on) peak is ≈29–31 kPa
  // (Kinney & Graham 1985 give 29 kPa). Both are asserted; see PHYSICS.md.
  within(free.pr / 1000, 70 * 0.8, 70 * 1.2, 'reflected kPa');
  within(free.ps / 1000, 29 * 0.8, 29 * 1.2, 'incident kPa');
  within(free.ta * 1000, 8 * 0.8, 9 * 1.2, 'arrival ms');
  // Surface burst (the charge lying on the ground): UFC 3-340-02 fig. 2-15 at Z = 5 ≈ 43 kPa.
  within(blastAt(1, 5).ps / 1000, 43 * 0.8, 43 * 1.2, 'surface-burst incident kPa');
});

test('calibration: annealed 6 mm window 1.5 × 1 m fails at ≈3–7 kPa reflected (long pulse)', () => {
  within(windowFailurePressure(MATERIALS.glass_annealed, 0.006) / 1000, 3, 7, 'annealed kPa');
  const ratio = windowFailurePressure(MATERIALS.glass_tempered, 0.006) / windowFailurePressure(MATERIALS.glass_annealed, 0.006);
  within(ratio, 3, 5, 'tempered/annealed strength ratio (ASTM E1300 glass-type factor 4)');
});

test('calibration: every row of the shared calibration table passes', () => {
  const failed = calibrationRows().filter((r) => !r.pass);
  assert.deepEqual(failed.map((r) => `${r.case}: ${r.value.toFixed(2)} ${r.unit} (expected ${r.expected})`), []);
});

// ─── Published model forms ──────────────────────────────────────────────────────────────────

test('NDRC: x/d = 2√G below x/d = 2 and G + 1 above; inverse is exact', () => {
  for (const v of [100, 300, 600, 900]) {
    const x = ndrcDepth(v, 0.0458, 0.01295, 1.14, 40e6);
    within(ndrcVelocity(x, 0.0458, 0.01295, 1.14, 40e6), v * 0.999, v * 1.001, `inverse at ${v}`);
  }
  // Depth grows like V^1.8 in the deep regime and ∝ 1/√fc (Kennedy 1976).
  const a = ndrcDepth(800, 0.4, 0.03, 1.14, 40e6), b = ndrcDepth(800, 0.4, 0.03, 1.14, 10e6);
  assert.ok(b > a * 1.7 && b < a * 2.05, `x ∝ fc^-½ in the deep regime (${(b / a).toFixed(2)})`);
});

test('Kennedy perforation / scabbing limits and their ordering (e < h_s)', () => {
  const d = 0.1;
  for (const xd of [0.3, 0.65, 1, 1.35, 3, 8]) {
    const e = kennedyPerforation(xd * d, d), hs = kennedyScabbing(xd * d, d);
    assert.ok(e > xd * d, 'perforation limit exceeds the semi-infinite depth');
    assert.ok(hs > e, `scabbing limit exceeds perforation limit at x/d = ${xd}`);
  }
  within(kennedyPerforation(3 * d, d) / d, 1.32 + 1.24 * 3 - 1e-9, 1.32 + 1.24 * 3 + 1e-9, 'e/d = 1.32 + 1.24 x/d');
});

test('Lambert–Jonas limit: inverse consistent, grows with thickness and obliquity', () => {
  const d = 0.0109, L = 0.035, m = 0.0458;
  const v = lambertLimit(0.02, 0, d, L, m);
  within(lambertThickness(v, 0, d, L, m), 0.0199, 0.0201, 'inverse');
  assert.ok(lambertLimit(0.03, 0, d, L, m) > v);
  // Same normal thickness at 45°: longer line of sight → higher limit velocity.
  assert.ok(lambertLimit(0.02 / Math.cos(Math.PI / 4), Math.PI / 4, d, L, m) > v);
});

test('Recht–Ipson residual velocity', () => {
  assert.equal(rechtIpson(500, 600), 0);
  within(rechtIpson(1000, 600), 799.9, 800.1, 'v_r = √(v² − v_bl²)');
  assert.ok(rechtIpson(1000, 600, 0.8) < rechtIpson(1000, 600));
});

test('Young (1997) soil penetration: SI constants, the two velocity branches meet at 61 m/s', () => {
  // SI low-velocity branch: ln(1 + 2.15e-4 V²) (the English form's 2e-5 is for V in ft/s).
  const m = 0.01, d = 0.01, N = 0.84;
  const A = (Math.PI * d * d) / 4, K = 0.46 * Math.pow(m, 0.15), Nn = 0.56 + 0.8 * (N - 0.72);
  within(youngDepth(40, m, d, N), 0.0008 * 5 * Nn * K * (m / A) ** 0.7 * Math.log(1 + 2.15e-4 * 1600) * 0.9999, 0.0008 * 5 * Nn * K * (m / A) ** 0.7 * Math.log(1 + 2.15e-4 * 1600) * 1.0001, 'low branch');
  const below = youngDepth(60.99, m, d, N), above = youngDepth(61, m, d, N);
  within(below / above, 0.8, 1.0, 'branches meet (Young\'s fit is continuous to ~15 %)');
  assert.ok(youngDepth(30, m, d, N) < youngDepth(50, m, d, N) && youngDepth(50, m, d, N) < youngDepth(100, m, d, N));
});

test('Lanz–Odermatt: penetration rises with speed and falls with target hardness', () => {
  const p1 = lanzOdermatt(1400, 0.8, 0.022, 18600, 7850, 5e9, 0);
  const p2 = lanzOdermatt(1700, 0.8, 0.022, 18600, 7850, 5e9, 0);
  const p3 = lanzOdermatt(1400, 0.8, 0.022, 18600, 7850, 8e9, 0);
  assert.ok(p2 > p1 && p3 < p1);
});

test('Alekseevskii–Tate: rod erodes into concrete and conserves sense', () => {
  const r = tatePenetration(1500, 0.3, 0.02, 18600, 1.4e9, 2400, 150e6, 10);
  assert.ok(r.depth > 0.3, 'a dense rod out-penetrates its own length in concrete');
  assert.ok(r.length < 0.3 && r.v < 1500);
});

// ─── Sanity properties ──────────────────────────────────────────────────────────────────────

const KINETIC = ['m855', 'm995', 'm80', 'm993', 'lps', 'm33', 'm2ap', 'm903', 'pgu14', 'm829a4', 'mk211', 'm908'];
const TARGETS: MaterialProps[] = [C40, MATERIALS.concrete_hs, MATERIALS.brick, MATERIALS.marble, S355, RHA, MATERIALS.rebar_b500, MATERIALS.glass_annealed, MATERIALS.soil];

function checkEvent(e: ResolvedImpact, label: string): void {
  const nums: [string, number][] = [
    ['speed', e.speed], ['mass', e.mass], ['kineticEnergy', e.kineticEnergy], ['depth', e.depth], ['residualSpeed', e.residualSpeed],
    ['craterRadius', e.craterRadius], ['craterDepth', e.craterDepth], ['tunnelRadius', e.tunnelRadius], ['spallRadius', e.spallRadius],
    ['spallDepth', e.spallDepth], ['damageRadius', e.damageRadius], ['energyAbsorbed', e.energyAbsorbed], ['obliquity', e.obliquity],
    ['momentum', e.momentum.length()],
  ];
  for (const [k, v] of nums) assert.ok(Number.isFinite(v) && v >= 0, `${label}: ${k} = ${v}`);
  assert.ok(e.summary.length > 20, `${label}: summary`);
  assert.ok(e.material && e.ammo && e.point && e.direction && e.normal, `${label}: references`);
  if (e.outcome === 'perforate') assert.ok(e.exitPoint && e.residualDirection, `${label}: exit point and direction`);
  if (e.outcome === 'ricochet') assert.ok(e.residualDirection, `${label}: ricochet direction`);
}

test('energy never increases: residual KE ≤ impact KE, every field finite (all rounds × materials × thicknesses × angles)', () => {
  for (const id of KINETIC) {
    const a = getAmmo(id);
    for (const m of TARGETS) {
      for (const t of [0.004, 0.012, 0.05, 0.25, 1.5]) {
        for (const deg of [0, 30, 60, 80]) {
          const v = a.muzzleVelocity * 0.95;
          const e = slabHit(id, v, m, t, deg);
          const label = `${id} → ${m.id} ${t} m @ ${deg}°`;
          checkEvent(e, label);
          const keOut = 0.5 * e.residualMass * e.residualSpeed ** 2;
          assert.ok(keOut <= e.kineticEnergy * (1 + 1e-9), `${label}: KE out ${keOut} > in ${e.kineticEnergy}`);
          assert.ok(e.residualSpeed <= e.speed + 1e-9, `${label}: speed grew`);
          assert.ok(e.residualMass <= e.mass + 1e-12, `${label}: mass grew`);
          if (e.outcome !== 'perforate' && e.outcome !== 'ricochet') assert.equal(e.residualSpeed, 0, `${label}: stopped round keeps speed`);
        }
      }
    }
  }
});

test('obliquity raises the effective thickness: fewer mm of plate are perforated at 45° and 60°', () => {
  for (const [id, v, m] of [['m2ap', 850, RHA], ['m993', 820, RHA], ['pgu14', 900, RHA], ['m829a4', 1600, RHA], ['m2ap', 850, C40]] as const) {
    const t0 = perforationLimit(id, v, m, 0, m === C40 ? 2 : 1.5);
    const t45 = perforationLimit(id, v, m, 45, m === C40 ? 2 : 1.5);
    assert.ok(t45 < t0, `${id} vs ${m.id}: ${mm(t45).toFixed(1)} mm at 45° should be < ${mm(t0).toFixed(1)} mm at 0°`);
    // …but the line-of-sight thickness defeated does not collapse (it is the obliquity, not a bug).
    assert.ok(t45 / Math.cos(Math.PI / 4) > 0.6 * t0, `${id}: line-of-sight at 45°`);
  }
});

test('damaged concrete is penetrated deeper (f_c × strength factor from the probe)', () => {
  for (const id of ['m855', 'm80', 'm2ap']) {
    const v = getAmmo(id).muzzleVelocity;
    const d1 = slabHit(id, v, C40, 2, 0, 7, 1).depth;
    const d05 = slabHit(id, v, C40, 2, 0, 7, 0.5).depth;
    const d02 = slabHit(id, v, C40, 2, 0, 7, 0.2).depth;
    assert.ok(d05 > d1 * 1.1 && d02 > d05 * 1.1, `${id}: ${mm(d1).toFixed(0)} → ${mm(d05).toFixed(0)} → ${mm(d02).toFixed(0)} mm`);
  }
  // …and the crater of a hit on damaged material is wider (less energy per unit volume needed).
  assert.ok(slabHit('m855', 900, C40, 2, 0, 7, 0.4).craterRadius > slabHit('m855', 900, C40, 2, 0, 7, 1).craterRadius);
});

test('shell break-up: an HE-OR body collapses on thick or hard steel (dent), punches thin plate, digs concrete as before', () => {
  const a = getAmmo('m908');
  const mv = a.mass * 1400;
  // Thick / hard steel: the plug force exceeds the body's crush load → it breaks up on the face.
  for (const [m, t] of [[RHA, 0.1], [RHA, 0.05], [S355, 0.04], [S355, 0.025]] as const) {
    const e = slabHit('m908', 1400, m, t);
    assert.equal(e.outcome, 'shatter', `${m.id} ${mm(t)} mm: ${e.summary}`);
    assert.ok(e.depth > 0.002 && e.depth < 0.8 * t, `${m.id} ${mm(t)} mm: dent ${mm(e.depth).toFixed(1)} mm`);
    // All of the round's momentum reaches the member; the plate works against the eroding nose
    // only and takes the Tate share u/v of its energy (≈ 25 % RHA, ≈ 40 % S355).
    within(e.momentum.length(), 0.99 * mv, 1.001 * mv, 'momentum N·s');
    const share = e.energyAbsorbed / (0.5 * a.coreMass! * 1400 ** 2);
    within(share, m === RHA ? 0.2 : 0.3, m === RHA ? 0.3 : 0.45, `${m.id} energy share`);
    assert.match(e.summary, /gövde çöktü/);
  }
  // Harder steel stops the nose sooner (Tate R_t ∝ hardness).
  assert.ok(slabHit('m908', 1400, RHA, 0.1).depth < slabHit('m908', 1400, S355, 0.1).depth);
  // Thin plates are plugged before the body gives way: the round punches through and flies on.
  for (const t of [0.006, 0.012, 0.019]) assert.equal(slabHit('m908', 1400, S355, t).outcome, 'perforate', `S355 ${mm(t)} mm`);
  // Repeated hits: a plate weakened by earlier strain (probe strength 0.5) no longer breaks the body up → it tears through.
  assert.equal(slabHit('m908', 1400, S355, 0.04, 0, 7, 0.5).outcome, 'perforate');
  // Obliquity lengthens the plug: 19 mm at 60° is 38 mm of steel on the shot line.
  assert.equal(slabHit('m908', 1400, S355, 0.019, 60).outcome, 'shatter');
  // Concrete is untouched by the criterion (R_t 0.44 GPa < the nose's 1.2 GPa): NDRC with the whole round.
  within(perforationLimit('m908', 1400, C40, 0, 5), 3.2, 3.6, 'C40 perforation limit m');
  assert.equal(slabHit('m908', 1400, C40, 1.2).outcome, 'perforate');
  // Real penetrators are not affected: an AP core and a long rod still perforate thick steel.
  assert.equal(slabHit('m829a4', 1500, RHA, 0.1).outcome, 'perforate');
  assert.equal(slabHit('pgu14', 1000, S355, 0.04).outcome, 'perforate');
});

test('thin walls: rear scab below the scabbing limit, perforation below the perforation limit', () => {
  const thick = slabHit('m2ap', 880, C40, 1.0);
  assert.equal(thick.spallRadius, 0, 'no scab on a thick wall');
  const scab = slabHit('m2ap', 880, C40, 0.25);
  assert.equal(scab.outcome, 'embed');
  assert.ok(scab.spallRadius > 0 && scab.spallDepth > 0, 'scab on a 25 cm wall');
  const thin = slabHit('m2ap', 880, C40, 0.12);
  assert.equal(thin.outcome, 'perforate');
  assert.ok(thin.residualSpeed > 0 && thin.residualSpeed < 880);
});

test('grazing hits ricochet, square hits do not', () => {
  for (const [id, m] of [['m855', RHA], ['m2ap', RHA], ['m80', C40], ['m829a4', RHA]] as const) {
    const a = getAmmo(id);
    let rico = 0;
    for (let s = 1; s <= 20; s++) if (slabHit(id, a.muzzleVelocity, m, 0.05, 86, s).outcome === 'ricochet') rico++;
    assert.ok(rico >= 18, `${id} on ${m.id} at 4° grazing: ${rico}/20 ricochets`);
    for (let s = 1; s <= 10; s++) assert.notEqual(slabHit(id, a.muzzleVelocity, m, 0.05, 0, s).outcome, 'ricochet', `${id} square-on`);
  }
  // Critical grazing angle: larger on harder targets, smaller at higher speed (Tate 1979 form).
  const ball = getAmmo('m855');
  assert.ok(criticalGrazingAngle(ball, RHA, 900) > criticalGrazingAngle(ball, C40, 900));
  assert.ok(criticalGrazingAngle(ball, RHA, 400) > criticalGrazingAngle(ball, RHA, 900));
  // Ricochet keeps less speed than it came with, and leaves the surface.
  const r = slabHit('m855', 900, RHA, 0.05, 86, 3);
  assert.equal(r.outcome, 'ricochet');
  assert.ok(r.residualSpeed < 900 && r.residualDirection!.z > 0);
});

// ─── Multi-material runs ────────────────────────────────────────────────────────────────────

const STUB = { id: -2, kind: 'voxel', name: 'probe stub' } as unknown as Destructible;
function runHit(id: string, speed: number, segs: [MaterialProps, number][], exits = true, strength = 1): ResolvedImpact {
  const ammo = getAmmo(id);
  const dir = new THREE.Vector3(0, 0, -1);
  const p: ProjectileState = { ammo, position: new THREE.Vector3(0, 0, 0.01), velocity: dir.clone().multiplyScalar(speed), mass: ammo.mass, length: ammo.length, perforations: 0 };
  const hit: RayHit = { target: STUB, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1), distance: 0.01, material: segs[0]![0] };
  let s = 0;
  const probe: ThicknessProbe = { segments: segs.map(([material, len]) => ({ material, start: s, end: (s += len), strength })), exits };
  return resolveImpact(p, hit, probe, new Rng(5));
}

test('multi-material probe runs: rebar in the path costs penetration; layers are named in the summary', () => {
  const plain = runHit('m2ap', 880, [[C40, 0.06], [C40, 0.016], [C40, 0.05]]);
  const bar = runHit('m2ap', 880, [[C40, 0.06], [MATERIALS.rebar_b500, 0.016], [C40, 0.05]]);
  assert.equal(plain.outcome, 'perforate');
  assert.ok(bar.outcome !== 'perforate' || bar.residualSpeed < plain.residualSpeed - 50, 'a bar slows the core');
  // Ball ammunition stops on a bar that concrete alone would not stop.
  const ball = runHit('m855', 900, [[C40, 0.02], [MATERIALS.rebar_b500, 0.012], [C40, 0.2]], false);
  assert.equal(ball.outcome, 'embed');
  assert.ok(ball.depth < 0.04, `ball stopped at the bar (${mm(ball.depth).toFixed(1)} mm)`);
  assert.match(bar.summary, /İnşaat demiri/);
  // Spaced run: 12 mm steel then 50 mm concrete, AP core goes through both.
  const lay = runHit('m2ap', 880, [[S355, 0.012], [C40, 0.05]]);
  assert.equal(lay.outcome, 'perforate');
  checkEvent(lay, 'layered');
});

test('HEAT jet: RHA-equivalent capacity is consumed layer by layer; hole is narrow in steel', () => {
  const a = getAmmo('pg7vl');
  const hit: RayHit = { target: STUB, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1), distance: 0, material: S355 };
  const dir = new THREE.Vector3(0, 0, -1);
  const probe: ThicknessProbe = { segments: [{ material: S355, start: 0, end: 0.02, strength: 1 }, { material: C40, start: 0.02, end: 0.5, strength: 1 }], exits: true };
  const e = resolveJet(a, 0.5, 0.085, hit, dir, probe, new Rng(1));
  assert.equal(e.agent, 'jet');
  assert.equal(e.outcome, 'perforate');
  assert.ok(e.residualCapacity! > 0 && e.residualCapacity! < 0.5 - 0.02);
  const steelOnly = resolveJet(a, 0.5, 0.085, hit, dir, { segments: [{ material: S355, start: 0, end: 0.02, strength: 1 }], exits: true }, new Rng(1));
  within(2 * steelOnly.tunnelRadius / 0.085, 0.15, 0.3, 'hole ≈ 0.2 CD in steel');
  checkEvent(e, 'jet');
  assert.match(e.summary, /DELDİ/);
});

test('summaries are Turkish one-liners that name the model', () => {
  assert.match(slabHit('m855', 900, C40, 2).summary, /Beton C40\/50.*SAPLANDI.*NDRC/);
  assert.match(slabHit('m2ap', 880, S355, 0.012).summary, /DELDİ.*Lambert–Jonas/);
  assert.match(slabHit('m855', 900, S355, 0.012).summary, /PARÇALANDI/);
  assert.match(slabHit('m855', 900, RHA, 0.05, 87, 3).summary, /SEKTİ/);
  assert.match(slabHit('m829a4', 1600, RHA, 0.3).summary, /Lanz–Odermatt/);
});

// ─── Exterior ballistics ────────────────────────────────────────────────────────────────────

test('drag: rifle bullets lose speed at a realistic rate', () => {
  // Cd from the published G7 ballistic coefficients (M855 ≈ 0.151, M33 ≈ 0.33 lb/in²) on the G7 curve.
  within(speedAtRange(getAmmo('m855'), 300), 580, 700, 'M855 at 300 m');
  within(speedAtRange(getAmmo('m33'), 500), 620, 720, 'M33 at 500 m');
  assert.ok(speedAtRange(getAmmo('m855'), 300) < speedAtRange(getAmmo('m855'), 100));
  // Energy never increases in unpowered flight.
  const a = getAmmo('m80');
  const b: FlightBody = { position: new THREE.Vector3(0, 1, 0), velocity: new THREE.Vector3(830, 20, 0), mass: a.mass, age: 0, burning: false };
  let e0 = 0.5 * b.velocity.lengthSq() + 9.80665 * b.position.y;
  for (let i = 0; i < 300; i++) {
    stepFlight(b, a, i % 2 ? 1 / 60 : 1 / 240);
    const e = 0.5 * b.velocity.lengthSq() + 9.80665 * b.position.y;
    assert.ok(e <= e0 + 1e-6, 'specific energy grew');
    e0 = e;
  }
});

test('rocket boost: PG-7VL 115 → ≈295 m/s, sustainer ignites ≈11 m out and burns off its propellant', () => {
  const a = getAmmo('pg7vl');
  const b: FlightBody = { position: new THREE.Vector3(), velocity: new THREE.Vector3(a.muzzleVelocity, 0, 0), mass: a.mass, age: 0, burning: false };
  let ignitionX = -1, vmax = 0;
  for (let i = 0; i < 180; i++) {
    stepFlight(b, a, 1 / 60);
    if (b.burning && ignitionX < 0) ignitionX = b.position.x;
    vmax = Math.max(vmax, b.velocity.length());
  }
  within(ignitionX, 8, 16, 'ignition distance m');
  within(vmax, 270, 320, 'max speed m/s');
  within(b.mass, a.mass - a.rocket!.propellantMass - 1e-9, a.mass - a.rocket!.propellantMass + 1e-9, 'burnt-out mass');
});

test('top-attack loft is a scripted arc: climbs, dives steeply, ends on the aimed point', () => {
  const a = getAmmo('javelin');
  for (const R of [40, 120, 400]) {
    const launch = new THREE.Vector3(0, 1.5, 0), target = new THREE.Vector3(3, 0.8, -R);
    const path = new LoftPath(launch, target, a.guidance!.loftHeight);
    const p0 = path.pointAtParam(0, new THREE.Vector3()), p1 = path.pointAtParam(1, new THREE.Vector3());
    assert.ok(p0.distanceTo(launch) < 1e-9 && p1.distanceTo(target) < 1e-9, 'endpoints');
    const b: FlightBody = { position: launch.clone(), velocity: path.tangentAtParam(0, new THREE.Vector3()).multiplyScalar(a.muzzleVelocity), mass: a.mass, age: 0, burning: false };
    const st = { path, s: 0 };
    let top = 0, closest = Infinity, steps = 0;
    while (!stepLoft(b, a, st, 1 / 60) && steps++ < 5000) {
      top = Math.max(top, b.position.y);
      closest = Math.min(closest, b.position.distanceTo(target));
    }
    assert.ok(top > launch.y + 5, `R ${R}: lofts (${top.toFixed(1)} m)`);
    assert.ok(closest < 3, `R ${R}: passes through the aimed point (${closest.toFixed(2)} m)`);
    const dive = Math.asin(-b.velocity.y / b.velocity.length());
    assert.ok(dive > THREE.MathUtils.degToRad(30), `R ${R}: dive ${THREE.MathUtils.radToDeg(dive).toFixed(0)}°`);
  }
});

test('indirect fire: planArrival flown forward reproduces the planned impact', () => {
  const a = getAmmo('m795');
  const target = new THREE.Vector3(10, 0, -5);
  const vImp = new THREE.Vector3(0.5, -0.866, 0).multiplyScalar(340);
  const plan = planArrival(a, target, vImp, 400, 3);
  const b: FlightBody = { position: plan.position.clone(), velocity: plan.velocity.clone(), mass: a.mass, age: 0, burning: false };
  for (let t = 0; t < plan.time - 1e-9; t += 1 / 60) stepFlight(b, a, 1 / 60);
  assert.ok(b.position.distanceTo(target) < 0.05, `lands ${b.position.distanceTo(target).toFixed(3)} m from the target`);
  assert.ok(b.velocity.distanceTo(vImp) < 0.5);
});

// ─── Blast ──────────────────────────────────────────────────────────────────────────────────

test('Kingery–Bulmash: monotonic decay, arrival time increases with distance, fits are continuous', () => {
  let prev = blastAt(1, 0.3);
  for (let R = 0.35; R < 300; R *= 1.15) {
    const b = blastAt(1, R);
    // (The KB incident impulse has a hump inside Z ≈ 1 m/kg^⅓ — fireball region — so it is checked beyond.)
    assert.ok(b.ps < prev.ps && b.pr < prev.pr && b.ir < prev.ir && (R < 1.2 || b.is < prev.is), `decay at R = ${R.toFixed(2)}`);
    assert.ok(b.ta > prev.ta, `arrival time increases at R = ${R.toFixed(2)}`);
    assert.ok(b.pr >= b.ps * 2 - 1e-6, 'reflected ≥ 2 × incident');
    prev = b;
  }
  for (const z of [0.96, 1.02, 1.5, 2.0, 2.38, 2.8, 2.9, 23.8, 33.7, 40]) {
    for (const f of [KB.incidentPressure, KB.incidentImpulse, KB.reflectedPressure, KB.reflectedImpulse, KB.arrivalTime, KB.positiveDuration]) {
      const jump = Math.abs(f(z * 1.0001) / f(z * 0.9999) - 1);
      assert.ok(jump < 0.03, `fit jump ${(jump * 100).toFixed(1)} % at Z = ${z}`);
    }
  }
  // Far-field arrival approaches the speed of sound.
  const far = blastAt(1, 300);
  within(300 / far.ta, 330, 380, 'far-field front speed m/s');
});

test('blast load: oblique reflection, ground reflection, thermobaric impulse, range for a pressure', () => {
  assert.equal(obliqueReflection(10, 30, 1), 30);
  assert.equal(obliqueReflection(10, 30, -0.5), 10);
  assert.ok(obliqueReflection(10, 30, 0.5) < 30 && obliqueReflection(10, 30, 0.5) > 10);
  within(hemisphericalCharge(1, 20, false), 1 / 1.8 - 1e-9, 1 / 1.8 + 1e-9, 'high air burst = W/1.8');
  assert.equal(hemisphericalCharge(1, 0, true), 1);
  const he = blastAt(2, 10), tb = blastAt(2, 10, true);
  assert.equal(tb.ps, he.ps);
  within(tb.is / he.is, 1.74, 1.76, 'thermobaric impulse factor');
  const R = rangeForOverpressure(10, 7000);
  within(blastAt(10, R).ps, 6900, 7100, 'range for 7 kPa');
  // Large charges too (the early exit once compared the fit at the wrong scaled distance).
  for (const [W, pa] of [[1000, 2000], [5000, 1500], [0.01, 2000]] as const) {
    within(blastAt(W, rangeForOverpressure(W, pa)).ps, pa * 0.98, pa * 1.02, `range for ${pa} Pa from ${W} kg`);
  }
  // The BlastLoad closure matches the raw fits and faces matter.
  const load = createBlastLoad({ center: new THREE.Vector3(0, 1, 0), tntKg: 1, kind: 'he', normal: new THREE.Vector3(0, 1, 0) }, 0);
  const p = new THREE.Vector3(5, 1, 0);
  within(load.overpressureAt(p), blastAt(1, 5).ps * 0.999, blastAt(1, 5).ps * 1.001, 'overpressureAt');
  assert.ok(load.reflectedPressureAt(p, new THREE.Vector3(-1, 0, 0)) > load.reflectedPressureAt(p, new THREE.Vector3(0, 0, 1)));
  within(load.arrivalTime(p), blastAt(1, 5).ta - 1e-9, blastAt(1, 5).ta + 1e-9, 'arrivalTime');
});

test('contactDamage: breach and spall thresholds for concrete, steel and glass', () => {
  // One M112 block (0.76 kg TNT-e) on 25 cm C40: crater and rear spall, no breach (T/W^⅓ = 0.27 > 0.18).
  const one = contactDamage(0.764, 'contact', C40, 0.25);
  assert.equal(one.breach, false);
  assert.ok(one.spallRadius > 0 && one.craterRadius > 0.15 && one.craterDepth < 0.25);
  // Four blocks (3.06 kg) breach it.
  const four = contactDamage(3.06, 'contact', C40, 0.25);
  assert.equal(four.breach, true);
  assert.ok(four.breachRadius > 0.1 && four.spallVelocity > one.spallVelocity);
  // Weaker masonry fails more easily than high-strength concrete.
  assert.ok(contactDamage(1, 'contact', MATERIALS.brick, 0.2).breach && !contactDamage(1, 'contact', MATERIALS.concrete_hs, 0.2).breach);
  // Thicker walls resist: no breach, then no spall.
  assert.equal(contactDamage(1, 'contact', C40, 1.0).spallRadius, 0);
  // Steel: 1 kg holes 10 mm mild steel but not 40 mm; HESH scabs the rear of armour it cannot hole.
  assert.ok(contactDamage(1, 'contact', S355, 0.01).breach);
  assert.ok(!contactDamage(1, 'contact', S355, 0.04).breach);
  const hesh = contactDamage(4.1, 'hesh', RHA, 0.1);
  assert.ok(!hesh.breach && hesh.spallRadius > 0 && hesh.spallVelocity > 50);
  // A shaped-charge warhead couples only part of its fill into the face.
  const shaped = contactDamage(1.2, 'shaped', C40, 0.25), bare = contactDamage(1.2, 'he', C40, 0.25);
  assert.ok(shaped.craterRadius < bare.craterRadius);
  within(shaped.craterRadius / contactDamage(1.2 * SHAPED_CONTACT_COUPLING, 'he', C40, 0.25).craterRadius, 0.999, 1.001, 'coupling');
  // Glass in contact always goes.
  assert.ok(contactDamage(0.05, 'contact', MATERIALS.glass_laminated, 0.012).breach);
  // Tamping a buried charge increases the damage.
  assert.ok(contactDamage(1, 'he', C40, 0.5, 3.6).craterRadius > contactDamage(1, 'he', C40, 0.5).craterRadius);
});

test('damageAt (P–I): glass, RC/masonry and steel respond at the right distances', () => {
  const load = createBlastLoad({ center: new THREE.Vector3(0, 0.5, 0), tntKg: 10, kind: 'he', normal: new THREE.Vector3(0, 1, 0) }, 0);
  const at = (x: number, m: MaterialProps, t: number) => load.damageAt(new THREE.Vector3(x, 1, 0), new THREE.Vector3(-1, 0, 0), m, t);
  // Annealed windows: broken at 20 m, intact at 150 m; tempered and laminated survive further in.
  assert.ok(at(20, MATERIALS.glass_annealed, 0.006) >= 1);
  assert.ok(at(150, MATERIALS.glass_annealed, 0.006) < 1);
  assert.ok(at(30, MATERIALS.glass_tempered, 0.006) < at(30, MATERIALS.glass_annealed, 0.006));
  // Damage falls with distance for every material.
  for (const [m, t] of [[MATERIALS.glass_annealed, 0.006], [C40, 0.25], [MATERIALS.brick, 0.24], [S355, 0.012]] as const) {
    let prev = Infinity;
    for (const x of [2, 4, 8, 16, 32]) {
      const d = at(x, m, t);
      assert.ok(d < prev, `${m.id} damage falls with distance`);
      prev = d;
    }
  }
  // A 25 cm RC wall is breached right next to 10 kg, cracked within ≈ 1.5 m, intact at 10 m; brick is weaker than RC.
  assert.ok(at(0.5, C40, 0.25) >= 2);
  assert.ok(at(1.2, C40, 0.25) >= 1);
  assert.ok(at(10, C40, 0.25) < 1);
  assert.ok(at(6, MATERIALS.brick, 0.24) > at(6, C40, 0.24));
  // Long pulses break glass at lower peak pressure than short ones (the P–I curve's two asymptotes).
  assert.ok(piDamage(5000, 500, MATERIALS.glass_annealed, 0.006) > piDamage(5000, 5, MATERIALS.glass_annealed, 0.006));
});

test('P–I asymptotes of RC walls (SDOF, PDC-TR 06-08 limits): onset ≈ 1–3 kPa·s, reinforcement and thickness matter', () => {
  const q = piAsymptotes(C40, 0.25);
  within(q.I0, 1000, 3000, '25 cm RC onset impulse Pa·s');
  within(q.I0b, 2.5e3, 8e3, '25 cm RC blow-out impulse Pa·s');
  within(q.P0, 40e3, 150e3, '25 cm RC quasi-static onset Pa (R_u of a 3 m strip)');
  // A short pulse (triangular, 10 ms) needs hundreds of kPa to crack it.
  let lo = 1e3, hi = 1e8;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    if (piDamage(mid, mid * 0.005, C40, 0.25) >= 1) hi = mid;
    else lo = mid;
  }
  within(hi, 200e3, 900e3, 'onset peak of a 10 ms pulse Pa');
  // Thicker is stronger; bars make concrete stronger than the same thickness of brick.
  assert.ok(piAsymptotes(C40, 0.4).I0 > q.I0 && piAsymptotes(C40, 0.2).I0 < q.I0);
  assert.ok(piAsymptotes(MATERIALS.brick, 0.25).I0 < q.I0);
});

test('P–I distances: 4 kg HE vs 25 cm RC and brick — cracks close in, nothing at 10–12 m, contact breaches', () => {
  // 4 kg in free air 1.2 m above the ground, wall face-on.
  const load = createBlastLoad({ center: new THREE.Vector3(0, 1.2, 0), tntKg: 4, kind: 'he' }, 0, { groundY: 0 });
  const at = (x: number, m: MaterialProps, t: number) => load.damageAt(new THREE.Vector3(x, 1.2, 0), new THREE.Vector3(-1, 0, 0), m, t);
  assert.ok(at(5, C40, 0.25) < 1.3, `5 m: light cracking at most (${at(5, C40, 0.25).toFixed(2)})`);
  assert.ok(at(5, C40, 0.25) < 1, 'in fact no damage at 5 m');
  assert.ok(at(10, C40, 0.25) < 0.5 && at(12, C40, 0.25) < 0.5, 'nothing at 10–12 m');
  assert.ok(at(1, C40, 0.25) >= 1, 'cracked at 1 m');
  assert.ok(at(0.5, C40, 0.25) >= 2, 'breached at 0.5 m stand-off');
  // Masonry: the 0.6 m brick block is untouched 7–9 m away; a 23 cm brick wall at 5 m too.
  for (const x of [7, 8, 9]) assert.ok(at(x, MATERIALS.brick, 0.6) < 0.5, `0.6 m brick at ${x} m`);
  assert.ok(at(5, MATERIALS.brick, 0.23) < 1);
  // Contact: 4 kg breaches 25 cm C40 (T* = 0.16 < 0.18), 1 kg only craters and spalls it.
  assert.ok(contactDamage(4, 'contact', C40, 0.25).breach);
  const one = contactDamage(1, 'contact', C40, 0.25);
  assert.ok(!one.breach && one.spallRadius > 0);
});

test('confined detonation: quasi-static gas pressure loads the room walls (Weibull / UFC 3-340-02 fig. 2-152)', () => {
  within(quasiStaticPressure(12, 616), 115e3, 150e3, '12 kg in 616 m³, Pa');
  within(quasiStaticPressure(1, 1), 2.0e6, 2.5e6, '1 kg/m³, Pa');
  // Blow-down through 10 m² of openings takes a few tenths of a second (≫ wall periods).
  within(ventTimeConstant(616, 10, 132e3), 0.15, 0.6, 'τ s');
  const room = { volume: 616, ventArea: 8, closed: 0.9, radius: 9 };
  const g = gasLoad(12, true, room)!;
  assert.ok(g && g.pressure > 150e3, 'thermobaric afterburn raises the gas pressure');
  assert.equal(gasLoad(12, false, { ...room, ventArea: 60 }), null, 'a room open on one side vents freely');
  // 30 cm RC wall 8 m away inside the chapel: the shock alone does nothing, the gas pressure breaches it.
  const req = { center: new THREE.Vector3(0, 1.2, 0), tntKg: 12, kind: 'thermobaric' as const };
  const free = createBlastLoad(req, 0), inside = createBlastLoad(req, 0, { gas: g });
  const p = new THREE.Vector3(0, 2, 8), nIn = new THREE.Vector3(0, 0, -1), nOut = new THREE.Vector3(0, 0, 1);
  assert.ok(free.damageAt(p, nIn, C40, 0.3) < 1);
  assert.ok(inside.damageAt(p, nIn, C40, 0.3) >= 2, `gas-loaded wall ${inside.damageAt(p, nIn, C40, 0.3).toFixed(2)}`);
  assert.ok(inside.reflectedImpulseAt(p, nIn) > free.reflectedImpulseAt(p, nIn) + 1000);
  // The outer face and anything beyond the room carry no gas load.
  assert.equal(inside.damageAt(p, nOut, C40, 0.3), free.damageAt(p, nOut, C40, 0.3));
  assert.equal(inside.reflectedImpulseAt(new THREE.Vector3(0, 2, 30), nIn), free.reflectedImpulseAt(new THREE.Vector3(0, 2, 30), nIn));
  // A plain 12 kg HE charge only cracks the 30 cm walls of the same room.
  const he = createBlastLoad({ ...req, kind: 'he' }, 0, { gas: gasLoad(12, false, room) });
  within(he.damageAt(p, nIn, C40, 0.3), 1, 2, 'HE gas-loaded wall');
});

test('blast push on loose bodies: area-integrated, cleared, and bounded by the charge momentum', () => {
  // A 12 t roof strip (r_eq ≈ 1.05 m) whose centre is 1.5 m from a 2.3 kg column charge: well under 1 m/s.
  const m = 11500, rEq = Math.cbrt((3 * (m / 2400)) / (4 * Math.PI));
  const J = bodyBlastImpulse({ tntKg: 2.3, W: 2.3, thermobaric: false, dist: 1.5, rEq });
  const s = 1.5 - rEq, cosA = s / Math.hypot(s, rEq);
  assert.ok(J <= 2.3 * 2440 * (1 - cosA) + 1e-6, 'within the products momentum in its solid angle');
  assert.ok(J / m < 0.3, `roof strip Δv ${(J / m).toFixed(2)} m/s (a 4 m throw needs ≈ 9 m/s)`);
  // A 150 kg block 3 m from 2 kg on the ground still gets a push of the order of 1 m/s.
  const rb = Math.cbrt((3 * (150 / 2400)) / (4 * Math.PI));
  within(bodyBlastImpulse({ tntKg: 2, W: 2, thermobaric: false, dist: 3, rEq: rb }) / 150, 0.1, 2, 'block Δv m/s');
  // Farther is less.
  assert.ok(bodyBlastImpulse({ tntKg: 2, W: 2, thermobaric: false, dist: 6, rEq: rb }) < bodyBlastImpulse({ tntKg: 2, W: 2, thermobaric: false, dist: 3, rEq: rb }));
});

// ─── Fragments ──────────────────────────────────────────────────────────────────────────────

test('fragments: Gurney speed, Mott masses, a few dozen real fragment rounds per shell', () => {
  const a = getAmmo('m795');
  within(gurneyCylinder(a.gurney!, a.casingMass!, a.explosiveTNT!), 1150, 1400, 'M795 Gurney speed (published ≈ 1.2–1.3 km/s)');
  const mu = mottScaleMass(0.019, 0.117);
  within(mu * 1000, 0.5, 20, 'Mott scale mass g');
  const n = fragmentBudget(a.casingMass!);
  within(n, 24, 64, 'representative fragments');
  const frags = sampleFragments({ center: new THREE.Vector3(), tntKg: a.explosiveTNT!, kind: 'he', casingMass: a.casingMass, gurney: a.gurney, source: a }, n, new Rng(9));
  assert.equal(frags.length, n);
  for (const f of frags) {
    assert.ok(f.mass > 0 && f.mass <= 0.05 * a.casingMass! + 1e-4);
    within(f.speed, 1000, 1500, 'fragment speed');
    within(f.direction.length(), 0.999, 1.001, 'unit direction');
  }
  const spec = fragmentAmmo(0.01, 1300, a);
  assert.equal(spec.kind, 'fragment');
  // A 10 g steel fragment at 1.3 km/s holes a 3 mm plate and pocks concrete.
  assert.equal(slabHit(spec, 1300, S355, 0.003).outcome, 'perforate');
  const pock = slabHit(spec, 1300, C40, 1);
  assert.ok(pock.depth > 0.005 && pock.depth < 0.1, `pock depth ${mm(pock.depth).toFixed(0)} mm`);
});

test('ammo table: every entry is a consistent AmmoSpec', () => {
  for (const [id, a] of Object.entries(AMMO)) {
    assert.equal(a.id, id);
    assert.ok(a.mass > 0 && a.diameter > 0 && a.length > 0 && a.dragCd > 0 && a.coreDensity > 0, id);
    if (a.kind === 'heat') assert.ok((a.heatPenetrationRHA ?? 0) > 0, `${id} has a rated jet`);
    if (a.kind === 'he' || a.kind === 'hesh' || a.kind === 'thermobaric') assert.ok((a.explosiveTNT ?? 0) > 0, `${id} has a filler`);
    if (a.fuze === 'delay') assert.ok((a.fuzeDelay ?? 0) > 0, `${id} has a delay`);
    if (a.guidance) assert.equal(a.guidance.mode, 'topAttack', `${id}: only the cosmetic top-attack arc is supported`);
    assert.ok(a.note.length > 10 && a.source.length > 5, id);
  }
});
