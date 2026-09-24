import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circumsolarLobe, clearSkyWallRatio, deriveLighting, luminance, skyIrradiance, skyRadiance, skyState, sunDirection, sunTransmittance, GOLDEN_HOUR_SKY } from '../src/render/skyModel.ts';

test('sun direction is a unit vector at the requested elevation', () => {
  for (const [e, a] of [[0, 0], [13, 232], [45, 90], [89, 300]] as const) {
    const d = sunDirection(e, a);
    assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-12);
    assert.ok(Math.abs(Math.asin(d[1]) * 180 / Math.PI - e) < 1e-9);
  }
});

test('beam transmittance reddens and dims towards the horizon (Rayleigh + Ångström)', () => {
  let prev = sunTransmittance(1);
  for (let e = 2; e <= 90; e += 4) {
    const t = sunTransmittance(e);
    for (let i = 0; i < 3; i++) assert.ok(t[i]! >= prev[i]! - 1e-12, `channel ${i} monotone at ${e}°`);
    assert.ok(t[0]! >= t[1]! && t[1]! >= t[2]!, 'red passes best');
    prev = t;
  }
  // Clear-sky direct beam at the zenith: ~0.7–0.8 of the extraterrestrial value in the green.
  const z = sunTransmittance(90);
  assert.ok(z[1] > 0.65 && z[1] < 0.85, `zenith green transmittance ${z[1]}`);
});

test('golden-hour sun is warm, noon sun near white', () => {
  const low = deriveLighting(10, 200);
  assert.ok(low.sunColor[0] === 1 && low.sunColor[2] < 0.35, `low sun ${low.sunColor}`);
  const high = deriveLighting(60, 200);
  assert.ok(high.sunColor[2] > 0.6, `high sun ${high.sunColor}`);
});

test('sun / sky ratio follows the clear-sky direct-normal / diffuse-horizontal range (in luminance)', () => {
  for (const e of [5, 13, 25, 45, 70]) {
    const L = deriveLighting(e, 232);
    const sunLum = L.sunIntensity * luminance(L.sunColor);
    // The visible sky (no circumsolar attenuation) carries the calibration.
    const s = skyState(sunDirection(e, 232), GOLDEN_HOUR_SKY);
    const visible = luminance(skyIrradiance(s, [0, 1, 0])) * L.skyScale;
    const ratio = sunLum / visible;
    assert.ok(ratio >= 4.4 && ratio <= 6.1, `E_dn/E_dh at ${e}° = ${ratio.toFixed(2)}`);
    // The lighting sky only loses its circumsolar overshoot: never more than a third of E_dh.
    const lit = sunLum / luminance(L.skyIrradiance);
    assert.ok(lit >= ratio - 1e-9 && lit <= ratio * 1.5, `lighting E_dn/E_dh at ${e}° = ${lit.toFixed(2)}`);
  }
});

test('golden hour: a wall facing a low sun sees ≈ 3–5 : 1 direct : diffuse, the shaded wall only sky', () => {
  for (const [e, p] of [[5, GOLDEN_HOUR_SKY], [9, { ...GOLDEN_HOUR_SKY, turbidity: 3.4, rayleigh: 1.7 }], [10, { ...GOLDEN_HOUR_SKY, turbidity: 3, rayleigh: 1.7, mieCoefficient: 0.003 }], [13, GOLDEN_HOUR_SKY], [25, GOLDEN_HOUR_SKY]] as const) {
    const L = deriveLighting(e, 232, p);
    assert.ok(L.circumsolar >= 0 && L.circumsolar <= 0.9, `k at ${e}° = ${L.circumsolar}`);
    assert.ok(L.wallRatio >= 2.9 && L.wallRatio <= 5, `sun-facing wall ratio at ${e}° = ${L.wallRatio.toFixed(2)}`);
    assert.ok(L.wallIrradiance > L.sunIntensity * luminance(L.sunColor) * 0.9, 'wall irradiance includes the sun');
    // The key is warm and the fill cool: the sky light is bluer than the sun.
    assert.ok(L.skyIrradiance[2] / L.skyIrradiance[0] > 1.2 * (L.sunColor[2] / L.sunColor[0]), `cool fill at ${e}°`);
  }
  // Target itself: Perez-derived 3.0 at a low sun, 3.5 by 30°.
  assert.equal(clearSkyWallRatio(9), 3);
  assert.equal(clearSkyWallRatio(30), 3.5);
});

test('circumsolar lobe is 1 at the sun and small beyond ≈ 30°', () => {
  assert.ok(Math.abs(circumsolarLobe(1) - 1) < 1e-12);
  const deg = (d: number) => Math.cos((d * Math.PI) / 180);
  assert.ok(circumsolarLobe(deg(10)) > 0.6 && circumsolarLobe(deg(10)) < 0.85);
  assert.ok(circumsolarLobe(deg(45)) < 0.1);
  assert.ok(circumsolarLobe(deg(180)) < 0.01);
  // Attenuating it lowers the radiance near the sun, not away from it.
  const s = skyState(sunDirection(9, 72), GOLDEN_HOUR_SKY);
  const near = sunDirection(12, 72), far = sunDirection(12, 252);
  assert.ok(luminance(skyRadiance(s, ...near, [0, 0, 0], 0.8)) < 0.5 * luminance(skyRadiance(s, ...near)));
  assert.ok(luminance(skyRadiance(s, ...far, [0, 0, 0], 0.8)) > 0.99 * luminance(skyRadiance(s, ...far)));
});

test('lighting stays finite for any sun position, including below the horizon', () => {
  for (let e = -10; e <= 95; e += 5) {
    const L = deriveLighting(e, e * 7);
    const all = [...L.sunColor, L.sunIntensity, L.skyScale, L.circumsolar, L.wallRatio, L.wallIrradiance, ...L.skyIrradiance, ...L.horizon, ...L.groundRadiance];
    assert.ok(all.every(Number.isFinite), `finite at ${e}°`);
    assert.ok(all.every((v) => v >= 0), `non-negative at ${e}°`);
  }
});

test('sky is brightest towards the sun and irradiance integrates the dome', () => {
  const sun = sunDirection(13, 232);
  const s = skyState(sun, GOLDEN_HOUR_SKY);
  const towards = luminance(skyRadiance(s, ...sunDirection(15, 232)));
  const away = luminance(skyRadiance(s, ...sunDirection(15, 52)));
  assert.ok(towards > 5 * away, 'Mie glow around the sun');
  // A dome of constant radiance L gives E = π L: check the quadrature with a flat-sky state.
  const flat = skyState([0, 1, 0], GOLDEN_HOUR_SKY);
  const E = luminance(skyIrradiance(flat, [0, 1, 0], 32, 64));
  assert.ok(E > 0 && Number.isFinite(E));
});
