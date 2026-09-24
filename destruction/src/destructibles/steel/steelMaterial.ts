import type { MaterialProps } from '../../physics/materials.ts';

/**
 * Constitutive numbers for the ductile-steel elements, derived from the shared material table.
 * Everything here is a closed-form engineering relation with its source next to it.
 */
export interface SteelParams {
  id: string;
  rho: number;
  E: number;
  nu: number;
  /** Static yield and ultimate tensile strength, Pa */
  fy: number;
  fu: number;
  /** Linear (isotropic) hardening modulus, Pa */
  H: number;
  /** Cap on the hardened flow stress, Pa (≈ true ultimate stress) */
  flowMax: number;
  /** Engineering elongation at break of a standard proportional test piece */
  elongation: number;
  /** Cowper–Symonds constants: σ_d/σ_y = 1 + (ε̇/D)^(1/q) */
  csD: number;
  csQ: number;
  /** Thermal: specific heat J/(kg K), conductivity W/(m K), emissivity */
  c: number;
  k: number;
  emissivity: number;
}

/**
 * Hardening modulus from the tensile test: the flow stress rises from f_y to f_u over the uniform
 * elongation, taken as 0.6 × elongation at break (typical for structural and armour steels, e.g.
 * S355 A ≈ 22 %, A_g ≈ 13–15 %; EN 10025-2 test data).
 */
export function steelParams(m: MaterialProps): SteelParams {
  const fy = m.yieldStrength ?? m.compressiveStrength;
  const fu = m.tensileStrength;
  const elong = m.fractureStrain ?? 0.2;
  const H = (fu - fy) / Math.max(0.6 * elong, 0.02);
  // Cowper–Symonds (1957) rate constants as tabulated by Jones, "Structural Impact" (1989), Table 8.1:
  // mild steel D = 40.4 s⁻¹, q = 5; stainless 304 D = 100 s⁻¹, q = 10; high-strength / armour steels
  // are far less rate sensitive (D ≈ 3 200 s⁻¹, q = 5, Paik & Chung for high-tensile steel).
  let csD = 40.4, csQ = 5, k = 48, emissivity = 0.8;
  if (m.id === 'stainless') {
    csD = 100;
    csQ = 10;
    k = 16;
    emissivity = 0.35;
  } else if (m.id === 'rha') {
    csD = 3200;
    k = 38;
  }
  return {
    id: m.id, rho: m.density, E: m.youngModulus, nu: m.poisson, fy, fu, H, flowMax: 1.15 * fu, elongation: elong,
    csD, csQ, c: m.specificHeat, k, emissivity,
  };
}

/** Hardened flow stress at equivalent plastic strain εp (linear hardening, capped), Pa. */
export function flowStress(p: SteelParams, eps: number): number {
  return Math.min(p.fy + p.H * eps, p.flowMax);
}

/** Cowper–Symonds dynamic factor on the flow stress (Cowper & Symonds 1957), capped at 3. */
export function rateFactor(p: SteelParams, strainRate: number): number {
  if (!(strainRate > 1e-3)) return 1;
  return Math.min(3, 1 + Math.pow(strainRate / p.csD, 1 / p.csQ));
}

/**
 * Element-size regularised fracture strain for shells, the "GL criterion" of Germanischer Lloyd
 * used in ship-collision FE analysis (Scharrer, Zhang & Egge 2002; see Hogström 2012 for a review):
 *     ε_f(l_e) = ε_g + ε_e · t / l_e,  ε_g = 0.056, ε_e = 0.54   (mild shipbuilding steel, A ≈ 22 %)
 * Necking localises over ≈ t, so a larger element averages a smaller strain at the moment it
 * tears. Scaled by the steel's elongation relative to the 22 % reference.
 */
export function fractureStrain(p: SteelParams, thickness: number, elementSize: number): number {
  const ef = 0.056 + (0.54 * thickness) / Math.max(elementSize, 1e-4);
  const scaled = ef * (p.elongation / 0.22);
  return Math.min(Math.max(scaled, 0.5 * p.elongation), 3 * p.elongation);
}

/**
 * Design resistance per unit length of a double fillet weld with throat a (EN 1993-1-8 §4.5.3.3,
 * simplified method): F_w/L = 2 · a · f_u / (√3 β_w), β_w = 0.9 for S355. Welded edges are sized as
 * full-strength welds (a = 0.7 × plate thickness, capped at 20 mm).
 */
export function weldStrengthPerLength(p: SteelParams, plateThickness: number): number {
  const a = Math.min(0.7 * plateThickness, 0.02);
  return (2 * a * p.fu) / (Math.sqrt(3) * 0.9);
}

/** Deformation a fillet weld takes before it cracks ≈ 0.25 × throat (ductility of fillet welds). */
export function weldDuctility(plateThickness: number): number {
  return 0.25 * Math.min(0.7 * plateThickness, 0.02);
}

/** Taylor–Quinney coefficient: share of plastic work converted into heat (Taylor & Quinney 1934). */
export const TAYLOR_QUINNEY = 0.9;
export const AMBIENT_C = 20;
const SIGMA_SB = 5.670374e-8;

/**
 * Heat loss of a thin steel sheet from both faces, W/m² of sheet: natural convection
 * h ≈ 10 W/(m² K) plus grey-body radiation ε σ (T⁴ − T∞⁴).
 */
export function sheetHeatLoss(p: SteelParams, tempC: number): number {
  const T = tempC + 273.15, Ta = AMBIENT_C + 273.15;
  return 2 * (10 * (tempC - AMBIENT_C) + p.emissivity * SIGMA_SB * (T ** 4 - Ta ** 4));
}

/** Thermal diffusivity k / (ρ c), m²/s. */
export function diffusivity(p: SteelParams): number {
  return p.k / (p.rho * p.c);
}

/**
 * Peak temperature rise of a small hot spot of radius r after time t, spreading by conduction in the
 * plane of a thick sheet: a Gaussian spot's peak decays as 1 / (1 + 4 α t / r²) (2-D heat kernel).
 */
export function spotDecay(alpha: number, radius: number, t: number): number {
  return 1 / (1 + (4 * alpha * Math.max(t, 0)) / Math.max(radius * radius, 1e-8));
}

/**
 * Heat per unit hole-wall area when a plug (or the displaced hole material) is sheared out through
 * the thickness t: q = β τ_d t φ (J/m²), the work of the adiabatic shear band that carries the plug
 * displacement (Recht 1964; Wingrove 1973), with τ_d = σ_y·min(2, R_CS)/√3 at band shear rates and
 * φ ≈ 0.5 because the band fractures about halfway through. Deposited in a thin wall layer it gives
 * T − T₀ = q / (ρ c √(π α t)) (Carslaw & Jaeger 1959) — a visible glow for ~0.1 s.
 */
export function plugShearHeat(p: SteelParams, t: number): number {
  const tau = (p.fy * Math.min(2, rateFactor(p, 1e4))) / Math.sqrt(3);
  return TAYLOR_QUINNEY * tau * t * 0.5;
}

/**
 * Upper bound on the momentum a charge can give a target: its detonation products carry about
 * ½ C √(2E) towards one side (Gurney velocity √(2E) ≈ 2.44 km/s for TNT; Cooper, Explosives
 * Engineering 1996, ch. 27) and reflection off the target can at most double that, so
 * J ≤ C √(2E) (N·s, C in kg TNT-equivalent). Kingery–Bulmash impulses extrapolated to contact
 * distances overshoot it; loads are scaled back to this bound.
 */
export function maxBlastMomentum(tntKg: number): number {
  return Math.max(0, tntKg) * 2440;
}
