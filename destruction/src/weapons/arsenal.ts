import type { WeaponSpec } from '../app/contracts.ts';

/** Weapon table. PLACEHOLDER — the ballistics/weapons module replaces it with the full arsenal. */
export const WEAPONS: WeaponSpec[] = [
  {
    id: 'm4a1', name: 'M4A1', role: 'Carbine, 5.56 mm', category: 'rifle', ammo: ['m855'],
    rpm: 800, fireMode: 'auto', dispersionMOA: 3, tracerEvery: 5, delivery: 'direct', recoil: 0.12,
    sound: 'rifle', zoom: 1.6, muzzleOffset: [0.18, -0.16, 0.5],
  },
];

export function getWeapon(id: string): WeaponSpec {
  const w = WEAPONS.find((x) => x.id === id);
  if (!w) throw new Error(`Unknown weapon "${id}"`);
  return w;
}
