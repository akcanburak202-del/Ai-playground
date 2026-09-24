import type { WeaponCategory } from '../app/contracts.ts';
import type { ImpactOutcome, ProjectileKind, BlastKind } from '../physics/ballistics/types.ts';

/**
 * Turkish labels. The arsenal and ammunition tables are in English (they cite English sources);
 * the interface speaks Turkish with precise engineering terms, falling back to the table text
 * for anything not translated here.
 */

export const CATEGORY_TR: Record<WeaponCategory, string> = {
  rifle: 'Piyade tüfeği',
  mg: 'Makineli tüfek',
  sniper: 'Keskin nişancı',
  launcher: 'Roketatar / füze',
  cannon: 'Top',
  artillery: 'Topçu',
  airstrike: 'Hava desteği',
  demolition: 'Yıkım şarjı',
};

/** Short slot labels for the weapon strip */
export const CATEGORY_SHORT_TR: Record<WeaponCategory, string> = {
  rifle: 'Tüfek',
  mg: 'Makineli',
  sniper: 'Nişancı',
  launcher: 'Atar',
  cannon: 'Top',
  artillery: 'Topçu',
  airstrike: 'Hava',
  demolition: 'Şarj',
};

export const ROLE_TR: Record<string, string> = {
  m4a1: 'ABD karabinası · 5,56 mm NATO',
  m249: 'ABD hafif makineli tüfeği (SAW) · 5,56 mm',
  m240b: 'ABD orta makineli tüfeği · 7,62 mm NATO',
  pkm: 'Sovyet genel maksatlı makineli tüfek · 7,62×54R',
  m2hb: 'ABD ağır makineli tüfeği · 12,7 mm (sehpa)',
  m107: 'Anti-materyal tüfeği · 12,7 mm',
  m134: 'Altı namlulu döner makineli tüfek · 7,62 mm',
  gau8: 'A-10 uçağının 30 mm döner namlulu topu',
  m320: '40 mm bombaatar',
  rpg7: 'Omuzdan atılan roketatar',
  carlgustaf: '84 mm geri tepmesiz top',
  javelin: 'Ateşle-unut tanksavar füzesi (tepeden vuruş)',
  tankgun: 'M256 düz namlu (Abrams) · L30A1 yivli (Challenger 2)',
  m777: '155 mm çekili obüs · endirekt atış',
  airstrike: 'GPS güdümlü bomba · F-15E / F-16',
  demo: 'C4 kalıp, doğrusal kesici şarj ve fünye',
};

/** Descriptive weapon names get a Turkish name; model designations (M4A1, RPG-7V2) stay as they are. */
export const NAME_TR: Record<string, string> = {
  tankgun: '120 mm tank topu',
  m777: 'M777 obüsü',
  airstrike: 'JDAM hava saldırısı',
  demo: 'Yıkım şarjları',
};

const CALIBER_TR: Record<string, string> = {
  'demolition charge': 'yıkım şarjı',
  '500 lb bomb': '500 lb (227 kg) bomba',
  '2 000 lb penetrator': '2000 lb (907 kg) delici bomba',
  '127 mm ATGM': '127 mm güdümlü tanksavar füzesi',
};

/** Calibre label in Turkish typography (decimal comma: 7,62×51 mm). */
export function caliberTr(c: string): string {
  if (CALIBER_TR[c]) return CALIBER_TR[c]!;
  return c
    .replace('linear shaped charge', 'doğrusal oyuk şarj')
    .replace('smoothbore', 'düz namlu')
    .replace('rifled', 'yivli')
    .replace(/(\d)\.(\d)/g, '$1,$2');
}

export const KIND_TR: Record<ProjectileKind, string> = {
  ball: 'Kurşun çekirdekli (ball)',
  ap: 'Zırh delici (AP)',
  apfsds: 'Kanatçıklı alt-kalibre (APFSDS)',
  heat: 'Oyuk dolgulu (HEAT)',
  he: 'Yüksek infilaklı (HE)',
  hesh: 'Plastik başlı (HESH)',
  thermobaric: 'Termobarik',
  fragment: 'Parça tesirli',
};

export const OUTCOME_TR: Record<ImpactOutcome, string> = {
  perforate: 'Deldi',
  embed: 'Delmedi',
  ricochet: 'Sekme',
  shatter: 'Parçalandı',
};

export const BLAST_TR: Record<BlastKind, string> = {
  he: 'HE',
  thermobaric: 'Termobarik',
  hesh: 'HESH',
  contact: 'Temas şarjı',
  shaped: 'Oyuk şarj',
};

export const TARGET_TR: Record<string, string> = {
  voxel: 'Yapı elemanı',
  plate: 'Çelik levha',
  beam: 'Çelik kiriş',
  glass: 'Cam panel',
  terrain: 'Zemin',
  rebar: 'Donatı',
};

/** Turkish upper case (dotted İ, dotless I) for labels that are set in capitals in code. */
export function upperTr(s: string): string {
  return s.toLocaleUpperCase('tr-TR');
}

export interface HelpEntry {
  keys: string[];
  label: string;
}

export const HELP_DESKTOP: { title: string; entries: HelpEntry[] }[] = [
  {
    title: 'Hareket',
    entries: [
      { keys: ['Fare'], label: 'Bakış (tıkla: fare kilidi)' },
      { keys: ['W', 'A', 'S', 'D'], label: 'Uçuş' },
      { keys: ['Space', 'E'], label: 'Yüksel' },
      { keys: ['Q', 'Ctrl'], label: 'Alçal' },
      { keys: ['Shift'], label: 'Hızlı (25 m/s)' },
    ],
  },
  {
    title: 'Ateş',
    entries: [
      { keys: ['Sol tık'], label: 'Tetik (basılı tut: seri atış)' },
      { keys: ['Sağ tık', 'Z'], label: 'Nişan / dürbün' },
      { keys: ['1–8'], label: 'Silah grubu (tekrar bas: sıradaki)' },
      { keys: ['Tekerlek'], label: 'Silah değiştir' },
      { keys: ['T', 'Orta tık'], label: 'Mühimmat değiştir' },
      { keys: ['G'], label: 'Yıkım şarjı / şarj yerleştir' },
      { keys: ['X'], label: 'Şarjları birlikte patlat' },
      { keys: ['B'], label: 'Şarjları sırayla patlat' },
    ],
  },
  {
    title: 'Görüntü',
    entries: [
      { keys: ['F', 'Tab'], label: 'Ağır çekim ×0,10' },
      { keys: ['C'], label: 'Mermi kamerası (roket, top mermisi, bomba)' },
      { keys: ['R'], label: 'Sahneyi yeniden kur' },
      { keys: ['M'], label: 'Sesi aç / kapat' },
      { keys: ['V'], label: 'Arayüzü gizle (temiz görüntü)' },
      { keys: ['H'], label: 'Bu yardım' },
      { keys: ['Esc'], label: 'Menü' },
    ],
  },
];

export const HELP_TOUCH: HelpEntry[] = [
  { keys: ['Sol yarı'], label: 'Hareket çubuğu (parmağın değdiği yerde)' },
  { keys: ['Sağ yarı'], label: 'Sürükle: bakış' },
  { keys: ['Ateş'], label: 'Tetik (basılı tut: seri atış)' },
  { keys: ['Yukarı', 'Aşağı'], label: 'Yüksel / alçal' },
  { keys: ['Silah'], label: 'Sıradaki silah' },
  { keys: ['Mühimmat'], label: 'Mühimmat değiştir' },
  { keys: ['Nişan'], label: 'Nişan / dürbün' },
  { keys: ['Ağır çekim'], label: 'Ağır çekim ×0,10' },
  { keys: ['Patlat'], label: 'Şarjları ateşle' },
  { keys: ['Kamera'], label: 'Mermi kamerası' },
  { keys: ['Menü'], label: 'Sahne menüsü' },
];
