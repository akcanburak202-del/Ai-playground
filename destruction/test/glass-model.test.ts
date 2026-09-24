import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATERIALS } from '../src/physics/materials.ts';
import {
  blastFragmentSpeed, COMPRESSION_DEPTH, CRACK_SPEED, diceEjectionSpeed, diceSize, frontArrival, impactStar, shardPieces,
  temperedFails, temperStrainEnergy,
} from '../src/destructibles/glass/model.ts';
import {
  diceDrag, diceRest, dragA, dragB, hash01, hash32, landingTime, NEVER, siteRelease, sitePosition, type BreakTiming,
} from '../src/destructibles/glass/dicing.ts';
import { Membrane } from '../src/destructibles/glass/membrane.ts';
import { Rng } from '../src/core/rng.ts';

const TEMPERED = MATERIALS.glass_tempered;

test('tempering strain energy and dice size match Barsom / EN 12150', () => {
  const U = temperStrainEnergy(TEMPERED);
  // 4(1−ν)σ²/5E with σ_m = 46 MPa: ≈ 18.9 kJ/m³.
  assert.ok(U > 17e3 && U < 21e3, `U = ${U.toFixed(0)} J/m³`);
  const d = diceSize(TEMPERED);
  // EN 12150-1: ≥ 40 particles in 50 × 50 mm → mean particle ≤ 7.9 mm; "~1 cm dice".
  assert.ok(d > 0.006 && d < 0.0085, `d = ${(d * 1000).toFixed(2)} mm`);
  // Heat-strengthened (half the residual stress) breaks into ~4× larger pieces.
  assert.ok(Math.abs(diceSize(TEMPERED, 23e6) / d - 4) < 1e-9);
  const v = diceEjectionSpeed(TEMPERED);
  assert.ok(v > 0.3 && v < 3, `ejection ${v.toFixed(2)} m/s`);
});

test('tempered glass fails only when damage reaches the tensile core', () => {
  const t = 0.01;
  assert.ok(Math.abs(COMPRESSION_DEPTH - 0.2113) < 1e-3);
  assert.equal(temperedFails('perforate', 0.01, 0.002, t), true);
  assert.equal(temperedFails('embed', 0.001, 0.0005, t), false);
  assert.equal(temperedFails('embed', 0.0025, 0.001, t), true);
});

test('fracture front: every die leaves only after the 1.5 km/s front has reached it', () => {
  const W = 3, H = 3, s = 0.03, salt = 4242;
  const b: BreakTiming = { ox: 0.7, oy: 2.1, t0: 5, hold: 0.05, unzip: 10, bite: 0.012, fitting: 0 };
  const p: [number, number] = [0, 0];
  let held = 0, n = 0, latest = 0;
  for (let j = 0; j < Math.ceil(H / s); j++) {
    for (let i = 0; i < Math.ceil(W / s); i++) {
      sitePosition(i, j, s, salt, W, H, p);
      assert.ok(p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H);
      const t = siteRelease(b, p[0], p[1], hash01(i, j, salt + 2), W, H);
      if (t >= NEVER) {
        held++;
        continue;
      }
      n++;
      const r = Math.hypot(p[0] - b.ox, p[1] - b.oy);
      assert.ok(t >= b.t0 + frontArrival(r) - 1e-12, 'released before the front arrived');
      latest = Math.max(latest, t);
    }
  }
  // The front crosses the 3 m pane (≤ 4.2 m diagonal) in < 3 ms.
  assert.ok(frontArrival(Math.hypot(3, 3)) < 0.003);
  assert.equal(CRACK_SPEED, 1500);
  assert.ok(held > 0 && held < n * 0.2, `framed edge dice held: ${held} of ${n + held}`);
  assert.ok(latest - b.t0 < 0.6, `collapse lasts ${(latest - b.t0).toFixed(3)} s`);
});

test('integer hash is stable (GLSL mirror must match these values)', () => {
  assert.equal(hash32(0), 0);
  assert.equal(hash32(1), 1753845952);
  const h = hash01(3, 7, 11);
  assert.ok(h >= 0 && h < 1);
  assert.equal(h, hash01(3, 7, 11));
  assert.notEqual(hash01(3, 7, 11), hash01(7, 3, 11));
  // 24-bit resolution: exactly representable in float32.
  assert.equal(Math.fround(h), h);
});

test('closed-form dice flight: drag integrals, landing time and rest are consistent', () => {
  for (const c of [1e-6, 0.05, 0.4, 3]) {
    for (const t of [0.001, 0.2, 1.3]) {
      // A' = e^{-ct}, B' = A: finite-difference check.
      const h = 1e-6;
      assert.ok(Math.abs((dragA(c, t + h) - dragA(c, t - h)) / (2 * h) - Math.exp(-c * t)) < 1e-5);
      assert.ok(Math.abs((dragB(c, t + h) - dragB(c, t - h)) / (2 * h) - dragA(c, t)) < 1e-5);
    }
  }
  // Drag-free limit: a die dropped from 4.9033 m lands after 1 s.
  assert.ok(Math.abs(landingTime(4.903325, 0, 1e-9, 0) - 1) < 1e-6);
  // Thrown up: lands later than dropped; drag slows the fall.
  const c = diceDrag(0.008, 0.01, 5);
  assert.ok(landingTime(3, 2, c, 0) > landingTime(3, 0, c, 0));
  assert.ok(landingTime(3, 0, c, 0) > landingTime(3, 0, 1e-9, 0));
  const rest = diceRest({ x: 0, y: 2, z: 0, vx: 3, vy: 0, vz: 0, c, floor: 0 }, { t1: 0, t2: 0, t3: 0, x: 0, z: 0 });
  assert.ok(rest.t1 > 0.6 && rest.t1 < 0.7, `t1 ${rest.t1}`);
  assert.ok(rest.x > 1.8 && rest.x < 3.2, `rests at x = ${rest.x.toFixed(2)}`);
  assert.ok(Number.isFinite(rest.t3) && rest.t3 >= 0);
});

test('crack star grows with impact energy', () => {
  const rnd = () => 0.5;
  const small = impactStar('annealed', 10, 0.006, 0.003, 2, rnd);
  const rifle = impactStar('annealed', 340, 0.006, 0.004, 2, rnd);
  const heavy = impactStar('annealed', 11000, 0.006, 0.02, 2, rnd);
  assert.ok(small.radials >= 4 && small.radials <= 5, `fragment: ${small.radials}`);
  assert.ok(rifle.radials >= 8 && rifle.radials <= 11, `rifle: ${rifle.radials}`);
  assert.equal(heavy.radials, 16);
  assert.ok(small.length < rifle.length && rifle.length < heavy.length);
});

test('blast fragment speed and shard secondary fracture', () => {
  // 6 mm glass, reflected impulse 200 Pa·s → ≈ 10 m/s (Fletcher et al. 1980 range 10–60 m/s).
  const v = blastFragmentSpeed(200, 2500, 0.006);
  assert.ok(v > 8 && v < 14, `v = ${v.toFixed(1)}`);
  // A 20 cm shard of 6 mm glass (0.6 kg) bursts at 3 m/s, a 3 cm chip does not at 2 m/s.
  assert.ok(shardPieces(0.6, 3, 0.2, 0.006) >= 2);
  assert.equal(shardPieces(0.0135, 2, 0.03, 0.006), 1);
});

test('laminated membrane: stable for any dt in (0, 1/60], sags with damage, falls when released', () => {
  for (const dt of [1 / 60, 1 / 240, 0.001, 0.0003]) {
    const m = new Membrane({ width: 1.2, height: 1.6, thickness: 0.0176, density: 2450, spacing: 0.08, framed: true });
    m.addDamage(0, 0, 0.9, 0.9);
    m.impulse(0.1, 0.1, 0.12, 0, 0, -1.2);
    const steps = Math.round(1.5 / dt);
    for (let k = 0; k < steps; k++) m.step(dt);
    let maxZ = 0;
    for (let i = 0; i < m.x.length; i++) assert.ok(Number.isFinite(m.x[i]!), `NaN at dt=${dt}`);
    for (let k = 0; k < m.n; k++) maxZ = Math.max(maxZ, Math.abs(m.x[3 * k + 2]!));
    // Slack of ≈1 % over a 1.2 m span → a bulge of several centimetres, bounded by the frame.
    assert.ok(maxZ > 0.01 && maxZ < 0.25, `dt=${dt}: sag ${(maxZ * 100).toFixed(1)} cm`);
  }
  const m = new Membrane({ width: 1.2, height: 1.6, thickness: 0.0176, density: 2450, spacing: 0.08, framed: true });
  m.floorD = -2;
  m.addDamage(0, 0, 2, 0.8);
  m.release();
  for (let k = 0; k < 240; k++) m.step(1 / 60);
  let minY = Infinity;
  for (let k = 0; k < m.n; k++) minY = Math.min(minY, m.x[3 * k + 1]!);
  assert.ok(minY > -2.05 && minY < -1.9, `sheet came to rest on the floor: min y ${minY.toFixed(3)}`);
});

test('rng determinism of the star generator', () => {
  const a = new Rng(5), b = new Rng(5);
  const s1 = impactStar('laminated', 500, 0.01, 0.004, 2, () => a.next());
  const s2 = impactStar('laminated', 500, 0.01, 0.004, 2, () => b.next());
  assert.deepEqual(s1, s2);
});
