import type { WeaponSpec } from '../app/contracts.ts';
import type { AmmoSpec } from '../physics/ballistics/types.ts';
import { clamp } from '../core/units.ts';
import { blastScale, muzzleLevelAt1m } from './acoustics.ts';

/**
 * What a weapon's report is made of. Gun reports are built from the round's muzzle energy with
 * Hopkinson–Cranz cube-root scaling (bigger charge → longer, lower blast); launchers, which throw
 * heavy projectiles slowly from low-pressure tubes, get their measured character instead
 * (recoilless back-blast, rocket booster, soft-launch missile).
 */
export interface ReportProfile {
  /** Peak level at 1 m, dB SPL */
  levelAt1m: number;
  /** Centre of the muzzle-blast noise body, Hz */
  fBody: number;
  /** Body amplitude time constant, s */
  tauBody: number;
  /** Low "thump" sine sweep */
  thump: { f0: number; f1: number; tau: number; gain: number };
  /** Relative level of the sharp onset (shock front + bullet crack at the gun), 0..1 */
  crack: number;
  crackHp: number;
  /** Mechanism noise after the shot */
  mech: 'bolt' | 'belt' | 'breech' | 'break' | 'none';
  /** Rolling low boom after big guns, 0..1 */
  tail: number;
  /** Launcher back-blast hiss, 0..1 */
  backblast: number;
  /** Rotary gun: continuous tone at the firing rate */
  rotary: { rpm: number; bodyTau: number; lowpass: number } | null;
  /** The gun is far away (indirect fire): only a faint distant thud reaches the viewer */
  distant: boolean;
  /** Air strike: a jet passes overhead */
  jet: boolean;
}

/** Muzzle energy ½ m v², J. */
export function muzzleEnergy(ammo: AmmoSpec): number {
  return 0.5 * ammo.mass * ammo.muzzleVelocity * ammo.muzzleVelocity;
}

function gunProfile(E: number, mech: ReportProfile['mech']): ReportProfile {
  // Reference: 5.56 mm (1.6 kJ) → body ≈ 1 kHz, τ ≈ 12 ms; thump 180 → 70 Hz.
  const s = clamp(blastScale(E), 0.5, 16);
  return {
    levelAt1m: muzzleLevelAt1m(E),
    fBody: clamp(1000 / s, 45, 2400),
    tauBody: 0.012 * s,
    thump: { f0: clamp(190 / Math.sqrt(s), 35, 260), f1: clamp(70 / Math.sqrt(s), 18, 90), tau: 0.022 * s ** 0.8, gain: clamp(0.45 + 0.12 * s, 0.4, 1) },
    crack: 0.9,
    crackHp: clamp(2600 / Math.sqrt(s), 600, 3200),
    mech,
    tail: clamp((s - 1.5) / 8, 0, 1),
    backblast: 0,
    rotary: null,
    distant: false,
    jet: false,
  };
}

export function reportProfile(weapon: WeaponSpec, ammo: AmmoSpec): ReportProfile {
  const E = muzzleEnergy(ammo);
  switch (weapon.sound) {
    case 'rifle':
      return gunProfile(E, 'bolt');
    case 'mg-light':
    case 'mg-medium':
      return gunProfile(E, 'belt');
    case 'hmg':
      return { ...gunProfile(E, 'belt'), tail: 0.25 };
    case 'amr': {
      // Muzzle brakes throw the blast sideways and back: a notably harsher report at the shooter.
      const p = gunProfile(E, 'bolt');
      return { ...p, levelAt1m: Math.min(190, p.levelAt1m + 3), crack: 1, tail: 0.3 };
    }
    case 'minigun':
      return { ...gunProfile(E, 'none'), rotary: { rpm: weapon.rpm, bodyTau: 0.004, lowpass: 3800 } };
    case 'gau8':
      return { ...gunProfile(E, 'none'), rotary: { rpm: weapon.rpm, bodyTau: 0.007, lowpass: 1600 }, tail: 0.7 };
    case 'gl':
      // High–low pressure launcher: a soft low "thoonk", subsonic, no crack.
      return { ...gunProfile(E, 'break'), levelAt1m: 150, fBody: 320, tauBody: 0.014, thump: { f0: 140, f1: 60, tau: 0.03, gain: 0.8 }, crack: 0.12, crackHp: 1800, tail: 0 };
    case 'rpg':
      return { ...gunProfile(E, 'none'), levelAt1m: 172, fBody: 380, tauBody: 0.04, thump: { f0: 95, f1: 38, tau: 0.06, gain: 0.8 }, crack: 0.45, crackHp: 1500, tail: 0.3, backblast: 0.9 };
    case 'recoilless':
      // Recoilless rifles are among the loudest shoulder weapons (≈ 180+ dB at the gunner).
      return { ...gunProfile(E, 'breech'), levelAt1m: 182, fBody: 240, tauBody: 0.05, thump: { f0: 75, f1: 30, tau: 0.09, gain: 1 }, crack: 1, crackHp: 1300, tail: 0.55, backblast: 1 };
    case 'atgm':
      // Soft launch: the eject motor pops the missile out; the flight motor lights metres away.
      return { ...gunProfile(E, 'none'), levelAt1m: 146, fBody: 420, tauBody: 0.02, thump: { f0: 110, f1: 60, tau: 0.025, gain: 0.45 }, crack: 0.1, crackHp: 2000, tail: 0, backblast: 0.25 };
    case 'tank':
      return { ...gunProfile(E, 'breech'), crack: 1, tail: 0.9 };
    case 'artillery':
      return { ...gunProfile(E, 'none'), distant: true };
    case 'bomb':
      return { ...gunProfile(E, 'none'), distant: true, jet: true };
    default:
      break;
  }
  switch (weapon.category) {
    case 'rifle':
    case 'sniper':
      return gunProfile(E, 'bolt');
    case 'mg':
      return gunProfile(E, 'belt');
    case 'cannon':
      return gunProfile(E, 'breech');
    case 'artillery':
    case 'airstrike':
      return { ...gunProfile(E, 'none'), distant: true, jet: weapon.category === 'airstrike' };
    default:
      return gunProfile(E, 'none');
  }
}
