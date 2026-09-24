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
}

export function impactRow(e: ImpactEvent): ImpactRow {
  return {
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

interface IndirectData {
  indirect?: { impactSpeed: number };
  placeRange?: number;
}

/** Real specifications of the selected weapon and round, for the weapon card. */
export function weaponSpecs(w: WeaponSpec, a: AmmoSpec): SpecItem[] {
  const x = w as WeaponSpec & IndirectData;
  const out: SpecItem[] = [];
  const massLabel = a.kind === 'apfsds' ? 'Delici kütlesi' : w.delivery === 'placed' ? 'Şarj kütlesi' : a.rocket || a.guidance ? 'Roket kütlesi' : w.category === 'airstrike' ? 'Bomba kütlesi' : 'Mermi kütlesi';
  out.push({ label: massLabel, value: fmtMass(a.mass) });
  if (w.delivery === 'indirect' && x.indirect) {
    const v = x.indirect.impactSpeed;
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
  if (w.delivery === 'placed' && x.placeRange) out.push({ label: 'Erişim', value: `${num(x.placeRange, 0)} m` });
  return out;
}

export function ammoLine(a: AmmoSpec): string {
  return `${KIND_TR[a.kind] ?? a.kind} · ${caliberTr(a.caliber)}`;
}
