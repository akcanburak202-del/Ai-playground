import type { WeaponSpec } from '../app/contracts.ts';
import type { AmmoSpec, BlastKind, ImpactEvent } from '../physics/ballistics/types.ts';
import { blastAt, hemisphericalCharge } from '../physics/ballistics/blast.ts';
import { EARDRUM_THRESHOLD_PA, WINDOW_BREAK_PA, splFromPressure } from '../audio/acoustics.ts';
import { fmtDeg, fmtDistance, fmtEnergy, fmtLength, fmtMass, fmtPressure, fmtRpm, fmtSpeed, fmtTime, num, fmtDb } from './format.ts';
import { KIND_TR, OUTCOME_TR, caliberTr } from './i18n.ts';

/**
 * What the HUD says about impacts, blasts and weapons, as plain data. Pure (no DOM) so the
 * numbers and their Turkish wording are unit-tested.
 */

export interface ImpactRow {
  /** Same round, same target, same material, same result: rows with one key are merged (×N) */
  key: string;
  /** How many impacts this row stands for */
  count: number;
  ammo: string;
  material: string;
  outcome: ImpactEvent['outcome'];
  outcomeTr: string;
  speed: string;
  obliquity: string;
  depth: string;
  residual: string;
  energy: string;
  /** Turkish description of what happened to the target */
  description: string;
  /** The resolver's own one-line model summary */
  model: string;
  /** The round had already gone through something (it hit what lies behind a holed target) */
  secondary: boolean;
  /** '' for a primary hit, else e.g. "2. hedef" (the round's second target) */
  follow: string;
}

/**
 * Did this impact come from a round that had already perforated something? Uses the resolver's
 * `priorPerforations` when it reports one; `undefined` when it does not (the caller may guess).
 */
export function followThrough(e: ImpactEvent): boolean | undefined {
  if (e.agent !== 'projectile') return e.agent === 'fragment' ? false : undefined;
  return e.priorPerforations === undefined ? undefined : e.priorPerforations > 0;
}

export function impactRow(e: ImpactEvent, secondary = followThrough(e) ?? false): ImpactRow {
  const n = e.priorPerforations ?? 0;
  return {
    key: `${e.ammo.id}|${e.agent}|${e.targetKind}|${e.targetName ?? ''}|${e.material.id}|${e.outcome}|${secondary ? 'b' : 'a'}`,
    count: 1,
    ammo: e.agent === 'jet' ? `${e.ammo.name} · jet` : e.ammo.name,
    material: e.material.nameTr,
    outcome: e.outcome,
    outcomeTr: OUTCOME_TR[e.outcome],
    speed: fmtSpeed(e.speed),
    obliquity: fmtDeg(e.obliquity),
    depth: fmtLength(e.depth),
    residual: fmtSpeed(e.residualSpeed),
    energy: fmtEnergy(e.energyAbsorbed),
    description: describeImpact(e),
    model: e.summary,
    secondary,
    follow: secondary ? (n > 0 ? `${n + 1}. hedef` : 'Arkadaki hedef') : '',
  };
}

export function describeImpact(e: ImpactEvent): string {
  const d = (m: number) => fmtLength(2 * m);
  const cls = e.material.class;
  if (e.agent === 'jet') {
    return e.outcome === 'perforate'
      ? `Oyuk dolgu jeti ${fmtLength(e.depth)} kesiti deldi · delik Ø${d(e.tunnelRadius)}`
      : `Oyuk dolgu jeti ${fmtLength(e.depth)} nüfuz etti · delik Ø${d(e.tunnelRadius)}`;
  }
  switch (e.outcome) {
    case 'ricochet':
      return `Sekti · çıkış hızı ${fmtSpeed(e.residualSpeed)} · yüzeyde iz Ø${d(e.craterRadius)}`;
    case 'shatter':
      return `Mermi sert yüzeyde parçalandı · göçük ${fmtLength(e.craterDepth)}`;
    case 'perforate': {
      const spall = e.spallRadius > 0 ? ` · arka yüz kavlaması Ø${d(e.spallRadius)}` : '';
      if (cls === 'ductile') return `Levhayı deldi · delik Ø${d(e.tunnelRadius)} · kalıntı hız ${fmtSpeed(e.residualSpeed)}${spall}`;
      if (cls === 'glass') return `Camı deldi · delik Ø${d(Math.max(e.tunnelRadius, e.craterRadius * 0.3))} · çatlak bölgesi Ø${d(e.damageRadius)}`;
      return `Kesiti deldi (${fmtLength(e.depth)}) · giriş krateri Ø${d(e.craterRadius)} · kalıntı hız ${fmtSpeed(e.residualSpeed)}${spall}`;
    }
    default: {
      if (cls === 'ductile') return `Göçük / nüfuz ${fmtLength(e.depth)} · plastik bölge Ø${d(e.damageRadius)}`;
      if (cls === 'glass') return `Cam çatladı · çatlak bölgesi Ø${d(e.damageRadius)}`;
      if (cls === 'soil') return `Zeminde krater Ø${d(e.craterRadius)} × ${fmtLength(e.craterDepth)}`;
      const spall = e.spallRadius > 0 ? ` · arka yüz kavlaması Ø${d(e.spallRadius)}` : '';
      return `Krater Ø${d(e.craterRadius)} × ${fmtLength(e.craterDepth)} · nüfuz ${fmtLength(e.depth)} · mikro çatlak Ø${d(e.damageRadius)}${spall}`;
    }
  }
}

/** Points kept of a group's depth profile (older ones are merged pairwise as the burst goes on) */
export const PROFILE_POINTS = 96;

/**
 * Consecutive hits on one spot of one target. The resolver measures each round's depth from the
 * surface it met, and after the first rounds that surface is the floor of the crater the earlier
 * rounds dug (and the damaged material around it resists less). Measured from the first hit's
 * entry plane, the group's deepest reach is the depth of the cavity, so a burst on one spot reads
 * as a number that keeps growing — the progressive damage the simulation is about, made visible.
 */
export class HitGroup {
  count = 0;
  /** Cavity depth (deepest reach so far) after each hit, m; ≤ PROFILE_POINTS entries, `stride` hits each */
  readonly profile: number[] = [];
  stride = 1;
  /** Deepest reach so far, m */
  deepest = 0;
  /** Reach of the first hit, m */
  first = 0;
  /** Hit number (1-based) that first went through, 0 while none has */
  perforatedAt = 0;
  /** Member thickness along the normal, known once a hit went through, m */
  thickness = NaN;
  material = '';
  /** Sim time of the latest hit, s */
  lastTime = -Infinity;
  /** Hits, decayed with a 0.5 s time constant: how hard this spot is being worked right now */
  activity = 0;
  private key = '';
  /** First entry point: the depth reference plane passes through it */
  private ox = 0;
  private oy = 0;
  private oz = 0;
  /** Centre of the spot, world (mean of the hits, in that plane): a wide burst is judged from its middle. Read-only outside. */
  cx = 0;
  cy = 0;
  cz = 0;
  private nx = 0;
  private ny = 0;
  private nz = 1;
  private radius = 0;
  /** The weapon's 95 % group radius at this range, m */
  private spread = 0;

  static keyOf(e: ImpactEvent): string {
    return `${e.targetKind}|${e.targetName ?? ''}`;
  }

  /**
   * Squared lateral distance of a hit from this spot's centre, m², or Infinity unless it is on the
   * same target, within the spot's radius and not in front of the first hit's surface.
   */
  distance2(e: ImpactEvent): number {
    if (this.count === 0 || HitGroup.keyOf(e) !== this.key) return Infinity;
    const d = this.below(e.point);
    if (!(d > -0.05 && d < 3)) return Infinity;
    // Lateral offset from the spot's centre, in the first hit's entry plane.
    const lx = e.point.x + d * this.nx - this.cx, ly = e.point.y + d * this.ny - this.cy, lz = e.point.z + d * this.nz - this.cz;
    const r2 = lx * lx + ly * ly + lz * lz;
    // Judged from a centre estimated from n hits, a round of the same group lies within the 95 %
    // radius × √(1 + 1/n) (the centre's own scatter adds σ²/n).
    const r = Math.max(this.radius, this.spread * Math.sqrt(1 + 1 / this.count));
    return r2 <= r * r ? r2 : Infinity;
  }

  /** Start a group at this hit; `minRadius` widens the spot for a dispersed weapon (m). */
  begin(e: ImpactEvent, minRadius = 0): void {
    this.key = HitGroup.keyOf(e);
    this.count = 0;
    this.profile.length = 0;
    this.stride = 1;
    this.deepest = this.first = 0;
    this.perforatedAt = 0;
    this.thickness = NaN;
    this.activity = 0;
    this.lastTime = -Infinity;
    this.material = e.material.nameTr;
    this.ox = this.cx = e.point.x;
    this.oy = this.cy = e.point.y;
    this.oz = this.cz = e.point.z;
    const n = e.normal;
    const len = Math.hypot(n.x, n.y, n.z);
    const s = len > 1e-6 ? 1 / len : 0;
    this.nx = len > 1e-6 ? n.x * s : -e.direction.x;
    this.ny = len > 1e-6 ? n.y * s : -e.direction.y;
    this.nz = len > 1e-6 ? n.z * s : -e.direction.z;
    // "One spot": a few crater radii, at least 10 cm (a rifle burst at 30 m groups within that),
    // and the weapon's own 95 % group at this range when it is wider (a GAU-8 at 30 m: ≈ 0.2 m).
    this.radius = Math.max(0.1, 3 * e.craterRadius, 1.5 * e.tunnelRadius);
    this.spread = Number.isFinite(minRadius) ? Math.max(0, minRadius) : 0;
  }

  /** Record a hit this group takes (`distance2` finite, or right after `begin`). */
  push(e: ImpactEvent): void {
    // A tandem precursor and the main jet (or two jets of one round) arrive in the same step:
    // one round, one hit.
    const sameRound = this.count > 0 && Math.abs(e.time - this.lastTime) < 1e-4;
    if (!sameRound) {
      this.activity = this.activityAt(e.time) + 1;
      this.count++;
      const d = this.below(e.point);
      if (Number.isFinite(d)) {
        const k = 1 / Math.min(this.count, 32);
        this.cx += (e.point.x + d * this.nx - this.cx) * k;
        this.cy += (e.point.y + d * this.ny - this.cy) * k;
        this.cz += (e.point.z + d * this.nz - this.cz) * k;
      }
    }
    this.lastTime = e.time;
    const cos = Math.max(0, -(e.direction.x * this.nx + e.direction.y * this.ny + e.direction.z * this.nz));
    const reach = this.below(e.point) + (Number.isFinite(e.depth) ? e.depth : 0) * cos;
    if (e.outcome === 'perforate') {
      const t = e.exitPoint ? this.below(e.exitPoint) : reach;
      if (Number.isFinite(t) && t > 0) this.thickness = Number.isFinite(this.thickness) ? Math.max(this.thickness, t) : t;
      if (!this.perforatedAt) this.perforatedAt = this.count;
    }
    const r = Number.isFinite(reach) ? Math.max(0, reach) : 0;
    if (this.count === 1 && !sameRound) this.first = r;
    this.deepest = Math.max(this.deepest, r);
    // Profile of the cavity: one point per `stride` hits; when full, merge pairs (it is monotone,
    // so the later of each pair is the pair).
    if (sameRound || (this.count - 1) % this.stride !== 0) {
      if (this.profile.length) this.profile[this.profile.length - 1] = this.deepest;
    } else {
      this.profile.push(this.deepest);
      if (this.profile.length > PROFILE_POINTS) {
        const tail = this.profile[PROFILE_POINTS]!; // the entry this hit just opened
        for (let i = 0; i < PROFILE_POINTS / 2; i++) this.profile[i] = this.profile[2 * i + 1]!;
        this.profile.length = PROFILE_POINTS / 2;
        this.profile.push(tail);
        this.stride *= 2;
      }
    }
  }

  /** Decayed hit count at sim time t (τ = 0.5 s). */
  activityAt(t: number): number {
    const dt = t - this.lastTime;
    return dt > 0 ? this.activity * Math.exp(-dt / 0.5) : this.activity;
  }

  /** Distance of p below the first entry plane, m (negative in front of it). */
  private below(p: { x: number; y: number; z: number }): number {
    return (this.ox - p.x) * this.nx + (this.oy - p.y) * this.ny + (this.oz - p.z) * this.nz;
  }
}

/** Anything with x, y, z (THREE.Vector3 or a plain object): keeps this module free of three.js. */
type XYZ = { x: number; y: number; z: number };

/**
 * The spots hit recently. A round that goes through a wall or a plate lands somewhere behind it,
 * and the rounds that follow it through the hole land there too: that is a spot of its own, but
 * not the one the viewer is working. So the readout shows, of the spots hit in the last second or
 * so that have a cavity to speak of (or were holed), the one nearest the crosshair.
 */
export class HitGroups {
  readonly list: HitGroup[] = [];
  current: HitGroup | null = null;
  private readonly max: number;

  constructor(max = 6) {
    this.max = max;
  }

  /** Add an impact; `minRadius` is the weapon's 95 % group radius at the impact's range, m. */
  add(e: ImpactEvent, minRadius = 0): HitGroup | null {
    if (e.agent === 'fragment') return null;
    // Of the spots that take it, the one being worked hardest (a burst's outliers do not pull
    // its rounds away into side groups), then the nearest (neighbouring spots keep their own).
    let g: HitGroup | null = null;
    let takeD2 = Infinity;
    let takeA = -1;
    for (const x of this.list) {
      const d2 = x.distance2(e);
      if (d2 === Infinity) continue;
      const a = x.activityAt(e.time);
      if (a > takeA + 0.25 || (a > takeA - 0.25 && d2 < takeD2)) {
        takeD2 = d2;
        takeA = a;
        g = x;
      }
    }
    if (!g) {
      if (this.list.length < this.max) this.list.push((g = new HitGroup()));
      else {
        // Recycle the idlest spot, never the one on display.
        let idle = 0;
        let low = Infinity;
        this.list.forEach((x, i) => {
          const a = x === this.current ? Infinity : x.activityAt(e.time);
          if (a < low) {
            low = a;
            idle = i;
          }
        });
        g = new HitGroup();
        this.list[idle] = g;
      }
      g.begin(e, minRadius);
    }
    g.push(e);
    return g;
  }

  /**
   * Choose the spot on display at sim time t for a viewer at `eye` looking along `fwd` (unit):
   * of the spots hit lately with at least two hits and a cavity (≥ 1 mm) or a hole, the one at
   * the smallest angle from the crosshair. With none, the current one stays — unless the latest
   * hit (`latest`) went elsewhere and the current spot has gone quiet: then nothing is shown
   * rather than a stale spot.
   */
  select(t: number, eye: XYZ, fwd: XYZ, latest: HitGroup | null = null): HitGroup | null {
    let best: HitGroup | null = null;
    let bestCos = -2;
    for (const x of this.list) {
      if (x.count < 2 || x.activityAt(t) < 0.3 || !(x.deepest >= 0.001 || x.perforatedAt > 0)) continue;
      const dx = x.cx - eye.x, dy = x.cy - eye.y, dz = x.cz - eye.z;
      const len = Math.hypot(dx, dy, dz);
      const cos = len > 1e-6 ? (dx * fwd.x + dy * fwd.y + dz * fwd.z) / len : 1;
      if (cos > bestCos) {
        bestCos = cos;
        best = x;
      }
    }
    if (best) this.current = best;
    else if (latest && this.current && this.current !== latest && this.current.activityAt(t) < 0.3) this.current = null;
    return this.current;
  }

  reset(): void {
    this.list.length = 0;
    this.current = null;
  }
}

export interface GroupLine {
  /** e.g. "Aynı nokta · 14. isabet" */
  head: string;
  /** Cavity depth after the first round → now, e.g. "oyuk 21 → 118 mm" */
  depth: string;
  /** e.g. "11. isabette delindi · kesit 250 mm" ('' until something went through) */
  note: string;
}

/** Turkish readout of a hit group (null until a second round lands on the spot). */
export function groupLine(g: HitGroup | null): GroupLine | null {
  if (!g || g.count < 2) return null;
  const mm = g.deepest < 1;
  const first = mm ? num(g.first * 1000, g.first < 0.01 ? 1 : 0) : fmtLength(g.first);
  const notes: string[] = [];
  if (g.perforatedAt) notes.push(`${g.perforatedAt}. isabette delindi`);
  if (Number.isFinite(g.thickness)) notes.push(`kesit ${fmtLength(g.thickness)}`);
  return { head: `Aynı nokta · ${g.count}. isabet`, depth: `oyuk ${first} → ${fmtLength(g.deepest)}`, note: notes.join(' · ') };
}

/**
 * Glass breakage and eardrum thresholds of incident overpressure: ≈ 1 kPa first panes crack,
 * ≈ 6.9 kPa (1 psi) typical windows shatter, ≈ 34.5 kPa (5 psi) eardrum rupture threshold
 * (Glasstone & Dolan 1977, Table 12.38; UFC 3-340-02 §2-15).
 */
export const WINDOWS_SHATTER_PA = 6_900;

export interface BlastRow {
  tnt: string;
  distance: string;
  overpressure: string;
  arrival: string;
  spl: string;
  note: string;
  warn: boolean;
  label: string;
  /** Raw values for tests */
  ps: number;
  ta: number;
}

/** Blast as experienced at the viewer (Kingery–Bulmash incident values via the ballistics module). */
export function blastRow(e: { center: { x: number; y: number; z: number; distanceTo(p: { x: number; y: number; z: number }): number }; tntKg: number; kind: BlastKind; normal?: unknown; label?: string }, viewer: { x: number; y: number; z: number }): BlastRow {
  const onSurface = !!e.normal || e.kind === 'contact' || e.kind === 'hesh';
  const W = hemisphericalCharge(e.tntKg, e.center.y, onSurface);
  const r = Math.max(0.3, e.center.distanceTo(viewer));
  const bp = blastAt(W, r, e.kind === 'thermobaric');
  const ps = bp.ps;
  let note = 'Hasar eşiklerinin altında';
  let warn = false;
  if (ps >= EARDRUM_THRESHOLD_PA) {
    note = `Kulak zarı yırtılma eşiği aşıldı (≥ ${fmtPressure(EARDRUM_THRESHOLD_PA)})`;
    warn = true;
  } else if (ps >= WINDOWS_SHATTER_PA) note = `Pencereler kırılır (≥ ${fmtPressure(WINDOWS_SHATTER_PA)})`;
  else if (ps >= WINDOW_BREAK_PA) note = `Cam kırılma başlangıcı (≈ ${fmtPressure(WINDOW_BREAK_PA)})`;
  return {
    tnt: fmtMass(e.tntKg),
    distance: fmtDistance(r),
    overpressure: fmtPressure(ps),
    arrival: fmtTime(bp.ta),
    spl: fmtDb(splFromPressure(ps)),
    note,
    warn,
    label: e.label ?? '',
    ps,
    ta: bp.ta,
  };
}

export interface SpecItem {
  label: string;
  value: string;
  /** Highlight (the number that defines this round) */
  hi?: boolean;
}

/** Real specifications of the selected weapon and round, for the weapon card. */
export function weaponSpecs(w: WeaponSpec, a: AmmoSpec): SpecItem[] {
  const out: SpecItem[] = [];
  const massLabel = a.kind === 'apfsds' ? 'Delici kütlesi' : w.delivery === 'placed' ? 'Şarj kütlesi' : a.rocket || a.guidance ? 'Roket kütlesi' : w.category === 'airstrike' ? 'Bomba kütlesi' : 'Mermi kütlesi';
  out.push({ label: massLabel, value: fmtMass(a.mass) });
  if (w.delivery === 'indirect' && w.indirect) {
    const v = w.indirect.impactSpeed;
    out.push({ label: 'Çarpma hızı', value: fmtSpeed(v) });
    out.push({ label: 'Kinetik enerji', value: fmtEnergy(0.5 * a.mass * v * v) });
  } else if (w.delivery !== 'placed') {
    out.push({ label: a.rocket ? 'Fırlatma hızı' : 'Namlu çıkış hızı', value: fmtSpeed(a.muzzleVelocity) });
    // Muzzle energy E = ½ m v²
    out.push({ label: a.rocket ? 'Fırlatma enerjisi' : 'Namlu enerjisi', value: fmtEnergy(0.5 * a.mass * a.muzzleVelocity * a.muzzleVelocity), hi: a.kind === 'ball' || a.kind === 'ap' || a.kind === 'apfsds' });
  }
  if (a.kind === 'heat' && a.heatPenetrationRHA) out.push({ label: 'Delme (RHA)', value: `${num(a.heatPenetrationRHA * 1000, 0)} mm`, hi: true });
  if ((a.explosiveTNT ?? 0) > 0) out.push({ label: 'TNT eşdeğeri', value: fmtMass(a.explosiveTNT!), hi: a.kind !== 'heat' });
  if (w.delivery === 'direct') out.push({ label: 'Atış hızı', value: fmtRpm(w.rpm) });
  if (w.delivery === 'direct' && w.dispersionMOA > 0) out.push({ label: 'Dağılım', value: `${num(w.dispersionMOA, 1)} MOA 1σ` });
  if (w.delivery === 'indirect' && w.indirect) {
    out.push({ label: 'Dalış açısı', value: `${num(w.indirect.descentDeg, 0)}°` });
    if (w.indirect.errorM > 0) out.push({ label: 'İsabet sapması', value: `≈ ${num(w.indirect.errorM, 1)} m` });
  }
  if (w.delivery === 'placed' && w.placeRange) out.push({ label: 'Erişim', value: `${num(w.placeRange, 0)} m` });
  return out;
}

/**
 * The numbers that define this weapon and round, on one line for the collapsed weapon card:
 * what it delivers (penetration, explosive, energy) and how (speed, rate). At most three.
 */
export function weaponSummary(w: WeaponSpec, a: AmmoSpec): string {
  const parts: string[] = [];
  const tnt = a.explosiveTNT ?? 0;
  if (w.delivery === 'placed') {
    parts.push(`${fmtMass(tnt > 0 ? tnt : a.mass)} TNT-e`);
    if (w.placeRange) parts.push(`erişim ${num(w.placeRange, 0)} m`);
    return parts.join(' · ');
  }
  if (a.kind === 'heat' && a.heatPenetrationRHA) parts.push(`${num(a.heatPenetrationRHA * 1000, 0)} mm RHA`);
  const v = w.delivery === 'indirect' && w.indirect ? w.indirect.impactSpeed : a.muzzleVelocity;
  if (tnt > 0 && a.kind !== 'heat') parts.push(`${fmtMass(tnt)} TNT-e`);
  parts.push(fmtSpeed(v));
  if (a.kind === 'ball' || a.kind === 'ap' || a.kind === 'apfsds' || tnt === 0) parts.push(fmtEnergy(0.5 * a.mass * v * v));
  if (w.delivery === 'direct' && w.fireMode === 'auto') parts.push(fmtRpm(w.rpm));
  return parts.slice(0, 3).join(' · ');
}

export function ammoLine(a: AmmoSpec): string {
  return `${KIND_TR[a.kind] ?? a.kind} · ${caliberTr(a.caliber)}`;
}
