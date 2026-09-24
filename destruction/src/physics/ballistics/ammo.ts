import type { AmmoSpec } from './types.ts';

/**
 * Ammunition database (SI units). Figures are open-source values: US Army TM 43-0001-27 (small
 * calibre data sheets), TM 43-0001-28 (artillery), manufacturer data (Nammo, Saab, General
 * Dynamics OTS), and Jane's Ammunition Handbook as reproduced in open literature. Where sources
 * disagree the more conservative value is used and the spread is noted in `source`.
 *
 * `AmmoData` extends the shared `AmmoSpec` with the few extra numbers the terminal-ballistics
 * models need (hard-core geometry, tandem/follow-through charges, rated penetration for
 * validation). Every `AmmoData` is a valid `AmmoSpec`, so the rest of the app never needs to know.
 */
export interface AmmoData extends AmmoSpec {
  /** Diameter of the hard penetrating core when it differs from the bullet (AP cores, sub-calibre bodies), m */
  coreDiameter?: number;
  /** Length of that core, m */
  coreLength?: number;
  /** Flow stress of the penetrator material for Alekseevskii–Tate, Pa (DU ≈ 1.4 GPa, W alloy ≈ 1.5 GPa, steel ≈ 1.0 GPa) */
  rodStrength?: number;
  /** Tandem HEAT precursor charge: rated RHA penetration, m */
  precursorRHA?: number;
  /** Anti-structure munition: HE bomblet sent through the precursor hole, detonated after `delay` s */
  followThrough?: { tntKg: number; casingMass: number; speed: number; delay: number };
  /** Linear cutting charge: blade-jet cut length and cut depth expressed in RHA, m */
  linearCut?: { length: number; depthRHA: number };
  /** Actual explosive fill: name, mass (kg) and relative effectiveness vs TNT */
  filler?: { name: string; mass: number; re: number };
  /** Self-destruct time after launch, s (RPG-7 grenades) */
  selfDestruct?: number;
  /** Published performance used to validate the models (see PHYSICS.md) */
  rated?: string;
  /** Where the numbers come from */
  source: string;
}

const TM27 = 'TM 43-0001-27 (Army Ammunition Data Sheets, Small Caliber)';

export const AMMO: Record<string, AmmoData> = {
  // ─── 5.56×45 mm NATO ────────────────────────────────────────────────────────────────────────
  m855: {
    id: 'm855', name: 'M855 ball', caliber: '5.56×45 mm NATO', kind: 'ball',
    mass: 0.00402, diameter: 0.0057, length: 0.0231, muzzleVelocity: 905, dragCd: 0.31,
    coreDensity: 11340, coreMass: 0.00072, coreDiameter: 0.0046, coreLength: 0.0105,
    noseFactor: 1.14, deformable: true, fuze: 'none',
    note: '62 gr (4.0 g) SS109-type bullet: lead core behind a 0.7 g hardened steel penetrator tip; 905 m/s from the M4A1',
    source: `${TM27}; STANAG 4172. G7 BC 0.151 → Cd ≈ 0.31 at Mach 2.6`,
  },
  m995: {
    id: 'm995', name: 'M995 AP', caliber: '5.56×45 mm NATO', kind: 'ap',
    mass: 0.00337, diameter: 0.0057, length: 0.0250, muzzleVelocity: 1000, dragCd: 0.30,
    coreDensity: 14900, coreMass: 0.0019, coreDiameter: 0.0041, coreLength: 0.0152,
    noseFactor: 1.14, deformable: false, fuze: 'none',
    note: '52 gr bullet with a tungsten-carbide penetrator; ≈ 1 000 m/s',
    rated: '≈ 12 mm RHA at 100 m (open sources)',
    source: `${TM27}; open-source penetration claims`,
  },

  // ─── 7.62×51 mm NATO ────────────────────────────────────────────────────────────────────────
  m80: {
    id: 'm80', name: 'M80 ball', caliber: '7.62×51 mm NATO', kind: 'ball',
    mass: 0.00953, diameter: 0.00782, length: 0.0288, muzzleVelocity: 840, dragCd: 0.30,
    coreDensity: 11340, noseFactor: 1.14, deformable: true, fuze: 'none',
    note: '147 gr gilding-metal-jacketed lead-antimony core; 840 m/s from the M240B',
    source: `${TM27}. G7 BC 0.200 → Cd ≈ 0.30 at Mach 2.4`,
  },
  m993: {
    id: 'm993', name: 'M993 AP', caliber: '7.62×51 mm NATO', kind: 'ap',
    mass: 0.0082, diameter: 0.00782, length: 0.0297, muzzleVelocity: 910, dragCd: 0.29,
    coreDensity: 14900, coreMass: 0.0045, coreDiameter: 0.0055, coreLength: 0.0127,
    noseFactor: 1.14, deformable: false, fuze: 'none',
    note: '126.6 gr bullet with a tungsten-carbide core (Nammo AP8 family); 910 m/s',
    rated: '≈ 12–18 mm RHA at 100 m (open sources)',
    source: `${TM27}; Nammo AP8 brochure`,
  },

  // ─── 7.62×54R ───────────────────────────────────────────────────────────────────────────────
  lps: {
    id: 'lps', name: '57-N-323S LPS', caliber: '7.62×54R', kind: 'ball',
    mass: 0.0096, diameter: 0.00792, length: 0.0325, muzzleVelocity: 825, dragCd: 0.31,
    coreDensity: 7850, coreMass: 0.0029, coreDiameter: 0.0058, coreLength: 0.0145,
    noseFactor: 1.14, deformable: true, fuze: 'none',
    note: 'Light ball with a mild-steel core in a lead sleeve (bimetal jacket); 825 m/s from the PKM',
    source: 'Soviet/Russian ammunition handbook data (open), GRAU index 57-N-323S',
  },

  // ─── 12.7×99 mm (.50 BMG) ───────────────────────────────────────────────────────────────────
  m33: {
    id: 'm33', name: 'M33 ball', caliber: '12.7×99 mm (.50 BMG)', kind: 'ball',
    mass: 0.0428, diameter: 0.01295, length: 0.0584, muzzleVelocity: 887, dragCd: 0.29,
    coreDensity: 7850, coreMass: 0.0265, coreDiameter: 0.0104, coreLength: 0.040,
    noseFactor: 1.14, deformable: true, fuze: 'none',
    note: '661 gr bullet with a soft-steel core; 887 m/s from the M2HB',
    source: `${TM27}. G7 BC ≈ 0.33`,
  },
  m2ap: {
    id: 'm2ap', name: 'M2 AP', caliber: '12.7×99 mm (.50 BMG)', kind: 'ap',
    mass: 0.0458, diameter: 0.01295, length: 0.0600, muzzleVelocity: 887, dragCd: 0.29,
    coreDensity: 7850, coreMass: 0.0256, coreDiameter: 0.0109, coreLength: 0.035,
    noseFactor: 1.14, deformable: false, fuze: 'none',
    note: '708 gr bullet with a hardened tungsten-chromium steel core',
    rated: '22 mm (0.875 in) armour plate at 100 yd; ≈ 19 mm at 500 yd',
    source: TM27,
  },
  m8api: {
    id: 'm8api', name: 'M8 API', caliber: '12.7×99 mm (.50 BMG)', kind: 'ap',
    mass: 0.0403, diameter: 0.01295, length: 0.0592, muzzleVelocity: 887, dragCd: 0.29,
    coreDensity: 7850, coreMass: 0.0240, coreDiameter: 0.0107, coreLength: 0.034,
    noseFactor: 1.14, deformable: false, fuze: 'none',
    note: '622 gr armour-piercing incendiary: hardened steel core, incendiary nose filler',
    rated: '≈ 20 mm armour plate at 100 yd',
    source: TM27,
  },
  mk211: {
    id: 'mk211', name: 'Mk 211 Raufoss', caliber: '12.7×99 mm (.50 BMG)', kind: 'ap',
    mass: 0.0430, diameter: 0.01295, length: 0.0607, muzzleVelocity: 890, dragCd: 0.29,
    coreDensity: 14900, coreMass: 0.012, coreDiameter: 0.0085, coreLength: 0.0145,
    noseFactor: 1.14, deformable: false, fuze: 'delay', fuzeDelay: 0.0003,
    explosiveTNT: 0.0024, casingMass: 0.012, gurney: 2800,
    filler: { name: 'RDX/PETN + zirconium incendiary', mass: 0.002, re: 1.2 },
    note: 'Multipurpose HEIAP: tungsten-carbide penetrator, small HE/zirconium charge that functions ~0.3 m behind the struck surface',
    rated: '11 mm armour steel at 45° at 1 000 m (Nammo)',
    source: 'Nammo MP NM140 / Mk 211 Mod 0 datasheet',
  },
  m903: {
    id: 'm903', name: 'M903 SLAP', caliber: '12.7×99 mm (.50 BMG)', kind: 'ap',
    mass: 0.0230, diameter: 0.00762, length: 0.0290, muzzleVelocity: 1204, dragCd: 0.33,
    coreDensity: 17600, noseFactor: 1.14, deformable: false, fuze: 'none', rodStrength: 1.5e9,
    note: 'Saboted light armour penetrator: 0.30-cal tungsten-alloy penetrator in a discarding plastic sabot, 1 204 m/s',
    rated: '19 mm (3/4 in) high-hardness armour at 1 500 m',
    source: TM27,
  },

  // ─── 30×173 mm (GAU-8/A) ────────────────────────────────────────────────────────────────────
  pgu14: {
    id: 'pgu14', name: 'PGU-14/B API', caliber: '30×173 mm', kind: 'ap',
    mass: 0.395, diameter: 0.030, length: 0.113, muzzleVelocity: 1013, dragCd: 0.30,
    coreDensity: 18600, coreMass: 0.302, coreDiameter: 0.0175, coreLength: 0.0675,
    noseFactor: 1.14, deformable: false, fuze: 'none', rodStrength: 1.4e9,
    note: 'Armour-piercing incendiary: 0.30 kg depleted-uranium sub-calibre penetrator in an aluminium body; pyrophoric flash',
    rated: '≈ 69 mm RHA at 500 m, 0° (GD-OTS; open sources)',
    source: 'General Dynamics OTS GAU-8/A ammunition data; USAF fact sheets',
  },
  pgu13: {
    id: 'pgu13', name: 'PGU-13/B HEI', caliber: '30×173 mm', kind: 'he',
    mass: 0.360, diameter: 0.030, length: 0.120, muzzleVelocity: 1040, dragCd: 0.30,
    coreDensity: 7850, noseFactor: 1.0, deformable: true, fuze: 'impact',
    explosiveTNT: 0.058, casingMass: 0.26, gurney: 2700,
    filler: { name: 'RDX/Al (PBXN-106 class)', mass: 0.046, re: 1.26 },
    note: 'High-explosive incendiary with a point-detonating fuze',
    source: 'General Dynamics OTS GAU-8/A ammunition data',
  },

  // ─── 40 mm low velocity ─────────────────────────────────────────────────────────────────────
  m433: {
    id: 'm433', name: 'M433 HEDP', caliber: '40×46 mm', kind: 'heat',
    mass: 0.230, diameter: 0.040, length: 0.098, muzzleVelocity: 76, dragCd: 0.40,
    coreDensity: 8960, noseFactor: 0.84, deformable: true, fuze: 'impact',
    explosiveTNT: 0.059, casingMass: 0.110, gurney: 2750,
    heatPenetrationRHA: 0.063, heatConeDiameter: 0.032,
    filler: { name: 'Composition A5', mass: 0.045, re: 1.3 },
    note: 'High-explosive dual-purpose: copper-lined shaped charge + fragmenting body; 76 m/s, visibly lobbed',
    rated: '≥ 63 mm (2 in) RHA; 5 m casualty radius',
    source: 'TM 43-0001-28; FM 3-22.31',
  },

  // ─── RPG-7 ──────────────────────────────────────────────────────────────────────────────────
  pg7vl: {
    id: 'pg7vl', name: 'PG-7VL', caliber: '93 mm (RPG-7)', kind: 'heat',
    mass: 2.6, diameter: 0.093, length: 0.95, muzzleVelocity: 115, dragCd: 0.34,
    coreDensity: 8960, noseFactor: 0.84, deformable: true, fuze: 'impact',
    explosiveTNT: 1.2, casingMass: 0.6, gurney: 2800,
    heatPenetrationRHA: 0.50, heatConeDiameter: 0.085,
    filler: { name: 'OKFOL (HMX/wax)', mass: 0.73, re: 1.6 },
    rocket: { thrust: 520, burnTime: 1.0, ignitionDelay: 0.096, propellantMass: 0.24 },
    selfDestruct: 4.5,
    note: 'HEAT grenade: booster to 115 m/s, sustainer lights ~11 m out and accelerates it to ~295 m/s; self-destructs after ~4.5 s',
    rated: '500 mm RHA; ≈ 1.5 m reinforced concrete',
    source: 'Bazalt / Jane\'s data (open); DIA-1100 threat handbooks',
  },
  tbg7v: {
    id: 'tbg7v', name: 'TBG-7V Tanin', caliber: '105 mm (RPG-7)', kind: 'thermobaric',
    mass: 4.5, diameter: 0.105, length: 1.20, muzzleVelocity: 115, dragCd: 0.38,
    coreDensity: 7850, noseFactor: 0.84, deformable: true, fuze: 'impact',
    explosiveTNT: 2.2, casingMass: 0.6, gurney: 2400,
    filler: { name: 'thermobaric mixture (metallised fuel-rich HE)', mass: 1.8, re: 1.2 },
    rocket: { thrust: 900, burnTime: 1.0, ignitionDelay: 0.096, propellantMass: 0.40 },
    selfDestruct: 4.5,
    note: 'Thermobaric grenade: long positive-phase impulse (~1.75× TNT impulse), weak fragmentation',
    rated: 'blast comparable to a 122 mm HE shell; lethal radius ~10 m',
    source: 'Bazalt data (open)',
  },
  og7v: {
    id: 'og7v', name: 'OG-7V', caliber: '40 mm (RPG-7)', kind: 'he',
    mass: 2.0, diameter: 0.040, length: 0.60, muzzleVelocity: 152, dragCd: 0.36,
    coreDensity: 7850, noseFactor: 0.84, deformable: true, fuze: 'impact',
    explosiveTNT: 0.28, casingMass: 0.95, gurney: 2600,
    filler: { name: 'A-IX-1 (phlegmatised RDX)', mass: 0.21, re: 1.35 },
    selfDestruct: 4.5,
    note: 'Fragmentation grenade without sustainer motor, 152 m/s',
    source: 'Bazalt data (open)',
  },

  // ─── Carl Gustaf 84 mm ──────────────────────────────────────────────────────────────────────
  ffv751: {
    id: 'ffv751', name: 'HEAT 751', caliber: '84 mm (Carl Gustaf)', kind: 'heat',
    mass: 4.0, diameter: 0.084, length: 0.70, muzzleVelocity: 215, dragCd: 0.32,
    coreDensity: 8960, noseFactor: 0.84, deformable: true, fuze: 'impact',
    explosiveTNT: 0.9, casingMass: 0.8, gurney: 2800, tandem: true, precursorRHA: 0.07,
    heatPenetrationRHA: 0.50, heatConeDiameter: 0.075,
    note: 'Tandem HEAT: precursor clears reactive armour, main charge penetrates > 500 mm RHA',
    rated: '> 500 mm RHA behind ERA (Saab)',
    source: 'Saab Bofors Dynamics Carl-Gustaf ammunition brochure',
  },
  ffv441: {
    id: 'ffv441', name: 'HE 441D', caliber: '84 mm (Carl Gustaf)', kind: 'he',
    mass: 3.1, diameter: 0.084, length: 0.62, muzzleVelocity: 240, dragCd: 0.32,
    coreDensity: 7850, noseFactor: 0.84, deformable: true, fuze: 'impact',
    explosiveTNT: 0.65, casingMass: 1.4, gurney: 2700,
    filler: { name: 'Composition B + ~800 steel balls', mass: 0.5, re: 1.33 },
    note: 'High-explosive round with pre-formed steel balls; impact or airburst fuze (impact modelled)',
    source: 'Saab Bofors Dynamics brochure',
  },
  asm509: {
    id: 'asm509', name: 'ASM 509', caliber: '84 mm (Carl Gustaf)', kind: 'heat',
    mass: 3.6, diameter: 0.084, length: 0.68, muzzleVelocity: 230, dragCd: 0.32,
    coreDensity: 8960, noseFactor: 0.84, deformable: true, fuze: 'impact',
    explosiveTNT: 0.2, casingMass: 0.3, gurney: 2700,
    heatPenetrationRHA: 0.15, heatConeDiameter: 0.070,
    followThrough: { tntKg: 0.55, casingMass: 0.45, speed: 180, delay: 0.004 },
    note: 'Anti-structure: a HEAT precursor holes the wall, then an HE follow-through charge enters the hole and detonates behind it',
    rated: 'mouse-hole in double-reinforced concrete; blast/frag inside the room',
    source: 'Saab Bofors Dynamics ASM 509 brochure (qualitative); charge sizes estimated',
  },

  // ─── FGM-148 Javelin ────────────────────────────────────────────────────────────────────────
  javelin: {
    id: 'javelin', name: 'FGM-148 Javelin', caliber: '127 mm ATGM', kind: 'heat',
    mass: 11.8, diameter: 0.127, length: 1.08, muzzleVelocity: 28, dragCd: 0.40,
    coreDensity: 8960, noseFactor: 0.84, deformable: true, fuze: 'impact',
    explosiveTNT: 2.8, casingMass: 1.5, gurney: 2800, tandem: true, precursorRHA: 0.12,
    heatPenetrationRHA: 0.78, heatConeDiameter: 0.12,
    rocket: { thrust: 720, burnTime: 3.2, ignitionDelay: 0.28, propellantMass: 1.25 },
    guidance: { mode: 'topAttack', maxAccel: 200, loftHeight: 150 },
    note: 'Fire-and-forget IR-guided missile: soft launch, flight motor lights clear of the gunner, climbs ~150 m and dives onto the top of the target',
    rated: '≈ 750–800 mm RHA (tandem, after ERA)',
    source: 'Javelin JV fact sheets (Raytheon/Lockheed); open estimates of penetration',
  },

  // ─── 120 mm tank ammunition ─────────────────────────────────────────────────────────────────
  m829a4: {
    id: 'm829a4', name: 'M829A4 APFSDS-T', caliber: '120 mm smoothbore (M256)', kind: 'apfsds',
    mass: 5.7, diameter: 0.022, length: 0.80, muzzleVelocity: 1555, dragCd: 0.95,
    coreDensity: 18600, noseFactor: 1.14, deformable: false, fuze: 'none', tracer: true, rodStrength: 1.4e9,
    note: 'Depleted-uranium long rod (working length ≈ 0.8 m, Ø 22 mm, L/D ≈ 36) after sabot discard; 1 555 m/s',
    rated: '≈ 700–800 mm RHA at 2 km (open estimates)',
    source: 'Orbital ATK/Northrop Grumman fact sheet (velocity); open-source rod geometry estimates',
  },
  m830a1: {
    id: 'm830a1', name: 'M830A1 HEAT-MP-T', caliber: '120 mm smoothbore (M256)', kind: 'heat',
    mass: 11.4, diameter: 0.080, length: 0.78, muzzleVelocity: 1410, dragCd: 0.36,
    coreDensity: 8960, noseFactor: 0.84, deformable: true, fuze: 'impact', tracer: true,
    explosiveTNT: 1.6, casingMass: 6.0, gurney: 2800,
    heatPenetrationRHA: 0.48, heatConeDiameter: 0.075,
    note: 'Multipurpose sub-calibre HEAT with fragmenting body; 1 410 m/s',
    rated: '≈ 480 mm RHA',
    source: 'TM 43-0001-28; open estimates',
  },
  m908: {
    id: 'm908', name: 'M908 HE-OR-T', caliber: '120 mm smoothbore (M256)', kind: 'he',
    mass: 11.4, diameter: 0.080, length: 0.78, muzzleVelocity: 1410, dragCd: 0.36,
    coreDensity: 7850, coreMass: 1.2, noseFactor: 1.14, deformable: false, fuze: 'delay', fuzeDelay: 0.0004, tracer: true,
    explosiveTNT: 1.6, casingMass: 6.0, gurney: 2800,
    note: 'Obstacle-reduction round: M830A1 body with a hardened steel nose cap that digs into concrete before a short-delay detonation',
    rated: 'reduces 1.2 m concrete obstacles (designed against dragon\'s teeth/walls)',
    source: 'TM 43-0001-28; PEO Ammunition fact sheet',
  },
  l31a7: {
    id: 'l31a7', name: 'L31A7 HESH', caliber: '120 mm rifled (L30A1, Challenger 2)', kind: 'hesh',
    mass: 17.1, diameter: 0.120, length: 0.45, muzzleVelocity: 670, dragCd: 0.30,
    coreDensity: 7850, noseFactor: 0.72, deformable: true, fuze: 'impact',
    explosiveTNT: 4.8, casingMass: 9.0, gurney: 2500,
    filler: { name: 'plasticised RDX (squash head)', mass: 4.1, re: 1.17 },
    note: 'British HESH: the plastic filler pats onto the surface and scabs the far face. Fired by the rifled L30A1 only — the M256 smoothbore cannot fire it',
    rated: 'scabs armour up to ~1.3 calibres; demolition of walls/bunkers',
    source: 'UK MoD / BAE data (open); Jane\'s',
  },

  // ─── Artillery and air-delivered ────────────────────────────────────────────────────────────
  m795: {
    id: 'm795', name: 'M795 HE', caliber: '155 mm (M777)', kind: 'he',
    mass: 46.7, diameter: 0.155, length: 0.80, muzzleVelocity: 827, dragCd: 0.30,
    coreDensity: 7850, noseFactor: 1.14, deformable: false, fuze: 'impact',
    explosiveTNT: 10.8, casingMass: 34.0, gurney: 2440,
    filler: { name: 'TNT (or IMX-101)', mass: 10.8, re: 1.0 },
    note: 'High-fragmentation-steel 155 mm shell, 10.8 kg TNT, PD fuze; arrives at 300–400 m/s on a steep descending branch',
    source: 'TM 43-0001-28; PEO Ammunition',
  },
  gbu38: {
    id: 'gbu38', name: 'GBU-38 JDAM (Mk 82)', caliber: '500 lb bomb', kind: 'he',
    mass: 241, diameter: 0.273, length: 2.35, muzzleVelocity: 270, dragCd: 0.22,
    coreDensity: 7850, noseFactor: 1.0, deformable: false, fuze: 'impact',
    explosiveTNT: 95, casingMass: 110, gurney: 2600,
    filler: { name: 'Tritonal (80/20 TNT/Al)', mass: 89, re: 1.07 },
    guidance: { mode: 'direct', maxAccel: 30 },
    note: 'GPS/INS guided Mk 82: 89 kg Tritonal (≈ 95 kg TNT-e), instantaneous fuze',
    source: 'USAF fact sheet (JDAM); Mk 82 data',
  },
  gbu31: {
    id: 'gbu31', name: 'GBU-31(V)3 JDAM (BLU-109)', caliber: '2 000 lb penetrator', kind: 'he',
    mass: 874, diameter: 0.368, length: 2.40, muzzleVelocity: 290, dragCd: 0.22,
    coreDensity: 7850, noseFactor: 1.14, deformable: false, fuze: 'delay', fuzeDelay: 0.015,
    explosiveTNT: 260, casingMass: 550, gurney: 2600,
    filler: { name: 'Tritonal', mass: 243, re: 1.07 },
    guidance: { mode: 'direct', maxAccel: 30 },
    note: 'Hardened 4340-steel penetrator: goes through ~1.8 m of reinforced concrete, then a delay fuze fires 243 kg Tritonal inside',
    rated: '1.8–2.4 m reinforced concrete',
    source: 'USAF fact sheet (BLU-109/B)',
  },

  // ─── Demolition ─────────────────────────────────────────────────────────────────────────────
  c4: {
    id: 'c4', name: 'M112 C4 block', caliber: 'demolition charge', kind: 'he',
    mass: 0.57, diameter: 0.051, length: 0.279, muzzleVelocity: 0, dragCd: 1.0,
    coreDensity: 1600, noseFactor: 0.72, deformable: true, fuze: 'none',
    explosiveTNT: 0.764,
    filler: { name: 'Composition C-4 (91 % RDX)', mass: 0.57, re: 1.34 },
    note: '1.25 lb (0.57 kg) block of C-4, RE 1.34 → 0.76 kg TNT-e; placed in contact and fired by detonator',
    source: 'FM 3-34.214 (Explosives and Demolitions)',
  },
  lsc: {
    id: 'lsc', name: 'Linear cutting charge', caliber: 'linear shaped charge, 0.6 m', kind: 'heat',
    mass: 0.35, diameter: 0.04, length: 0.6, muzzleVelocity: 0, dragCd: 1.0,
    coreDensity: 8960, noseFactor: 0.72, deformable: true, fuze: 'none',
    explosiveTNT: 0.16, heatPenetrationRHA: 0.026, heatConeDiameter: 0.02,
    linearCut: { length: 0.6, depthRHA: 0.026 },
    filler: { name: 'RDX core load 0.2 kg/m, copper chevron liner', mass: 0.12, re: 1.3 },
    note: 'Flexible linear shaped charge: a copper blade-jet cuts ~30 mm of structural steel along its length',
    source: 'Manufacturer LSC tables (≈ 1 000 gr/ft cuts ~28 mm mild steel)',
  },
};

export function getAmmo(id: string): AmmoData {
  const a = AMMO[id];
  if (!a) throw new Error(`Unknown ammunition "${id}"`);
  return a;
}

/** Extra data for an ammo spec (returns the spec itself; fields are optional). */
export function ammoData(a: AmmoSpec): Partial<AmmoData> & AmmoSpec {
  return a as Partial<AmmoData> & AmmoSpec;
}
