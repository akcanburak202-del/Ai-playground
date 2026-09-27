import * as THREE from 'three';
import { clamp, fmtLength, smoothstep } from '../../core/units.ts';
import type { Rng } from '../../core/rng.ts';
import type { RayHit } from '../../destructibles/Destructible.ts';
import type { MaterialProps } from '../materials.ts';
import type { AmmoData } from './ammo.ts';
import type { ResolvedImpact } from './penetration.ts';
import type { AmmoSpec, ProjectileState, ThicknessProbe, WoundProfile } from './types.ts';

/**
 * Terminal ballistics in a soft-tissue simulant: 10 % ordnance gelatin with a synthetic skeleton.
 * Pure functions, SI units. Equations and sources are in PHYSICS.md §13.
 *
 *  - Retardation (Poncelet form, as used for projectiles in gelatin by Peters 1990 and Sellier &
 *    Kneubuehl 1994, "Wundballistik"): m dv/dx = −A(ψ)·(½ ρ C_d(ψ) v² + R). The presented area A
 *    and the drag coefficient C_d follow the yaw ψ: a spitzer bullet goes in nose first (C_d ≈ 0.3),
 *    becomes unstable in the dense medium, turns sideways (C_d ≈ 1.2 on L·d) and ends base first.
 *  - Yaw: the published wound profiles (Fackler & Malinowski 1985/1988; US Army Wound Ballistics
 *    Laboratory) give where each bullet starts to yaw — the "neck" — and that it reaches 90° a
 *    third of a neck later. The yaw curve is that description, not a six-degree-of-freedom model.
 *  - Fragmentation: lead-core bullets that turn sideways above ≈ 760 m/s (M193/M855) break at the
 *    cannelure (Fackler 1988); the pieces cut short side channels.
 *  - Temporary cavity: the radial momentum given to the gel opens a cavity whose volume per unit
 *    length is proportional to the energy deposited there (Kneubuehl 2011, "Wound Ballistics",
 *    §3.4): π R² σ_c = dE/dx, with σ_c fitted to the published 5.56 mm and 7.62 mm profiles.
 *  - Permanent cavity and tears: the crush channel is what the bullet's presented width cuts; gel
 *    tears radially where the hoop strain of the stretched wall, √(1 + R²/r²) − 1 (incompressible
 *    cylinder), exceeds the gel's failure strain at ballistic rates.
 */

/** Drag coefficients in gel: ogive nose first, sideways on the L·d profile, base first (Sellier & Kneubuehl 1994). */
export const GEL_CD = { nose: 0.3, side: 1.2, base: 0.9, fragment: 1.05 } as const;
/**
 * Poncelet strength term of 10 % gelatin at 4 °C, Pa. Fixed by the FBI calibration shot: a 4.5 mm
 * steel BB (0.37 g) at 180 m/s must penetrate 8.5 ± 1 cm (FBI protocol; Jussila 2004 for the
 * 590 ± 15 fps variant). With C_d = 0.47 for a sphere this gives R ≈ 1.5 MPa.
 */
export const GEL_RESISTANCE = 1.5e6;
/** Sphere drag in gel for the calibration BB */
export const SPHERE_CD = 0.47;
/**
 * Stress that the temporary cavity's volume is referred to: π R² σ_c = dE/dx, Pa. Fitted so that
 * M855 at 900 m/s gives a ≈ 12 cm cavity and M80 at 840 m/s ≈ 13–15 cm (Fackler 1988 profiles).
 */
export const CAVITY_STRESS = 1.8e6;
/** Hoop strain at which gelatin tears at ballistic strain rates (fitted to fissure lengths, ≈ 0.55 R) */
export const GEL_FAILURE_STRAIN = 1.0;
/** Energy a bone wall must absorb to fracture, J (cortical bone ≈ 2–10 J for a small-calibre strike) */
export const BONE_BREAK_ENERGY = 3;
/** Initial yaw of a stable round at the gel face, rad (≈ 2°) */
const YAW0 = THREE.MathUtils.degToRad(2);
const YAW_NECK = THREE.MathUtils.degToRad(20);
/** Integration step along the channel, m */
const STEP = 0.002;
/** Samples of the stored profile, m */
const SAMPLE = 0.01;

/** Distance before the bullet yaws noticeably (the neck), m — from published gelatin wound profiles. */
const NECK: Record<string, number> = {
  m855: 0.12, // Fackler 1988: M193/M855 yaw at ≈ 12 cm, fragment at the cannelure
  m995: 0.14,
  m80: 0.16, // 7.62×51 M80: ≈ 16 cm (Fackler, 7.62 mm NATO profile)
  m993: 0.17,
  lps: 0.2, // 7.62×54R steel-core: longer neck than lead-core M80 (Russian profiles ≈ 18–24 cm)
  m33: 0.26, // .50 M33 ball: neck ≈ 25–30 cm in open wound-profile data
  m2ap: 0.3,
  m8api: 0.3,
  mk211: 0.2, // functions on impact, yaws early
  m903: 1e9, // sabot-launched tungsten: stable
};

/** Lead-core break-up: speed above which a sideways bullet fragments, m/s, and the mass that breaks off. */
const FRAGMENT: Record<string, { v: number; f: number }> = {
  m855: { v: 760, f: 0.4 }, // Fackler 1988: ≥ 2 500 fps, ~40 % of the mass as fragments
  m80: { v: 790, f: 0.25 }, // M80 breaks at the cannelure less reliably
  lps: { v: 820, f: 0.15 }, // mild-steel core stays whole; jacket and lead sheath tear off
  m33: { v: 820, f: 0.2 },
};

/** Neck length of a round in gel, m (Infinity: never yaws — long rods, shells; 0: a tumbling fragment). */
export function gelNeck(a: AmmoSpec): number {
  if (a.kind === 'fragment') return 0;
  if (a.kind === 'apfsds' || a.kind === 'he' || a.kind === 'hesh' || a.kind === 'thermobaric' || a.kind === 'heat') return Infinity;
  return NECK[a.id] ?? 25 * a.diameter;
}

/**
 * Yaw after `x` metres of tissue for a round with neck `N`: slow growth to 20° at the neck,
 * sideways (90°) at 1.35 N, base first (180°) by 2.6 N, where it stays.
 */
export function gelYaw(x: number, N: number): number {
  if (!Number.isFinite(N) || N > 1e6) return YAW0;
  if (N <= 0) return Math.PI / 2;
  if (x <= N) return YAW0 + (YAW_NECK - YAW0) * Math.pow(Math.max(x, 0) / N, 3);
  if (x <= 1.35 * N) return YAW_NECK + (Math.PI / 2 - YAW_NECK) * smoothstep(N, 1.35 * N, x);
  return Math.PI / 2 + (Math.PI / 2) * smoothstep(1.35 * N, 2.6 * N, x);
}

/** Presented area of a bullet of calibre d and length L at yaw ψ, m² (ogive side profile ≈ 0.85 L d). */
export function presentedArea(d: number, L: number, yaw: number): number {
  return 0.25 * Math.PI * d * d * Math.abs(Math.cos(yaw)) + 0.85 * L * d * Math.abs(Math.sin(yaw));
}

/** Drag coefficient in gel at yaw ψ. */
export function gelCd(yaw: number): number {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return (yaw <= Math.PI / 2 ? GEL_CD.nose : GEL_CD.base) * c * c + GEL_CD.side * s * s;
}

/** Poncelet strength term of a tissue-simulant material, Pa (bone: cavity-expansion ≈ 2 σ_c). */
export function tissueResistance(m: MaterialProps): number {
  return m.id === 'gelatin' ? GEL_RESISTANCE : 2 * m.compressiveStrength;
}

/**
 * Closed-form Poncelet penetration depth of a body with constant presented area A and drag
 * coefficient Cd: x = m / (ρ Cd A) · ln(1 + ρ Cd v² / 2R).
 */
export function ponceletDepth(v: number, mass: number, area: number, cd: number, rho: number, R: number): number {
  return (mass / (rho * cd * area)) * Math.log(1 + (rho * cd * v * v) / (2 * R));
}

/** Speed left after `x` metres at constant area and Cd (0 if it stops). */
export function ponceletSpeed(v: number, x: number, mass: number, area: number, cd: number, rho: number, R: number): number {
  const c = (2 * R) / (rho * cd);
  const u = (v * v + c) * Math.exp((-rho * cd * area * x) / mass) - c;
  return u > 0 ? Math.sqrt(u) : 0;
}

/** Temporary-cavity radius for an energy deposit per unit length, m. */
export function cavityRadius(dEdx: number): number {
  return Math.sqrt(Math.max(dEdx, 0) / (Math.PI * CAVITY_STRESS));
}

/** Reach of the radial tears around a cavity of radius R: where √(1 + R²/r²) − 1 = ε_f. */
export function fissureRadius(R: number): number {
  const k = (1 + GEL_FAILURE_STRAIN) ** 2 - 1;
  return R / Math.sqrt(k);
}

export interface TissueRun {
  /** Speed, mass and tissue path when the round leaves (or stops in) the run */
  v: number;
  mass: number;
  path: number;
  wound: WoundProfile;
}

/**
 * March a round through a run of tissue-simulant material (gel, bone, gel …), integrating the
 * Poncelet retardation with the yaw-dependent area in 2 mm steps. Returns the exit state and the
 * sampled wound channel. `path0` is the tissue already traversed (a round that went through an arm
 * arrives at the torso yawing); `destabilized` rounds (through glass or steel) yaw at once.
 */
export function marchTissue(a: AmmoSpec, v0: number, mass0: number, length0: number, probe: ThicknessProbe, rng: Rng, path0 = 0, destabilized = false): TissueRun {
  const N = gelNeck(a);
  const fragment = a.kind === 'fragment';
  const d = a.diameter;
  let L = Math.max(length0, d);
  let m = mass0;
  let v = v0;
  let xe = destabilized && Number.isFinite(N) && N > 0 ? Math.max(path0, 0.85 * N) : path0;
  const frag = a.deformable ? (FRAGMENT[a.id] ?? { v: 790, f: 0.3 }) : null;
  const runEnd = probe.segments.length ? probe.segments[probe.segments.length - 1]!.end : 0;
  const n = Math.max(1, Math.ceil(runEnd / STEP) + 1);
  const dep = new Float64Array(n);
  const yawAt = new Float64Array(n);
  const widthAt = new Float64Array(n);
  const wound: WoundProfile = {
    s: [], cavity: [], crush: [], fissure: [], yaw: [], length: 0, stopped: false, neck: -1,
    maxCavity: 0, maxCavityAt: 0, fragmentedAt: -1, massLost: 0, fragments: [], bones: [],
  };
  let pos = 0;
  let last = 0;
  let stopped = false;
  for (const seg of probe.segments) {
    if (stopped) break;
    pos = Math.max(pos, seg.start);
    const mat = seg.material;
    const bone = mat.id !== 'gelatin';
    const rho = mat.density;
    const R = tissueResistance(mat) * clamp(seg.strength, 0.05, 1);
    const eIn = 0.5 * m * v * v;
    const boneAt = pos;
    while (pos < seg.end - 1e-9) {
      const dx = Math.min(STEP, seg.end - pos);
      const yaw = fragment ? Math.PI / 2 : gelYaw(xe, N);
      const A = fragment ? 0.25 * Math.PI * d * d : presentedArea(d, L, yaw);
      const cd = fragment ? GEL_CD.fragment : gelCd(yaw);
      const k = (rho * cd * A) / m;
      const c = (2 * R) / (rho * cd);
      const u0 = v * v;
      const u1 = (u0 + c) * Math.exp(-k * dx) - c;
      const i = Math.min(n - 1, Math.floor(pos / STEP));
      yawAt[i] = yaw;
      widthAt[i] = fragment ? d : d * Math.abs(Math.cos(yaw)) + L * Math.abs(Math.sin(yaw));
      if (wound.neck < 0 && yaw >= YAW_NECK && !fragment && Number.isFinite(N)) wound.neck = pos;
      if (u1 <= 0) {
        const ds = Math.log((u0 + c) / c) / k;
        dep[i] += (0.5 * m * u0) / STEP;
        pos += ds;
        v = 0;
        stopped = true;
        break;
      }
      dep[i] += (0.5 * m * (u0 - u1)) / STEP;
      v = Math.sqrt(u1);
      pos += dx;
      xe += dx;
      // Lead-core break-up once the bullet is well sideways and still fast.
      if (frag && !bone && wound.fragmentedAt < 0 && yaw > THREE.MathUtils.degToRad(50) && v0 > frag.v) {
        const lost = frag.f * m;
        wound.fragmentedAt = pos;
        wound.massLost = lost;
        breakUp(wound, dep, n, pos, lost, v, rng, 11340);
        m -= lost;
        L *= 1 - frag.f;
      }
    }
    if (bone) {
      const absorbed = eIn - 0.5 * m * v * v;
      const broken = absorbed >= BONE_BREAK_ENERGY;
      wound.bones.push({ s: boneAt, broken });
      if (broken && !stopped) {
        // A struck bone destabilises the bullet and throws a few bone splinters forward.
        if (Number.isFinite(N) && N > 0) xe = Math.max(xe, 0.9 * N);
        splinters(wound, dep, n, pos, Math.min(absorbed, 0.1 * eIn), rng);
      }
    }
    last = pos;
  }
  if (!stopped) pos = last;
  wound.length = Math.min(pos, runEnd);
  wound.stopped = stopped;
  buildProfile(wound, dep, yawAt, widthAt, n);
  return { v, mass: m, path: xe, wound };
}

/**
 * The broken-off part of a lead-core bullet: 5–9 pieces leave at 10–35° from the track at ≈ 0.8 v
 * and cut short channels (Poncelet with a tumbling sphere of lead); their energy is deposited
 * along the stretch of track they run beside.
 */
function breakUp(w: WoundProfile, dep: Float64Array, n: number, at: number, mass: number, v: number, rng: Rng, rho: number): void {
  const count = rng.int(5, 10);
  const mf = mass / count;
  const df = Math.cbrt((6 * mf) / (Math.PI * rho));
  const vf = 0.8 * v;
  for (let k = 0; k < count; k++) {
    const polar = THREE.MathUtils.degToRad(rng.range(10, 35));
    const len = ponceletDepth(vf, mf, 0.25 * Math.PI * df * df, GEL_CD.fragment, 1040, GEL_RESISTANCE);
    w.fragments.push({ s: at, polar, azimuth: rng.range(0, 2 * Math.PI), length: len });
    spread(dep, n, at, at + len * Math.cos(polar), 0.5 * mf * vf * vf);
  }
}

/** Bone splinters: 2–4 short secondary channels ahead of the struck bone. */
function splinters(w: WoundProfile, dep: Float64Array, n: number, at: number, energy: number, rng: Rng): void {
  const count = rng.int(2, 5);
  for (let k = 0; k < count; k++) {
    const polar = THREE.MathUtils.degToRad(rng.range(15, 50));
    const len = rng.range(0.025, 0.06);
    w.fragments.push({ s: at, polar, azimuth: rng.range(0, 2 * Math.PI), length: len });
    spread(dep, n, at, at + len * Math.cos(polar), energy / count);
  }
}

/**
 * Deposit `energy` uniformly (J/m) over [from, to]; what lies beyond the end of this run is carried
 * out of the target by the pieces, so it is not deposited here.
 */
function spread(dep: Float64Array, n: number, from: number, to: number, energy: number): void {
  const per = energy / Math.max(to - from, STEP);
  const i0 = Math.floor(from / STEP), i1 = Math.floor(to / STEP);
  for (let i = Math.max(0, i0); i <= i1 && i < n; i++) dep[i] += per;
}

/**
 * Condense the 2 mm deposit into 1 cm samples: temporary cavity from the deposit smoothed over
 * ≈ 2 cm (the cavity is a continuum), crush channel from the presented width, tears from the
 * hoop-strain limit (wider where fragments riddled the gel first).
 */
function buildProfile(w: WoundProfile, dep: Float64Array, yawAt: Float64Array, widthAt: Float64Array, n: number): void {
  const used = Math.max(1, Math.min(n, Math.ceil(w.length / STEP) + 1));
  const half = 5;
  const smooth = new Float64Array(used);
  for (let i = 0; i < used; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(used - 1, i + half); j++) {
      s += dep[j]!;
      c++;
    }
    smooth[i] = s / c;
  }
  const per = Math.max(1, Math.round(SAMPLE / STEP));
  for (let i0 = 0; i0 < used; i0 += per) {
    let cav = 0, width = 0, yaw = 0;
    for (let i = i0; i < Math.min(used, i0 + per); i++) {
      cav = Math.max(cav, cavityRadius(smooth[i]!));
      width = Math.max(width, widthAt[i]!);
      yaw = yawAt[i]!;
    }
    const s = Math.min(w.length, (i0 + per / 2) * STEP);
    const crush = 0.55 * width;
    const riddled = w.fragmentedAt >= 0 && s >= w.fragmentedAt && s < w.fragmentedAt + 0.1;
    cav = Math.max(cav, crush);
    w.s.push(s);
    w.cavity.push(cav);
    w.crush.push(riddled ? Math.max(crush, 0.15 * cav) : crush);
    w.fissure.push(Math.max(crush, fissureRadius(cav) * (riddled ? 1.3 : 1)));
    w.yaw.push(yaw);
    if (cav > w.maxCavity) {
      w.maxCavity = cav;
      w.maxCavityAt = s;
    }
  }
}

const _dir = new THREE.Vector3();

/**
 * Resolve a projectile meeting a tissue-simulant target (the first probe segment is gel or bone).
 * The event carries the wound profile; the target realises it (channel, tears, cavity, momentum).
 */
export function resolveTissue(p: ProjectileState, hit: RayHit, probe: ThicknessProbe, rng: Rng): ResolvedImpact {
  const a = p.ammo as AmmoData;
  const speed = p.velocity.length();
  const dir = _dir.copy(p.velocity).divideScalar(Math.max(speed, 1e-9));
  const obliq = Math.acos(clamp(-dir.dot(hit.normal), 0, 1));
  const mat = probe.segments[0]?.material ?? hit.material;
  const run = marchTissue(a, speed, p.mass, p.length, probe, rng, p.tissuePath ?? 0, !!p.destabilized);
  const w = run.wound;
  const perforated = !w.stopped && probe.exits && run.v > 1;
  const ke = 0.5 * p.mass * speed * speed;
  const ev: ResolvedImpact = {
    time: 0, ammo: a, agent: a.kind === 'fragment' ? 'fragment' : 'projectile',
    point: hit.point.clone(), direction: dir.clone(), normal: hit.normal.clone(), obliquity: obliq,
    speed, mass: p.mass, kineticEnergy: ke, outcome: perforated ? 'perforate' : 'embed', depth: w.length,
    residualSpeed: perforated ? run.v : 0, craterRadius: w.crush[0] ?? 0.5 * a.diameter, craterDepth: 0,
    tunnelRadius: Math.max(0, ...w.crush), spallRadius: 0, spallDepth: 0, damageRadius: w.maxCavity,
    energyAbsorbed: 0, momentum: new THREE.Vector3(), material: mat, targetKind: hit.target.kind,
    targetName: hit.target.name, summary: '', residualMass: perforated ? run.mass : p.mass,
    residualLength: p.length, exitDistance: w.length, wound: w, residualTissuePath: run.path,
  };
  if (perforated) {
    ev.exitPoint = hit.point.clone().addScaledVector(dir, w.length);
    // A yawing bullet leaves off its entry line: a few degrees for a sideways or tumbling round.
    const yawOut = w.yaw.length ? w.yaw[w.yaw.length - 1]! : 0;
    const dev = 0.01 + 0.08 * Math.abs(Math.sin(yawOut));
    ev.residualDirection = rng.inCone(dir, dev, new THREE.Vector3());
  }
  const keOut = 0.5 * ev.residualMass * ev.residualSpeed * ev.residualSpeed;
  ev.energyAbsorbed = Math.max(0, ke - keOut);
  // Fragments that broke off stay in the gel: their momentum is the target's too.
  ev.momentum.copy(dir).multiplyScalar(p.mass * speed);
  if (ev.residualDirection) ev.momentum.addScaledVector(ev.residualDirection, -ev.residualMass * ev.residualSpeed);
  ev.summary = tissueSummary(ev, `${a.name} ${speed.toFixed(0)} m/s → ${mat.nameTr}`, w);
  return ev;
}

function cm(m: number): string {
  return m >= 0.1 ? `${(m * 100).toFixed(0)} cm` : fmtLength(m);
}

/** One-line Turkish summary for the telemetry panel. */
function tissueSummary(ev: ResolvedImpact, name: string, w: WoundProfile): string {
  const parts: string[] = [];
  if (w.neck >= 0) parts.push(`boyun ${cm(w.neck)}`);
  parts.push(`geçici boşluk Ø${cm(2 * w.maxCavity)} @ ${cm(w.maxCavityAt)}`);
  if (w.fragmentedAt >= 0) parts.push(`${cm(w.fragmentedAt)}'de parçalandı (%${Math.round((100 * w.massLost) / Math.max(ev.mass, 1e-9))})`);
  const broken = w.bones.filter((b) => b.broken).length;
  if (broken) parts.push(broken > 1 ? `${broken} kemik kırıldı` : 'kemik kırıldı');
  const what = ev.outcome === 'perforate' ? `DELDİ ${cm(w.length)}, çıkış ${ev.residualSpeed.toFixed(0)} m/s` : `DURDU ${cm(w.length)}`;
  return `${name}: ${what} · ${parts.join(', ')} (Poncelet, sapma profili)`;
}

/**
 * A shaped-charge jet through gel: a narrow channel and a cavity from the jet's energy deposit
 * (it loses almost nothing in gel, so the channel is straight and thin).
 */
export function jetWound(length: number, cone: number, energyPerLength: number): WoundProfile {
  const w: WoundProfile = {
    s: [], cavity: [], crush: [], fissure: [], yaw: [], length, stopped: false, neck: -1,
    maxCavity: 0, maxCavityAt: 0, fragmentedAt: -1, massLost: 0, fragments: [], bones: [],
  };
  const R = Math.max(cavityRadius(energyPerLength), 0.2 * cone);
  for (let s = 0; s <= length + 1e-9; s += SAMPLE) {
    w.s.push(s);
    w.cavity.push(R);
    w.crush.push(0.1 * cone);
    w.fissure.push(Math.max(0.1 * cone, fissureRadius(R)));
    w.yaw.push(0);
  }
  w.maxCavity = R;
  w.maxCavityAt = 0;
  return w;
}

/** Speed after a run of tissue for a nose-first round (used when gel lies behind armour in one probe). */
export function tissueRunSpeed(a: AmmoSpec, v: number, mass: number, len: number, m: MaterialProps): number {
  const A = 0.25 * Math.PI * a.diameter * a.diameter;
  return ponceletSpeed(v, len, mass, A, a.kind === 'fragment' ? GEL_CD.fragment : GEL_CD.nose, m.density, tissueResistance(m));
}
