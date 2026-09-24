import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D65_KELVIN, applyMat3, daylightChromaticity, whiteBalanceMatrix } from '../src/render/grade.ts';

const lum = (c: [number, number, number]) => 0.2126729 * c[0] + 0.7151522 * c[1] + 0.072175 * c[2];

test('daylight locus passes through D65 at 6504 K and runs from amber to blue', () => {
  const [x, y] = daylightChromaticity(D65_KELVIN);
  assert.ok(Math.abs(x - 0.3127) < 5e-4 && Math.abs(y - 0.329) < 5e-4, `D65 at (${x}, ${y})`);
  // CIE D50 ≈ (0.3457, 0.3585) at 5003 K; D75 ≈ (0.2990, 0.3149) at 7504 K.
  const d50 = daylightChromaticity(5003);
  assert.ok(Math.abs(d50[0] - 0.3457) < 1e-3 && Math.abs(d50[1] - 0.3585) < 1e-3);
  const d75 = daylightChromaticity(7504);
  assert.ok(Math.abs(d75[0] - 0.299) < 1e-3 && Math.abs(d75[1] - 0.3149) < 1e-3);
});

test('white balance: neutral at D65, warmer above it, cooler below, exposure kept', () => {
  const id = whiteBalanceMatrix(D65_KELVIN);
  assert.deepEqual(id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (const k of [4500, 5500, 7200, 9000]) {
    const w = applyMat3(whiteBalanceMatrix(k), [1, 1, 1]);
    assert.ok(Math.abs(lum(w) - 1) < 1e-9, `luminance of white kept at ${k} K`);
    if (k > D65_KELVIN) assert.ok(w[0] > 1 && w[2] < 1, `${k} K warms: ${w}`);
    else assert.ok(w[0] < 1 && w[2] > 1, `${k} K cools: ${w}`);
  }
  // A camera balanced to the light it sees renders it neutral: 7200 K daylight (its chromaticity in
  // linear sRGB, IEC 61966-2-1) under a 7200 K white balance comes out grey.
  for (const k of [5000, 7200, 9000]) {
    const [x, y] = daylightChromaticity(k);
    const X = x / y, Z = (1 - x - y) / y;
    const rgb: [number, number, number] = [
      3.2404542 * X - 1.5371385 - 0.4985314 * Z,
      -0.969266 * X + 1.8760108 + 0.041556 * Z,
      0.0556434 * X - 0.2040259 + 1.0572252 * Z,
    ];
    const out = applyMat3(whiteBalanceMatrix(k), rgb);
    assert.ok(Math.abs(out[0] / out[1] - 1) < 2e-3 && Math.abs(out[2] / out[1] - 1) < 2e-3, `${k} K light renders grey: ${out}`);
  }
  // Monotone: the warmer the setting, the redder the low sun renders.
  const sun: [number, number, number] = [1, 0.51, 0.16];
  let prev = 0;
  for (const k of [5000, 6000, 6504, 7200, 8000]) {
    const c = applyMat3(whiteBalanceMatrix(k), sun);
    const ratio = c[0] / c[2];
    assert.ok(ratio > prev, `R/B of the low sun rises with the setting (${k} K: ${ratio.toFixed(2)})`);
    prev = ratio;
  }
  // Garbage in: identity.
  assert.deepEqual(whiteBalanceMatrix(Number.NaN), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});
