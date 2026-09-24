/**
 * Turkish engineering number formatting for the HUD (TS 1212 / SI brochure conventions): decimal
 * comma, narrow no-break space as the thousands separator, a space between value and unit.
 * Pure functions; `—` for values that are not finite.
 */

const NNBSP = ' ';
const DASH = '—';

/** Fixed-decimal number with a decimal comma and grouped thousands. */
export function num(x: number, digits = 0): string {
  if (!Number.isFinite(x)) return DASH;
  const neg = x < 0 || Object.is(x, -0);
  const s = Math.abs(x).toFixed(digits);
  const [int, frac] = s.split('.') as [string, string | undefined];
  let grouped = int;
  if (int.length > 4) grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
  const out = frac ? `${grouped},${frac}` : grouped;
  return neg && Number(s) !== 0 ? `−${out}` : out;
}

/** Significant-ish formatting: 3 significant figures, never more than `maxDigits` decimals. */
export function sig(x: number, maxDigits = 2): string {
  if (!Number.isFinite(x)) return DASH;
  const a = Math.abs(x);
  const d = a >= 100 ? 0 : a >= 10 ? Math.min(1, maxDigits) : Math.min(2, maxDigits);
  return num(x, d);
}

export function fmtLength(m: number): string {
  if (!Number.isFinite(m)) return DASH;
  const a = Math.abs(m);
  if (a < 0.01) return `${num(m * 1000, 1)} mm`;
  if (a < 1) return `${num(m * 1000, 0)} mm`;
  if (a < 1000) return `${num(m, 2)} m`;
  return `${num(m / 1000, 2)} km`;
}

export function fmtDistance(m: number): string {
  if (!Number.isFinite(m)) return DASH;
  if (m < 10) return `${num(m, 1)} m`;
  if (m < 1000) return `${num(m, 0)} m`;
  return `${num(m / 1000, 2)} km`;
}

export function fmtSpeed(v: number): string {
  return Number.isFinite(v) ? `${num(v, 0)} m/s` : DASH;
}

export function fmtEnergy(j: number): string {
  if (!Number.isFinite(j)) return DASH;
  const a = Math.abs(j);
  if (a >= 1e9) return `${sig(j / 1e9)} GJ`;
  if (a >= 1e6) return `${sig(j / 1e6)} MJ`;
  if (a >= 1e3) return `${sig(j / 1e3)} kJ`;
  return `${num(j, 0)} J`;
}

export function fmtMass(kg: number): string {
  if (!Number.isFinite(kg)) return DASH;
  if (kg < 1) return `${sig(kg * 1000)} g`;
  return `${sig(kg)} kg`;
}

export function fmtPressure(pa: number): string {
  if (!Number.isFinite(pa)) return DASH;
  const a = Math.abs(pa);
  if (a >= 1e6) return `${sig(pa / 1e6)} MPa`;
  if (a >= 1e3) return `${sig(pa / 1e3, 1)} kPa`;
  return `${num(pa, 0)} Pa`;
}

export function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return DASH;
  if (Math.abs(s) < 1) return `${num(s * 1000, 0)} ms`;
  return `${num(s, 2)} s`;
}

/** Radians → whole degrees */
export function fmtDeg(rad: number): string {
  return Number.isFinite(rad) ? `${num((rad * 180) / Math.PI, 0)}°` : DASH;
}

export function fmtScale(scale: number): string {
  return `×${num(scale, 2)}`;
}

export function fmtRpm(rpm: number): string {
  return `${num(rpm, 0)} atım/dk`;
}

/** Sound pressure level */
export function fmtDb(db: number): string {
  return Number.isFinite(db) ? `${num(db, 0)} dB` : DASH;
}
