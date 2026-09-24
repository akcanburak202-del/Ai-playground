import { ATM, SPEED_OF_SOUND, clamp } from '../core/units.ts';

/**
 * Outdoor acoustics used by the audio system: propagation delay, spreading, air absorption, the
 * ballistic shock wave of a supersonic projectile, Doppler shift and the loudness mapping from
 * physical sound pressure levels to what a speaker can play. Pure functions, SI units, no DOM.
 */

/** Reference pressure for sound pressure level, Pa (20 µPa). */
export const P_REF = 20e-6;

/** Sound pressure level of a peak pressure, dB re 20 µPa. */
export function splFromPressure(pa: number): number {
  return 20 * Math.log10(Math.max(pa, 1e-9) / P_REF);
}

export function pressureFromSpl(db: number): number {
  return P_REF * 10 ** (db / 20);
}

/**
 * Geometric spreading of a point source: L(r) = L(1 m) − 20·log10(r / 1 m) (inverse-square law).
 * Closer than 1 m the source is not a point any more, so the level is held at the 1 m value.
 */
export function spreadingDb(r: number): number {
  return -20 * Math.log10(Math.max(1, r));
}

/**
 * Atmospheric absorption above ~1 kHz grows with f²: α(f) ≈ 1.2·10⁻⁹ f² dB/m, a fit to ISO 9613-1
 * / ISO 9613-2 Table 2 at 20 °C and 70 % RH (22.9 dB/km at 4 kHz, 76.6 dB/km at 8 kHz).
 */
export const AIR_ABSORPTION_K = 1.2e-9;

/** Atmospheric absorption at frequency f after distance r, dB (ISO 9613-1 fit above). */
export function airAbsorptionDb(f: number, r: number): number {
  return AIR_ABSORPTION_K * f * f * Math.max(0, r);
}

/**
 * Corner frequency of the low-pass that stands in for air absorption: the frequency whose
 * absorption over r reaches 3 dB, f_c = √(3 / (k·r)). 10 m → 16 kHz, 100 m → 5 kHz, 1 km → 1.6 kHz.
 */
export function airAbsorptionCutoff(r: number): number {
  const f = Math.sqrt(3 / (AIR_ABSORPTION_K * Math.max(r, 1)));
  return clamp(f, 250, 20000);
}

/** Propagation delay of sound over r metres, s (c = 343 m/s at 20 °C). */
export function propagationDelay(r: number): number {
  return Math.max(0, r) / SPEED_OF_SOUND;
}

/**
 * Ballistic shock wave (the "crack") of a supersonic projectile passing a listener at miss
 * distance r: peak overpressure and N-wave duration from Whitham's far-field theory
 * (G. B. Whitham, "The flow pattern of a supersonic projectile", Comm. Pure Appl. Math. 5, 1952;
 * in the form used by R. C. Maher, "Acoustical characterization of gunshots", IEEE SAFE 2007):
 *   Δp = 0.53 · p₀ · (M² − 1)^⅛ · d / (r^¾ · l^¼)
 *   T  = 1.82 · M · r^¼ · d / (c · (M² − 1)^⅜ · l^¼)
 * d = projectile diameter, l = projectile length. Returns 0 below Mach 1.02 (no shock).
 */
export function ballisticShock(mach: number, diameter: number, length: number, missDistance: number): { peakPa: number; duration: number } {
  if (!(mach > 1.02) || !(diameter > 0) || !(length > 0)) return { peakPa: 0, duration: 0 };
  const r = Math.max(missDistance, 0.1);
  const m2 = mach * mach - 1;
  const l4 = Math.pow(length, 0.25);
  const peakPa = (0.53 * ATM * Math.pow(m2, 0.125) * diameter) / (Math.pow(r, 0.75) * l4);
  const duration = (1.82 * mach * Math.pow(r, 0.25) * diameter) / (SPEED_OF_SOUND * Math.pow(m2, 0.375) * l4);
  return { peakPa, duration };
}

/**
 * When the Mach cone reaches a listener at perpendicular miss distance d, measured from the
 * moment the projectile passes the point of closest approach: T = (d / c) · √(1 − 1/M²).
 * (First arrival on the envelope of the spherical wavelets emitted along a straight track.)
 */
export function shockArrivalAfterPassing(missDistance: number, mach: number): number {
  if (!(mach > 1)) return missDistance / SPEED_OF_SOUND;
  return (missDistance / SPEED_OF_SOUND) * Math.sqrt(1 - 1 / (mach * mach));
}

/**
 * Doppler factor for a moving source and a still listener: f' = f · c / (c − v_r), with v_r the
 * source speed towards the listener. Clamped to ±0.8 c: at and beyond Mach 1 the source outruns
 * its own sound and the formula breaks down (the listener hears the shock instead).
 */
export function dopplerFactor(radialSpeedTowardsListener: number): number {
  const c = SPEED_OF_SOUND;
  const v = clamp(radialSpeedTowardsListener, -0.8 * c, 0.8 * c);
  return c / (c - v);
}

/**
 * Speakers cannot play 190 dB. Received levels are mapped onto playable gain with a fixed
 * compression slope so that relative loudness survives: a rifle at the shooter's ear
 * (≈ 160 dB peak) lands around −8 dBFS, a distant bullet impact (≈ 90 dB) near −37 dBFS,
 * and anything above ≈ 180 dB is held by the master limiter.
 */
export const LOUDNESS = { refSpl: 160, refDbfs: -8, slope: 0.42, maxGain: 3 };

export function splToGain(spl: number): number {
  if (!Number.isFinite(spl)) return 0;
  const dbfs = LOUDNESS.refDbfs + LOUDNESS.slope * (spl - LOUDNESS.refSpl);
  return Math.min(LOUDNESS.maxGain, 10 ** (dbfs / 20));
}

/**
 * Received level of a source with level L1 at 1 m heard at distance r: inverse-square spreading
 * plus the broadband part of air absorption (evaluated at 1 kHz; the high-frequency part is the
 * low-pass above).
 */
export function receivedSpl(levelAt1m: number, r: number): number {
  return levelAt1m + spreadingDb(r) - airAbsorptionDb(1000, r);
}

/**
 * Closest approach of a straight segment a→b to point p. Writes into `out`: s ∈ [0, 1] along the
 * segment and the miss distance. Allocation-free (called for every flying round each frame).
 */
export function closestApproach(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  px: number, py: number, pz: number, out: { s: number; distance: number },
): { s: number; distance: number } {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let s = len2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2 : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  const cx = ax + dx * s - px, cy = ay + dy * s - py, cz = az + dz * s - pz;
  out.s = s;
  out.distance = Math.sqrt(cx * cx + cy * cy + cz * cz);
  return out;
}

/**
 * Muzzle blast scaling. Blast waves from charges of energy E scale with the cube root of E
 * (Hopkinson–Cranz scaling, e.g. Baker, "Explosions in Air", 1973): durations grow and the
 * characteristic frequency falls as E^⅓. Referenced to a 5.56 mm rifle (≈ 1.6 kJ muzzle energy),
 * whose report is centred around 1 kHz with a ≈ 12 ms body.
 */
export function blastScale(energyJ: number, refJ = 1600): number {
  return Math.cbrt(Math.max(energyJ, 1) / refJ);
}

/**
 * Peak level of a muzzle report at 1 m from the energy of the round, dB SPL. Measured
 * free-field peaks: 5.56 mm ≈ 160 dB, 7.62 mm ≈ 163 dB, .50 BMG ≈ 170 dB, large-calibre guns
 * 180–190 dB (e.g. Rasmussen et al., "Muzzle blast from small arms", JASA 2009; MIL-STD-1474E).
 * Fitted as L1 = 128 + 10·log10(E / 1 J), capped at 190 dB.
 */
export function muzzleLevelAt1m(energyJ: number): number {
  return Math.min(190, 128 + 10 * Math.log10(Math.max(energyJ, 1)));
}

/**
 * Peak level at 1 m of a projectile striking a target, from the energy it dissipates there:
 * L1 ≈ 95 + 10·log10(E / 1 J) dB (a 1.6 kJ rifle round on concrete ≈ 127 dB at 1 m; a 6.9 MJ
 * tank round ≈ 163 dB). An engineering fit to steel-target and impact-noise measurements, not a
 * first-principles radiation model.
 */
export function impactLevelAt1m(energyJ: number): number {
  return 95 + 10 * Math.log10(Math.max(energyJ, 1));
}

/**
 * Eardrum-rupture threshold ≈ 34.5 kPa (5 psi) and window-breakage onset ≈ 1 kPa of incident
 * overpressure (Glasstone & Dolan, "The Effects of Nuclear Weapons", 1977, Table 12.38; UFC 3-340-02).
 */
export const EARDRUM_THRESHOLD_PA = 34_500;
export const WINDOW_BREAK_PA = 1_000;
