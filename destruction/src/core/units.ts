/** Physical constants and unit helpers. The simulation is SI throughout: m, kg, s, N, Pa, J. */

export const G = 9.80665; // m/s²
export const AIR_DENSITY = 1.225; // kg/m³ at sea level, 15 °C
export const SPEED_OF_SOUND = 343; // m/s at 20 °C
export const ATM = 101_325; // Pa
export const TNT_ENERGY = 4.184e6; // J/kg

export const mm = (v: number) => v / 1000;
export const cm = (v: number) => v / 100;
export const inch = (v: number) => v * 0.0254;
export const grain = (v: number) => v * 6.479891e-5; // kg
export const MPa = (v: number) => v * 1e6;
export const GPa = (v: number) => v * 1e9;
export const kJ = (v: number) => v * 1e3;
export const MJ = (v: number) => v * 1e6;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Human-readable formatting used by the HUD and logs. */
export function fmtLength(m: number): string {
  const a = Math.abs(m);
  if (a < 0.01) return `${(m * 1000).toFixed(1)} mm`;
  if (a < 1) return `${(m * 1000).toFixed(0)} mm`;
  return `${m.toFixed(2)} m`;
}
export function fmtEnergy(j: number): string {
  const a = Math.abs(j);
  if (a >= 1e6) return `${(j / 1e6).toFixed(2)} MJ`;
  if (a >= 1e3) return `${(j / 1e3).toFixed(1)} kJ`;
  return `${j.toFixed(0)} J`;
}
export function fmtPressure(pa: number): string {
  const a = Math.abs(pa);
  if (a >= 1e6) return `${(pa / 1e6).toFixed(1)} MPa`;
  return `${(pa / 1e3).toFixed(1)} kPa`;
}
