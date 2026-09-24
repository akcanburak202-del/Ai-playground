import * as THREE from 'three';
import type { MaterialProps } from '../../physics/materials.ts';
import type { AmmoSpec, BlastLoad, ContactDamage, ImpactEvent, ThicknessProbe } from '../../physics/ballistics/types.ts';
import type { RayHit } from '../Destructible.ts';

/**
 * STAND-INS for the ballistics module (M1), used only by the voxel sandbox and tests so this
 * module can be exercised before the real terminal-ballistics and blast code exists. They produce
 * ImpactEvents / BlastLoads with the magnitudes the design calibration table asks for; the element
 * code consumes them exactly like the real ones.
 */

export const STUB_AMMO: Record<'m855' | 'm80' | 'm2ap', AmmoSpec> = {
  m855: {
    id: 'm855', name: 'M855 ball', caliber: '5.56×45 mm NATO', kind: 'ball', mass: 0.00402, diameter: 0.0057, length: 0.0231,
    muzzleVelocity: 910, dragCd: 0.3, coreDensity: 11340, coreMass: 0.00072, noseFactor: 1.14, deformable: true, fuze: 'none', note: 'stub',
  },
  m80: {
    id: 'm80', name: 'M80 ball', caliber: '7.62×51 mm NATO', kind: 'ball', mass: 0.00953, diameter: 0.00782, length: 0.0288,
    muzzleVelocity: 840, dragCd: 0.3, coreDensity: 11340, noseFactor: 1.14, deformable: true, fuze: 'none', note: 'stub',
  },
  m2ap: {
    id: 'm2ap', name: 'M2 AP', caliber: '12.7×99 mm', kind: 'ap', mass: 0.0459, diameter: 0.0127, length: 0.059,
    muzzleVelocity: 890, dragCd: 0.3, coreDensity: 7850, coreMass: 0.0265, noseFactor: 1.14, deformable: false, fuze: 'none', note: 'stub',
  },
};

interface Base {
  crater: number;
  craterDepth: number;
  depth: number;
  tunnel: number;
  damage: number;
  spall: number;
}

// Single-hit numbers into pristine C40 (design calibration table: 5.56 crater Ø 40–90 mm, depth
// 15–40 mm; 7.62 depth 25–60 mm; .50 AP depth 100–200 mm).
const BASE: Record<string, Base> = {
  m855: { crater: 0.032, craterDepth: 0.026, depth: 0.04, tunnel: 0.004, damage: 0.08, spall: 0.06 },
  m80: { crater: 0.04, craterDepth: 0.03, depth: 0.05, tunnel: 0.005, damage: 0.1, spall: 0.08 },
  m2ap: { crater: 0.07, craterDepth: 0.05, depth: 0.15, tunnel: 0.008, damage: 0.22, spall: 0.16 },
};

/**
 * Resolve a bullet against a probed run. Depth scales like the NDRC deep-penetration regime,
 * x ∝ 1/√f_c (Kennedy 1976), with f_c reduced by the probe's damage factor; the crater widens
 * as ∝ f_c^−¼. A bar in the path stops ball ammunition at the bar.
 */
export function resolveBulletStub(ammo: AmmoSpec, hit: RayHit, dir: THREE.Vector3, probe: ThicknessProbe, time: number): ImpactEvent {
  const b = BASE[ammo.id] ?? BASE.m855!;
  const v = ammo.muzzleVelocity;
  const ke = 0.5 * ammo.mass * v * v;
  const first = probe.segments[0];
  const concreteStrength = first && !first.material.id.startsWith('rebar') ? first.strength : 1;
  let depth = b.depth / Math.sqrt(concreteStrength);
  const craterR = b.crater * Math.pow(concreteStrength, -0.25);
  let craterD = Math.min(depth, b.craterDepth / Math.sqrt(concreteStrength));
  const run = probe.segments.length ? probe.segments[probe.segments.length - 1]!.end : 0;
  let outcome: ImpactEvent['outcome'] = 'embed';
  // Steel in the path.
  const steel = probe.segments.find((s) => s.material.id.startsWith('rebar'));
  if (steel && steel.start < depth) {
    if (ammo.kind === 'ball') {
      depth = steel.start + 0.002;
      craterD = Math.min(craterD, depth);
    }
  }
  let spallR = 0, spallD = 0;
  let exitPoint: THREE.Vector3 | undefined;
  if (probe.exits) {
    const remaining = run - depth;
    if (remaining <= 0) {
      outcome = 'perforate';
      depth = run;
      exitPoint = hit.point.clone().addScaledVector(dir, run);
      spallR = b.spall;
      spallD = Math.min(run, b.spall * 0.4);
    } else {
      // NDRC scabbing limit (Kennedy 1976): h_s/d = 2.12 + 1.36·x/d for 0.65 ≤ x/d ≤ 11.75.
      const xd = Math.min(11.75, depth / ammo.diameter);
      const hs = ammo.diameter * (2.12 + 1.36 * xd);
      if (remaining < hs) {
        const f = 1 - remaining / hs;
        spallR = b.spall * f + 0.01;
        spallD = Math.min(remaining * 0.7, spallR * 0.5);
      }
    }
  }
  return {
    time, ammo, agent: 'projectile', point: hit.point.clone(), direction: dir.clone(), normal: hit.normal.clone(),
    obliquity: Math.acos(Math.min(1, Math.abs(dir.dot(hit.normal)))), speed: v, mass: ammo.mass, kineticEnergy: ke,
    outcome, depth, exitPoint, residualSpeed: outcome === 'perforate' ? v * 0.3 : 0, craterRadius: craterR, craterDepth: craterD,
    tunnelRadius: b.tunnel, spallRadius: spallR, spallDepth: spallD, damageRadius: b.damage, energyAbsorbed: ke,
    momentum: dir.clone().multiplyScalar(ammo.mass * v), material: hit.material, targetKind: hit.target.kind, targetName: hit.target.name,
    summary: `stub ${ammo.id}: depth ${(depth * 1000).toFixed(0)} mm (strength ${concreteStrength.toFixed(2)})`,
  };
}

/** Mills (1987) side-on overpressure fit, kPa: 1772/Z³ − 114/Z² + 108/Z (Z in m/kg^⅓). */
function millsKPa(Z: number): number {
  const z = Math.max(0.05, Z);
  return 1772 / (z * z * z) - 114 / (z * z) + 108 / z;
}

/**
 * A blast load with rough but physically shaped numbers (Mills overpressure, impulse ∝ W^⅓/Z,
 * reflection ×(2..8), P–I damage number ∝ (0.5/Z)^1.5 · (0.25 m / t), contact crater/breach/scab
 * scaled by W^⅓ from a 2 kg reference charge on a 0.25 m RC wall: crater 0.40 m, breach 0.30 m,
 * scab 0.60 m).
 */
export function makeBlastLoadStub(center: THREE.Vector3, tntKg: number, opts: { normal?: THREE.Vector3; contactTargetId?: number; time?: number } = {}): BlastLoad {
  const W = Math.max(1e-3, tntKg);
  const w3 = Math.cbrt(W);
  const Z = (p: THREE.Vector3) => Math.max(0.05, p.distanceTo(center)) / w3;
  const cos = (p: THREE.Vector3, n: THREE.Vector3) => {
    const d = new THREE.Vector3().subVectors(center, p).normalize();
    return Math.max(0, d.dot(n));
  };
  return {
    center: center.clone(), tntKg: W, kind: opts.contactTargetId !== undefined ? 'contact' : 'he', normal: opts.normal?.clone(), contactTargetId: opts.contactTargetId, time: opts.time ?? 0,
    overpressureAt: (p) => millsKPa(Z(p)) * 1000,
    impulseAt: (p) => (200 * w3) / Z(p),
    reflectedPressureAt: (p, n) => {
      const ps = millsKPa(Z(p)) * 1000;
      const cr = 2 + 6 * Math.min(1, ps / 2e6);
      return ps * (1 + (cr - 1) * cos(p, n));
    },
    reflectedImpulseAt: (p, n) => ((200 * w3) / Z(p)) * (1 + 3 * cos(p, n)),
    arrivalTime: (p) => p.distanceTo(center) / 343,
    contactDamage: (_m: MaterialProps, thickness: number): ContactDamage => {
      const s = Math.cbrt(W / 2);
      const tb = 0.35 * s;
      const breach = thickness < tb;
      return {
        craterRadius: 0.4 * s,
        craterDepth: Math.min(thickness, 0.12 * s),
        breach,
        breachRadius: breach ? 0.3 * s * Math.sqrt(1 - thickness / tb) + 0.08 : 0,
        spallRadius: 0.6 * s,
        spallDepth: Math.min(0.4 * thickness, 0.1 * s),
        spallVelocity: 30 * s,
      };
    },
    damageAt: (p, n, _m, thickness) => Math.pow(0.5 / Z(p), 1.5) * (0.25 / Math.max(0.05, thickness)) * (0.3 + 0.7 * cos(p, n)),
  };
}

/** Fire one stub round from `from` at `at` through the registry (what the ProjectileSystem does). */
export function fireStub(ctx: import('../../app/contracts.ts').SimContext, ammo: AmmoSpec, from: THREE.Vector3, at: THREE.Vector3): ImpactEvent | null {
  const dir = at.clone().sub(from).normalize();
  const hit = ctx.registry.raycast(from, dir, 1000);
  if (!hit) return null;
  const probe = hit.target.probe(hit, dir, 3);
  const e = resolveBulletStub(ammo, hit, dir, probe, ctx.time.now);
  hit.target.applyImpact(e);
  ctx.events.emit('impact', e);
  return e;
}

export interface CraterMeasure {
  /** Equivalent diameter of the area deeper than 5 mm, m */
  diameter: number;
  /** Largest horizontal extent of that area, m */
  extent: number;
  /** Deepest point below the original face, m */
  maxDepth: number;
  /** Rays that passed through the member (holed area samples) */
  through: number;
  /** Rays stopped by exposed rebar */
  onBar: number;
  /** Sample spacing, m */
  step: number;
}

/**
 * Probe a crater with rays along −normal on a square grid around `center` (a point on the
 * original face), measuring depth below the face, and holes through the member.
 */
export function measureCrater(target: import('../Destructible.ts').Destructible, center: THREE.Vector3, normal: THREE.Vector3, radius = 0.35, step = 0.01, thickness = 0.25): CraterMeasure {
  const n = normal.clone().normalize();
  const u = new THREE.Vector3().crossVectors(n, Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
  const w = new THREE.Vector3().crossVectors(n, u);
  const dir = n.clone().negate();
  let area = 0, maxDepth = 0, through = 0, onBar = 0;
  let minU = Infinity, maxU = -Infinity;
  const o = new THREE.Vector3();
  for (let a = -radius; a <= radius + 1e-9; a += step)
    for (let b = -radius; b <= radius + 1e-9; b += step) {
      o.copy(center).addScaledVector(u, a).addScaledVector(w, b).addScaledVector(n, 1);
      const hit = target.raycast(o, dir, 3);
      const depth = hit ? hit.distance - 1 : Infinity;
      if (hit && hit.material.id.startsWith('rebar')) onBar++;
      if (!hit || depth > thickness + 0.01) through++;
      if (depth > 0.005) {
        area += step * step;
        if (a < minU) minU = a;
        if (a > maxU) maxU = a;
      }
      if (hit && depth < thickness + 0.01 && depth > maxDepth) maxDepth = depth;
      if (!hit || depth > thickness + 0.01) maxDepth = Math.max(maxDepth, thickness);
    }
  return { diameter: 2 * Math.sqrt(area / Math.PI), extent: maxU >= minU ? maxU - minU + step : 0, maxDepth, through, onBar, step };
}
