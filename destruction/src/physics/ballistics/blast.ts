import * as THREE from 'three';
import { clamp } from '../../core/units.ts';
import type { MaterialProps } from '../materials.ts';
import type { BlastLoad, BlastRequest, ContactDamage } from './types.ts';

/**
 * Air blast from high explosives.
 *
 * Kingery & Bulmash (1984) fits for a hemispherical TNT surface burst, in the simplified
 * polynomial form of Swisdak (1994, "Simplified Kingery Airblast Calculations", 26th DoD
 * Explosives Safety Seminar), the same curves as UFC 3-340-02 figs. 2-15 / 2-7:
 *     Y = exp(A + B ln Z + C ln²Z + D ln³Z + E ln⁴Z + F ln⁵Z + G ln⁶Z)
 * with Z = R / W^(1/3) in m/kg^(1/3); pressures in kPa, impulses and times scaled by W^(1/3)
 * (kPa·ms/kg^(1/3), ms/kg^(1/3)). A free-air (spherical) burst of W behaves like a surface burst of
 * W / 1.8 (ground reflection factor 1.8, UFC 3-340-02 §2-13), so the free-air case uses W/1.8.
 */
type Fit = { zMin: number; zMax: number; c: number[] }[];

const PS: Fit = [
  { zMin: 0.2, zMax: 2.9, c: [7.2106, -2.1069, -0.3229, 0.1117, 0.0685] },
  { zMin: 2.9, zMax: 23.8, c: [7.5938, -3.0523, 0.40977, 0.0261, -0.01267] },
  { zMin: 23.8, zMax: 198.5, c: [6.0536, -1.4066] },
];
const IS: Fit = [
  { zMin: 0.2, zMax: 0.96, c: [5.522, 1.117, 0.6, -0.292, -0.087] },
  { zMin: 0.96, zMax: 2.38, c: [5.465, -0.308, -1.464, 1.362, -0.432] },
  { zMin: 2.38, zMax: 33.7, c: [5.2749, -0.4677, -0.2499, 0.0588, -0.00554] },
  { zMin: 33.7, zMax: 158.7, c: [5.9825, -1.062] },
];
const PR: Fit = [
  { zMin: 0.06, zMax: 2.0, c: [9.006, -2.6893, -0.6295, 0.1011, 0.29255, 0.13505, 0.019736] },
  { zMin: 2.0, zMax: 40, c: [8.8396, -1.733, -2.64, 2.293, -0.8232, 0.14247, -0.0099] },
];
const IR: Fit = [{ zMin: 0.06, zMax: 40, c: [6.7853, -1.3466, 0.101, -0.01123] }];
const TA: Fit = [
  { zMin: 0.06, zMax: 1.5, c: [-0.7604, 1.8058, 0.1257, -0.0437, -0.031, -0.00669] },
  { zMin: 1.5, zMax: 40, c: [-0.7137, 1.5732, 0.5561, -0.4213, 0.1054, -0.00929] },
];
const TD: Fit = [
  { zMin: 0.2, zMax: 1.02, c: [0.5426, 3.2299, -1.5931, -5.9667, -4.0815, -0.9149] },
  { zMin: 1.02, zMax: 2.8, c: [0.544, 2.7082, -9.7354, 14.3425, -9.7791, 2.8535] },
  { zMin: 2.8, zMax: 40, c: [-2.4608, 7.1639, -5.6215, 2.2711, -0.44994, 0.03486] },
];

function poly(c: number[], x: number): number {
  let s = 0;
  let p = 1;
  for (const k of c) {
    s += k * p;
    p *= x;
  }
  return s;
}

/**
 * Evaluate a fit. Inside the table: the segment's polynomial. Below the smallest Z: clamp (the
 * fits diverge; values near the charge are bounded by the detonation products anyway). Above the
 * largest Z: continue with the log-log slope at the end of the table (acoustic decay).
 */
function evalFit(f: Fit, Z: number): number {
  const first = f[0]!;
  const last = f[f.length - 1]!;
  if (Z <= first.zMin) return Math.exp(poly(first.c, Math.log(first.zMin)));
  if (Z >= last.zMax) {
    const x1 = Math.log(last.zMax);
    const h = 1e-3;
    const y1 = poly(last.c, x1);
    const slope = (y1 - poly(last.c, x1 - h)) / h;
    return Math.exp(y1 + slope * (Math.log(Z) - x1));
  }
  for (const s of f) if (Z <= s.zMax) return Math.exp(poly(s.c, Math.log(Z)));
  return Math.exp(poly(last.c, Math.log(Z)));
}

/**
 * Normal reflection of a weak shock in air (Rankine–Hugoniot, γ = 1.4):
 * P_r = 2 P_s (7 P_0 + 4 P_s) / (7 P_0 + P_s). Tends to the acoustic 2 P_s.
 */
export function rankineHugoniotReflection(ps: number, p0 = 101_325): number {
  return (2 * ps * (7 * p0 + 4 * ps)) / (7 * p0 + ps);
}

/** Largest Z covered by the reflected-pressure fit; beyond it P_r follows from P_s by Rankine–Hugoniot. */
const PR_ZMAX = 40;

/** Kingery–Bulmash hemispherical burst quantities at scaled distance Z (m/kg^⅓). SI output. */
export const KB = {
  /** Peak incident overpressure, Pa */
  incidentPressure: (Z: number) => evalFit(PS, Z) * 1e3,
  /** Scaled incident impulse, Pa·s / kg^⅓ */
  incidentImpulse: (Z: number) => evalFit(IS, Z) * 1e3 * 1e-3,
  /** Peak normally reflected overpressure, Pa (past the fit's range: Rankine–Hugoniot on P_s) */
  reflectedPressure: (Z: number) => (Z > PR_ZMAX ? rankineHugoniotReflection(evalFit(PS, Z) * 1e3) : evalFit(PR, Z) * 1e3),
  /** Scaled normally reflected impulse, Pa·s / kg^⅓ */
  reflectedImpulse: (Z: number) => evalFit(IR, Z) * 1e3 * 1e-3,
  /** Scaled arrival time, s / kg^⅓ */
  arrivalTime: (Z: number) => evalFit(TA, Z) * 1e-3,
  /** Scaled positive-phase duration, s / kg^⅓ */
  positiveDuration: (Z: number) => evalFit(TD, Z) * 1e-3,
};

/** Surface bursts reflect off the ground: equivalent free-air charge 1.8 W (UFC 3-340-02 §2-13). */
export const GROUND_REFLECTION_FACTOR = 1.8;

/** Thermobaric / enhanced-blast fills: same peak overpressure per TNT-e, ≈1.75× impulse and duration. */
export const THERMOBARIC_IMPULSE_FACTOR = 1.75;

/**
 * Equivalent hemispherical-burst charge for the KB surface-burst fits. A charge lying on (or within
 * ~0.3 W^⅓ of) the ground or a wall is a surface burst (W); one high in free air is W/1.8; in between
 * the factor blends with scaled height (Mach-stem enhancement is not modelled).
 */
export function hemisphericalCharge(tntKg: number, heightAboveGround: number, onSurface: boolean): number {
  if (onSurface) return tntKg;
  const hs = Math.max(0, heightAboveGround) / Math.cbrt(Math.max(tntKg, 1e-6));
  const t = clamp((hs - 0.3) / 1.7, 0, 1);
  return tntKg / (1 + (GROUND_REFLECTION_FACTOR - 1) * t);
}

export interface BlastPoint {
  /** Peak incident overpressure, Pa */
  ps: number;
  /** Incident impulse, Pa·s */
  is: number;
  /** Normally reflected overpressure, Pa */
  pr: number;
  /** Normally reflected impulse, Pa·s */
  ir: number;
  /** Arrival time, s */
  ta: number;
  /** Positive-phase duration, s */
  td: number;
  /** Scaled distance, m/kg^⅓ (of the hemispherical-equivalent charge) */
  Z: number;
}

/** Blast parameters at range R from a charge whose hemispherical-equivalent mass is W. */
export function blastAt(W: number, R: number, thermobaric = false, out: Partial<BlastPoint> = {}): BlastPoint {
  const w3 = Math.cbrt(Math.max(W, 1e-9));
  const Z = Math.max(R, 1e-3) / w3;
  const f = thermobaric ? THERMOBARIC_IMPULSE_FACTOR : 1;
  out.ps = KB.incidentPressure(Z);
  out.is = KB.incidentImpulse(Z) * w3 * f;
  out.pr = KB.reflectedPressure(Z);
  out.ir = KB.reflectedImpulse(Z) * w3 * f;
  out.ta = KB.arrivalTime(Z) * w3;
  out.td = KB.positiveDuration(Z) * w3 * f;
  out.Z = Z;
  return out as BlastPoint;
}

/**
 * Oblique reflection: P(α) = P_i (1 + cos α − 2 cos² α) + P_r cos² α for angle of incidence α
 * (0 = face-on), P_i on faces turned away (Randers-Pehrson & Bannister 1997, the ConWep/LS-DYNA
 * LOAD_BLAST formula). Applied to pressure and impulse alike.
 */
export function obliqueReflection(incident: number, reflected: number, cosA: number): number {
  if (cosA <= 0) return incident;
  return incident * (1 + cosA - 2 * cosA * cosA) + reflected * cosA * cosA;
}

/** Radius at which peak incident overpressure falls to `pa` Pascals, m (bisection on the fit). */
export function rangeForOverpressure(W: number, pa: number): number {
  // Bisection in scaled distance Z (m/kg^⅓) between 0.05 and 400, then R = Z W^⅓.
  let lo = 0.05, hi = 400;
  const w3 = Math.cbrt(Math.max(W, 1e-9));
  if (KB.incidentPressure(hi) > pa) return hi * w3;
  if (KB.incidentPressure(lo) <= pa) return lo * w3;
  for (let i = 0; i < 50; i++) {
    const mid = Math.sqrt(lo * hi);
    if (KB.incidentPressure(mid) > pa) lo = mid;
    else hi = mid;
  }
  return hi * w3;
}

/**
 * Visual fireball radius, m: ≈1.75 W^⅓ for condensed HE (fireball diameter ≈3.5 W^⅓, Baker et al.
 * "Explosion Hazards and Evaluation" 1983); thermobaric fills burn in the air: ≈1.6× larger.
 */
export function fireballRadius(tntKg: number, thermobaric: boolean): number {
  return 1.75 * Math.cbrt(Math.max(tntKg, 0)) * (thermobaric ? 1.6 : 1);
}

// ─── Contact charges ────────────────────────────────────────────────────────────────────────

/**
 * Fraction of a shaped-charge warhead's fill that loads the struck face like a contact charge.
 * Estimate, not a published constant: the charge detonates at ≈1–3 cone diameters stand-off and a
 * large share of its energy goes into the liner (jet + slug). Chosen so that an RPG-7 HEAT hit on
 * a C40 wall leaves the ≈20–40 cm entry crater seen in open-source photographs rather than the
 * ≈65 cm crater of a 1.2 kg TNT charge in contact.
 */
export const SHAPED_CONTACT_COUPLING = 0.25;

/**
 * Damage directly under a contact / near-contact charge.
 *
 * Concrete & stone (McVay 1988, "Spall damage of concrete structures", USAE WES TR SL-88-22; UFC 3-340-02 spall & breach thresholds;
 * Morishita et al. 2004 contact-detonation tests): with scaled thickness T* = T / W^⅓ (m/kg^⅓),
 * breach for T* < 0.18 and rear spall for T* < 0.33 (normal-strength concrete; thresholds scale
 * with (f_c/40 MPa)^−0.25 so weaker material fails at larger T*). Front crater radius ≈0.30 W^⅓,
 * depth ≈0.12 W^⅓. Tamped (buried) charges couple ~3.6× better (FM 5-250 tamping factor C).
 *
 * Steel: a contact charge holes a plate thinner than ≈0.020 W^⅓ (mild steel; ∝ √(σ_u/510 MPa)) —
 * from the FM 5-250 steel-cutting rule P = 3/8 A applied to the charge perimeter; HESH / contact
 * scabbing of the rear face for t < 0.09 W^⅓ × √(σ_u/1100 MPa) (≈1.3 calibres for a 120 mm HESH),
 * scab ≈ the squashed-charge footprint (HESH ≈ 2–2.5 calibres across), none once the plate is holed.
 *
 * Soil: crater radius ≈0.4 W^⅓, depth ≈0.2 W^⅓ (Cooper, "Explosives Engineering", 1996, dry soil).
 *
 * Shaped-charge warheads ('shaped': HEAT rounds, linear cutters) sit at stand-off behind their
 * liner and put most of their energy into the jet, so only `SHAPED_CONTACT_COUPLING` of the fill
 * acts as a contact charge on the struck face (game-level estimate, see PHYSICS.md; the jet itself
 * is resolved separately by the terminal-ballistics module).
 */
/**
 * Permanent dish of a steel plate under a contact charge, m. Nurick & Martin (1989, Int. J. Impact
 * Eng. 8) for clamped circular plates under localised impulse: δ/t = 0.480 φ + 0.277 with
 * φ = I (1 + ln(R/r0)) / (π R t² √(ρ σ_y)); below φ = 1 the plate barely yields, so δ/t falls
 * linearly to 0. Impulse delivered I ≈ 1 000 N·s per kg TNT (half the momentum (8/27) W D of a slab
 * charge detonating against a rigid wall, D = 6.9 km/s; the rest leaves sideways from a compact
 * charge). Plate radius R = 1 m, charge radius r0 = 0.053 W^⅓ (a TNT sphere).
 */
export function contactDish(W: number, material: MaterialProps, thickness: number): number {
  const t = Math.max(thickness, 1e-3);
  const sy = material.yieldStrength ?? material.compressiveStrength;
  const I = 1000 * W;
  const R = 1, r0 = Math.min(0.5, 0.053 * Math.cbrt(Math.max(W, 1e-6)));
  const phi = (I * (1 + Math.log(R / r0))) / (Math.PI * R * t * t * Math.sqrt(material.density * sy));
  const dt = phi >= 1 ? 0.48 * phi + 0.277 : 0.757 * phi;
  return Math.min(t * dt, 0.3);
}

export function contactDamage(tntKg: number, kind: BlastRequest['kind'], material: MaterialProps, thickness: number, tamping = 1): ContactDamage {
  const W = Math.max(tntKg, 0) * tamping * (kind === 'shaped' ? SHAPED_CONTACT_COUPLING : 1);
  const w3 = Math.cbrt(W);
  const out: ContactDamage = { craterRadius: 0, craterDepth: 0, breach: false, breachRadius: 0, spallRadius: 0, spallDepth: 0, spallVelocity: 0 };
  if (W <= 0) return out;
  const hesh = kind === 'hesh';
  switch (material.class) {
    case 'brittle': {
      const sf = Math.pow(40e6 / material.compressiveStrength, 0.25);
      const Tb = 0.18 * w3 * sf * (hesh ? 1.2 : 1);
      const Ts = 0.33 * w3 * sf * (hesh ? 1.3 : 1);
      out.craterRadius = 0.3 * w3 * sf;
      out.craterDepth = Math.min(thickness, 0.12 * w3 * sf);
      if (thickness < Tb) {
        out.breach = true;
        out.breachRadius = out.craterRadius * Math.sqrt(1 - (thickness / Tb) ** 2) + 0.25 * out.craterRadius;
      }
      if (thickness < Ts) {
        const f = 1 - thickness / Ts;
        out.spallRadius = out.craterRadius * (1.2 + 0.8 * f);
        out.spallDepth = out.breach ? thickness : Math.min(thickness - out.craterDepth, thickness * (0.2 + 0.4 * f));
        // Spall velocity grows with how far the wall is inside the spall threshold (McVay: 10–100 m/s).
        out.spallVelocity = clamp(60 * Math.sqrt(Ts / Math.max(thickness, 1e-3) - 1), 5, 150);
      }
      return out;
    }
    case 'ductile': {
      const su = material.tensileStrength;
      const tb = 0.020 * w3 * Math.sqrt(510e6 / su) * (hesh ? 0.5 : 1);
      const ts = 0.09 * w3 * Math.sqrt(1100e6 / su) * (hesh ? 1 : 0.6);
      out.craterRadius = 0.12 * w3; // dished zone under the charge
      out.craterDepth = contactDish(W, material, thickness);
      if (thickness < tb) {
        out.breach = true;
        out.breachRadius = 0.08 * w3 * Math.sqrt(1 - thickness / tb) + 0.02 * w3;
      }
      if (thickness < ts && !out.breach) {
        // Rear scab about the size of the squashed charge (HESH: ≈ 2–2.5 calibres, i.e. 0.13 W^⅓
        // across for a 120 mm round), a quarter to a half of the plate thick.
        const f = 1 - thickness / ts;
        out.spallRadius = (hesh ? 0.065 : 0.05) * w3 * (1 + f);
        out.spallDepth = Math.min(thickness, thickness * (0.25 + 0.25 * f));
        out.spallVelocity = clamp((hesh ? 150 : 80) * (0.5 + f), 30, 250);
      }
      return out;
    }
    case 'glass':
      out.breach = true;
      out.breachRadius = 2 * w3 + 0.1;
      out.craterRadius = out.breachRadius;
      out.spallVelocity = clamp(80 * w3, 20, 300);
      return out;
    default: {
      out.craterRadius = 0.4 * w3;
      out.craterDepth = 0.2 * w3;
      return out;
    }
  }
}

// ─── Pressure–impulse damage ────────────────────────────────────────────────────────────────

/**
 * Normalised P–I iso-damage curve (P/P0 − 1)(I/I0 − 1) = ψ, ψ = 0.3 (Baker et al. 1983; the SDOF
 * P–I shape used in PDC-TR 06-08). Returns the load scale s at which the load (P, I) meets the
 * curve: s ≥ 1 means the curve is reached. Always ≤ min(P/P0, I/I0), so a short, sharp pulse with
 * little impulse does no damage however high its peak.
 */
export function piScale(P: number, I: number, P0: number, I0: number, psi = 0.3): number {
  const a = P / P0, b = I / I0;
  if (!(a > 0) || !(b > 0)) return 0;
  // (a x − 1)(b x − 1) = ψ with x = 1/s → ab x² − (a+b) x + (1 − ψ) = 0, larger root.
  const ab = a * b;
  const disc = (a + b) * (a + b) - 4 * ab * (1 - psi);
  const x = ((a + b) + Math.sqrt(Math.max(disc, 0))) / (2 * ab);
  return 1 / x;
}

interface PIParams { P0: number; I0: number; P0b: number; I0b: number }

/** Span of the wall / slab strip assumed by the brittle-member P–I model, m (a storey-height panel). */
export const PI_WALL_SPAN = 3;

/**
 * Reinforcement assumed for concrete members (the damage query does not know the element's bars):
 * tension steel per face as a fraction of the effective depth — Ø12 @ 150–200 mm in a 200–300 mm
 * wall is 0.22–0.35 %; EC2 §9.6 asks for ≥ 0.1 % per face in walls.
 */
export const RC_STEEL_RATIO = 0.003;
/** Reinforcing-bar yield strength (B500), Pa */
const REBAR_FY = 500e6;

/**
 * Response limits as support rotations of a one-way member (PDC-TR 06-08, "Single degree of
 * freedom structural response limits for antiterrorism design", 2008, tables 3-1/3-3):
 * reinforced concrete slabs/walls in flexure B2 (moderate) θ = 2°, B4 (hazardous, blow-out) θ = 10°;
 * unreinforced masonry with arching B2 θ = 1.5°, B4 θ = 8°. Damage number 1 = B2 (visible
 * cracking, some permanent deflection), 2 = B4 (failure: breach / blow-out). B1 (μ = 1, no
 * visible damage) lies below 1.
 */
const RC_THETA = [2, 10] as const;
const URM_THETA = [1.5, 8] as const;

/**
 * Elastic–perfectly-plastic SDOF (Biggs 1964, "Introduction to Structural Dynamics", ch. 5;
 * UFC 3-340-02 §3-19) asymptotes of the iso-damage curve for a peak deflection x_m:
 *   impulsive      I = √(2 K_LM m R_u (x_m − x_y/2))      (kinetic energy = strain energy)
 *   quasi-static   P = R_u (1 − x_y / (2 x_m))            (work of a step load = strain energy)
 * with x_y = R_u / k and K_LM = 0.66 (simply supported one-way member, uniform load, plastic range;
 * Biggs table 5.1).
 */
function sdofAsymptotes(Ru: number, k: number, mass: number, xm: number): [number, number] {
  const xy = Ru / k;
  const x = Math.max(xm, xy);
  return [Ru * (1 - xy / (2 * x)), Math.sqrt(2 * 0.66 * mass * Ru * (x - xy / 2))];
}

/**
 * P–I asymptotes for a member of `thickness` made of `material`: [onset of damage] and [severe /
 * breach].
 *
 * Glass: ASTM E1300 load resistance of a 6 mm annealed 1.5 × 1 m pane ≈ 2.3 kPa (3-s) ≈ 4.5 kPa
 * dynamic, ∝ t², ×4 tempered (glass-type factor), impulse asymptote I0 = 2 P0/ω with ω = 2π·21 Hz
 * (first mode of that simply supported pane).
 *
 * Reinforced concrete walls and slabs: a one-way strip of span L = 3 m, simply supported, as an
 * elastic–perfectly-plastic SDOF (UFC 3-340-02 ch. 4; PDC-TR 06-08). Ultimate resistance
 * R_u = 8 M_p / L² with M_p = A_s f_dy (d − a/2), a = A_s f_dy / (0.85 f'_dc) (UFC 3-340-02
 * eq. 4-1/4-2), d = 0.85 h, A_s = ρ d (ρ = RC_STEEL_RATIO per face), dynamic strengths
 * f_dy = 1.1 · 1.17 f_y (strength increase and dynamic increase factors, UFC 3-340-02 tables 4-1,
 * 4-2), f'_dc = 1.19 f_c; never below the cracking capacity f_t h²/6. Stiffness
 * k = 384 E I_a / (5 L⁴) with the average of gross and cracked moments of inertia
 * I_a = (I_g + I_cr)/2 (UFC 3-340-02 §4-11), I_cr = (kd)³/3 + n A_s (d − kd)². Deflection limits
 * from the PDC-TR 06-08 support rotations (2° / 10°): for 0.25 m C40 this gives onset at
 * I ≈ 1.7 kPa·s / P ≈ 73 kPa and blow-out at I ≈ 4.0 kPa·s / P ≈ 75 kPa — so a 4 kg charge must be
 * within ≈ 1.2 m to crack it and within ≈ 0.7 m (or in contact, `contactDamage`) to breach it.
 *
 * Unreinforced masonry and stone (brick, marble, travertine, granite, onyx): rigid arching between
 * the supporting slabs (McDowell, McKee & Sevin 1956, "Arching action theory of masonry walls",
 * J. Struct. Div. ASCE 82): the two halves rotate about crushed hinges of depth ≈ 0.1 h, thrust
 * C = 0.85 f_m · 0.1 h with lever arm 0.9 h, so R_u = 8 · 0.0765 f_m h² / L² — never below the
 * flexural cracking capacity. Uncracked stiffness, PDC-TR 06-08 arching limits (1.5° / 8°), and the
 * deflection capped at 0.5 h (the arch snaps through as the deflection approaches the thickness).
 *
 * Steel plates: yield-line capacity 6 σ_y t² / a² (a ≈ 1 m) and the Nurick–Martin damage number
 * φ = I R / (t² √(ρ σ_y)) ≈ 1.5 (onset of permanent deflection) / 25 (tearing).
 */
function piParams(m: MaterialProps, t: number): PIParams {
  const th = Math.max(t, 1e-3);
  switch (m.class) {
    case 'glass': {
      const gtf = m.id === 'glass_tempered' ? 4 : m.id === 'glass_laminated' ? 1.1 : 1;
      const P0 = 4500 * gtf * (th / 0.006) ** 2;
      const omega = 2 * Math.PI * 21 * (th / 0.006);
      const I0 = (2 * P0) / omega;
      return { P0, I0, P0b: P0 * 2, I0b: I0 * 2 };
    }
    case 'ductile': {
      const sy = m.yieldStrength ?? m.compressiveStrength;
      const P0 = 6 * sy * th * th;
      const I0 = (1.5 * th * th * Math.sqrt(m.density * sy)) / 0.5;
      return { P0, I0, P0b: P0 * 4, I0b: (I0 * 25) / 1.5 };
    }
    case 'soil':
      return { P0: 2e6, I0: 5e3, P0b: 1e7, I0b: 5e4 };
    default: {
      const L = PI_WALL_SPAN;
      const mass = m.density * th;
      const Ig = (th * th * th) / 12;
      const Mcr = (m.tensileStrength * th * th) / 6;
      const reinforced = m.id === 'concrete' || m.id === 'concrete_hs';
      let Ru: number, k: number, theta: readonly [number, number], xCap = Infinity;
      if (reinforced) {
        const d = 0.85 * th;
        const As = RC_STEEL_RATIO * d;
        const fdy = 1.1 * 1.17 * REBAR_FY;
        const fdc = 1.19 * m.compressiveStrength;
        const a = (As * fdy) / (0.85 * fdc);
        const Mp = As * fdy * (d - a / 2);
        Ru = (8 * Math.max(Mp, Mcr)) / (L * L);
        const n = 200e9 / m.youngModulus;
        const np = n * RC_STEEL_RATIO;
        const kd = d * (Math.sqrt(2 * np + np * np) - np);
        const Icr = (kd * kd * kd) / 3 + n * As * (d - kd) ** 2;
        k = (384 * m.youngModulus * 0.5 * (Ig + Icr)) / (5 * L ** 4);
        theta = RC_THETA;
      } else {
        const March = 0.0765 * m.compressiveStrength * th * th;
        Ru = (8 * Math.max(March, Mcr)) / (L * L);
        k = (384 * m.youngModulus * Ig) / (5 * L ** 4);
        theta = URM_THETA;
        xCap = 0.5 * th;
      }
      const xm = (deg: number) => Math.min(xCap, (L / 2) * Math.tan((deg * Math.PI) / 180));
      const [P0, I0] = sdofAsymptotes(Ru, k, mass, xm(theta[0]));
      const [P0b, I0b] = sdofAsymptotes(Ru, k, mass, xm(theta[1]));
      return { P0, I0, P0b, I0b };
    }
  }
}

/** P–I asymptotes (onset, severe) of a member, for tests, tables and the HUD. */
export function piAsymptotes(m: MaterialProps, thickness: number): Readonly<PIParams> {
  return piParams(m, thickness);
}

/**
 * Damage number from P–I: < 1 none, 1 onset (cracking / pane failure / first yield), ≥ 2 severe
 * (breach / tearing). Between the two curves the number interpolates logarithmically. Laminated
 * glass cracks at the annealed limit but its PVB interlayer holds, so its severe curve is 3× higher.
 */
export function piDamage(P: number, I: number, m: MaterialProps, thickness: number): number {
  const q = piParams(m, thickness);
  const s1 = piScale(P, I, q.P0, q.I0);
  if (s1 < 1) return s1;
  const lam = m.id === 'glass_laminated' ? 3 : 1;
  const s2 = piScale(P, I, q.P0b * lam, q.I0b * lam);
  if (s2 >= 1) return 2 + Math.log2(s2);
  // s1 at the point where s2 = 1: ratio of the two curves along this load ray.
  const ratio = s1 / Math.max(s2, 1e-9);
  return 1 + Math.log(s1) / Math.log(Math.max(ratio, 1.0001));
}

// ─── Confined detonations: quasi-static gas pressure ───────────────────────────────────────

/**
 * Quasi-static gas overpressure after a detonation inside a closed volume, Pa:
 * Δp_QS = 2.25 MPa · (W/V)^0.72, W kg TNT, V m³ (Weibull 1968 fit to closed-chamber data, the
 * curve of UFC 3-340-02 fig. 2-152 and NATO AASTP-1). 12 kg in 616 m³ (W/V = 0.019) → 132 kPa.
 * Capped at W/V = 5 kg/m³ (the upper end of the data).
 */
export function quasiStaticPressure(W: number, V: number): number {
  if (!(W > 0) || !(V > 0)) return 0;
  return 2.25e6 * Math.pow(Math.min(W / V, 5), 0.72);
}

/**
 * Blow-down time constant of the gas pressure through a vent of area A, s: choked outflow,
 * dm/dt = −C_d A ρ c · 0.578 (γ = 1.4) → τ = V / (0.578 C_d A c), C_d = 0.6 (sharp-edged openings),
 * c = 20.05 √T of the heated gas with T ≈ 293 K · p_abs/p_0 (isochoric heating). Kinney & Graham
 * 1985, "Explosive Shocks in Air", ch. 13 (vented internal explosions).
 */
export function ventTimeConstant(V: number, A: number, P: number): number {
  const T = 293 * (1 + P / 101_325);
  const c = 20.05 * Math.sqrt(T);
  return V / (0.578 * 0.6 * Math.max(A, 1e-3) * c);
}

/**
 * Longest gas-pressure duration counted, s. Walls that fail open the enclosure (frangible venting,
 * UFC 3-340-02 §2-15), and by then the load is well into the quasi-static regime of the
 * storey-height members here (natural periods ≈ 20–30 ms). Game-level choice, see PHYSICS.md.
 */
export const GAS_DURATION_CAP = 0.05;
/** Afterburning of a fuel-rich thermobaric fill in the room air: TNT-equivalent × this for the gas pressure (estimate). */
export const THERMOBARIC_GAS_FACTOR = 1.75;

/** A charge's surroundings as measured by rays from it (BlastSystem.measureEnclosure). */
export interface Enclosure {
  /** Volume bounded by the surfaces the rays met, m³ */
  volume: number;
  /** Area of openings (rays that escaped) and of glazing (fails first and vents), m² */
  ventArea: number;
  /** Fraction of directions that met a solid (non-glass) surface within the probe range */
  closed: number;
  /** Farthest enclosure surface met, m */
  radius: number;
}

/** Quasi-static gas load on the inner faces of an enclosure. */
export interface GasLoad {
  /** Peak quasi-static overpressure, Pa */
  pressure: number;
  /** Its impulse on the enclosure faces, Pa·s (exponential blow-down, duration capped) */
  impulse: number;
  /** Blow-down time constant, s */
  tau: number;
  /** Faces within this distance of the charge are loaded (if they face it), m */
  radius: number;
  enclosure: Enclosure;
}

/**
 * Gas pressure for a charge of `tntKg` in `enc`, or null when it vents too freely to matter.
 * Venting: full quasi-static pressure for a scaled vent area A/V^⅔ ≤ 0.15, none from 0.6 up
 * (smooth in between; game-level reading of UFC 3-340-02 §2-15, where rooms with large openings
 * are treated as fully vented).
 */
export function gasLoad(tntKg: number, thermobaric: boolean, enc: Enclosure): GasLoad | null {
  if (!(enc.volume > 0.1)) return null;
  const aScaled = enc.ventArea / Math.pow(enc.volume, 2 / 3);
  const g = 1 - smooth01((aScaled - 0.15) / 0.45);
  if (g <= 0.01) return null;
  const P = g * quasiStaticPressure(tntKg * (thermobaric ? THERMOBARIC_GAS_FACTOR : 1), enc.volume);
  if (P < 1000) return null;
  const tau = ventTimeConstant(enc.volume, enc.ventArea, P);
  // ∫ P e^(−t/τ) dt over [0, cap]
  const impulse = P * tau * (1 - Math.exp(-GAS_DURATION_CAP / tau));
  return { pressure: P, impulse, tau, radius: enc.radius * 1.1 + 0.5, enclosure: enc };
}

function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

// ─── Loose bodies ────────────────────────────────────────────────────────────────────────────

/** Radius of a bare TNT sphere (ρ ≈ 1 600 kg/m³), m: 0.053 W^⅓. */
export function chargeRadius(tntKg: number): number {
  return 0.053 * Math.cbrt(Math.max(tntKg, 0));
}

/**
 * Impulse on a compact loose body (debris, a fallen slab) of sphere-equivalent radius rEq whose
 * centre is `dist` from the charge, N·s.
 *
 * 1. Load: the reflected impulse integrated over the presented disc (π rEq², four equal-area rings)
 *    at the body's own standoff s = dist − rEq, with oblique reflection per ring — not the value
 *    at one point, which for a large body next to the charge sits almost on the charge.
 * 2. Clearing: a finite body only feels the reflected pressure until the rarefaction from its edges
 *    clears it, t_c ≈ 4S / ((1 + S/G) U) ≈ 2 rEq / U, U ≈ 400 m/s (UFC 3-340-02 §2-15.3); after
 *    that roughly the incident pressure: i = i_s + (i_r − i_s) min(1, t_c / t_d).
 * 3. Momentum bound inside the fireball (products-dominated near field): a Gurney sphere with a
 *    linear velocity profile carries W·(3/4)·√(5/3)·√(2E) ≈ W √(2E) of outward momentum (Gurney
 *    1943), at most doubled by reflection, so a body subtending the half-angle α gets at most
 *    W √(2E) (1 − cos α). Relaxed smoothly between 0.5 and 1.5 fireball radii, where the air
 *    shock takes over.
 */
export function bodyBlastImpulse(o: { tntKg: number; W: number; thermobaric: boolean; dist: number; rEq: number; gurney?: number }): number {
  const { tntKg, W, thermobaric, rEq } = o;
  if (!(tntKg > 0) || !(rEq > 0)) return 0;
  const s = Math.max(o.dist - rEq, chargeRadius(tntKg));
  const K = 4;
  const area = (Math.PI * rEq * rEq) / K;
  const tc = (2 * rEq) / 400;
  const b: Partial<BlastPoint> = {};
  let J = 0;
  for (let k = 0; k < K; k++) {
    const rho = rEq * Math.sqrt((k + 0.5) / K);
    const R = Math.hypot(s, rho);
    blastAt(W, R, thermobaric, b);
    const ir = obliqueReflection(b.is!, b.ir!, s / R);
    J += area * (b.is! + (ir - b.is!) * Math.min(1, tc / Math.max(b.td!, 1e-6)));
  }
  const cosA = s / Math.hypot(s, rEq);
  const avail = tntKg * (o.gurney ?? 2440) * (1 - cosA);
  const Rf = fireballRadius(tntKg, thermobaric);
  const relax = smooth01((s - 0.5 * Rf) / Rf);
  return Math.min(J, avail + J * relax);
}

// ─── BlastLoad ──────────────────────────────────────────────────────────────────────────────

export interface BlastLoadOptions {
  /** Pressure/impulse multiplier for an occluded target (a wall in between) */
  attenuation?: number;
  /** Ground height under the charge (y), m */
  groundY?: number;
  /** Charge buried inside the target (delay-fuzed penetrators): tamping factor ≥ 1 for contactDamage */
  tamping?: number;
  /** Quasi-static gas pressure of a confined detonation, for targets that bound the enclosure */
  gas?: GasLoad | null;
}

/** BlastLoad with the confinement it was built with (for telemetry and tests). */
export interface ExtendedBlastLoad extends BlastLoad {
  gas: GasLoad | null;
}

const _d = new THREE.Vector3();

/**
 * Build the blast as seen by targets: all queries are closed-form and allocation-free.
 *
 * With `opts.gas` (a confined detonation, for a target that bounds the enclosure) faces inside the
 * enclosure that are turned towards the charge also carry the quasi-static gas pressure: it adds
 * to the reflected impulse, bounds the peak pressure from below, and the P–I damage number is the
 * larger of the shock alone and (P_QS, i_r + i_gas) — the long-duration load read on the same
 * iso-damage curve (its quasi-static asymptote governs).
 */
export function createBlastLoad(req: BlastRequest, time: number, opts: BlastLoadOptions = {}): ExtendedBlastLoad {
  const center = req.center.clone();
  const onSurface = !!req.normal || req.kind === 'contact' || req.kind === 'hesh';
  const W = hemisphericalCharge(req.tntKg, center.y - (opts.groundY ?? 0), onSurface);
  const thermo = req.kind === 'thermobaric';
  const att = opts.attenuation ?? 1;
  const tamping = opts.tamping ?? 1;
  const gas = opts.gas ?? null;
  const gasR2 = gas ? gas.radius * gas.radius : 0;
  const pt: Partial<BlastPoint> = {};
  const at = (p: THREE.Vector3) => blastAt(W, _d.copy(p).sub(center).length(), thermo, pt);
  const cosInc = (p: THREE.Vector3, n: THREE.Vector3) => {
    _d.copy(center).sub(p);
    const l = _d.length();
    return l > 1e-6 ? _d.dot(n) / l : 1;
  };
  const inside = (p: THREE.Vector3) => !!gas && p.distanceToSquared(center) <= gasR2;
  const load: ExtendedBlastLoad = {
    center, tntKg: req.tntKg, kind: req.kind, normal: req.normal?.clone(), contactTargetId: req.contactTargetId, time, gas,
    overpressureAt: (p) => Math.max(at(p).ps * att, inside(p) ? gas!.pressure : 0),
    impulseAt: (p) => at(p).is * att + (inside(p) ? gas!.impulse : 0),
    reflectedPressureAt(p, n) {
      const c = cosInc(p, n);
      const b = at(p);
      const pr = obliqueReflection(b.ps, b.pr, c) * att;
      return c > 0 && inside(p) ? Math.max(pr, gas!.pressure) : pr;
    },
    reflectedImpulseAt(p, n) {
      const c = cosInc(p, n);
      const b = at(p);
      const ir = obliqueReflection(b.is, b.ir, c) * att;
      return c > 0 && inside(p) ? ir + gas!.impulse : ir;
    },
    arrivalTime: (p) => at(p).ta,
    contactDamage: (m, t) => contactDamage(req.tntKg, req.kind, m, t, tamping),
    damageAt(p, n, m, t) {
      const c = cosInc(p, n);
      const b = at(p);
      const pr = obliqueReflection(b.ps, b.pr, c) * att, ir = obliqueReflection(b.is, b.ir, c) * att;
      const d = piDamage(pr, ir, m, t);
      return c > 0 && inside(p) ? Math.max(d, piDamage(gas!.pressure, ir + gas!.impulse, m, t)) : d;
    },
  };
  return load;
}
