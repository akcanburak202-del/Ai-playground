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
 * P–I asymptotes for a member of `thickness` made of `material`: [onset of damage] and [severe /
 * breach].
 *
 * Glass: ASTM E1300 load resistance of a 6 mm annealed 1.5 × 1 m pane ≈ 2.3 kPa (3-s) ≈ 4.5 kPa
 * dynamic, ∝ t², ×4 tempered (glass-type factor), impulse asymptote I0 = 2 P0/ω with ω = 2π·21 Hz
 * (first mode of that simply supported pane).
 *
 * Brittle walls and slabs (concrete, stone, brick): a one-way strip of span L = 3 m as an elastic
 * single-degree-of-freedom system (Biggs 1964, "Introduction to Structural Dynamics"; the SDOF
 * basis of PDC-TR 06-08). Cracking resistance R_cr = 8 M_cr / L² with M_cr = f_t h²/6, stiffness
 * k = 384 E I / (5 L⁴), I = h³/12, mass m = ρ h, load–mass factor K_LM = 0.78. Onset of cracking is
 * the elastic response reaching R_cr: quasi-static asymptote P0 = R_cr / 2 (dynamic load factor
 * 2), impulsive asymptote I0 = x_cr √(K_LM m k), x_cr = R_cr / k. (For a 0.25 m C40 wall:
 * 16 kPa, 107 Pa·s.) Severe damage / local breach is placed at P0b = 20 P0, I0b = 48 I0 for
 * reinforced concrete (≈ 320 kPa and ≈ 5 kPa·s for 0.25 m — heavier than the global-flexure
 * "heavy damage" limit of PDC-TR 06-08 because the element realises it as a local breach) and at
 * half those ratios for unreinforced masonry and stone, whose post-cracking capacity is small.
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
      const Rcr = (8 * (m.tensileStrength * th * th) / 6) / (L * L);
      const k = (384 * m.youngModulus * (th * th * th) / 12) / (5 * L ** 4);
      const mass = m.density * th;
      const xcr = Rcr / k;
      const P0 = Rcr / 2;
      const I0 = xcr * Math.sqrt(0.78 * mass * k);
      const reinforced = m.id === 'concrete' || m.id === 'concrete_hs';
      const aP = reinforced ? 20 : 10, aI = reinforced ? 48 : 24;
      return { P0, I0, P0b: P0 * aP, I0b: I0 * aI };
    }
  }
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

// ─── BlastLoad ──────────────────────────────────────────────────────────────────────────────

export interface BlastLoadOptions {
  /** Pressure/impulse multiplier for an occluded target (a wall in between) */
  attenuation?: number;
  /** Ground height under the charge (y), m */
  groundY?: number;
  /** Charge buried inside the target (delay-fuzed penetrators): tamping factor ≥ 1 for contactDamage */
  tamping?: number;
}

const _d = new THREE.Vector3();

/** Build the blast as seen by targets: all queries are closed-form and allocation-free. */
export function createBlastLoad(req: BlastRequest, time: number, opts: BlastLoadOptions = {}): BlastLoad {
  const center = req.center.clone();
  const onSurface = !!req.normal || req.kind === 'contact' || req.kind === 'hesh';
  const W = hemisphericalCharge(req.tntKg, center.y - (opts.groundY ?? 0), onSurface);
  const thermo = req.kind === 'thermobaric';
  const att = opts.attenuation ?? 1;
  const tamping = opts.tamping ?? 1;
  const pt: Partial<BlastPoint> = {};
  const at = (p: THREE.Vector3) => blastAt(W, _d.copy(p).sub(center).length(), thermo, pt);
  const cosInc = (p: THREE.Vector3, n: THREE.Vector3) => {
    _d.copy(center).sub(p);
    const l = _d.length();
    return l > 1e-6 ? _d.dot(n) / l : 1;
  };
  const load: BlastLoad = {
    center, tntKg: req.tntKg, kind: req.kind, normal: req.normal?.clone(), contactTargetId: req.contactTargetId, time,
    overpressureAt: (p) => at(p).ps * att,
    impulseAt: (p) => at(p).is * att,
    reflectedPressureAt(p, n) {
      const c = cosInc(p, n);
      const b = at(p);
      return obliqueReflection(b.ps, b.pr, c) * att;
    },
    reflectedImpulseAt(p, n) {
      const c = cosInc(p, n);
      const b = at(p);
      return obliqueReflection(b.is, b.ir, c) * att;
    },
    arrivalTime: (p) => at(p).ta,
    contactDamage: (m, t) => contactDamage(req.tntKg, req.kind, m, t, tamping),
    damageAt(p, n, m, t) {
      const c = cosInc(p, n);
      const b = at(p);
      return piDamage(obliqueReflection(b.ps, b.pr, c) * att, obliqueReflection(b.is, b.ir, c) * att, m, t);
    },
  };
  return load;
}
