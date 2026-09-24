import type { WeaponSpec } from '../app/contracts.ts';

/**
 * The arsenal. Rates of fire, sights and dispersion are published figures (FM 3-22.x series,
 * TM 9-1005/1010 series, manufacturer data). `WeaponData` adds what the weapon controller needs
 * beyond the shared `WeaponSpec`.
 *
 * Dispersion is the per-axis standard deviation of the shot direction in MOA (1 MOA = 0.291 mrad),
 * representing the system in its usual firing condition (shoulder, bipod, tripod, mount).
 */
export interface WeaponData extends WeaponSpec {
  /** Real reload / cycling time for single-shot weapons, s (the controller shortens it for play) */
  reloadTime?: number;
  /** Barrel spin-up before the first round (rotary guns), s */
  spinUp?: number;
  /** Mixed belt: every `every`-th round is `ammo` when firing the default ammunition (GAU-8 combat mix) */
  mix?: { every: number; ammo: string };
  /** Indirect fire geometry: impact speed (m/s), descent angle below horizontal (deg), spawn height above target (m) */
  indirect?: { impactSpeed: number; descentDeg: number; height: number; maxTime: number; errorM: number };
  /** Placed charges: maximum reach from the viewer, m */
  placeRange?: number;
  /** Real-world note shown in the HUD */
  note: string;
}

/** Reload times are real; the controller multiplies them by this for play (documented in PHYSICS.md). */
export const PLAY_RELOAD_SCALE = 0.4;

export const WEAPONS: WeaponData[] = [
  {
    id: 'm4a1', name: 'M4A1', role: 'US carbine, 5.56 mm', category: 'rifle', ammo: ['m855', 'm995'],
    rpm: 800, fireMode: 'auto', dispersionMOA: 1.5, tracerEvery: 5, delivery: 'direct', recoil: 0.12,
    sound: 'rifle', zoom: 3, muzzleOffset: [0.16, -0.14, 0.45],
    note: '14.5 in barrel, 700–950 rpm cyclic, M856 tracer every 5th round in a 4:1 mix',
  },
  {
    id: 'm249', name: 'M249 SAW', role: 'US squad automatic weapon, 5.56 mm', category: 'mg', ammo: ['m855', 'm995'],
    rpm: 850, fireMode: 'auto', dispersionMOA: 4, tracerEvery: 5, delivery: 'direct', recoil: 0.1,
    sound: 'mg-light', zoom: 1.5, muzzleOffset: [0.2, -0.2, 0.5],
    note: 'Open-bolt belt-fed LMG, 750–1 000 rpm cyclic, 4:1 ball/tracer belts',
  },
  {
    id: 'm240b', name: 'M240B', role: 'US medium machine gun, 7.62 mm', category: 'mg', ammo: ['m80', 'm993'],
    rpm: 750, fireMode: 'auto', dispersionMOA: 3.5, tracerEvery: 5, delivery: 'direct', recoil: 0.18,
    sound: 'mg-medium', zoom: 1.5, muzzleOffset: [0.2, -0.22, 0.55],
    note: 'FN MAG derivative, 650–950 rpm, 4:1 M80/M62 belts',
  },
  {
    id: 'pkm', name: 'PKM', role: 'Soviet general-purpose machine gun, 7.62×54R', category: 'mg', ammo: ['lps'],
    rpm: 650, fireMode: 'auto', dispersionMOA: 4, tracerEvery: 4, delivery: 'direct', recoil: 0.18,
    sound: 'mg-medium', zoom: 1.5, muzzleOffset: [0.2, -0.22, 0.55],
    note: 'Kalashnikov GPMG, 650 rpm, T-46 tracer every 4th round in mixed belts',
  },
  {
    id: 'm2hb', name: 'M2HB', role: 'US heavy machine gun, .50 BMG (tripod)', category: 'mg', ammo: ['m33', 'm2ap', 'm8api', 'mk211', 'm903'],
    rpm: 550, fireMode: 'auto', dispersionMOA: 2.5, tracerEvery: 5, delivery: 'direct', recoil: 0.3,
    sound: 'hmg', zoom: 2, muzzleOffset: [0.0, -0.25, 0.9],
    note: '"Ma Deuce", 450–635 rpm, 4:1 AP/tracer belts; M903 SLAP with the saboted-ammunition kit',
  },
  {
    id: 'm107', name: 'Barrett M107', role: 'Anti-materiel rifle, .50 BMG', category: 'sniper', ammo: ['mk211', 'm33', 'm2ap', 'm8api'],
    rpm: 90, fireMode: 'semi', dispersionMOA: 0.7, tracerEvery: 0, delivery: 'direct', recoil: 0.6,
    sound: 'amr', zoom: 10, muzzleOffset: [0.14, -0.1, 0.8],
    note: 'Semi-automatic, recoil-operated; 10-round magazine; Leupold 4.5–14× scope',
  },
  {
    id: 'm134', name: 'M134 Minigun', role: 'Rotary machine gun, 7.62 mm (mount)', category: 'mg', ammo: ['m80'],
    rpm: 3000, fireMode: 'auto', dispersionMOA: 6, tracerEvery: 5, delivery: 'direct', recoil: 0.25,
    sound: 'minigun', zoom: 1.5, muzzleOffset: [0.25, -0.35, 0.8], spinUp: 0.35,
    note: 'Six-barrel electric Gatling, 2 000–6 000 rpm selectable (3 000 here), ~0.35 s spin-up',
  },
  {
    id: 'gau8', name: 'GAU-8/A Avenger', role: 'A-10 30 mm rotary cannon (aircraft gun)', category: 'cannon', ammo: ['pgu14', 'pgu13'],
    rpm: 3900, fireMode: 'auto', dispersionMOA: 9.6, tracerEvery: 0, delivery: 'direct', recoil: 0.5,
    sound: 'gau8', zoom: 2, muzzleOffset: [0.0, -1.2, 2.0], spinUp: 0.5, mix: { every: 5, ammo: 'pgu13' },
    note: '7-barrel, 3 900 rpm; combat mix 4 API : 1 HEI; 80 % of rounds within 12 m at 1 220 m',
  },
  {
    id: 'm320', name: 'M320', role: '40 mm grenade launcher', category: 'launcher', ammo: ['m433'],
    rpm: 6, fireMode: 'single', dispersionMOA: 8, tracerEvery: 0, delivery: 'direct', recoil: 0.35,
    sound: 'gl', zoom: 1.3, muzzleOffset: [0.16, -0.2, 0.45], reloadTime: 4,
    note: 'Single-shot break-action, 76 m/s: the grenade arcs visibly; 5–7 aimed rounds/min',
  },
  {
    id: 'rpg7', name: 'RPG-7V2', role: 'Shoulder-fired rocket launcher', category: 'launcher', ammo: ['pg7vl', 'tbg7v', 'og7v'],
    rpm: 4, fireMode: 'single', dispersionMOA: 3, tracerEvery: 0, delivery: 'direct', recoil: 0.3,
    sound: 'rpg', zoom: 2.7, muzzleOffset: [0.12, -0.05, 0.6], reloadTime: 6,
    note: 'Booster 115 m/s, sustainer lights ~11 m out → ~295 m/s; PGO-7 2.7× sight; ~6 s reload',
  },
  {
    id: 'carlgustaf', name: 'Carl Gustaf M4', role: '84 mm recoilless rifle', category: 'launcher', ammo: ['ffv751', 'ffv441', 'asm509'],
    rpm: 6, fireMode: 'single', dispersionMOA: 2, tracerEvery: 0, delivery: 'direct', recoil: 0.35,
    sound: 'recoilless', zoom: 3, muzzleOffset: [0.12, -0.05, 0.6], reloadTime: 4,
    note: 'Rifled recoilless, 6.6 kg (M4); two-man team reload ~4 s',
  },
  {
    id: 'javelin', name: 'FGM-148 Javelin', role: 'Fire-and-forget ATGM (top attack)', category: 'launcher', ammo: ['javelin'],
    rpm: 2, fireMode: 'single', dispersionMOA: 0, tracerEvery: 0, delivery: 'direct', recoil: 0.2,
    sound: 'atgm', zoom: 4, muzzleOffset: [0.15, -0.05, 0.6], reloadTime: 20,
    note: 'Soft launch, flight motor ignites clear of the gunner; lofts and dives onto the target top',
  },
  {
    id: 'tankgun', name: '120 mm tank gun', role: 'M256 smoothbore (Abrams) / L30A1 rifled (Challenger 2)', category: 'cannon', ammo: ['m829a4', 'm830a1', 'm908', 'l31a7'],
    rpm: 8, fireMode: 'single', dispersionMOA: 1, tracerEvery: 0, delivery: 'direct', recoil: 1,
    sound: 'tank', zoom: 10, muzzleOffset: [0.0, -1.2, 3.0], reloadTime: 6,
    note: 'Human loader ~6 s between rounds; L31A7 HESH only fits the rifled L30A1',
  },
  {
    id: 'm777', name: 'M777 howitzer', role: '155 mm towed howitzer (indirect fire)', category: 'artillery', ammo: ['m795'],
    rpm: 2, fireMode: 'single', dispersionMOA: 0, tracerEvery: 0, delivery: 'indirect', recoil: 0,
    sound: 'artillery', zoom: 1, muzzleOffset: [0, 0, 0], reloadTime: 12,
    indirect: { impactSpeed: 340, descentDeg: 60, height: 500, maxTime: 3, errorM: 3 },
    note: 'Sustained 2 rds/min (max 4–5); shell descends at ~60° and 300–400 m/s',
  },
  {
    id: 'airstrike', name: 'JDAM air strike', role: 'GPS-guided bombs from an F-15E / F-16', category: 'airstrike', ammo: ['gbu38', 'gbu31'],
    rpm: 1, fireMode: 'single', dispersionMOA: 0, tracerEvery: 0, delivery: 'indirect', recoil: 0,
    sound: 'bomb', zoom: 1, muzzleOffset: [0, 0, 0], reloadTime: 30,
    indirect: { impactSpeed: 285, descentDeg: 75, height: 300, maxTime: 3, errorM: 1.5 },
    note: 'Released ~3 km up; arrives near terminal velocity (~280 m/s) at 70–80°; CEP ≈ 5 m',
  },
  {
    id: 'demo', name: 'Demolition charges', role: 'C4 blocks and linear cutting charge + detonator', category: 'demolition', ammo: ['c4', 'lsc'],
    rpm: 60, fireMode: 'single', dispersionMOA: 0, tracerEvery: 0, delivery: 'placed', recoil: 0,
    sound: 'demo', zoom: 1, muzzleOffset: [0, 0, 0], reloadTime: 1, placeRange: 80,
    note: 'Place charges on surfaces (≤ 80 m for play), then fire them with the detonator in sequence',
  },
];

export function getWeapon(id: string): WeaponData {
  const w = WEAPONS.find((x) => x.id === id);
  if (!w) throw new Error(`Unknown weapon "${id}"`);
  return w;
}
