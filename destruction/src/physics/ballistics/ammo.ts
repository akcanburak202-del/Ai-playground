import type { AmmoSpec } from './types.ts';

/**
 * Ammunition database. PLACEHOLDER — the ballistics module replaces this with the full, sourced
 * table. Keep the export names (`AMMO`, `getAmmo`).
 */
export const AMMO: Record<string, AmmoSpec> = {
  m855: {
    id: 'm855', name: 'M855 ball', caliber: '5.56×45 mm NATO', kind: 'ball',
    mass: 0.00402, diameter: 0.0057, length: 0.0231, muzzleVelocity: 910, dragCd: 0.3,
    coreDensity: 11340, coreMass: 0.00072, noseFactor: 1.14, deformable: true, fuze: 'none',
    note: '62 gr, lead core with a 7-gr hardened steel penetrator tip',
  },
  m829a4: {
    id: 'm829a4', name: 'M829A4 APFSDS-T', caliber: '120 mm smoothbore', kind: 'apfsds',
    mass: 4.6, diameter: 0.025, length: 0.8, muzzleVelocity: 1555, dragCd: 0.9,
    coreDensity: 18600, noseFactor: 1.14, deformable: false, fuze: 'none', tracer: true,
    note: 'Depleted-uranium long-rod penetrator, L/D ≈ 30',
  },
};

export function getAmmo(id: string): AmmoSpec {
  const a = AMMO[id];
  if (!a) throw new Error(`Unknown ammunition "${id}"`);
  return a;
}
