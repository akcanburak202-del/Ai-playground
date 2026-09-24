/**
 * CPU port of the analytic daylight model used by three's `Sky` shader (Preetham, Shirley & Smits,
 * "A Practical Analytic Model for Daylight", SIGGRAPH 1999, in the form of the three.js shader) so
 * the sun light, the sky fill and the haze colour are derived from the same sky the viewer sees
 * instead of being tuned separately. Pure math: safe to import under Node.
 *
 * Radiance values are in the shader's own units (before `skyScale`); only ratios matter here.
 */

export type RGB = [number, number, number];

export interface SkyParams {
  /** Atmospheric turbidity (2 = very clear, 10 = hazy) */
  turbidity: number;
  /** Rayleigh coefficient multiplier */
  rayleigh: number;
  mieCoefficient: number;
  /** Henyey–Greenstein asymmetry of the Mie lobe */
  mieDirectionalG: number;
}

/** Golden-hour defaults: a little haze (warm glow around the sun), moderate Rayleigh (blue zenith). */
export const GOLDEN_HOUR_SKY: SkyParams = { turbidity: 2.6, rayleigh: 2.4, mieCoefficient: 0.0035, mieDirectionalG: 0.8 };

// Constants of the shader (Preetham 1999 appendix, precomputed for λ = 680/550/450 nm).
const TOTAL_RAYLEIGH: RGB = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST: RGB = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000;
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const THREE_OVER_SIXTEENPI = 0.05968310365946075;
const ONE_OVER_FOURPI = 0.07957747154594767;

export interface SkyState {
  sun: [number, number, number];
  sunE: number;
  betaR: RGB;
  betaM: RGB;
  g: number;
}

/** Unit sun direction from elevation / azimuth in degrees (azimuth from +Z towards +X). */
export function sunDirection(elevationDeg: number, azimuthDeg: number): [number, number, number] {
  const e = (elevationDeg * Math.PI) / 180;
  const a = (azimuthDeg * Math.PI) / 180;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}

/** Per-sun quantities (the shader's vertex stage). */
export function skyState(sun: [number, number, number], p: SkyParams): SkyState {
  const cz = Math.max(-1, Math.min(1, sun[1]));
  // Preetham "earth shadow hack": sun intensity falls off as it approaches the horizon.
  const sunE = EE * Math.max(0, 1 - Math.exp(-(CUTOFF_ANGLE - Math.acos(cz)) / STEEPNESS));
  const c = 0.2 * p.turbidity * 10e-18;
  const betaR: RGB = [TOTAL_RAYLEIGH[0] * p.rayleigh, TOTAL_RAYLEIGH[1] * p.rayleigh, TOTAL_RAYLEIGH[2] * p.rayleigh];
  const betaM: RGB = [
    0.434 * c * MIE_CONST[0] * p.mieCoefficient,
    0.434 * c * MIE_CONST[1] * p.mieCoefficient,
    0.434 * c * MIE_CONST[2] * p.mieCoefficient,
  ];
  return { sun, sunE, betaR, betaM, g: p.mieDirectionalG };
}

/** Relative optical air mass towards a direction with vertical component `dy` (Kasten–Young form used by the shader). */
export function airMass(dy: number): number {
  const zenith = Math.acos(Math.max(0, Math.min(1, dy)));
  return 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));
}

/** Beer–Lambert extinction along a view direction (Rayleigh + Mie), per channel. */
export function extinction(s: SkyState, dy: number, out: RGB = [0, 0, 0]): RGB {
  const m = airMass(dy);
  const sR = RAYLEIGH_ZENITH_LENGTH * m;
  const sM = MIE_ZENITH_LENGTH * m;
  for (let i = 0; i < 3; i++) out[i] = Math.exp(-(s.betaR[i]! * sR + s.betaM[i]! * sM));
  return out;
}

/** Sky radiance towards unit direction d (no sun disc, no clouds), shader units. */
export function skyRadiance(s: SkyState, dx: number, dy: number, dz: number, out: RGB = [0, 0, 0]): RGB {
  const Fex = extinction(s, dy, _fex);
  const cosTheta = dx * s.sun[0] + dy * s.sun[1] + dz * s.sun[2];
  // The shader feeds (cosθ·½+½) to the Rayleigh phase; kept verbatim so both skies match.
  const rc = cosTheta * 0.5 + 0.5;
  const rPhase = THREE_OVER_SIXTEENPI * (1 + rc * rc);
  const g2 = s.g * s.g;
  const mPhase = ONE_OVER_FOURPI * ((1 - g2) / Math.pow(1 - 2 * s.g * cosTheta + g2, 1.5));
  const horizonMix = Math.min(1, Math.max(0, Math.pow(1 - s.sun[1], 5)));
  for (let i = 0; i < 3; i++) {
    const bR = s.betaR[i]!;
    const bM = s.betaM[i]!;
    const ratio = (bR * rPhase + bM * mPhase) / (bR + bM);
    let lin = Math.pow(s.sunE * ratio * (1 - Fex[i]!), 1.5);
    lin *= 1 + (Math.sqrt(Math.max(0, s.sunE * ratio * Fex[i]!)) - 1) * horizonMix;
    const L0 = 0.1 * Fex[i]!;
    out[i] = (lin + L0) * 0.04 + (i === 1 ? 0.0003 : i === 2 ? 0.00075 : 0);
  }
  return out;
}
const _fex: RGB = [0, 0, 0];

/**
 * Cosine-weighted irradiance of the sky dome on a surface with unit normal n (upper hemisphere of
 * the sky only), shader units: E = ∫ L(ω) max(0, n·ω) dω, midpoint rule over elevation × azimuth.
 */
export function skyIrradiance(s: SkyState, n: [number, number, number], rings = 24, sectors = 48): RGB {
  const out: RGB = [0, 0, 0];
  const L: RGB = [0, 0, 0];
  const dEl = Math.PI / 2 / rings;
  const dAz = (2 * Math.PI) / sectors;
  for (let i = 0; i < rings; i++) {
    const el = (i + 0.5) * dEl;
    const ce = Math.cos(el);
    const se = Math.sin(el);
    for (let j = 0; j < sectors; j++) {
      const az = (j + 0.5) * dAz;
      const dx = ce * Math.sin(az);
      const dz = ce * Math.cos(az);
      const cosN = dx * n[0] + se * n[1] + dz * n[2];
      if (cosN <= 0) continue;
      skyRadiance(s, dx, se, dz, L);
      const w = cosN * ce * dEl * dAz; // dω = cos(el) dEl dAz
      out[0] += L[0] * w;
      out[1] += L[1] * w;
      out[2] += L[2] * w;
    }
  }
  return out;
}

export function luminance(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * Direct-beam transmittance of the real atmosphere towards a sun at `elevationDeg`: Rayleigh optical
 * depth τ_R = 0.0088 λ^−4.05 (λ in µm; Leckner 1978) plus aerosol τ_a = β λ^−α (Ångström 1929;
 * β = 0.1, α = 1.3: clear continental air), with the Kasten & Young (1989) relative air mass.
 * Used for the sun's colour and brightness; the Preetham constants over-redden the low sun when
 * Rayleigh is raised for a bluer zenith.
 */
export function sunTransmittance(elevationDeg: number, beta = 0.1, alpha = 1.3): RGB {
  const h = Math.max(0, elevationDeg);
  const m = 1 / (Math.sin((h * Math.PI) / 180) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
  const lambdas = [0.68, 0.55, 0.45];
  return lambdas.map((l) => Math.exp(-m * (0.0088 * Math.pow(l, -4.05) + beta * Math.pow(l, -alpha)))) as RGB;
}

export interface SunLighting {
  /** Linear RGB colour of direct sunlight (max channel 1) */
  sunColor: RGB;
  /** Directional-light intensity: sun irradiance on a surface facing it, render units */
  sunIntensity: number;
  /** Multiplier from shader sky units to render units (applied to the visible sky and the env map) */
  skyScale: number;
  /** Sky irradiance on a horizontal surface, render units, linear RGB */
  skyIrradiance: RGB;
  /** Average horizon radiance (render units): colour of distant haze */
  horizon: RGB;
  /** Radiance of sunlit ground of the given albedo (render units), for the lower env hemisphere */
  groundRadiance: RGB;
}

/**
 * Derive the light rig from the sun position. The Preetham sky radiance is not calibrated against
 * its own sun, so the sun is set from the clear-sky ratio of direct-normal to diffuse horizontal
 * illuminance, E_dn / E_dh ≈ 4.5 at low sun rising to ≈ 6 by 40° (clear-sky measurements, e.g.
 * Perez et al. 1990, "Modeling daylight availability", Solar Energy 44), and everything is scaled
 * so that the sun delivers `sunTarget` render units at 25°+ (the exposure anchor: a white wall
 * facing the sun renders ≈ 1.4). Lower suns are dimmer by their beam transmittance.
 */
export function deriveLighting(elevationDeg: number, azimuthDeg: number, p: SkyParams = GOLDEN_HOUR_SKY, groundAlbedo: RGB = [0.24, 0.22, 0.19], sunTarget = 6): SunLighting {
  // Keep the model defined for a sun at or below the horizon (dusk scenes): clamp to 1°.
  const elev = Math.max(1, Math.min(89, elevationDeg));
  const sun = sunDirection(elev, azimuthDeg);
  const s = skyState(sun, p);
  const tr = sunTransmittance(elev);
  const maxC = Math.max(tr[0], tr[1], tr[2], 1e-9);
  const sunColor: RGB = [tr[0] / maxC, tr[1] / maxC, tr[2] / maxC];
  const eSkyRaw = skyIrradiance(s, [0, 1, 0]);
  const ratio = 4.5 + 1.5 * Math.min(1, Math.max(0, (elev - 5) / 35));
  const dim = Math.min(1, Math.max(0.2, luminance(tr) / luminance(sunTransmittance(25))));
  const sunIntensity = sunTarget * dim;
  const skyScale = sunIntensity / (ratio * Math.max(luminance(eSkyRaw), 1e-9));
  const skyIrr: RGB = [eSkyRaw[0] * skyScale, eSkyRaw[1] * skyScale, eSkyRaw[2] * skyScale];
  // Haze colour: mean sky radiance a few degrees above the horizon over all azimuths.
  const horizon: RGB = [0, 0, 0];
  const L: RGB = [0, 0, 0];
  const n = 32;
  const hy = Math.sin((3 * Math.PI) / 180);
  const hc = Math.cos((3 * Math.PI) / 180);
  for (let j = 0; j < n; j++) {
    const az = ((j + 0.5) / n) * 2 * Math.PI;
    skyRadiance(s, hc * Math.sin(az), hy, hc * Math.cos(az), L);
    horizon[0] += (L[0] * skyScale) / n;
    horizon[1] += (L[1] * skyScale) / n;
    horizon[2] += (L[2] * skyScale) / n;
  }
  // Lambertian ground: L = ρ/π · (E_sun sin h + E_sky).
  const sinH = Math.sin((elev * Math.PI) / 180);
  const groundRadiance: RGB = [0, 1, 2].map((i) => (groundAlbedo[i]! / Math.PI) * (sunIntensity * sunColor[i]! * sinH + skyIrr[i]!)) as RGB;
  return { sunColor, sunIntensity, skyScale, skyIrradiance: skyIrr, horizon, groundRadiance };
}
