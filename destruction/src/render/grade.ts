/**
 * Camera white balance for the render pipeline. Pure math (safe under Node).
 *
 * The renderer's linear RGB is sRGB-primaried with a D65 white: (1, 1, 1) on screen is CIE D65,
 * "average midday daylight". The lighting rig reproduces that: sun + sky on a horizontal surface at
 * 40–60° elevation sums to within ≈ 3 % of neutral (skyModel.deriveLighting), so the render behaves
 * like a camera white-balanced to ≈ 6500 K. A camera balanced to a white of colour temperature T maps
 * a light of that chromaticity to neutral: T above 6504 K warms every light source (the "cloudy" /
 * "shade" presets photographers use to keep the glow of a low sun), T below cools it.
 *
 * Model: von Kries adaptation in the Bradford cone space (Lam 1985; the CIECAM97s / ICC transform)
 * from the camera white to D65, with the camera white on the CIE daylight locus (CIE 15:2004,
 * valid 4000–25 000 K) — which passes through D65 at 6504 K, so that setting is exactly neutral.
 */

/** Row-major 3 × 3 matrix */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** CIE D65 correlated colour temperature on the daylight locus (6500 K × 1.4388 / 1.4380). */
export const D65_KELVIN = 6504;

/** Chromaticity (x, y) of CIE daylight of correlated colour temperature T (CIE 15:2004 §3.1). */
export function daylightChromaticity(kelvin: number): [number, number] {
  const T = Math.min(25000, Math.max(4000, kelvin));
  const x = T <= 7000
    ? -4.607e9 / T ** 3 + 2.9678e6 / T ** 2 + 0.09911e3 / T + 0.244063
    : -2.0064e9 / T ** 3 + 1.9018e6 / T ** 2 + 0.24748e3 / T + 0.23704;
  const y = -3.0 * x * x + 2.87 * x - 0.275;
  return [x, y];
}

// sRGB (D65) ↔ XYZ (IEC 61966-2-1) and the Bradford cone matrix (Lam 1985).
const RGB_TO_XYZ: Mat3 = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
const XYZ_TO_RGB: Mat3 = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];
const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const BRADFORD_INV: Mat3 = [0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428, 0.9684867];

function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
}

function apply(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function whiteXYZ(x: number, y: number): [number, number, number] {
  return [x / y, 1, (1 - x - y) / y];
}

/**
 * Linear-sRGB matrix of a camera white-balanced to daylight of `kelvin`: a surface lit by that
 * daylight renders neutral. Normalised so the luminance of the display white is unchanged (white
 * balance shifts hue, the exposure stays the pipeline's).
 */
export function whiteBalanceMatrix(kelvin: number): Mat3 {
  if (!Number.isFinite(kelvin) || Math.abs(kelvin - D65_KELVIN) < 1) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [xs, ys] = daylightChromaticity(kelvin);
  const src = apply(BRADFORD, whiteXYZ(xs, ys));
  const dst = apply(BRADFORD, whiteXYZ(0.3127, 0.329));
  const D: Mat3 = [dst[0] / src[0], 0, 0, 0, dst[1] / src[1], 0, 0, 0, dst[2] / src[2]];
  const m = mul(XYZ_TO_RGB, mul(BRADFORD_INV, mul(D, mul(BRADFORD, RGB_TO_XYZ))));
  const w = apply(m, [1, 1, 1]);
  const lum = 0.2126729 * w[0] + 0.7151522 * w[1] + 0.072175 * w[2];
  return m.map((v) => v / lum) as Mat3;
}

/** Apply a row-major matrix to a linear RGB triple (tests, CPU-side colour picks). */
export function applyMat3(m: Mat3, rgb: [number, number, number]): [number, number, number] {
  return apply(m, rgb);
}
