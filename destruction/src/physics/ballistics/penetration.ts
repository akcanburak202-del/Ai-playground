import * as THREE from 'three';
import { clamp, fmtLength, smoothstep } from '../../core/units.ts';
import type { Rng } from '../../core/rng.ts';
import type { RayHit } from '../../destructibles/Destructible.ts';
import { RHA, type MaterialProps } from '../materials.ts';
import type { AmmoData } from './ammo.ts';
import type { AmmoSpec, ImpactEvent, ImpactOutcome, ProbeSegment, ProjectileState, ThicknessProbe } from './types.ts';

/**
 * Terminal ballistics: what one projectile does to one run of material. Pure functions, SI units.
 *
 * Models (equations and sources in PHYSICS.md):
 *  - brittle targets: modified NDRC penetration (Kennedy 1976) with Kennedy perforation/scabbing
 *    limits, Recht–Ipson residual velocity, deformable-core reduction, crater cone from energy;
 *  - steel: Lambert–Jonas ballistic limit (Lambert 1978) scaled by target strength and obliquity,
 *    Recht–Ipson residual velocity with plug mass, lead-ball splash;
 *  - long rods: Lanz–Odermatt perforation limit with rod erosion into steel, Alekseevskii–Tate
 *    eroding-rod penetration into concrete / soil / glass;
 *  - HEAT jets: rated RHA penetration scaled by √(ρ_RHA/ρ_t) and a target-strength factor;
 *  - soil: Young's penetration equation (Sandia, 1997);
 *  - ricochet: Tate-type critical grazing angle tan³β ∝ Y_t / (ρ_p v²).
 */

/** An ImpactEvent plus what the projectile carries on with. */
export interface ResolvedImpact extends ImpactEvent {
  residualMass: number;
  residualLength: number;
  /** Distance along the shot line from the entry point to where the projectile left the run, m */
  exitDistance: number;
  /** HEAT: jet penetration capacity left after this run, m RHA-equivalent */
  residualCapacity?: number;
}

// ─── Unit helpers for the imperial NDRC formula ─────────────────────────────────────────────

const LB = 0.45359237;
const IN = 0.0254;
const FT = 0.3048;
const PSI = 6894.757;

// ─── Brittle targets: modified NDRC (Kennedy 1976) ──────────────────────────────────────────

/** Above ~1 km/s rigid-projectile NDRC over-predicts (the nose erodes); depth then grows ∝ V instead of V^1.8. */
const NDRC_VMAX = 1000;

function ndrcEffV18(v: number): number {
  return v <= NDRC_VMAX ? Math.pow(v, 1.8) : Math.pow(NDRC_VMAX, 1.8) * (v / NDRC_VMAX);
}

function ndrcInvEffV18(e: number): number {
  const lim = Math.pow(NDRC_VMAX, 1.8);
  return e <= lim ? Math.pow(e, 1 / 1.8) : NDRC_VMAX * (e / lim);
}

/**
 * NDRC impact function coefficient: G = C · V^1.8 with (imperial, Kennedy 1976)
 * G = (180/√fc) · N · (W/d) · (V / 1000 d)^1.8, W lb, d in, V ft/s, fc psi.
 */
function ndrcCoef(mass: number, d: number, nose: number, fc: number): number {
  const W = mass / LB;
  const din = d / IN;
  const K = 180 / Math.sqrt(Math.max(fc, 1e5) / PSI);
  return (K * nose * (W / din)) / Math.pow(1000 * din * FT, 1.8); // V in m/s → ft/s folded in
}

/** Rigid-projectile penetration depth into a semi-infinite brittle target, m (modified NDRC). */
export function ndrcDepth(v: number, mass: number, d: number, nose: number, fc: number): number {
  if (!(v > 0)) return 0;
  const G = ndrcCoef(mass, d, nose, fc) * ndrcEffV18(v);
  // x/d = 2√G for G ≤ 1, G + 1 for G > 1 (Kennedy 1976, eq. 2.3)
  const xd = G <= 1 ? 2 * Math.sqrt(G) : G + 1;
  return xd * d;
}

/** Inverse of `ndrcDepth`: impact speed that gives depth x, m/s. */
export function ndrcVelocity(x: number, mass: number, d: number, nose: number, fc: number): number {
  if (!(x > 0)) return 0;
  const xd = x / d;
  const G = xd <= 2 ? (xd / 2) ** 2 : xd - 1;
  return ndrcInvEffV18(G / ndrcCoef(mass, d, nose, fc));
}

/** Kennedy (1976) perforation limit: wall thickness e that just stops a projectile with depth x, m. */
export function kennedyPerforation(x: number, d: number): number {
  const xd = x / d;
  const ed = xd <= 1.35 ? 3.19 * xd - 0.718 * xd * xd : 1.32 + 1.24 * xd;
  return Math.max(ed, 0) * d;
}

/** Inverse of `kennedyPerforation`: penetration depth whose perforation limit is e, m. */
export function kennedyPerforationInverse(e: number, d: number): number {
  const ed = e / d;
  const edAt135 = 3.19 * 1.35 - 0.718 * 1.35 * 1.35;
  if (ed >= edAt135) return ((ed - 1.32) / 1.24) * d;
  // 0.718 xd² − 3.19 xd + ed = 0, smaller root
  const disc = Math.max(0, 3.19 * 3.19 - 4 * 0.718 * ed);
  return ((3.19 - Math.sqrt(disc)) / (2 * 0.718)) * d;
}

/** Kennedy (1976) scabbing limit: thinnest wall that shows no rear scab, m. */
export function kennedyScabbing(x: number, d: number): number {
  const xd = x / d;
  const hd = xd <= 0.65 ? 7.91 * xd - 5.06 * xd * xd : 2.12 + 1.36 * xd;
  return Math.max(hd, 0) * d;
}

// ─── Steel: Lambert–Jonas ballistic limit ───────────────────────────────────────────────────

/**
 * Target-strength factor on the ballistic limit relative to RHA: V_bl ∝ √σ_u (energy dissipated
 * in plugging / hole enlargement scales with flow stress; Recht 1978, Woodward 1990).
 */
export function steelStrengthFactor(m: MaterialProps, strength = 1): number {
  return Math.sqrt((m.tensileStrength * strength) / RHA.tensileStrength);
}

/**
 * Lambert–Jonas limit velocity (Lambert 1978, ARBRL-MR-02828) for RHA, m/s:
 * V_L = 4000 (L/D)^0.15 √(f(z) D³ / m), f(z) = z + e^(−z) − 1, z = (t/D) sec^0.75 θ,
 * with D cm, m g. Here t is the line-of-sight thickness, so z = (t_los/D) cos^0.25 θ.
 */
export function lambertLimit(tLos: number, obliquity: number, d: number, len: number, mass: number): number {
  const z = (tLos / d) * Math.pow(Math.max(Math.cos(obliquity), 0.05), 0.25);
  const f = z + Math.exp(-z) - 1;
  const Dcm = d * 100;
  return 4000 * Math.pow(Math.max(len / d, 0.5), 0.15) * Math.sqrt((f * Dcm * Dcm * Dcm) / (mass * 1000));
}

/** Inverse of `lambertLimit`: line-of-sight RHA thickness just perforated at speed v, m. */
export function lambertThickness(v: number, obliquity: number, d: number, len: number, mass: number): number {
  const Dcm = d * 100;
  const s = v / (4000 * Math.pow(Math.max(len / d, 0.5), 0.15));
  const f = (s * s * mass * 1000) / (Dcm * Dcm * Dcm);
  let z = f < 1 ? Math.sqrt(2 * f) : f + 1;
  for (let i = 0; i < 30; i++) {
    const g = z + Math.exp(-z) - 1 - f;
    const dg = 1 - Math.exp(-z);
    if (dg < 1e-9) break;
    const dz = g / dg;
    z = Math.max(1e-6, z - dz);
    if (Math.abs(dz) < 1e-9) break;
  }
  return (z * d) / Math.pow(Math.max(Math.cos(obliquity), 0.05), 0.25);
}

/** Recht–Ipson (1963) residual velocity V_r = a (V^p − V_bl^p)^(1/p). */
export function rechtIpson(v: number, vbl: number, a = 1, p = 2): number {
  if (v <= vbl) return 0;
  return a * Math.pow(Math.pow(v, p) - Math.pow(vbl, p), 1 / p);
}

// ─── Long rods ──────────────────────────────────────────────────────────────────────────────

/** Lanz–Odermatt (1992) coefficients for tungsten-alloy / DU rods. */
const LO = { a: 0.994, b0: 0.283, b1: 0.0656, c: 4.024, m: -0.224 };
/**
 * Target resistance in the Lanz–Odermatt exponent, Pa, for RHA at 280 BHN. c·σ_T ≈ 20 GPa
 * reproduces the Hohler–Stilp tungsten/RHA data (P/L ≈ 0.95 at 1.5 km/s, ≈ 1.2 at 2 km/s for
 * L/D 20). Scaled linearly with Brinell hardness for other steels.
 */
const LO_SIGMA_RHA = 5.0e9;

export function loTargetStrength(m: MaterialProps, strength = 1): number {
  return LO_SIGMA_RHA * ((m.hardnessBHN ?? 150) / 280) * strength;
}

/**
 * Lanz–Odermatt perforation limit (line-of-sight thickness), m:
 * P/L = a · (1/tanh(b0 + b1 L/D)) · cos^m θ · √(ρp/ρt) · exp(−c σ_T / (ρp v²)).
 */
export function lanzOdermatt(v: number, L: number, d: number, rhoP: number, rhoT: number, sigmaT: number, obliquity: number): number {
  if (!(v > 0) || !(L > 0)) return 0;
  const ld = L / d;
  const cosT = Math.max(Math.cos(obliquity), 0.1);
  const pl = LO.a * (1 / Math.tanh(LO.b0 + LO.b1 * ld)) * Math.pow(cosT, LO.m) * Math.sqrt(rhoP / rhoT) * Math.exp((-LO.c * sigmaT) / (rhoP * v * v));
  return pl * L;
}

export interface TateResult {
  /** Penetration achieved, m */
  depth: number;
  /** Rod (tail) speed after the run, m/s */
  v: number;
  /** Remaining rod length, m */
  length: number;
}

/**
 * Alekseevskii–Tate eroding-rod penetration (Alekseevskii 1966; Tate 1967): the rod tail
 * decelerates by Y_p/(ρp l), the interface moves at u from ½ρp(v−u)² + Y_p = ½ρt u² + R_t, the
 * rod erodes at (v−u). When ½ρt v² + R_t < Y_p the rod stops eroding and penetrates as a rigid
 * body against ½ρt v² + R_t. Integrated until `maxDepth` is reached or the rod stops.
 */
export function tatePenetration(v0: number, L0: number, d: number, rhoP: number, Yp: number, rhoT: number, Rt: number, maxDepth: number): TateResult {
  let v = v0, l = L0, P = 0;
  let guard = 0;
  while (v > 1 && l > 1e-4 && P < maxDepth && guard++ < 20000) {
    const dt = Math.min(2e-6, (0.005 * Math.max(l, d)) / v);
    const rigid = 0.5 * rhoT * v * v + Rt <= Yp;
    let u: number;
    if (rigid) {
      u = v;
      // Rigid body: ρp l dv/dt = −(½ ρt v² + R_t) (Tate's interface stress on a non-eroding nose)
      v -= ((0.5 * rhoT * v * v + Rt) / (rhoP * l)) * dt;
    } else {
      // ½(ρp − ρt) u² − ρp v u + ½ ρp v² + Y_p − R_t = 0, root with u < v
      const A = 0.5 * (rhoP - rhoT);
      const B = -rhoP * v;
      const C = 0.5 * rhoP * v * v + Yp - Rt;
      if (Math.abs(A) < 1e-6) u = -C / B;
      else u = (-B - Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
      u = clamp(u, 0, v);
      v -= (Yp / (rhoP * l)) * dt;
      l -= (v - u) * dt;
    }
    P += u * dt;
  }
  return { depth: Math.min(P, maxDepth), v: Math.max(v, 0), length: Math.max(l, 0) };
}

/**
 * Target resistance for Tate in brittle / soft materials, Pa. Concrete: Forrestal et al. (1994)
 * cavity-expansion resistance R = S f_c with S = 82.6 f_c^−0.544 (f_c in MPa). Soil ≈ 50 MPa,
 * glass ≈ 2 GPa (comminuted-glass flow stress), steels from the Lanz–Odermatt σ_T.
 */
export function tateTargetResistance(m: MaterialProps, strength = 1): number {
  switch (m.class) {
    case 'brittle': {
      const fcMPa = (m.compressiveStrength * strength) / 1e6;
      return 82.6 * Math.pow(Math.max(fcMPa, 1), -0.544) * fcMPa * 1e6;
    }
    case 'soil': return 50e6 * strength;
    case 'glass': return 2e9 * strength;
    default: return loTargetStrength(m, strength);
  }
}

// ─── Soil: Young's penetration equation ─────────────────────────────────────────────────────

/**
 * Young (1997, SAND97-2426) earth penetration, SI (m, kg, m², m/s): for V ≥ 61 m/s
 * D = 0.000018 S N K (m/A)^0.7 (V − 30.5); below, D = 0.0008 S N K (m/A)^0.7 ln(1 + 2.15·10⁻⁴ V²)
 * (the English-unit form has 2·10⁻⁵ with V in ft/s; 2·10⁻⁵ / 0.3048² = 2.15·10⁻⁴).
 * K = 0.46 m^0.15 for m < 182 kg (small-penetrator correction). S = 5: compacted fill.
 */
export function youngDepth(v: number, mass: number, d: number, nose: number, S = 5): number {
  if (!(v > 0)) return 0;
  const A = (Math.PI * d * d) / 4;
  const K = mass < 182 ? 0.46 * Math.pow(mass, 0.15) : 1;
  const N = 0.56 + 0.8 * (nose - 0.72); // Young's nose coefficient: flat 0.56, ogive ≈ 0.9
  const base = S * N * K * Math.pow(mass / A, 0.7);
  return v >= 61 ? 0.000018 * base * (v - 30.5) : 0.0008 * base * Math.log(1 + 2.15e-4 * v * v);
}

function youngVelocity(D: number, mass: number, d: number, nose: number): number {
  return invertMonotonic((v) => youngDepth(v, mass, d, nose), D, 0, 5000);
}

function invertMonotonic(f: (x: number) => number, y: number, lo: number, hi: number): number {
  if (f(lo) >= y) return lo;
  if (f(hi) <= y) return hi;
  for (let i = 0; i < 48; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) < y) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// ─── HEAT jets ──────────────────────────────────────────────────────────────────────────────

/**
 * Metres of RHA-equivalent jet capacity consumed per metre of this material. Hydrodynamic jet
 * penetration scales with √(ρ_jet/ρ_t) (Birkhoff et al. 1948), so relative to RHA a material costs
 * √(ρ_t/ρ_RHA); weaker targets resist less than the density law alone predicts, captured by
 * (Y_t/Y_RHA)^0.16 (fit to field data: HEAT penetrates ≈3× its RHA rating in C40 concrete).
 */
export function jetResistance(m: MaterialProps, strength = 1): number {
  const Y = (m.class === 'ductile' ? (m.yieldStrength ?? m.compressiveStrength) : m.compressiveStrength) * strength;
  const Yr = RHA.yieldStrength ?? RHA.compressiveStrength;
  const fs = clamp(Math.pow(Yr / Math.max(Y, 1e4), 0.16), 0.8, 2.2);
  return 1 / (Math.sqrt(RHA.density / m.density) * fs);
}

// ─── Ricochet ───────────────────────────────────────────────────────────────────────────────

function flowStress(m: MaterialProps, strength: number): number {
  switch (m.class) {
    case 'ductile': return m.tensileStrength * strength;
    case 'brittle': return m.compressiveStrength * strength;
    case 'soil': return 10e6 * strength; // dynamic resistance of compacted soil (Forrestal & Luk 1992 order)
    default: return 0;
  }
}

/**
 * Critical grazing angle β_c (radians from the surface) below which the round ricochets. Tate's
 * (1979) ricochet analysis gives tan³β_c ∝ Y_t / (ρp v²); the constant per projectile class is set
 * from observed thresholds on RHA (long rods ≈12° at 1.5 km/s, AP cores ≈20° and lead ball ≈30° at
 * 850 m/s, fragments ≈25° at 1 km/s). Returns 0 for rounds that never ricochet (fuzed, jets).
 */
export function criticalGrazingAngle(ammo: AmmoSpec, m: MaterialProps, v: number, strength = 1): number {
  let b0: number, vref: number, rho: number;
  switch (ammo.kind) {
    case 'apfsds': b0 = 12; vref = 1500; rho = 18600; break;
    case 'ap': b0 = 20; vref = 850; rho = 7850; break;
    case 'ball': b0 = 30; vref = 850; rho = 11340; break;
    case 'fragment': b0 = 25; vref = 1000; rho = 7850; break;
    default:
      // Delay-fuzed or unfuzed steel-bodied shells (M908, BLU-109) skip off like AP; impact fuzes
      // and shaped charges function on the graze instead.
      if (ammo.fuze === 'impact' || ammo.kind === 'heat') return 0;
      b0 = 20; vref = 850; rho = 7850;
      break;
  }
  const Y = flowStress(m, strength);
  if (Y <= 0) return THREE.MathUtils.degToRad(2);
  const rhoP = ammo.kind === 'ball' ? 11340 : ammo.kind === 'ap' || ammo.kind === 'apfsds' || ammo.kind === 'fragment' ? ammo.coreDensity : 7850;
  const t0 = Math.tan(THREE.MathUtils.degToRad(b0));
  const t3 = t0 * t0 * t0 * (Y / RHA.tensileStrength) * ((rho * vref * vref) / (rhoP * Math.max(v, 30) ** 2));
  return Math.atan(Math.cbrt(t3));
}

// ─── The resolver ───────────────────────────────────────────────────────────────────────────

const _dir = new THREE.Vector3();
const _t = new THREE.Vector3();
const _u = new THREE.Vector3();

/** Effective penetrator for a target class: steel strips jackets, brittle targets see the whole round. */
interface Penetrator {
  d: number;
  len: number;
  mass: number;
  nose: number;
  /** Mass fraction of hard core (0 for plain lead ball) */
  hard: number;
}

/**
 * A thin-walled HE shell with a hardened nose cap (M908 HE-OR): against steel only the cap acts as
 * a penetrator — the body behind it is a light case full of explosive that collapses on the face
 * (it is designed to dig into concrete, where NDRC sees the whole round).
 */
function isCappedShell(a: AmmoData): boolean {
  return (a.kind === 'he' || a.kind === 'hesh' || a.kind === 'thermobaric') && !!a.explosiveTNT && !!a.coreMass && !a.coreDiameter;
}

function penetrator(a: AmmoData, mass: number, length: number, onSteel: boolean): Penetrator {
  if (onSteel && isCappedShell(a)) {
    // The cap as a short cylinder of the calibre: L = m / (ρ π d²/4).
    const m = Math.min(a.coreMass!, mass);
    return { d: a.diameter, len: m / (a.coreDensity * Math.PI * 0.25 * a.diameter * a.diameter), mass: m, nose: a.noseFactor, hard: 1 };
  }
  const hard = a.deformable ? clamp((a.coreMass ?? 0) / a.mass, 0, 1) : 1;
  // AP jackets strip on steel and the hard core does the work; ball rounds mushroom instead, so
  // they present at least their full calibre.
  if (onSteel && a.coreDiameter && !a.deformable) {
    return { d: a.coreDiameter, len: a.coreLength ?? length, mass, nose: a.noseFactor, hard };
  }
  return { d: a.diameter, len: length, mass, nose: a.noseFactor, hard };
}

/**
 * Deformable (lead-core) bullets flatten on hard targets. Concrete: depth × (0.4 + 0.45 h) where h
 * is the hard-core mass fraction (M855's steel tip); steel: V_bl × (1 + 0.4 (1 − h)). Fitted to
 * published rifle-into-concrete craters and the M855 mild-steel plate threshold (see PHYSICS.md).
 */
function deformConcrete(p: Penetrator, a: AmmoSpec): number {
  return a.deformable ? 0.4 + 0.45 * p.hard : 1;
}
function deformSteel(p: Penetrator, a: AmmoSpec): number {
  return a.deformable ? 1 + 0.4 * (1 - p.hard) : 1;
}

function isRod(a: AmmoSpec): boolean {
  return a.kind === 'apfsds';
}

function rodStrength(a: AmmoData): number {
  return a.rodStrength ?? (a.coreDensity > 15000 ? 1.4e9 : 1.0e9);
}

// ─── Shell break-up on steel ────────────────────────────────────────────────────────────────

/** Flow stress of a hardened steel shell nose (cap or solid ogive), Tate's Y_p, Pa (estimate: ≈ HRC 40 steel). */
export const SHELL_NOSE_STRENGTH = 1.2e9;
/** Flow stress of quenched-and-tempered shell-body steel, Pa (estimate). */
export const SHELL_CASE_STRENGTH = 1.0e9;
/** Share of the casing steel in a solid nose when the round has no separate nose cap (estimate). */
const SHELL_NOSE_FRACTION = 0.15;
const STEEL_DENSITY = 7850;

/** A steel-cased explosive round that reaches targets kinetically (delay-fuzed or unfuzed HE, HESH, thermobaric). */
export function isShellBody(a: AmmoData): boolean {
  return (a.kind === 'he' || a.kind === 'hesh' || a.kind === 'thermobaric') && !!a.explosiveTNT && (a.casingMass ?? 0) > 0;
}

/**
 * Axial load a shell body carries before its wall collapses, N: the wall section (casing mass
 * over a body length of 0.6 L — the casing geometry of fragments.ts) × the case steel's flow stress.
 * M908: 6 kg over 0.47 m → 16 cm² → 1.6 MN.
 */
export function shellCrushLoad(a: AmmoData): number {
  const Lc = Math.max(0.6 * a.length, a.diameter);
  return ((a.casingMass ?? 0) / (STEEL_DENSITY * Lc)) * SHELL_CASE_STRENGTH;
}

/**
 * Force to punch a plug of diameter d out of a steel run of length t: F = τ π d t with the
 * dynamic shear strength τ ≈ 0.6 σ_u (plugging model of Recht & Ipson 1963 / Woodward 1990;
 * von Mises τ = σ/√3). The line-of-sight length is used, so obliquity also loads the body harder.
 */
export function plugForce(m: MaterialProps, strength: number, d: number, t: number): number {
  return 0.6 * m.tensileStrength * strength * Math.PI * d * t;
}

export interface ShellBreakup {
  /** Depth the nose reaches before it is used up, m */
  depth: number;
  /** Mass of the nose that worked against the plate, kg */
  noseMass: number;
  /**
   * Share of the nose's kinetic energy the plate absorbs: u/v, the interface speed over the
   * impact speed (the interface force does work F·u on the target and F·(v − u) eroding the nose).
   */
  share: number;
  /** Body crush load and plate plugging force, N */
  crush: number;
  plug: number;
}

/**
 * Does a steel-cased HE shell break up on the face of this steel run?
 *  1. The nose cannot penetrate steel as a rigid body: Tate (1967, J. Mech. Phys. Solids 15) — a
 *     penetrator whose flow stress Y_p is below the target resistance R_t deforms at every speed
 *     (R_t = 2.7 GPa for S355, 5 GPa for RHA against Y_p ≈ 1.2 GPa). Concrete (R_t = 0.44 GPa) does
 *     not meet this condition, so HE-OR's purpose — digging into concrete — is unchanged.
 *  2. The deforming nose is driven only as hard as the thin body behind it can push: when the force
 *     needed to plug the plate (τ π d t) exceeds the body's crush load (wall area × case flow
 *     stress), the body collapses on the face and the charge goes off there.
 *  3. The nose alone then erodes into the plate: Alekseevskii–Tate with the nose as a short rod
 *     (the primary penetration; a lower estimate for L/D < 1, where the after-flow adds some).
 * Returns null when the body holds (thin or already weakened plate: the round punches through as a
 * rigid nose, Lambert–Jonas) or when the nose alone would get through anyway.
 */
export function shellBreakup(a: AmmoData, m: MaterialProps, strength: number, len: number, v: number, massNow: number): ShellBreakup | null {
  if (!isShellBody(a) || m.class !== 'ductile' || !(len > 0) || !(v > 0)) return null;
  const Rt = tateTargetResistance(m, strength);
  if (Rt <= SHELL_NOSE_STRENGTH) return null;
  const crush = shellCrushLoad(a);
  const plug = plugForce(m, strength, a.diameter, len);
  if (plug <= crush) return null;
  const noseMass = Math.min(a.coreMass ?? SHELL_NOSE_FRACTION * (a.casingMass ?? 0), massNow);
  const L = noseMass / (a.coreDensity * Math.PI * 0.25 * a.diameter * a.diameter);
  const r = tatePenetration(v, L, a.diameter, a.coreDensity, SHELL_NOSE_STRENGTH, m.density, Rt, len);
  if (r.depth >= len - 1e-6 && r.v > 1 && r.length > 1e-4) return null;
  const share = tateInterfaceSpeed(v, a.coreDensity, SHELL_NOSE_STRENGTH, m.density, Rt) / v;
  return { depth: Math.min(r.depth, len), noseMass, share, crush, plug };
}

/**
 * Steady-state Alekseevskii–Tate interface speed u < v: ½ρp(v − u)² + Y_p = ½ρt u² + R_t
 * (0 when the nose cannot push the interface at all; v when it stays rigid).
 */
export function tateInterfaceSpeed(v: number, rhoP: number, Yp: number, rhoT: number, Rt: number): number {
  if (0.5 * rhoT * v * v + Rt <= Yp) return v;
  const A = 0.5 * (rhoP - rhoT);
  const B = -rhoP * v;
  const C = 0.5 * rhoP * v * v + Yp - Rt;
  const u = Math.abs(A) < 1e-6 ? -C / B : (-B - Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
  return clamp(u, 0, v);
}

interface MarchState {
  v: number;
  mass: number;
  length: number;
  depth: number;
  stoppedIn: ProbeSegment | null;
  perforated: boolean;
  /** A shell body collapsed on the struck steel face (see `shellBreakup`): mass of its nose, kg */
  brokeUp: number;
  /** …and the share of the nose's energy the plate took (Tate u/v) */
  brokeUpShare: number;
  /** Short model note for the summary */
  note: string;
}

/**
 * March a kinetic penetrator through the probe's segments (concrete → rebar → concrete …),
 * consuming each with the model for its material class.
 */
function marchKinetic(a: AmmoData, st: MarchState, probe: ThicknessProbe, obliq: number): void {
  const segs = probe.segments;
  let stripped = false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const len = Math.max(0, seg.end - seg.start);
    if (len <= 0) continue;
    const last = i === segs.length - 1;
    const backFree = last && probe.exits;
    const m = seg.material;
    const s = clamp(seg.strength, 0.05, 1);
    const v = st.v;
    if (v <= 0) break;
    const onSteel = m.class === 'ductile';
    const pen = penetrator(a, st.mass, st.length, onSteel);

    if (isRod(a) && onSteel) {
      // Lanz–Odermatt limit; the rod erodes in proportion to the thickness defeated.
      const lim = lanzOdermatt(v, st.length, pen.d, a.coreDensity, m.density, loTargetStrength(m, s), obliq);
      if (!st.note) st.note = `Lanz–Odermatt sınır ${fmtLength(lim)}`;
      if (len < lim) {
        const lr = st.length * (1 - len / lim);
        // Tate tail deceleration: Δv = Y_p / (ρp (v−u)) · ln(L/L_r), v−u ≈ v / (1 + √(ρt/ρp))
        const vu = v / (1 + Math.sqrt(m.density / a.coreDensity));
        const dv = (rodStrength(a) / (a.coreDensity * vu)) * Math.log(st.length / Math.max(lr, 1e-4));
        st.mass *= lr / st.length;
        st.length = lr;
        st.v = Math.max(0, v - dv);
        st.depth += len;
        continue;
      }
      st.depth += lim * (lim > 0 ? 0.92 : 0);
      st.v = 0;
      st.stoppedIn = seg;
      return;
    }

    if (isRod(a) || (m.class !== 'ductile' && v > 1300 && (a.rodStrength ?? 0) > 0)) {
      // Eroding rod into concrete / soil / glass: Alekseevskii–Tate.
      const Rt = tateTargetResistance(m, s);
      const r = tatePenetration(v, st.length, pen.d, a.coreDensity, rodStrength(a), m.density, Rt, len + 1e-6);
      if (!st.note) st.note = `Tate R_t ${(Rt / 1e6).toFixed(0)} MPa`;
      st.mass *= r.length / Math.max(st.length, 1e-6);
      st.length = r.length;
      if (r.depth >= len - 1e-6 && r.v > 1 && r.length > 1e-3) {
        st.v = r.v;
        st.depth += len;
        continue;
      }
      st.depth += Math.min(r.depth, len);
      st.v = 0;
      st.stoppedIn = seg;
      return;
    }

    if (m.class === 'brittle') {
      // Modified NDRC with the damaged strength f_c · s and deformable-core reduction φ.
      const fc = m.compressiveStrength * s;
      const phi = deformConcrete(pen, a);
      const x = phi * ndrcDepth(v, pen.mass, pen.d, pen.nose, fc);
      if (!st.note) st.note = backFree ? `NDRC x=${fmtLength(x)}, Kennedy e=${fmtLength(kennedyPerforation(x, pen.d))}` : `NDRC x=${fmtLength(x)}`;
      if (backFree) {
        const e = kennedyPerforation(x, pen.d);
        if (len < e) {
          // Ballistic limit: the speed whose perforation limit equals this wall; then Recht–Ipson (a = 1, p = 2).
          const vbl = ndrcVelocity(kennedyPerforationInverse(len, pen.d) / phi, pen.mass, pen.d, pen.nose, fc);
          st.v = rechtIpson(v, vbl);
          if (a.deformable) st.mass *= 0.8;
          st.depth += len;
          continue;
        }
        st.depth += Math.min(x, len);
        st.v = 0;
        st.stoppedIn = seg;
        return;
      }
      if (x > len) {
        st.v = ndrcVelocity((x - len) / phi, pen.mass, pen.d, pen.nose, fc);
        st.depth += len;
        continue;
      }
      st.depth += x;
      st.v = 0;
      st.stoppedIn = seg;
      return;
    }

    if (m.class === 'ductile') {
      if (i === 0) {
        // A steel-cased HE shell whose body cannot push its nose through this plate breaks up on
        // the face (only on a struck steel face: a bar inside concrete is cut, not plugged).
        const bu = shellBreakup(a, m, s, len, v, st.mass);
        if (bu) {
          st.note = `gövde çöktü: tıkaç ${(bu.plug / 1e6).toFixed(1)} MN > gövde ${(bu.crush / 1e6).toFixed(1)} MN, burun (Tate) ${fmtLength(bu.depth)}`;
          st.depth += bu.depth;
          st.v = 0;
          st.stoppedIn = seg;
          st.brokeUp = bu.noseMass;
          st.brokeUpShare = bu.share;
          return;
        }
      }
      // Lambert–Jonas limit (RHA) × target-strength factor × deformable-core penalty.
      const k = steelStrengthFactor(m, s) * deformSteel(pen, a);
      const vbl = lambertLimit(len, obliq, pen.d, pen.len, pen.mass) * k;
      if (!st.note) st.note = `Lambert–Jonas V_bl ${vbl.toFixed(0)} m/s`;
      if (v > vbl) {
        // Plugging (blunt noses, fragments) ejects a plug of mass ρ π d²/4 t: a = m/(m + m_plug).
        const blunt = pen.nose < 0.9 || a.kind === 'fragment';
        const plug = blunt ? (m.density * Math.PI * pen.d * pen.d * 0.25 * len * Math.cos(obliq)) : 0;
        st.v = rechtIpson(v, vbl, pen.mass / (pen.mass + plug));
        if (!stripped && (a.kind === 'ap' || a.kind === 'ball')) {
          // The jacket strips off in the first plate: AP carries on as its core, lead ball loses ~¼.
          st.mass = Math.min(st.mass, a.kind === 'ap' ? Math.max(a.coreMass ?? st.mass * 0.8, st.mass * 0.5) : st.mass * 0.75);
          stripped = true;
        }
        st.depth += len;
        continue;
      }
      // Depth of penetration is somewhat less than the perforation limit (no rear-surface help).
      const t = lambertThickness(v / k, obliq, pen.d, pen.len, pen.mass);
      st.depth += Math.min(len, 0.85 * t);
      st.v = 0;
      st.stoppedIn = seg;
      return;
    }

    if (m.class === 'glass') {
      // Brittle pane: ~30 % of RHA's resistance per thickness, plus the momentum of the punched cone plug.
      const vbl = 0.3 * lambertLimit(len, obliq, pen.d, pen.len, pen.mass);
      if (v > vbl) {
        const plug = m.density * Math.PI * pen.d * pen.d * 0.25 * len;
        st.v = rechtIpson(v, vbl, pen.mass / (pen.mass + plug));
        st.depth += len;
        if (!st.note) st.note = `cam V_bl ${vbl.toFixed(0)} m/s`;
        continue;
      }
      st.depth += Math.min(len, 0.5 * pen.d);
      st.v = 0;
      st.stoppedIn = seg;
      return;
    }

    // Soil (Young 1997)
    const phi = deformConcrete(pen, a);
    const D = phi * youngDepth(v, pen.mass, pen.d, pen.nose);
    if (!st.note) st.note = `Young D=${fmtLength(D)}`;
    if (D > len) {
      st.v = youngVelocity((D - len) / phi, pen.mass, pen.d, pen.nose);
      st.depth += len;
      continue;
    }
    st.depth += D;
    st.v = 0;
    st.stoppedIn = seg;
    return;
  }
  st.perforated = probe.exits && st.v > 0;
}

/** Summary helpers */
function deg(r: number): string {
  return `${Math.round(THREE.MathUtils.radToDeg(r))}°`;
}

function baseEvent(p: ProjectileState, hit: RayHit, dir: THREE.Vector3, speed: number, obliq: number, mat: MaterialProps): ResolvedImpact {
  const ke = 0.5 * p.mass * speed * speed;
  return {
    time: 0, ammo: p.ammo, agent: p.ammo.kind === 'fragment' ? 'fragment' : 'projectile',
    point: hit.point.clone(), direction: dir.clone(), normal: hit.normal.clone(), obliquity: obliq,
    speed, mass: p.mass, kineticEnergy: ke, outcome: 'embed', depth: 0, residualSpeed: 0,
    craterRadius: 0, craterDepth: 0, tunnelRadius: 0, spallRadius: 0, spallDepth: 0, damageRadius: 0,
    energyAbsorbed: 0, momentum: new THREE.Vector3(), material: mat, targetKind: hit.target.kind,
    targetName: hit.target.name, summary: '', residualMass: p.mass, residualLength: p.length, exitDistance: 0,
  };
}

/**
 * Resolve a projectile meeting a target. HEAT rounds resolve as their main jet (see `resolveJet`);
 * the projectile system handles tandem precursors, fuzes and follow-through charges.
 */
export function resolveImpact(p: ProjectileState, hit: RayHit, probe: ThicknessProbe, rng: Rng): ResolvedImpact {
  const a = p.ammo as AmmoData;
  const speed = p.velocity.length();
  const dir = _dir.copy(p.velocity).divideScalar(Math.max(speed, 1e-9));
  const cosT = clamp(-dir.dot(hit.normal), 0, 1);
  const obliq = Math.acos(cosT);
  if (a.kind === 'heat' && a.heatPenetrationRHA) {
    return resolveJet(a, a.heatPenetrationRHA, a.heatConeDiameter ?? a.diameter * 0.8, hit, dir, probe, rng);
  }
  const seg0 = probe.segments[0];
  const mat = seg0?.material ?? hit.material;
  const ev = baseEvent(p, hit, dir, speed, obliq, mat);
  const name = `${a.name} ${speed.toFixed(0)} m/s, ${deg(obliq)} → ${mat.nameTr}`;

  // Ricochet: grazing angle below the critical angle (smoothed ±15 % so the edge is stochastic).
  const graze = Math.PI / 2 - obliq;
  const bc = criticalGrazingAngle(a, mat, speed, seg0?.strength ?? 1);
  if (bc > 0 && speed > 0 && rng.next() < smoothstep(1.15 * bc, 0.85 * bc, graze)) {
    return ricochet(ev, a, dir, hit.normal, graze, bc, rng, name);
  }

  const st: MarchState = { v: speed, mass: p.mass, length: p.length, depth: 0, stoppedIn: null, perforated: false, brokeUp: 0, brokeUpShare: 1, note: '' };
  marchKinetic(a, st, probe, obliq);
  if (probe.segments.length === 0) st.perforated = speed > 0;
  const runLen = probe.segments.length ? probe.segments[probe.segments.length - 1]!.end : 0;

  ev.depth = st.perforated ? runLen : st.depth;
  ev.residualSpeed = st.perforated ? st.v : 0;
  ev.residualMass = st.perforated ? st.mass : p.mass;
  ev.residualLength = st.perforated ? st.length : p.length;
  ev.exitDistance = ev.depth;
  const pen = penetrator(a, p.mass, p.length, mat.class === 'ductile');

  let outcome: ImpactOutcome = st.perforated ? 'perforate' : 'embed';
  // Lead-core ball that fails to perforate steel splashes (shatters) on the face.
  if (!st.perforated && a.kind === 'ball' && st.stoppedIn?.material.class === 'ductile' && st.stoppedIn === seg0) outcome = 'shatter';
  if (!st.perforated && a.kind === 'fragment' && mat.class === 'ductile' && speed > 600) outcome = 'shatter';
  // A shell whose body collapsed on the steel face (or a capped shell whose nose was stopped by it)
  // breaks up there and hands the plate all its momentum.
  if (!st.perforated && st.brokeUp > 0) outcome = 'shatter';
  if (!st.perforated && isCappedShell(a) && st.stoppedIn?.material.class === 'ductile' && st.stoppedIn === seg0) outcome = 'shatter';
  ev.outcome = outcome;

  if (st.perforated) {
    ev.exitPoint = hit.point.clone().addScaledVector(dir, runLen);
    // Small random yaw on exit, larger when the round lost more of its speed.
    const loss = 1 - st.v / Math.max(speed, 1e-6);
    const yaw = (a.kind === 'apfsds' ? 0.01 : 0.05) * loss;
    ev.residualDirection = yaw > 1e-4 ? rng.inCone(dir, yaw, new THREE.Vector3()) : dir.clone();
  }

  // Energy and momentum bookkeeping.
  const keOut = 0.5 * ev.residualMass * ev.residualSpeed * ev.residualSpeed;
  ev.energyAbsorbed = Math.max(0, ev.kineticEnergy - keOut);
  ev.momentum.copy(dir).multiplyScalar(p.mass * speed);
  if (ev.residualDirection) ev.momentum.addScaledVector(ev.residualDirection, -ev.residualMass * ev.residualSpeed);
  if (outcome === 'shatter') ev.energyAbsorbed *= 0.4; // most of the energy leaves in the radial splash
  if (mat.class === 'ductile' && (isCappedShell(a) || st.brokeUp > 0)) {
    // The plate works against the nose; the light body's energy goes into its own break-up (and
    // its momentum, above, still reaches the plate). An eroding nose spends the share (v − u)/v of
    // its energy on its own erosion and splash (Tate), the plate takes u/v.
    const mc = st.brokeUp > 0 ? st.brokeUp : Math.min(a.coreMass!, p.mass);
    ev.energyAbsorbed = 0.5 * mc * (speed * speed - ev.residualSpeed * ev.residualSpeed) * (st.brokeUp > 0 ? st.brokeUpShare : 1);
  }

  sizeCrater(ev, a, pen, mat, probe, st, speed, obliq);
  ev.summary = summaryFor(ev, name, st, runLen, probe);
  return ev;
}

function sizeCrater(ev: ResolvedImpact, a: AmmoData, pen: Penetrator, mat: MaterialProps, probe: ThicknessProbe, st: MarchState, speed: number, obliq: number): void {
  const d = pen.d;
  const s0 = probe.segments[0]?.strength ?? 1;
  const runLen = probe.segments.length ? probe.segments[probe.segments.length - 1]!.end : 0;
  if (mat.class === 'brittle' || mat.class === 'soil') {
    // Crater cone volume from the energy deposited near the face: V = E_abs·w / (η σ), η ≈ 4
    // (brittle fragmentation energy density ≈ 4 f_c; checks against 5.56/7.62/.50 crater data),
    // w = 1 for short penetrations, √(6d/x) for deep tunnels where the energy goes down the tunnel.
    // E_abs is what the target absorbed: a round that perforates keeps the rest.
    const sigma = mat.class === 'soil' ? 5e6 : mat.compressiveStrength * s0;
    const x = Math.max(ev.depth, 1e-4);
    const w = x <= 6 * d ? 1 : Math.sqrt((6 * d) / x);
    const V = (ev.energyAbsorbed * w) / (4 * sigma);
    const h = Math.min(x, (a.deformable ? 3 : 2.5) * d);
    let r = Math.sqrt((3 * V) / (Math.PI * Math.max(h, 1e-4)));
    r = clamp(r, 1.0 * d, (mat.class === 'soil' ? 6 : 12) * d);
    ev.craterRadius = r;
    ev.craterDepth = h;
    // Tunnel: ≈1.1–1.2 d for bullets; an eroding long rod opens a cavity ≈3 d across in concrete
    // (cavity expansion around the mushroomed rod head, Tate 1967; game-level estimate, see PHYSICS.md).
    ev.tunnelRadius = (a.kind === 'apfsds' ? 1.5 : a.deformable ? 0.6 : 0.55) * d;
    ev.damageRadius = Math.max(4 * r, 3 * d);
    if (mat.class === 'brittle' && probe.exits) {
      const xr = Math.max(st.depth, 1e-4);
      const hs = kennedyScabbing(xr, d);
      if (ev.outcome === 'perforate') {
        // Exit scab: a punching-shear cone whose flanks leave the rear face at ≈30° (half-angle
        // ≈60° about the shot line, as in concrete perforation tests and the EC2 punching cone).
        ev.spallDepth = Math.min(0.45 * runLen, 3 * d);
        ev.spallRadius = Math.max(1.3 * r, Math.tan(Math.PI / 3) * ev.spallDepth);
      } else if (runLen < hs) {
        const e = kennedyPerforation(xr, d);
        const lig = Math.max(0, runLen - ev.depth);
        const f = clamp((hs - runLen) / Math.max(hs - e, 1e-6), 0.15, 1);
        ev.spallDepth = lig * f;
        ev.spallRadius = Math.max(1.2 * r * f, 2 * ev.spallDepth + ev.tunnelRadius);
      }
    }
    return;
  }
  if (mat.class === 'glass') {
    ev.tunnelRadius = 0.6 * d;
    ev.craterRadius = 1.5 * d; // crushed halo on the impact face
    ev.craterDepth = Math.min(runLen, 0.5 * d);
    ev.spallRadius = ev.outcome === 'perforate' ? 3 * d : 0; // Hertzian cone flake on the exit face
    ev.spallDepth = ev.outcome === 'perforate' ? 0.5 * runLen : 0;
    ev.damageRadius = Math.max(15 * d, 0.05 * Math.sqrt(ev.kineticEnergy / 1000));
    return;
  }
  // Steel: hole by plugging (blunt / thick) or ductile hole growth (pointed), petals on thin plates.
  const tn = Math.max(runLen * Math.cos(obliq), 1e-4);
  const blunt = pen.nose < 0.9 || a.kind === 'fragment';
  const k = tn / d < 0.25 ? 1.4 : blunt ? 1.05 : 1.15;
  const holeD = a.kind === 'ball' ? a.diameter : d;
  ev.tunnelRadius = 0.5 * holeD * k;
  if (ev.outcome === 'perforate') {
    ev.craterRadius = 1.8 * ev.tunnelRadius;
    ev.craterDepth = Math.min(tn, 0.5 * d);
  } else if (ev.outcome === 'shatter') {
    ev.craterRadius = 0.9 * holeD;
    ev.craterDepth = Math.min(ev.depth, 0.3 * holeD * (speed / 800));
    ev.depth = ev.craterDepth;
  } else {
    ev.craterRadius = 1.5 * d * (a.kind === 'apfsds' ? 2 : 1);
    ev.craterDepth = ev.depth;
  }
  // Plastic zone: E_abs = σ_y · ε̄ · π r² t with ε̄ ≈ 0.05 → r = √(E / (π σ_y t ε̄)).
  const sy = (mat.yieldStrength ?? mat.compressiveStrength) * s0;
  const tz = Math.min(tn, 20 * d);
  ev.damageRadius = Math.max(2.5 * d, Math.sqrt(ev.energyAbsorbed / (Math.PI * sy * tz * 0.05)));
}

/** "Beton 40 mm + İnşaat demiri 12 mm + …" for multi-material runs (empty for a single material). */
function layers(probe: ThicknessProbe): string {
  const segs = probe.segments;
  if (segs.length < 2) return '';
  const parts: string[] = [];
  for (let i = 0; i < segs.length && parts.length < 4; i++) parts.push(`${segs[i]!.material.nameTr} ${fmtLength(segs[i]!.end - segs[i]!.start)}`);
  if (segs.length > 4) parts.push('…');
  return ` [${parts.join(' + ')}]`;
}

/**
 * One-line, Turkish model summary for the telemetry panel: round, speed, obliquity, material, what
 * happened (upper-case verb), the key sizes, and the model that decided it.
 */
function summaryFor(ev: ResolvedImpact, name: string, st: MarchState, runLen: number, probe: ThicknessProbe): string {
  const note = st.note ? ` (${st.note})` : '';
  const mm = (m: number) => fmtLength(m);
  const lay = layers(probe);
  switch (ev.outcome) {
    case 'perforate':
      return `${name} ${mm(runLen)}${lay}: DELDİ, çıkış ${ev.residualSpeed.toFixed(0)} m/s${ev.ammo.kind === 'apfsds' ? `, kalan çubuk ${mm(ev.residualLength)}` : ''}${ev.spallRadius > 0 && ev.material.class === 'brittle' ? `, arka kavlama Ø${mm(2 * ev.spallRadius)}` : ''}${note}`;
    case 'shatter':
      return `${name}: mermi yüzeyde PARÇALANDI, göçük ${mm(ev.craterDepth)}${note}`;
    default:
      if (ev.material.class === 'brittle' || ev.material.class === 'soil') {
        return `${name}${lay}: SAPLANDI ${mm(ev.depth)}, krater Ø${mm(2 * ev.craterRadius)} × ${mm(ev.craterDepth)}${ev.spallRadius > 0 ? `, arka kavlama Ø${mm(2 * ev.spallRadius)}` : ''}${note}`;
      }
      return `${name}${lay}: DURDU ${mm(ev.depth)} / ${mm(runLen)}${note}`;
  }
}

function ricochet(ev: ResolvedImpact, a: AmmoData, dir: THREE.Vector3, n: THREE.Vector3, graze: number, bc: number, rng: Rng, name: string): ResolvedImpact {
  const m = ev.material;
  // Outgoing grazing angle is a fraction of the incoming one (the round planes along the face);
  // tangential speed retention ≈ 0.9, the normal component is absorbed: v_r = v (0.9 − 0.6 sin β).
  const kOut = m.class === 'ductile' ? 0.5 : m.class === 'soil' ? 0.6 : 0.3;
  const bOut = graze * kOut * rng.range(0.6, 1.4);
  _t.copy(dir).addScaledVector(n, -dir.dot(n));
  if (_t.lengthSq() < 1e-12) _t.set(1, 0, 0).cross(n);
  _t.normalize();
  _u.crossVectors(n, _t);
  const out = new THREE.Vector3().copy(_t).multiplyScalar(Math.cos(bOut)).addScaledVector(n, Math.sin(bOut));
  out.addScaledVector(_u, rng.gaussian(0, 0.03)).normalize();
  const vr = ev.speed * clamp(0.9 - 0.6 * Math.sin(graze), 0.2, 0.95);
  const mr = a.deformable && m.class === 'ductile' ? ev.mass * 0.85 : ev.mass;
  ev.outcome = 'ricochet';
  ev.residualSpeed = vr;
  ev.residualDirection = out;
  ev.residualMass = mr;
  ev.depth = 0;
  ev.exitDistance = 0;
  const d = a.diameter;
  ev.craterRadius = 1.5 * d;
  ev.craterDepth = m.class === 'brittle' ? 0.5 * d * Math.sin(graze) + 0.1 * d : 0.1 * d;
  ev.tunnelRadius = 0;
  ev.damageRadius = 3 * d;
  ev.energyAbsorbed = Math.max(0, ev.kineticEnergy - 0.5 * mr * vr * vr);
  ev.momentum.copy(dir).multiplyScalar(ev.mass * ev.speed).addScaledVector(out, -mr * vr);
  ev.summary = `${name}: SEKTİ (sıyırma açısı ${deg(graze)} < kritik ${deg(bc)}), çıkış ${vr.toFixed(0)} m/s`;
  return ev;
}

// ─── HEAT jet ───────────────────────────────────────────────────────────────────────────────

const JET_LABEL_TR: Record<string, string> = { jet: 'oyuk dolgu jeti', 'precursor jet': 'öncü jet', 'cutting jet': 'kesici jet' };

/** Jet tip speed of a copper shaped-charge jet, m/s (Walters & Zukas, "Fundamentals of Shaped Charges"). */
export const JET_TIP_SPEED = 7500;

/**
 * Resolve a shaped-charge jet with `capacity` metres of RHA penetration left, marching through
 * the probe segments (stand-off effects ignored: the rating is taken at optimum stand-off).
 */
export function resolveJet(a: AmmoSpec, capacity: number, cone: number, hit: RayHit, dir: THREE.Vector3, probe: ThicknessProbe, _rng: Rng, label = 'jet'): ResolvedImpact {
  const cosT = clamp(-dir.dot(hit.normal), 0, 1);
  const obliq = Math.acos(cosT);
  const seg0 = probe.segments[0];
  const mat = seg0?.material ?? hit.material;
  // Liner ≈ 2π r² × 0.02 CD of copper; the jet carries ~20 % of it at ~4 km/s mean speed.
  const r = cone / 2;
  const jetMass = 0.2 * 8960 * 2 * Math.PI * r * r * 0.02 * cone;
  const vMean = 4000;
  const proj: ProjectileState = { ammo: a, position: hit.point, velocity: dir, mass: jetMass, length: 0, perforations: 0 };
  const ev = baseEvent(proj, hit, dir, JET_TIP_SPEED, obliq, mat);
  ev.agent = 'jet';
  ev.kineticEnergy = 0.5 * jetMass * vMean * vMean;
  let c = capacity;
  let depth = 0;
  let stopped = false;
  for (const seg of probe.segments) {
    const len = Math.max(0, seg.end - seg.start);
    const k = jetResistance(seg.material, clamp(seg.strength, 0.05, 1));
    const need = len * k;
    if (c >= need) {
      c -= need;
      depth += len;
    } else {
      depth += c / k;
      c = 0;
      stopped = true;
      break;
    }
  }
  const runLen = probe.segments.length ? probe.segments[probe.segments.length - 1]!.end : 0;
  const perforated = !stopped && probe.exits && c > 0;
  ev.outcome = perforated ? 'perforate' : 'embed';
  ev.depth = perforated ? runLen : depth;
  ev.exitDistance = ev.depth;
  ev.residualCapacity = perforated ? c : 0;
  const frac = capacity > 0 ? (capacity - (perforated ? c : 0)) / capacity : 1;
  ev.residualSpeed = perforated ? JET_TIP_SPEED * Math.sqrt(c / capacity) : 0;
  ev.residualMass = jetMass * (1 - frac);
  ev.energyAbsorbed = ev.kineticEnergy * frac;
  ev.momentum.copy(dir).multiplyScalar(jetMass * vMean * frac);
  if (perforated) {
    ev.exitPoint = hit.point.clone().addScaledVector(dir, runLen);
    ev.residualDirection = dir.clone();
  }
  // Hole: ≈ 0.2 CD diameter in steel (narrow, clean), wider tunnel and a large entry crater in
  // brittle material (the jet's radial shock and the warhead blast spall the face).
  if (mat.class === 'brittle') {
    ev.tunnelRadius = 0.25 * cone;
    ev.craterRadius = 1.2 * cone;
    ev.craterDepth = Math.min(ev.depth, 0.6 * cone);
    ev.damageRadius = 3 * ev.craterRadius;
    if (perforated) {
      ev.spallRadius = 1.5 * cone;
      ev.spallDepth = Math.min(0.4 * runLen, 0.8 * cone);
    }
  } else if (mat.class === 'glass') {
    ev.tunnelRadius = 0.3 * cone;
    ev.craterRadius = 0.6 * cone;
    ev.damageRadius = 3 * cone;
  } else if (mat.class === 'soil') {
    ev.tunnelRadius = 0.3 * cone;
    ev.craterRadius = 1.0 * cone;
    ev.craterDepth = 0.5 * cone;
    ev.damageRadius = 2 * cone;
  } else {
    ev.tunnelRadius = 0.1 * cone;
    ev.craterRadius = 0.25 * cone;
    ev.craterDepth = Math.min(ev.depth, 0.1 * cone);
    ev.damageRadius = 0.6 * cone;
  }
  let eq = 0;
  for (const seg of probe.segments) eq += Math.max(0, seg.end - seg.start) * jetResistance(seg.material, clamp(seg.strength, 0.05, 1));
  const what = JET_LABEL_TR[label] ?? label;
  ev.summary = `${a.name} ${what} (${fmtLength(capacity)} RHA) → ${mat.nameTr}${layers(probe)}: ${perforated ? `DELDİ ${fmtLength(runLen)} (≈${fmtLength(eq)} RHA-eşd.), kalan ${fmtLength(c)} RHA` : `nüfuz ${fmtLength(ev.depth)}, jet tükendi`}`;
  return ev;
}
