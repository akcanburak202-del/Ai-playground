import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeamSim } from '../src/destructibles/steel/beamSim.ts';
import { sectionProps } from '../src/destructibles/steel/section.ts';
import { steelParams } from '../src/destructibles/steel/steelMaterial.ts';
import { MATERIALS } from '../src/physics/materials.ts';

const S355 = steelParams(MATERIALS.steel_s355);
const HEB300 = sectionProps({ type: 'I', h: 0.3, b: 0.3, tw: 0.011, tf: 0.019 });
const L = 3;

function cantilever(): BeamSim {
  return new BeamSim({
    start: [0, 2, 0], end: [L, 2, 0], up: [0, 1, 0], section: HEB300, params: S355,
    ends: { start: 'fixed', end: 'free' }, gravity: [0, 0, 0], imperfection: 0,
  });
}

/** Ramp a tip load to P over 0.3 s, hold, return tip deflection; optionally unload and return the set. */
function loadTip(b: BeamSim, P: number, dt: number, hold = 1.2): { loaded: number; unloaded: number } {
  const tip = b.n - 1;
  const y0 = b.x[3 * tip + 1]!;
  for (let t = 0; t < hold; t += dt) {
    b.loads[3 * tip + 1] = -P * Math.min(1, t / 0.3);
    b.step(dt);
  }
  const loaded = y0 - b.x[3 * tip + 1]!;
  b.loads[3 * tip + 1] = 0;
  for (let t = 0; t < 1.5; t += dt) b.step(dt);
  return { loaded, unloaded: y0 - b.x[3 * tip + 1]! };
}

test('cantilever below yield deflects ≈ PL³/3EI and springs back', () => {
  const My = HEB300.Sy * S355.fy;
  const P = 0.8 * (My / L);
  const r = loadTip(cantilever(), P, 1 / 60);
  const expected = (P * L ** 3) / (3 * S355.E * HEB300.Iy);
  assert.ok(Math.abs(r.loaded / expected - 1) < 0.15, `δ = ${(r.loaded * 1000).toFixed(2)} mm vs ${(expected * 1000).toFixed(2)} mm`);
  assert.ok(Math.abs(r.unloaded) < 0.01 * expected, `springs back (${(r.unloaded * 1000).toFixed(3)} mm)`);
});

test('cantilever above the plastic collapse load hinges at the root and keeps a permanent set', () => {
  const Mp = HEB300.Zy * S355.fy;
  const b = cantilever();
  const r = loadTip(b, 1.15 * (Mp / L), 1 / 60);
  assert.ok(r.unloaded > 0.05, `permanent set ${(r.unloaded * 1000).toFixed(0)} mm`);
  assert.ok(b.bendPlast[0]! > 0.01, 'plastic hinge at the fixed end');
  assert.ok(b.bendPlast[2 * (b.n - 3)]! < 1e-4, 'no plastic rotation near the tip');
  // Plastic work ≈ M_p × total plastic rotation (within hardening).
  let rot = 0;
  for (let i = 0; i < b.n; i++) rot += b.bendPlast[2 * i]!;
  assert.ok(b.plasticWork > 0.9 * Mp * rot && b.plasticWork < 1.5 * Mp * rot, `W_p ${b.plasticWork.toFixed(0)} J vs M_p·θ ${(Mp * rot).toFixed(0)} J`);
});

test('pinned slender column: imperfection amplified by 1/(1 − P/P_cr), collapses above Euler load', () => {
  const tube = sectionProps({ type: 'tube', d: 0.1, t: 0.005 });
  const H = 4;
  const Pcr = (Math.PI ** 2 * S355.E * tube.Iy) / (H * H);
  const run = (f: number) => {
    const b = new BeamSim({ start: [0, 0, 0], end: [0, H, 0], up: [0, 0, 1], section: tube, params: S355, ends: { start: 'pinned', end: 'pinned' } });
    const mid = Math.floor(b.n / 2);
    const e0 = Math.hypot(b.x[3 * mid]!, b.x[3 * mid + 2]!);
    for (let t = 0; t < 2.5; t += 1 / 60) {
      b.imposed = f * Pcr * Math.min(1, t / 0.5);
      b.step(1 / 60);
    }
    return { amp: Math.hypot(b.x[3 * mid]!, b.x[3 * mid + 2]!) / e0, drop: H - b.x[3 * (b.n - 1) + 1]! };
  };
  for (const f of [0.6, 0.85]) {
    const { amp } = run(f);
    const expected = 1 / (1 - f);
    assert.ok(Math.abs(amp / expected - 1) < 0.15, `P = ${f} P_cr: amplification ${amp.toFixed(2)} vs ${expected.toFixed(2)}`);
  }
  const over = run(1.15);
  assert.ok(over.drop > 1, `buckles and collapses above P_cr (top dropped ${over.drop.toFixed(2)} m)`);
});

test('damaged column under heavy load buckles progressively; intact one stands', () => {
  const H = 4, N = 3.0e6;
  const make = () => new BeamSim({ start: [0, 0, 0], end: [0, H, 0], up: [1, 0, 0], section: HEB300, params: S355, ends: { start: 'fixed', end: 'pinned' } });
  const run = (b: BeamSim) => {
    for (let t = 0; t < 3; t += 1 / 60) {
      b.imposed = N * Math.min(1, t / 0.5);
      b.step(1 / 60);
    }
    return H - b.x[3 * (b.n - 1) + 1]!;
  };
  assert.ok(run(make()) < 0.02, 'intact HEB 300 carries 3 MN');
  const damaged = make();
  // Holes through both flanges and part of the web at mid-height: 70 % of the section gone locally.
  const mid = Math.floor(damaged.n / 2);
  for (const i of [mid - 1, mid, mid + 1]) {
    damaged.frac[i * 3] = 0.25;
    damaged.frac[i * 3 + 1] = 0.25;
    damaged.frac[i * 3 + 2] = 0.5;
    damaged.updateSection(i);
  }
  assert.ok(run(damaged) > 0.3, 'damaged column collapses under the same load');
});

test('stable and consistent at dt = 1/60 and dt = 0.001 (slow motion)', () => {
  const P = 0.5 * ((HEB300.Sy * S355.fy) / L);
  const a = cantilever(), b = cantilever();
  const ra = loadTip(a, P, 1 / 60), rb = loadTip(b, P, 0.001);
  for (const s of [a, b]) for (let i = 0; i < 3 * s.n; i++) assert.ok(Number.isFinite(s.x[i]!));
  assert.ok(Math.abs(ra.loaded / rb.loaded - 1) < 0.02, `${ra.loaded} vs ${rb.loaded}`);
  // An impulse (a heavy hit) in slow motion and at full rate ends in the same plastic state.
  const hit = (dt: number) => {
    const c = cantilever();
    c.addImpulse(2.5, 0, -6000, 0);
    for (let t = 0; t < 1; t += dt) c.step(dt);
    return c.bendPlast[0]!;
  };
  const h1 = hit(1 / 60), h2 = hit(0.001);
  assert.ok(h1 > 0.005, `impact hinges the root (${h1})`);
  assert.ok(Math.abs(h1 / h2 - 1) < 0.25, `hinge rotation ${h1} vs ${h2}`);
});

test('slicing a member conserves mass and frees the cut ends', () => {
  const b = new BeamSim({ start: [0, 0, 0], end: [0, 4, 0], up: [1, 0, 0], section: HEB300, params: S355, ends: { start: 'fixed', end: 'fixed' } });
  const k = 10;
  const lo = b.slice(0, k), hi = b.slice(k + 1, b.n - 1);
  assert.equal(lo.ends.end, 'free');
  assert.equal(hi.ends.start, 'free');
  assert.ok(Math.abs(lo.totalMass() + hi.totalMass() - b.totalMass()) < 0.08 * b.totalMass());
});

test('a loaded column struck twice bends, then buckles and comes down the same way at any dt', () => {
  // HEB 300, 4 m, fixed base, roller head carrying 3 MN (≈ 0.66 N_b,Rd). A contact HEAT-MP hit
  // (≈ 3.9 kN·s) leaves it standing and bent; a HESH hit (≈ 11.7 kN·s) makes it buckle. The load
  // is a mass (P/g): it can only fall, and the work it does is bounded by P·Δ.
  const run = (dt: number) => {
    const b = new BeamSim({ start: [0, 0.1, 0], end: [0, 4.1, 0], up: [0, 0, 1], section: HEB300, params: S355, ends: { start: 'fixed', end: 'pinned' } });
    b.imposed = 3e6;
    let afterFirst = 0, landed = false, landTop = Infinity, riseAfter = 0, t = 0;
    for (; t < 4; t += dt) {
      if (Math.abs(t - 1) < dt / 2) for (const s of [1.7, 1.85, 2.0, 2.15, 2.3]) b.addImpulse(s, 0, 0, -3900 / 5);
      if (Math.abs(t - 2) < dt / 2) for (const s of [1.7, 1.85, 2.0, 2.15, 2.3]) b.addImpulse(s, 0, 0, -11700 / 5);
      b.step(dt);
      const top = b.x[3 * (b.n - 1) + 1]!;
      if (t < 1.99) afterFirst = top;
      for (const e of b.events.splice(0)) if (e.type === 'landed') { landed = true; landTop = top; }
      if (landed) riseAfter = Math.max(riseAfter, top - landTop);
    }
    for (let i = 0; i < 3 * b.n; i++) assert.ok(Number.isFinite(b.x[i]!));
    return { afterFirst, top: b.x[3 * (b.n - 1) + 1]!, landed, riseAfter, work: b.plasticWork };
  };
  const a = run(1 / 60), c = run(0.001);
  for (const r of [a, c]) {
    assert.ok(r.afterFirst > 4.05, `stands after the first hit (${r.afterFirst})`);
    assert.ok(r.landed && r.top < 1.5, `buckles and comes down (${r.top})`);
    assert.ok(r.riseAfter < 0.2, `no rebound after landing (${r.riseAfter})`);
    // Energy: load work P·Δ plus the kinetic energy the hits gave (Σ J²/2m ≈ 0.9 MJ) bounds it.
    assert.ok(r.work < 3e6 * 4 + 0.9e6, `plastic work ${r.work}`);
  }
  assert.ok(Math.abs(a.top - c.top) < 0.3, `same final shape at 1/60 and 0.001 s (${a.top} vs ${c.top})`);
});
