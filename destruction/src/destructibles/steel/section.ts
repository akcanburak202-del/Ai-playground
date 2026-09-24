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

// ─── Section sampling (cuts and eccentricity of damaged sections) ────────────────────────────

/** A plate sampled into small cells: section coordinates and area of each (plate order kept). */
export interface PlateSamples {
  y: Float64Array;
  z: Float64Array;
  a: Float64Array;
  /** Cells of plate p are [start[p], start[p + 1]) */
  start: Int32Array;
}

const sampleCache = new WeakMap<SectionProps, PlateSamples>();

/** Every plate as a grid of cells no coarser than `cell` (m); cached per section. */
export function plateSamples(s: SectionProps, cell = 0.005): PlateSamples {
  const hit = sampleCache.get(s);
  if (hit) return hit;
  const y: number[] = [], z: number[] = [], a: number[] = [];
  const start = new Int32Array(s.plates.length + 1);
  s.plates.forEach((p, k) => {
    start[k] = a.length;
    if (p.kind === 'rect') {
      const ny = Math.max(2, Math.ceil((2 * p.hy) / cell)), nz = Math.max(2, Math.ceil((2 * p.hz) / cell));
      // Cells carry the plate's own area (fillets included), spread uniformly.
      const dA = p.A / (ny * nz);
      for (let i = 0; i < ny; i++)
        for (let j = 0; j < nz; j++) {
          y.push(p.cy - p.hy + ((i + 0.5) / ny) * 2 * p.hy);
          z.push(p.cz - p.hz + ((j + 0.5) / nz) * 2 * p.hz);
          a.push(dA);
        }
    } else {
      const nr = Math.max(2, Math.ceil((p.r1 - p.r0) / cell)), na = Math.max(4, Math.ceil(((p.a1 - p.a0) * p.r1) / cell));
      let sum = 0;
      const first = a.length;
      for (let i = 0; i < nr; i++)
        for (let j = 0; j < na; j++) {
          const r = p.r0 + ((i + 0.5) / nr) * (p.r1 - p.r0), ang = p.a0 + ((j + 0.5) / na) * (p.a1 - p.a0);
          y.push(r * Math.sin(ang));
          z.push(r * Math.cos(ang));
          const dA = r * ((p.r1 - p.r0) / nr) * ((p.a1 - p.a0) / na);
          a.push(dA);
          sum += dA;
        }
      for (let q = first; q < a.length; q++) a[q] = (a[q]! * p.A) / Math.max(sum, 1e-12);
    }
  });
  start[s.plates.length] = a.length;
  const out = { y: Float64Array.from(y), z: Float64Array.from(z), a: Float64Array.from(a), start };
  sampleCache.set(s, out);
  return out;
}

/**
 * Cross-section area a placed steel-cutting charge severs, m². US Army FM 5-250 (Explosives and
 * Demolitions, 1992, §3-7, steel-cutting formula for structural steel sections):
 *     P = 3/8 · A      (P in lb of TNT, A in in²)
 * inverted: a charge of W kg TNT cuts A = W · 2.2046 / 0.375 in² = 3.79·10⁻³ m² per kg. The formula
 * is for structural (mild) steel; stronger steels are scaled like the ballistics module's contact
 * breach threshold, × √(510 MPa / σ_u) (blast.ts contactDamage).
 */
export function fm5250CutArea(tntKg: number, ultimateStrength = 510e6): number {
  const LB_PER_KG = 2.20462, M2_PER_IN2 = 6.4516e-4;
  return ((Math.max(0, tntKg) * LB_PER_KG) / 0.375) * M2_PER_IN2 * Math.sqrt(510e6 / Math.max(ultimateStrength, 1e8));
}

/** Steel area of each plate within distance R of (y0, z0) in the section plane, m² (weighted by `fractions`). */
export function plateAreaWithin(s: SectionProps, y0: number, z0: number, R: number, fractions?: ArrayLike<number>, offset = 0, out?: Float64Array): Float64Array {
  const sm = plateSamples(s);
  const res = out ?? new Float64Array(s.plates.length);
  const R2 = R * R;
  for (let p = 0; p < s.plates.length; p++) {
    let A = 0;
    for (let q = sm.start[p]!; q < sm.start[p + 1]!; q++) if ((sm.y[q]! - y0) ** 2 + (sm.z[q]! - z0) ** 2 <= R2) A += sm.a[q]!;
    res[p] = A * (fractions ? Math.max(0, fractions[offset + p]!) : 1);
  }
  return res;
}

/**
 * The cut a contact charge at (y0, z0) makes: every plate within a radius R of the charge loses the
 * steel inside it, R growing until that steel equals the charge's FM 5-250 cut area `budget`
 * (fm5250CutArea) or R reaches `reach`. Returns the area each plate loses (m²) and R.
 */
export function contactCut(s: SectionProps, y0: number, z0: number, budget: number, reach: number, fractions?: ArrayLike<number>, offset = 0): { lost: Float64Array; R: number } {
  const lost = new Float64Array(s.plates.length);
  const total = (R: number) => {
    plateAreaWithin(s, y0, z0, R, fractions, offset, lost);
    let a = 0;
    for (let p = 0; p < lost.length; p++) a += lost[p]!;
    return a;
  };
  if (!(budget > 0) || !(reach > 0)) return { lost, R: 0 };
  if (total(reach) <= budget) return { lost, R: reach };
  let lo = 0, hi = reach;
  for (let k = 0; k < 24; k++) {
    const mid = 0.5 * (lo + hi);
    if (total(mid) > budget) hi = mid;
    else lo = mid;
  }
  total(lo);
  return { lost, R: lo };
}

/**
 * A damaged section that has lost material on one side carries an axial force through its old
 * centroid with an eccentricity e (the shift of its own centroid): N and M = N·e together. The
 * squash load it can still take follows the linear N–M interaction N/N_p + N·e/M_p,e ≤ 1
 * (EN 1993-1-1 §6.2.1(7), conservative for every section shape), with M_p,e the plastic moment of
 * what is left about its plastic neutral axis in the plane of e (equal-area axis, sampled). Returns
 * that capacity as an effective area N_max / f_y (m²) — the plain remaining area when e ≈ 0.
 */
export function eccentricAxialArea(s: SectionProps, fractions: ArrayLike<number>, offset = 0): number {
  const sm = plateSamples(s);
  let A = 0, Sy = 0, Sz = 0, damaged = false;
  for (let p = 0; p < s.plates.length; p++) {
    const f = Math.max(0, fractions[offset + p]!);
    if (f < 0.999) damaged = true;
    const pl = s.plates[p]!;
    A += f * pl.A;
    Sy += f * pl.A * (pl.kind === 'rect' ? pl.cy : 0);
    Sz += f * pl.A * (pl.kind === 'rect' ? pl.cz : 0);
    if (pl.kind === 'arc') {
      // Sector centroid from the samples (cy, cz of an arc plate are its mid-radius point only).
      let ay = 0, az = 0, aa = 0;
      for (let q = sm.start[p]!; q < sm.start[p + 1]!; q++) {
        ay += sm.y[q]! * sm.a[q]!;
        az += sm.z[q]! * sm.a[q]!;
        aa += sm.a[q]!;
      }
      Sy += (f * pl.A * ay) / Math.max(aa, 1e-12);
      Sz += (f * pl.A * az) / Math.max(aa, 1e-12);
    }
  }
  if (!damaged || !(A > 0)) return Math.max(A, 0);
  const ey = Sy / A, ez = Sz / A;
  const e = Math.hypot(ey, ez);
  if (e < 1e-4) return A;
  const ux = ey / e, uz = ez / e;
  // Plastic neutral axis ⊥ e: the weighted median of the cells' coordinate along e.
  const xs: { x: number; w: number }[] = [];
  for (let p = 0; p < s.plates.length; p++) {
    const f = Math.max(0, fractions[offset + p]!);
    if (f <= 0) continue;
    for (let q = sm.start[p]!; q < sm.start[p + 1]!; q++) xs.push({ x: sm.y[q]! * ux + sm.z[q]! * uz, w: f * sm.a[q]! });
  }
  xs.sort((a, b) => a.x - b.x);
  let acc = 0, xp = 0;
  for (const c of xs) {
    acc += c.w;
    if (acc >= 0.5 * A) {
      xp = c.x;
      break;
    }
  }
  let Z = 0;
  for (const c of xs) Z += c.w * Math.abs(c.x - xp);
  // N_max = 1 / (1/N_p + e/M_p) with N_p = A f_y, M_p = Z f_y → as an area: 1 / (1/A + e/Z).
  return 1 / (1 / A + e / Math.max(Z, 1e-12));
}
