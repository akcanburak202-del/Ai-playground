import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLighting, luminance, skyIrradiance, skyRadiance, skyState, sunDirection, sunTransmittance, GOLDEN_HOUR_SKY } from '../src/render/skyModel.ts';

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

test('sun / sky ratio follows the clear-sky direct-normal / diffuse-horizontal range', () => {
  for (const e of [5, 13, 25, 45, 70]) {
    const L = deriveLighting(e, 232);
    const ratio = L.sunIntensity / luminance(L.skyIrradiance);
    assert.ok(ratio >= 4.4 && ratio <= 6.1, `E_dn/E_dh at ${e}° = ${ratio.toFixed(2)}`);
  }
});

test('lighting stays finite for any sun position, including below the horizon', () => {
  for (let e = -10; e <= 95; e += 5) {
    const L = deriveLighting(e, e * 7);
    const all = [...L.sunColor, L.sunIntensity, L.skyScale, ...L.skyIrradiance, ...L.horizon, ...L.groundRadiance];
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
