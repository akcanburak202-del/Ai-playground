import type { BeamProfile } from '../../app/contracts.ts';

/**
 * Cross-section properties of the rolled / built-up profiles a beam can have, in the profile
 * plane: `y` is the profile's "up" (the web direction of an I-section), `z` points sideways
 * (across the flanges). All values SI (m, m², m⁴, m³).
 *
 * Naming follows the integrals, not Eurocode's axis letters: `Iy = ∫y² dA` resists deflection along
 * y, so for an I-section `Iy` is the strong-axis value (EC3 "I_y") and `Iz` the weak-axis one.
 *
 * Every profile is decomposed into non-overlapping *plates* (flanges, web, walls, tube sectors).
 * Section damage is tracked per plate, so a hole through one flange reduces exactly that flange's
 * share of A, I and Z.
 */

export interface SectionPlate {
  name: string;
  /** Rectangle: centre and half sizes in (y, z). Arcs (tubes) use the polar fields instead. */
  kind: 'rect' | 'arc';
  cy: number;
  cz: number;
  hy: number;
  hz: number;
  /** Arc sector (tube wall): inner / outer radius and angle range (radians, from +z towards +y) */
  r0: number;
  r1: number;
  a0: number;
  a1: number;
  /** Plate thickness used for holes and probes, m */
  t: number;
  /** Contributions of this plate (plus any fillets attached to it) about the profile centroid */
  A: number;
  Iy: number;
  Iz: number;
  /** First moments of |y| and |z|: the plate's share of the plastic moduli */
  Zy: number;
  Zz: number;
}

export interface SectionProps {
  profile: BeamProfile;
  plates: SectionPlate[];
  A: number;
  /** Second moments ∫y² dA and ∫z² dA */
  Iy: number;
  Iz: number;
  /** Elastic section moduli I / c_max */
  Sy: number;
  Sz: number;
  /** Plastic section moduli ∫|y| dA, ∫|z| dA (equal-area axis = centroidal axis for these symmetric shapes) */
  Zy: number;
  Zz: number;
  /** Extreme fibre distances */
  cy: number;
  cz: number;
  /** Outer perimeter length (painting, heat exchange) */
  perimeter: number;
  /** Root fillet radius used (I-sections), m */
  rootRadius: number;
}

/** A rectangle's contributions about the section centroid. */
function rectPlate(name: string, cy: number, cz: number, hy: number, hz: number, t: number): SectionPlate {
  const w = 2 * hz, h = 2 * hy;
  const A = w * h;
  // ∫|y| over [cy−hy, cy+hy]: closed form handles plates straddling the axis (webs).
  const absInt = (c: number, half: number) => {
    const lo = c - half, hi = c + half;
    if (lo >= 0) return (hi * hi - lo * lo) / 2;
    if (hi <= 0) return (lo * lo - hi * hi) / 2;
    return (lo * lo + hi * hi) / 2;
  };
  return {
    name, kind: 'rect', cy, cz, hy, hz, r0: 0, r1: 0, a0: 0, a1: 0, t,
    A,
    Iy: (w * h * h * h) / 12 + A * cy * cy,
    Iz: (h * w * w * w) / 12 + A * cz * cz,
    Zy: w * absInt(cy, hy),
    Zz: h * absInt(cz, hz),
  };
}

/** Tube wall sector between angles a0 and a1 (numerical integration: exact enough at 64×8 samples). */
function arcPlate(name: string, r0: number, r1: number, a0: number, a1: number): SectionPlate {
  let A = 0, Iy = 0, Iz = 0, Zy = 0, Zz = 0;
  const nr = 8, na = 64;
  for (let i = 0; i < nr; i++) {
    const r = r0 + ((i + 0.5) / nr) * (r1 - r0);
    for (let j = 0; j < na; j++) {
      const a = a0 + ((j + 0.5) / na) * (a1 - a0);
      const dA = r * ((r1 - r0) / nr) * ((a1 - a0) / na);
      const y = r * Math.sin(a), z = r * Math.cos(a);
      A += dA;
      Iy += y * y * dA;
      Iz += z * z * dA;
      Zy += Math.abs(y) * dA;
      Zz += Math.abs(z) * dA;
    }
  }
  const am = (a0 + a1) / 2, rm = (r0 + r1) / 2;
  return { name, kind: 'arc', cy: rm * Math.sin(am), cz: rm * Math.cos(am), hy: 0, hz: 0, r0, r1, a0, a1, t: r1 - r0, A, Iy, Iz, Zy, Zz };
}

/**
 * Root radius of hot-rolled I/H sections (EN 10365): wide-flange HE sections by flange width,
 * IPE by depth. Used when a profile does not say.
 */
export function defaultRootRadius(p: { h: number; b: number; tw: number }): number {
  const mm = (v: number) => v / 1000;
  if (p.b / p.h >= 0.85 || p.b >= 0.295) {
    const b = p.b * 1000;
    if (b <= 145) return mm(12);
    if (b <= 185) return mm(15);
    if (b <= 225) return mm(18);
    if (b <= 245) return mm(21);
    if (b <= 285) return mm(24);
    return mm(27);
  }
  const h = p.h * 1000;
  if (h <= 85) return mm(5);
  if (h <= 145) return mm(7);
  if (h <= 185) return mm(9);
  if (h <= 225) return mm(12);
  if (h <= 305) return mm(15);
  if (h <= 365) return mm(18);
  if (h <= 505) return mm(21);
  return mm(24);
}

/**
 * Root fillet ("spandrel": an r×r square minus a quarter disc). Area (1 − π/4) r², centroid 0.2234 r
 * from both faces, own second moment 0.007542 r⁴ (standard section-table geometry).
 */
const FILLET_A = 1 - Math.PI / 4;
const FILLET_C = (10 - 3 * Math.PI) / (12 - 3 * Math.PI);
const FILLET_I = 0.007542;

export function sectionProps(profile: BeamProfile, rootRadius?: number): SectionProps {
  const plates: SectionPlate[] = [];
  let cy = 0, cz = 0, perimeter = 0, r = 0;
  switch (profile.type) {
    case 'I': {
      const { h, b, tw, tf } = profile;
      r = rootRadius ?? defaultRootRadius(profile);
      plates.push(rectPlate('top flange', h / 2 - tf / 2, 0, tf / 2, b / 2, tf));
      plates.push(rectPlate('bottom flange', -(h / 2 - tf / 2), 0, tf / 2, b / 2, tf));
      const web = rectPlate('web', 0, 0, h / 2 - tf, tw / 2, tw);
      // The four root fillets ride with the web (a hole through the web root takes them too).
      const af = FILLET_A * r * r;
      const fy = h / 2 - tf - FILLET_C * r;
      const fz = tw / 2 + FILLET_C * r;
      web.A += 4 * af;
      web.Iy += 4 * (af * fy * fy + FILLET_I * r ** 4);
      web.Iz += 4 * (af * fz * fz + FILLET_I * r ** 4);
      web.Zy += 4 * af * fy;
      web.Zz += 4 * af * fz;
      plates.push(web);
      cy = h / 2;
      cz = b / 2;
      perimeter = 2 * b + 2 * (b - tw) + 2 * (h - 2 * tf) + 2 * tf * 2 - 4 * (2 - Math.PI / 2) * r;
      break;
    }
    case 'cruciform': {
      const { arm, t } = profile;
      // A horizontal plate (full width) and the two halves of the vertical one.
      plates.push(rectPlate('horizontal', 0, 0, t / 2, arm, t));
      const hl = (arm - t / 2) / 2;
      plates.push(rectPlate('upper arm', t / 2 + hl, 0, hl, t / 2, t));
      plates.push(rectPlate('lower arm', -(t / 2 + hl), 0, hl, t / 2, t));
      cy = arm;
      cz = arm;
      perimeter = 8 * arm;
      break;
    }
    case 'box': {
      const { h, b, t } = profile;
      plates.push(rectPlate('top wall', h / 2 - t / 2, 0, t / 2, b / 2, t));
      plates.push(rectPlate('bottom wall', -(h / 2 - t / 2), 0, t / 2, b / 2, t));
      plates.push(rectPlate('left wall', 0, -(b / 2 - t / 2), h / 2 - t, t / 2, t));
      plates.push(rectPlate('right wall', 0, b / 2 - t / 2, h / 2 - t, t / 2, t));
      cy = h / 2;
      cz = b / 2;
      perimeter = 2 * (h + b);
      break;
    }
    case 'tube': {
      const { d, t } = profile;
      const n = 8;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        plates.push(arcPlate(`sector ${i}`, d / 2 - t, d / 2, a0, a1));
      }
      cy = cz = d / 2;
      perimeter = Math.PI * d;
      break;
    }
  }
  let A = 0, Iy = 0, Iz = 0, Zy = 0, Zz = 0;
  for (const p of plates) {
    A += p.A;
    Iy += p.Iy;
    Iz += p.Iz;
    Zy += p.Zy;
    Zz += p.Zz;
  }
  return { profile, plates, A, Iy, Iz, Sy: Iy / cy, Sz: Iz / cz, Zy, Zz, cy, cz, perimeter, rootRadius: r };
}

/** Section properties with each plate scaled by its remaining fraction (holes, dents, cuts). */
export interface DamagedSection {
  A: number;
  Iy: number;
  Iz: number;
  Zy: number;
  Zz: number;
  Sy: number;
  Sz: number;
}

export function damagedSection(s: SectionProps, fractions: ArrayLike<number>, offset = 0, out: DamagedSection = { A: 0, Iy: 0, Iz: 0, Zy: 0, Zz: 0, Sy: 0, Sz: 0 }): DamagedSection {
  let A = 0, Iy = 0, Iz = 0, Zy = 0, Zz = 0;
  for (let i = 0; i < s.plates.length; i++) {
    const f = fractions[offset + i]!;
    const p = s.plates[i]!;
    A += f * p.A;
    Iy += f * p.Iy;
    Iz += f * p.Iz;
    Zy += f * p.Zy;
    Zz += f * p.Zz;
  }
  out.A = A;
  out.Iy = Iy;
  out.Iz = Iz;
  out.Zy = Zy;
  out.Zz = Zz;
  out.Sy = Iy / s.cy;
  out.Sz = Iz / s.cz;
  return out;
}
