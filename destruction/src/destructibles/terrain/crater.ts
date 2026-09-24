/**
 * Crater geometry for blasts and heavy rounds in the ground. The ballistics module supplies the
 * contact-burst size (`BlastLoad.contactDamage(soil)`: apparent radius ≈ 0.4 W^⅓, depth ≈ 0.2 W^⅓
 * in dry soil, Cooper 1996 "Explosives Engineering" ch. 28, tamping for buried charges); this file
 * turns it into a surface: height-of-burst reduction, an irregular paraboloid bowl, a raised lip and
 * a thin ejecta blanket. Pure numerics, no three.js.
 *
 * Note on the brief's "radius 0.8–1.0 W^⅓": in m/kg^⅓ that matches the apparent crater *diameter*
 * of a surface burst (2 × 0.4 W^⅓; cf. Ambrosini et al. 2002, Shock Waves 12, for charges on the
 * ground); read in ft/lb^⅓ it is 0.32–0.40 m/kg^⅓, i.e. the radius used here.
 */

export interface CraterShape {
  /** Apparent crater radius at the original surface, m */
  radius: number;
  /** Apparent depth below the original surface, m */
  depth: number;
  /** Height of the raised lip above the original surface, m */
  lipHeight: number;
  /** Outer radius of the ejecta blanket (thin cover of thrown soil), m */
  ejectaRadius: number;
  /** Radius of the paving that is shattered and thrown out (plaza), m */
  pavingRadius: number;
}

/**
 * Size factors for a charge at height `hob` (m, negative = buried) above the ground. The apparent
 * crater shrinks quickly as the charge is raised (the above-ground end of the depth-of-burst
 * cratering curves, Cooper 1996; Ambrosini et al. 2002); here it vanishes linearly by a scaled
 * height of 0.6 m/kg^⅓ (radius) and 0.5 m/kg^⅓ (depth) — an engineering approximation of that
 * trend. Burial is already accounted for by the tamping factor inside `contactDamage`.
 */
export function heightOfBurstFactors(hob: number, tntKg: number): { radius: number; depth: number } {
  const hs = hob / Math.cbrt(Math.max(tntKg, 1e-6));
  if (hs <= 0) return { radius: 1, depth: 1 };
  const r = Math.max(0, 1 - hs / 0.6);
  const d = Math.max(0, 1 - hs / 0.5);
  return { radius: Math.pow(r, 0.8), depth: Math.pow(d, 1.5) };
}

/** Crater from a contact-burst size (from the ballistics model) scaled by height of burst. */
export function blastCrater(contactRadius: number, contactDepth: number, hob: number, tntKg: number, pavingBreach = 0): CraterShape {
  const f = heightOfBurstFactors(hob, tntKg);
  const radius = contactRadius * f.radius;
  const depth = contactDepth * f.depth;
  // Lip ≈ 0.25 of the apparent depth and ejecta out to ≈ 2.5 R (Cooper 1996; typical of
  // cratering in dry alluvium, where the true-crater rim is uplifted and overturned).
  return {
    radius,
    depth,
    lipHeight: 0.25 * depth,
    ejectaRadius: 2.5 * radius,
    pavingRadius: Math.max(1.25 * radius, pavingBreach),
  };
}

/**
 * Radial surface profile of a crater: `cut` is the bowl relative to the reference surface (the
 * surface is lowered to at most ref + cut), `add` is the lip and ejecta added on top.
 * `wobble` in [−1, 1] perturbs the rim radius (irregular craters, ±12 %).
 */
export function craterProfile(c: CraterShape, r: number, wobble: number): { cut: number; add: number } {
  const R = c.radius * (1 + 0.12 * wobble);
  if (R <= 1e-4) return { cut: Infinity, add: 0 };
  const x = r / R;
  // Paraboloid bowl, flattened slightly at the floor.
  const cut = x < 1 ? -c.depth * Math.pow(1 - x * x, 0.85) : Infinity;
  // Lip: a Gaussian ridge centred on the rim; ejecta: exponential blanket beyond it.
  const lip = c.lipHeight * Math.exp(-(((r - R) / (0.32 * R)) ** 2));
  const ejecta = r > R ? 0.12 * c.lipHeight * Math.exp(-(r - R) / (0.6 * R)) : 0;
  return { cut, add: lip + ejecta };
}

/**
 * Irregular-rim function tabulated over the circle (the per-pixel / per-vertex evaluation of the
 * harmonics was the bulk of a crater's cost). Linear interpolation between 256 samples.
 */
export function rimWobbleTable(seed: number, n = 256): Float32Array {
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = rimWobble((i / n) * Math.PI * 2, seed);
  return t;
}

/** Look up a wobble table at `angle` (radians, any range). */
export function wobbleAt(table: Float32Array, angle: number): number {
  const n = table.length - 1;
  let u = (angle / (Math.PI * 2)) % 1;
  if (u < 0) u += 1;
  const f = u * n;
  const i = Math.floor(f);
  const w = f - i;
  return table[i]! * (1 - w) + table[Math.min(i + 1, n)]! * w;
}

/** Smooth pseudo-random function of angle for irregular rims: a few low harmonics with seeded phases. */
export function rimWobble(angle: number, seed: number): number {
  let s = 0;
  let w = 0;
  for (let k = 2; k <= 9; k++) {
    const ph = fract(Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453) * Math.PI * 2;
    // Random amplitudes with a red spectrum: irregular, never a regular scallop.
    const a = (0.35 + fract(Math.sin(seed * 3.7 + k * 19.19) * 9631.7)) / Math.pow(k, 1.6);
    s += a * Math.sin(k * angle + ph);
    w += a;
  }
  return s / w * 1.6;
}

function fract(x: number): number {
  return x - Math.floor(x);
}
