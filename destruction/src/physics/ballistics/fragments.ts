import * as THREE from 'three';
import { SPEED_OF_SOUND } from '../../core/units.ts';
import type { Rng } from '../../core/rng.ts';
import { dragShape } from './flight.ts';
import type { AmmoSpec, BlastRequest } from './types.ts';

/**
 * Casing fragmentation: initial speed from the Gurney equations, mass distribution from Mott,
 * flight from the blunt-fragment drag curve. A detonation throws a few dozen *representative*
 * fragments as real projectiles; each has its true sampled mass and speed.
 */

const STEEL = 7850;

/** Gurney (1943) cylinder: V = √(2E) / √(M/C + 1/2). */
export function gurneyCylinder(sqrt2E: number, casingMass: number, chargeMass: number): number {
  return sqrt2E / Math.sqrt(casingMass / Math.max(chargeMass, 1e-9) + 0.5);
}

/** Gurney sphere: V = √(2E) / √(M/C + 3/5). */
export function gurneySphere(sqrt2E: number, casingMass: number, chargeMass: number): number {
  return sqrt2E / Math.sqrt(casingMass / Math.max(chargeMass, 1e-9) + 0.6);
}

/**
 * Mott (1947) scale mass μ (half the mean fragment mass) for a cylindrical steel casing:
 * √μ = B t^(5/6) d_i^(1/3) (1 + t/d_i), μ in lb, t and d_i in inches; B ≈ 0.0646 lb^½·in^(−7/6)
 * for TNT, 0.0554 for Comp B (NAVORD Report 2022; Mott 1947). (t^(5/6)·d^(1/3) is what makes B's
 * in^(−7/6) come out in lb^½.) Returned in kg.
 */
export function mottScaleMass(wall: number, innerDiameter: number, B = 0.0646): number {
  const t = Math.max(wall, 1e-4) / 0.0254;
  const di = Math.max(innerDiameter, 1e-3) / 0.0254;
  const sq = B * Math.pow(t, 5 / 6) * Math.cbrt(di) * (1 + t / di);
  return sq * sq * 0.45359237;
}

/** Sample a fragment mass from the Mott distribution N(>m) = N0 exp(−√(m/μ)). */
export function sampleMott(mu: number, rng: Rng): number {
  let u = rng.next();
  if (u < 1e-9) u = 1e-9;
  const s = -Math.log(u);
  return mu * s * s;
}

/**
 * Mean presented area of a tumbling natural steel fragment: A = γ m^(2/3), γ ≈ 0.0047 m²/kg^(2/3)
 * (a random-orientation cube gives 0.0038; natural fragments are flatter; JMEM / Held).
 */
export function fragmentArea(mass: number): number {
  return 0.0047 * Math.pow(mass, 2 / 3);
}

/** Build a flying-fragment AmmoSpec with the right mass, size and drag. */
export function fragmentAmmo(mass: number, speed: number, source?: AmmoSpec, density = STEEL): AmmoSpec {
  const A = fragmentArea(mass);
  const d = Math.sqrt((4 * A) / Math.PI);
  const side = Math.cbrt(mass / density);
  return {
    id: 'fragment', name: source ? `${source.name} fragment` : 'fragment', caliber: `${(mass * 1000).toFixed(1)} g fragment`,
    kind: 'fragment', mass, diameter: d, length: side, muzzleVelocity: speed,
    dragCd: dragShape(speed / SPEED_OF_SOUND, 'fragment'),
    coreDensity: density, noseFactor: 0.84, deformable: false, fuze: 'none',
    note: 'Natural fragment of a steel casing (Gurney velocity, Mott mass)',
  };
}

export interface FragmentSample {
  mass: number;
  speed: number;
  direction: THREE.Vector3;
}

/** Casing geometry guess from the round's diameter and casing mass (for Mott). */
function casingGeometry(req: BlastRequest): { wall: number; inner: number } {
  const src = req.source;
  const Do = src?.diameter ?? Math.max(0.03, 0.12 * Math.cbrt(req.tntKg));
  const Lc = Math.max(0.6 * (src?.length ?? 3 * Do), Do);
  const M = req.casingMass ?? 0;
  const inner2 = Do * Do - (4 * M) / (STEEL * Math.PI * Lc);
  const inner = Math.sqrt(Math.max(inner2, 0.2 * Do * Do));
  return { wall: Math.max((Do - inner) / 2, 0.001), inner };
}

/**
 * Representative fragments for a detonation: `count` samples, each with a Mott mass, Gurney
 * speed and a direction. Cylindrical casings throw mostly sideways (a belt ±35° about the plane
 * normal to the axis, Taylor angle neglected); the round's own velocity is added to each fragment.
 * With no travel direction the spray is spherical.
 */
export function sampleFragments(req: BlastRequest, count: number, rng: Rng): FragmentSample[] {
  const out: FragmentSample[] = [];
  const M = req.casingMass ?? 0;
  if (M <= 0 || count <= 0) return out;
  const C = Math.max(req.tntKg, 1e-4);
  const g = req.gurney ?? 2440;
  const v0 = gurneyCylinder(g, M, C);
  const { wall, inner } = casingGeometry(req);
  const mu = mottScaleMass(wall, inner);
  const axis = req.travelDirection && req.travelDirection.lengthSq() > 0 ? req.travelDirection.clone().normalize() : null;
  const u = new THREE.Vector3();
  const w = new THREE.Vector3();
  if (axis) {
    u.set(1, 0, 0);
    if (Math.abs(axis.x) > 0.9) u.set(0, 1, 0);
    u.cross(axis).normalize();
    w.crossVectors(axis, u);
  }
  const travel = req.travelSpeed ?? 0;
  for (let i = 0; i < count; i++) {
    // Cap the sampled mass at 5 % of the casing so tiny shells do not throw absurd chunks.
    const m = Math.min(sampleMott(mu, rng), 0.05 * M + 1e-4);
    const dir = new THREE.Vector3();
    if (axis) {
      const phi = rng.range(0, Math.PI * 2);
      const el = rng.gaussian(0, 0.35); // side-spray belt
      dir.copy(u).multiplyScalar(Math.cos(phi)).addScaledVector(w, Math.sin(phi)).multiplyScalar(Math.cos(el)).addScaledVector(axis, Math.sin(el));
    } else {
      rng.onSphere(dir);
    }
    // Fragment velocity = Gurney speed (±10 % scatter) + projectile velocity.
    const vel = dir.multiplyScalar(v0 * rng.range(0.9, 1.1));
    if (axis) vel.addScaledVector(axis, travel);
    const speed = vel.length();
    out.push({ mass: m, speed, direction: vel.divideScalar(Math.max(speed, 1e-6)) });
  }
  return out;
}

/** How many representative fragments to throw for a casing mass (a few dozen for shells, a handful for 30 mm). */
export function fragmentBudget(casingMass: number): number {
  if (casingMass <= 0) return 0;
  return Math.round(Math.min(64, Math.max(4, 14 * Math.cbrt(casingMass))));
}
