import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  airAbsorptionCutoff, airAbsorptionDb, ballisticShock, closestApproach, dopplerFactor, muzzleLevelAt1m, propagationDelay,
  receivedSpl, shockArrivalAfterPassing, splFromPressure, splToGain, blastScale,
} from '../src/audio/acoustics.ts';
import { beamFrequencies, buildModes, contactWeight, plateFrequencies, renderModes, t60FromLoss } from '../src/audio/modal.ts';
import { brownNoise, grainTexture, nWave, outdoorImpulse, pinkNoise, reflectionsFor, rotaryLoop, whiteNoise } from '../src/audio/buffers.ts';
import { muzzleEnergy, reportProfile } from '../src/audio/profiles.ts';
import { MATERIALS } from '../src/physics/materials.ts';
import { Rng } from '../src/core/rng.ts';
import { WEAPONS } from '../src/weapons/arsenal.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';
import { blastAt, hemisphericalCharge } from '../src/physics/ballistics/blast.ts';

const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} ± ${tol}`);
const finite = (a: Float32Array) => a.every((x) => Number.isFinite(x));

test('SPL and propagation basics', () => {
  near(splFromPressure(20e-6), 0, 1e-9);
  near(splFromPressure(1), 93.98, 0.01);
  near(propagationDelay(343), 1, 1e-12);
  // Inverse square law: −6.02 dB per doubling of distance.
  near(receivedSpl(150, 20) - receivedSpl(150, 40), 20 * Math.log10(2) + (airAbsorptionDb(1000, 40) - airAbsorptionDb(1000, 20)), 1e-9);
  // ISO 9613 fit: ≈ 77 dB/km at 8 kHz, ≈ 19 dB/km at 4 kHz.
  near(airAbsorptionDb(8000, 1000), 76.8, 1);
  near(airAbsorptionDb(4000, 1000), 19.2, 4);
  assert.ok(airAbsorptionCutoff(10) > 10000 && airAbsorptionCutoff(1000) < 2500);
  assert.ok(airAbsorptionCutoff(0) <= 20000 && airAbsorptionCutoff(1e7) >= 250);
});

test('Whitham N-wave of a 7.62 mm round at 5 m matches field measurements', () => {
  // 7.62×51 at Mach 2.4, 5 m miss: measured peaks ≈ 300–600 Pa, durations ≈ 150–300 µs.
  const s = ballisticShock(2.4, 0.00782, 0.0288, 5);
  assert.ok(s.peakPa > 250 && s.peakPa < 650, `peak ${s.peakPa}`);
  assert.ok(s.duration > 120e-6 && s.duration < 320e-6, `duration ${s.duration}`);
  // Falls as r^-3/4 and lengthens as r^1/4.
  const far = ballisticShock(2.4, 0.00782, 0.0288, 80);
  near(s.peakPa / far.peakPa, 16 ** 0.75, 1e-6);
  near(far.duration / s.duration, 16 ** 0.25, 1e-6);
  assert.equal(ballisticShock(0.9, 0.00782, 0.0288, 5).peakPa, 0);
});

test('shock arrival geometry and Doppler', () => {
  // Mach √2: T = (d/c)·√(1/2).
  near(shockArrivalAfterPassing(10, Math.SQRT2), (10 / 343) * Math.SQRT1_2, 1e-12);
  assert.ok(shockArrivalAfterPassing(10, 5) < 10 / 343);
  near(dopplerFactor(0), 1, 1e-12);
  assert.ok(dopplerFactor(100) > 1 && dopplerFactor(-100) < 1);
  assert.ok(Number.isFinite(dopplerFactor(1e6)) && Number.isFinite(dopplerFactor(-1e6)));
  const out = { s: 0, distance: 0 };
  closestApproach(-10, 0, 0, 10, 0, 0, 0, 3, 0, out);
  near(out.s, 0.5, 1e-12);
  near(out.distance, 3, 1e-12);
  closestApproach(1, 1, 1, 1, 1, 1, 0, 0, 0, out); // degenerate segment
  near(out.distance, Math.sqrt(3), 1e-12);
});

test('loudness mapping is monotonic, bounded and finite', () => {
  let prev = 0;
  for (let spl = 40; spl <= 260; spl += 5) {
    const g = splToGain(spl);
    assert.ok(g >= prev && g <= 3 && g > 0);
    prev = g;
  }
  assert.equal(splToGain(NaN), 0);
  // A rifle at the ear should sit well below full scale; a 1 kg blast at 5 m should hit the limiter.
  assert.ok(splToGain(muzzleLevelAt1m(1600)) < 0.6);
  const W = hemisphericalCharge(1, 0, true);
  assert.ok(splToGain(splFromPressure(blastAt(W, 5).ps)) > 1);
});

test('muzzle levels and cube-root blast scaling', () => {
  const m855 = getAmmo('m855'), m33 = getAmmo('m33'), apfsds = getAmmo('m829a4');
  near(muzzleLevelAt1m(muzzleEnergy(m855)), 160, 3);
  near(muzzleLevelAt1m(muzzleEnergy(m33)), 170, 3);
  assert.ok(muzzleLevelAt1m(muzzleEnergy(apfsds)) >= 185);
  near(blastScale(1600 * 8), 2, 1e-9);
});

test('every weapon in the arsenal gets a sane report profile', () => {
  for (const w of WEAPONS) {
    if (w.delivery === 'placed') continue; // charges make no report of their own
    for (const id of w.ammo) {
      const p = reportProfile(w, getAmmo(id));
      for (const v of [p.levelAt1m, p.fBody, p.tauBody, p.thump.f0, p.thump.f1, p.thump.tau, p.crackHp]) assert.ok(Number.isFinite(v) && v > 0, `${w.id}/${id}`);
      assert.ok(p.levelAt1m >= 140 && p.levelAt1m <= 190, `${w.id} level ${p.levelAt1m}`);
    }
  }
  const rifle = reportProfile(WEAPONS.find((w) => w.id === 'm4a1')!, getAmmo('m855'));
  const tank = reportProfile(WEAPONS.find((w) => w.id === 'tankgun')!, getAmmo('m829a4'));
  assert.ok(tank.fBody < rifle.fBody / 8, 'a tank gun is far deeper than a rifle');
  assert.ok(tank.tauBody > rifle.tauBody * 8);
  const gau8 = reportProfile(WEAPONS.find((w) => w.id === 'gau8')!, getAmmo('pgu14'));
  // 3 900 rpm is a 65 Hz tone.
  near(gau8.rotary!.rpm / 60, 65, 0.01);
});

test('plate and beam modes follow thin-plate / Euler–Bernoulli theory', () => {
  const s = MATERIALS.steel_s355;
  // 1 m × 1 m × 10 mm steel, simply supported: f11 = π·√(D/ρh) ≈ 49 Hz.
  const f = plateFrequencies(s, 1, 1, 0.01, 6, 1);
  near(f[0]!, 49.2, 1.5);
  // Frequency ∝ thickness.
  const f2 = plateFrequencies(s, 1, 1, 0.02, 6, 1);
  near(f2[0]! / f[0]!, 2, 1e-9);
  assert.ok(f.every((x, i) => i === 0 || x > f[i - 1]!));
  // Free–free beam: f1 = 22.37/(2π L²)·r_g·√(E/ρ).
  const b = beamFrequencies(s, 4, 0.3, 4);
  near(b[0]!, (22.373 / (2 * Math.PI * 16)) * 0.126 * Math.sqrt(s.youngModulus / s.density), 1);
  near(t60FromLoss(1000, 0.001), 2.2, 1e-9);
  assert.ok(contactWeight(100, 2e-5) > 0.99 && contactWeight(5000, 1e-3) < 0.1);
});

test('modal render is finite, normalised and decays', () => {
  const rng = new Rng(3);
  const modes = buildModes({ frequencies: plateFrequencies(MATERIALS.rha, 1.5, 1, 0.02, 10), eta: 0.004, contactTime: 3e-5, jitter: 0.02 }, rng);
  const out = renderModes(new Float32Array(48000), 48000, modes, 0.9);
  assert.ok(finite(out));
  let peak = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  near(peak, 0.9, 1e-6);
  let early = 0, late = 0;
  for (let i = 0; i < 4800; i++) early += out[i]! ** 2;
  for (let i = 43200; i < 48000; i++) late += out[i]! ** 2;
  assert.ok(late < early * 0.1, 'ring decays');
});

test('noise, textures, N-wave, rotary loop and reverb are finite and well-formed', () => {
  const rng = new Rng(9);
  for (const g of [whiteNoise, pinkNoise, brownNoise]) assert.ok(finite(g(new Float32Array(20000), rng)));
  const tex = grainTexture(new Float32Array(48000), 48000, rng, { rate: 100, fLo: 1000, fHi: 8000, ring: 0.01, envelope: 0.5, noisy: 0.5 });
  assert.ok(finite(tex) && tex.some((x) => x !== 0));
  const nw = nWave(new Float32Array(200), 48000, 200e-6);
  const max = Math.max(...nw), min = Math.min(...nw);
  near(max, 1, 1e-6);
  near(min, -1, 0.15);
  const loop = rotaryLoop(48000, 60 / 3900, 12, rng, 0.007);
  near(loop.length, Math.round((60 / 3900) * 12 * 48000), 1);
  assert.ok(finite(loop));
  const refl = reflectionsFor([{ distance: 30, pan: -1 }, { distance: Infinity, pan: 1 }]);
  assert.ok(refl.length >= 3 && refl.every((r) => r.path > 0 && r.gain > 0 && r.gain < 1));
  const [L, R] = outdoorImpulse(48000, rng, { duration: 1.5, rt60Low: 2, rt60High: 0.8, reflections: refl, tail: 0.2 });
  assert.ok(finite(L) && finite(R));
  let e = 0;
  for (let i = 0; i < L.length; i++) e += L[i]! ** 2 + R[i]! ** 2;
  near(e / 2, 1, 1e-3);
  // The 30 m façade answers after 60 m / 343 m/s ≈ 175 ms.
  const k = Math.round((60 / 343) * 48000);
  let local = 0, before = 0;
  for (let i = k; i < k + 200; i++) local += L[i]! ** 2;
  for (let i = k - 400; i < k - 200; i++) before += L[i]! ** 2;
  assert.ok(local > before, 'slap-back arrives at 2d/c');
});
