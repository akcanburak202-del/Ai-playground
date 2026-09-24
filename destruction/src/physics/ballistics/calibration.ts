import * as THREE from 'three';
import { Rng } from '../../core/rng.ts';
import { MATERIALS, type MaterialProps } from '../materials.ts';
import type { RayHit, Destructible } from '../../destructibles/Destructible.ts';
import { getAmmo } from './ammo.ts';
import { speedAtRange } from './flight.ts';
import { resolveImpact, type ResolvedImpact } from './penetration.ts';
import { blastAt, piDamage, KB } from './blast.ts';
import type { AmmoSpec, ProjectileState, ThicknessProbe } from './types.ts';

/**
 * The DESIGN.md §3 calibration cases evaluated with the real models. Shared by the unit tests and
 * by the PHYSICS.md table generator (`node .tmp/calib.ts`), so the documented numbers are the
 * numbers the code produces.
 */

const STUB = { id: -1, kind: 'voxel', name: 'calibration block' } as unknown as Destructible;

/** Square-on hit on a slab of `thickness` metres of one material (exits = air behind). */
export function slabHit(ammoId: string | AmmoSpec, speed: number, material: MaterialProps, thickness: number, obliquityDeg = 0, rngSeed = 7, strength = 1): ResolvedImpact {
  const ammo = typeof ammoId === 'string' ? getAmmo(ammoId) : ammoId;
  const th = THREE.MathUtils.degToRad(obliquityDeg);
  const dir = new THREE.Vector3(0, -Math.sin(th), -Math.cos(th));
  const p: ProjectileState = { ammo, position: new THREE.Vector3(0, 0, 0.01), velocity: dir.clone().multiplyScalar(speed), mass: ammo.mass, length: ammo.length, perforations: 0 };
  const hit: RayHit = { target: STUB, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1), distance: 0.01, material };
  const los = thickness / Math.max(Math.cos(th), 1e-3);
  const probe: ThicknessProbe = { segments: [{ material, start: 0, end: los, strength }], exits: true };
  return resolveImpact(p, hit, probe, new Rng(rngSeed));
}

/** Thickest plate (normal thickness) the round perforates, m (bisection on the full resolver). */
export function perforationLimit(ammoId: string, speed: number, material: MaterialProps, obliquityDeg = 0, hi = 2): number {
  let lo = 0;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    const ev = slabHit(ammoId, speed, material, mid, obliquityDeg);
    if (ev.outcome === 'perforate') lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface CalibrationRow {
  case: string;
  expected: string;
  lo: number;
  hi: number;
  value: number;
  unit: string;
  pass: boolean;
  note: string;
}

function row(c: string, expected: string, lo: number, hi: number, value: number, unit: string, note = ''): CalibrationRow {
  return { case: c, expected, lo, hi, value, unit, pass: value >= lo && value <= hi, note };
}

/** Evaluate every calibration case (fast: < 50 ms). */
export function calibrationRows(): CalibrationRow[] {
  const C40 = MATERIALS.concrete;
  const rows: CalibrationRow[] = [];
  const thick = 2.0;

  const m855 = slabHit('m855', 900, C40, thick);
  rows.push(row('5.56 M855 @ 900 m/s → C40, depth', '15–40 mm', 15, 40, m855.depth * 1000, 'mm', m855.summary));
  rows.push(row('5.56 M855 @ 900 m/s → C40, crater Ø', '40–90 mm', 40, 90, 2 * m855.craterRadius * 1000, 'mm'));
  const m80 = slabHit('m80', 830, C40, thick);
  rows.push(row('7.62 M80 @ 830 m/s → C40, depth', '25–60 mm', 25, 60, m80.depth * 1000, 'mm', m80.summary));
  const m2c = slabHit('m2ap', 880, C40, thick);
  rows.push(row('.50 M2 AP @ 880 m/s → C40, depth', '100–200 mm', 100, 200, m2c.depth * 1000, 'mm', m2c.summary));

  const s355 = MATERIALS.steel_s355;
  const p6 = slabHit('m855', 900, s355, 0.006);
  const p10 = slabHit('m855', 900, s355, 0.010);
  rows.push(row('M855 @ 900 m/s vs S355 6 mm perforates', 'perforate', 1, 1, p6.outcome === 'perforate' ? 1 : 0, 'bool', p6.summary));
  rows.push(row('M855 @ 900 m/s vs S355 10 mm stopped', 'stopped', 1, 1, p10.outcome !== 'perforate' ? 1 : 0, 'bool', p10.summary));
  rows.push(row('M855 @ 900 m/s vs S355, perforation limit', '6–10 mm', 6, 10, perforationLimit('m855', 900, s355) * 1000, 'mm'));

  const rha = MATERIALS.rha;
  const v993 = speedAtRange(getAmmo('m993'), 100);
  rows.push(row('7.62 M993 AP vs RHA @ 100 m', '8–15 mm ±30 %', 8 * 0.7, 15 * 1.3, perforationLimit('m993', v993, rha) * 1000, 'mm', `${v993.toFixed(0)} m/s at 100 m`));
  const v2 = speedAtRange(getAmmo('m2ap'), 100);
  rows.push(row('.50 M2 AP vs RHA @ 100 m', '20–25 mm ±25 %', 20 * 0.75, 25 * 1.25, perforationLimit('m2ap', v2, rha) * 1000, 'mm', `${v2.toFixed(0)} m/s at 100 m`));
  const v30 = speedAtRange(getAmmo('pgu14'), 500);
  rows.push(row('30 mm PGU-14 API vs RHA @ 500 m', '55–70 mm ±25 %', 55 * 0.75, 70 * 1.25, perforationLimit('pgu14', v30, rha) * 1000, 'mm', `${v30.toFixed(0)} m/s at 500 m`));
  const v120 = speedAtRange(getAmmo('m829a4'), 2000);
  rows.push(row('120 mm M829A4 vs RHA @ 2 km', '650–800 mm ±15 %', 650 * 0.85, 800 * 1.15, perforationLimit('m829a4', v120, rha, 0, 3) * 1000, 'mm', `${v120.toFixed(0)} m/s at 2 km`));

  const pg = slabHit('pg7vl', 120, rha, 3);
  rows.push(row('PG-7VL HEAT vs RHA', '≈500 mm ±15 %', 425, 575, pg.depth * 1000, 'mm', pg.summary));
  const pgc = slabHit('pg7vl', 120, C40, 5);
  rows.push(row('PG-7VL HEAT vs concrete', '1.2–1.8 m ±15 %', 1.2 * 0.85, 1.8 * 1.15, pgc.depth, 'm', pgc.summary));
  const jav = slabHit('javelin', 150, rha, 3);
  rows.push(row('Javelin vs RHA', '750–800 mm ±15 %', 750 * 0.85, 800 * 1.15, jav.depth * 1000, 'mm', jav.summary));

  const free = blastAt(1 / 1.8, 5);
  rows.push(row('1 kg TNT free air, R = 5 m: incident overpressure', '≈29 kPa (Kinney–Graham) ±20 %', 29 * 0.8, 29 * 1.2, free.ps / 1000, 'kPa', 'DESIGN.md lists 70 kPa: that is the reflected value (next row)'));
  rows.push(row('1 kg TNT free air, R = 5 m: normally reflected overpressure', '≈70 kPa ±20 %', 56, 84, free.pr / 1000, 'kPa'));
  rows.push(row('1 kg TNT free air, R = 5 m: arrival time', '8–9 ms ±20 %', 8 * 0.8, 9 * 1.2, free.ta * 1000, 'ms'));
  rows.push(row('1 kg TNT surface burst, R = 5 m: incident overpressure', 'UFC 3-340-02 fig 2-15 ≈ 43 kPa ±20 %', 43 * 0.8, 43 * 1.2, blastAt(1, 5).ps / 1000, 'kPa'));

  rows.push(row('Annealed 6 mm pane 1.5×1 m: failure pressure (long pulse)', '3–7 kPa reflected', 3, 7, windowFailurePressure(MATERIALS.glass_annealed, 0.006) / 1000, 'kPa'));
  rows.push(row('Tempered 6 mm pane: failure pressure (long pulse)', '≈4× annealed (12–28 kPa)', 12, 28, windowFailurePressure(MATERIALS.glass_tempered, 0.006) / 1000, 'kPa'));
  void KB;
  return rows;
}

/** Reflected pressure at which a pane reaches damage 1 under a long (quasi-static) pulse, Pa. */
export function windowFailurePressure(m: MaterialProps, t: number): number {
  let lo = 100, hi = 1e6;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    // Long pulse: impulse = P · 0.1 s (triangular, t_d ≈ 0.2 s)
    if (piDamage(mid, mid * 0.1, m, t) >= 1) hi = mid;
    else lo = mid;
  }
  return hi;
}
