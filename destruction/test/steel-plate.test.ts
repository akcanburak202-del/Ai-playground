import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlateSim, dihedral } from '../src/destructibles/steel/plateSim.ts';
import { steelParams, fractureStrain } from '../src/destructibles/steel/steelMaterial.ts';
import { MATERIALS } from '../src/physics/materials.ts';

const S355 = steelParams(MATERIALS.steel_s355);

/** 2 × 2 m plate welded (clamped) on all four edges. */
function clampedPlate(t = 0.02, size = 2, spacing = 0.05): PlateSim {
  const sim = PlateSim.grid({ width: size, height: size, thickness: t, spacing, params: S355 });
  for (let i = 0; i < sim.n; i++) {
    const u = sim.uv[2 * i]!, v = sim.uv[2 * i + 1]!;
    if (Math.abs(Math.abs(u) - size / 2) < 1e-9 || Math.abs(Math.abs(v) - size / 2) < 1e-9) sim.addWeld(i, 0);
  }
  sim.addClampHinges(0);
  return sim;
}

const RADII = [0.05, 0.08, 0.12, 0.18, 0.27, 0.4, 0.6, 0.9, 1.35, 100];

function uniformImpulse(sim: PlateSim, v: number): { J: Float64Array; ke: number; I: number } {
  const J = new Float64Array(3 * sim.n);
  let ke = 0, I = 0;
  for (let i = 0; i < sim.n; i++) {
    J[3 * i + 2] = sim.mass[i]! * v;
    ke += 0.5 * sim.mass[i]! * v * v;
    I += sim.mass[i]! * v;
  }
  return { J, ke, I };
}

function gaussianImpulse(sim: PlateSim, P: number, a: number): { J: Float64Array; ke: number } {
  const J = new Float64Array(3 * sim.n);
  const w = new Float64Array(sim.n);
  let sum = 0, ke = 0;
  for (let i = 0; i < sim.n; i++) {
    w[i] = Math.exp(-(sim.uv[2 * i]! ** 2 + sim.uv[2 * i + 1]! ** 2) / (a * a)) * sim.mass[i]!;
    sum += w[i]!;
  }
  for (let i = 0; i < sim.n; i++) {
    const Ji = (P * w[i]!) / sum;
    J[3 * i + 2] = Ji;
    ke += (0.5 * Ji * Ji) / sim.mass[i]!;
  }
  return { J, ke };
}

test('dihedral gradient matches finite differences', () => {
  const x = new Float64Array([0, 0, 0, 1, 0.1, 0.05, 0.4, 0.8, 0.2, 0.6, -0.7, -0.1]);
  const g = new Float64Array(12), g2 = new Float64Array(12);
  dihedral(x, 0, 1, 2, 3, x, 9, g);
  for (let c = 0; c < 12; c++) {
    const h = 1e-6;
    const xp = x.slice(), xm = x.slice();
    xp[c]! += h;
    xm[c]! -= h;
    const d = (dihedral(xp, 0, 1, 2, 3, xp, 9, g2) - dihedral(xm, 0, 1, 2, 3, xm, 9, g2)) / (2 * h);
    assert.ok(Math.abs(d - g[c]!) < 1e-7, `component ${c}: ${d} vs ${g[c]}`);
  }
});

test('clamped plate under uniform impulse matches Nurick–Martin (1989) within 30 %', () => {
  // Nurick & Martin, Int. J. Impact Eng. 8 (1989): quadrangular clamped plates, δ/t = 0.471 φq + 0.001,
  // φq = I / (2 t² √(B L ρ σy)).
  for (const v of [20, 64]) {
    const sim = clampedPlate();
    const { J, I } = uniformImpulse(sim, v);
    const c = sim.nearestParticle(0, 0, 0);
    const r = sim.impulse(J, c, [0, 0, 1], RADII)!;
    sim.flush();
    const phi = I / (2 * 0.02 * 0.02 * Math.sqrt(2 * 2 * S355.rho * S355.fy));
    const expected = (0.471 * phi + 0.001) * 0.02;
    const got = sim.x[3 * c + 2]!;
    assert.ok(r.radius > 10, 'uniform load picks the global mode');
    assert.ok(Math.abs(got / expected - 1) < 0.3, `v=${v}: δ=${(got * 1000).toFixed(1)} mm vs N–M ${(expected * 1000).toFixed(1)} mm`);
  }
});

test('plastic work never exceeds the energy put in; small loads leave no permanent set', () => {
  for (const v of [2, 6.4, 20, 64]) {
    const sim = clampedPlate();
    const { J, ke } = uniformImpulse(sim, v);
    const r = sim.impulse(J, sim.nearestParticle(0, 0, 0), [0, 0, 1], RADII)!;
    sim.flush();
    assert.ok(r.modalEnergy <= ke * 1.0001, 'mode keeps at most the input kinetic energy');
    assert.ok(sim.plasticWork <= r.modalEnergy * 1.02 + 1, `v=${v}: plastic ${sim.plasticWork.toFixed(0)} J ≤ modal ${r.modalEnergy.toFixed(0)} J`);
    if (v === 2) assert.equal(sim.plasticWork, 0, 'below the elastic capacity nothing yields');
  }
  for (const P of [200, 2000, 8000]) {
    const sim = clampedPlate();
    const { J, ke } = gaussianImpulse(sim, P, 0.12);
    const r = sim.impulse(J, sim.nearestParticle(0, 0, 0), [0, 0, 1], RADII)!;
    sim.flush();
    assert.ok(r.radius < 1, 'concentrated load picks a local dome');
    assert.ok(sim.plasticWork <= ke * 1.0001, `P=${P}: plastic ${sim.plasticWork.toFixed(0)} J ≤ ${ke.toFixed(0)} J`);
  }
});

test('tearing starts only beyond the element fracture strain (GL criterion)', () => {
  const ef = fractureStrain(S355, 0.02, 0.05);
  assert.ok(ef > 0.2 && ef < 0.35, `GL fracture strain for t/le = 0.4: ${ef}`);
  // A 45 mm local dish stays whole; a 230 mm one on the same footprint tears.
  const soft = clampedPlate();
  soft.impulse(gaussianImpulse(soft, 2000, 0.12).J, soft.nearestParticle(0, 0, 0), [0, 0, 1], RADII);
  soft.flush();
  assert.equal(soft.drainEvents().filter((e) => e.type === 'crack').length, 0);
  let maxEq = 0;
  for (let t = 0; t < soft.nt; t++) if (soft.talive[t]) maxEq = Math.max(maxEq, soft.eqStrain(t) / soft.tEf[t]!);
  assert.ok(maxEq < 1 && maxEq > 0.05, `strained but below fracture (${maxEq.toFixed(2)} of ε_f)`);
  const hard = clampedPlate();
  hard.impulse(gaussianImpulse(hard, 8000, 0.12).J, hard.nearestParticle(0, 0, 0), [0, 0, 1], RADII);
  hard.flush();
  const cracks = hard.drainEvents().filter((e) => e.type === 'crack');
  assert.ok(cracks.length > 10, `tears (${cracks.length} cracks)`);
  for (const c of cracks) assert.ok(c.value >= c.limit - 1e-9, `crack at ε=${c.value} < ε_f=${c.limit}`);
});

test('end state is frame-rate independent (dt = 1/60 vs 0.001) and finite', () => {
  const run = (dt: number) => {
    const sim = clampedPlate();
    const c = sim.nearestParticle(0, 0, 0);
    const r = sim.impulse(gaussianImpulse(sim, 3000, 0.15).J, c, [0, 0, 1], RADII)!;
    let t = 0;
    while (sim.busy && t < 1) {
      sim.advance(dt);
      t += dt;
    }
    for (let i = 0; i < 3 * sim.n; i++) assert.ok(Number.isFinite(sim.x[i]!), 'finite positions');
    return { z: sim.x[3 * c + 2]!, W: sim.plasticWork, T: r.duration };
  };
  const a = run(1 / 60), b = run(0.001), c = run(0.0001);
  assert.ok(a.z > 0.02, `dents (${a.z})`);
  assert.ok(Math.abs(a.z / b.z - 1) < 0.1, `1/60: ${a.z} vs 0.001: ${b.z}`);
  assert.ok(Math.abs(b.z / c.z - 1) < 0.05, `0.001: ${b.z} vs 0.0001: ${c.z}`);
  assert.ok(a.T > 1e-4 && a.T < 0.05, `rigid–plastic response time ${a.T} s`);
});

test('repeated hits on one spot keep stretching and thinning the plate until it tears through', () => {
  const sim = clampedPlate();
  const c = sim.nearestParticle(0, 0, 0);
  let prevZ = 0, prevThin = 1, torn = -1;
  for (let k = 0; k < 10 && torn < 0; k++) {
    sim.impulse(gaussianImpulse(sim, 2500, 0.12).J, sim.nearestParticle(0, 0, sim.x[3 * c + 2]!), [0, 0, 1], RADII);
    sim.flush();
    const z = sim.x[3 * c + 2]!;
    let thin = 1;
    for (let t = 0; t < sim.nt; t++) if (sim.talive[t]) thin = Math.min(thin, sim.tThick[t]!);
    if (sim.drainEvents().some((e) => e.type === 'crack')) torn = k;
    else {
      assert.ok(z > prevZ, `hit ${k}: deflection grows (${z} > ${prevZ})`);
      assert.ok(thin < prevThin, `hit ${k}: thins (${thin})`);
    }
    prevZ = z;
    prevThin = thin;
  }
  assert.ok(torn >= 1 && torn <= 8, `tears after repeated hits (hit ${torn})`);
});

test('breach petals fold outward within the energy budget; torn pieces separate', () => {
  const sim = clampedPlate();
  // Punch a 6 cm hole and cut five radial cracks, then fold the petals with 300 kJ (a 1.6 kg contact
  // charge gives the petal ring of a 20 mm plate ≈ 2 MJ of kinetic energy; folding 5 petals of
  // 20 mm steel costs M_p·L_root·β ≈ 42 kJ/rad × Cowper–Symonds ≈ 2.4 plus tearing and stretching).
  const { removed, crackAngles } = sim.breach(0, 0, 0.06, 0.14, 5, 3);
  assert.ok(removed > 0, 'material punched out');
  assert.equal(crackAngles.length, 5);
  const before = sim.plasticWork;
  const r = sim.foldPetals(0, 0, 0.06, 0.2, [0, 0, 1], 300e3, 150)!;
  sim.flush();
  assert.ok(r.amplitude > 0.4, `petals fold (${r.amplitude} rad)`);
  assert.ok(sim.plasticWork - before <= 300e3 * 1.02, 'within budget');
  // Extracting a component conserves mass.
  const m0 = sim.totalMass();
  const comps = sim.components();
  const piece = comps.sort((a, b) => a.length - b.length)[0]!;
  const sub = sim.extract(piece);
  assert.ok(Math.abs(sim.totalMass() + sub.totalMass() - m0) < 1e-6 * m0, 'mass conserved');
});
