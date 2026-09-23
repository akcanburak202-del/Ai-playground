import { GPa, MPa } from '../core/units.ts';

/**
 * Engineering material database. Values are typical published figures (Eurocode 2/3, EN 10025,
 * MIL-DTL-12560 for RHA, ASTM C1036/C1048 for glass, dimension-stone datasheets). They feed the
 * terminal-ballistics and blast models directly, so change them with care.
 */

export type MaterialId =
  | 'concrete' // C40/50 normal-weight structural concrete (reinforced elements add rebar separately)
  | 'concrete_hs' // C80/95 high-strength concrete
  | 'marble' // Carrara-type marble
  | 'travertine'
  | 'granite'
  | 'onyx'
  | 'brick' // clay brick masonry (brick + mortar composite)
  | 'steel_s355' // hot-rolled structural steel
  | 'rha' // rolled homogeneous armour, ~280 BHN
  | 'rebar_b500' // B500B reinforcing steel
  | 'stainless' // 304 stainless / chromed cladding
  | 'glass_tempered'
  | 'glass_laminated'
  | 'glass_annealed'
  | 'soil'; // compacted ground under the plaza

/** How damage is represented: voxels that crack and crumble, metal that yields, or glass that shatters. */
export type MaterialClass = 'brittle' | 'ductile' | 'glass' | 'soil';

export interface MaterialProps {
  id: MaterialId;
  name: string;
  nameTr: string;
  class: MaterialClass;
  /** kg/m³ */
  density: number;
  /** Young's modulus, Pa */
  youngModulus: number;
  poisson: number;
  /** Uniaxial compressive strength, Pa (for steels: the yield strength). */
  compressiveStrength: number;
  /** Tensile strength, Pa (concrete: f_ctm; steels: ultimate tensile strength). */
  tensileStrength: number;
  /** Yield strength for ductile metals, Pa. */
  yieldStrength?: number;
  /** Engineering strain at fracture (elongation at break) for ductile metals. */
  fractureStrain?: number;
  /** Brinell hardness (steels; approximate for stone). Used by Lanz-Odermatt. */
  hardnessBHN?: number;
  /** Mode-I fracture toughness, Pa·√m. */
  fractureToughness?: number;
  /** Longitudinal wave speed, m/s (spall timing, audio pitch). */
  soundSpeed: number;
  /** Specific heat, J/(kg·K) — heating of metal from plastic work. */
  specificHeat: number;
  /** Rendering/FX hints. */
  color: number;
  dustColor: number;
  sparks: boolean;
}

export const MATERIALS: Record<MaterialId, MaterialProps> = {
  concrete: {
    id: 'concrete', name: 'Concrete C40/50', nameTr: 'Beton C40/50', class: 'brittle',
    density: 2400, youngModulus: GPa(35), poisson: 0.2,
    compressiveStrength: MPa(40), tensileStrength: MPa(3.5), fractureToughness: 1.0e6,
    soundSpeed: 3900, specificHeat: 880,
    color: 0xb9b6ae, dustColor: 0xc8c4bb, sparks: false,
  },
  concrete_hs: {
    id: 'concrete_hs', name: 'High-strength concrete C80/95', nameTr: 'Yüksek dayanımlı beton C80/95', class: 'brittle',
    density: 2450, youngModulus: GPa(44), poisson: 0.2,
    compressiveStrength: MPa(80), tensileStrength: MPa(4.8), fractureToughness: 1.3e6,
    soundSpeed: 4300, specificHeat: 880,
    color: 0xa9a7a1, dustColor: 0xbdbab3, sparks: false,
  },
  marble: {
    id: 'marble', name: 'Carrara marble', nameTr: 'Carrara mermeri', class: 'brittle',
    density: 2700, youngModulus: GPa(50), poisson: 0.27,
    compressiveStrength: MPa(110), tensileStrength: MPa(7), fractureToughness: 1.1e6, hardnessBHN: 120,
    soundSpeed: 4800, specificHeat: 880,
    color: 0xece9e2, dustColor: 0xf3f1ec, sparks: false,
  },
  travertine: {
    id: 'travertine', name: 'Roman travertine', nameTr: 'Traverten', class: 'brittle',
    density: 2450, youngModulus: GPa(35), poisson: 0.25,
    compressiveStrength: MPa(60), tensileStrength: MPa(5), fractureToughness: 0.9e6,
    soundSpeed: 4200, specificHeat: 880,
    color: 0xd8ccb2, dustColor: 0xe3d9c4, sparks: false,
  },
  granite: {
    id: 'granite', name: 'Granite', nameTr: 'Granit', class: 'brittle',
    density: 2650, youngModulus: GPa(60), poisson: 0.25,
    compressiveStrength: MPa(180), tensileStrength: MPa(10), fractureToughness: 1.6e6, hardnessBHN: 200,
    soundSpeed: 5500, specificHeat: 790,
    color: 0x7d7a78, dustColor: 0xa9a5a1, sparks: true,
  },
  onyx: {
    id: 'onyx', name: 'Onyx', nameTr: 'Oniks', class: 'brittle',
    density: 2650, youngModulus: GPa(55), poisson: 0.27,
    compressiveStrength: MPa(90), tensileStrength: MPa(6), fractureToughness: 0.9e6,
    soundSpeed: 5000, specificHeat: 850,
    color: 0xd9b98a, dustColor: 0xeadcc4, sparks: false,
  },
  brick: {
    id: 'brick', name: 'Clay brick masonry', nameTr: 'Tuğla duvar', class: 'brittle',
    density: 1900, youngModulus: GPa(5), poisson: 0.15,
    compressiveStrength: MPa(12), tensileStrength: MPa(0.6), fractureToughness: 0.4e6,
    soundSpeed: 2800, specificHeat: 840,
    color: 0x9c4a32, dustColor: 0xb8735a, sparks: false,
  },
  steel_s355: {
    id: 'steel_s355', name: 'Structural steel S355', nameTr: 'Yapı çeliği S355', class: 'ductile',
    density: 7850, youngModulus: GPa(210), poisson: 0.3,
    compressiveStrength: MPa(355), yieldStrength: MPa(355), tensileStrength: MPa(510),
    fractureStrain: 0.22, hardnessBHN: 150, fractureToughness: 100e6,
    soundSpeed: 5900, specificHeat: 490,
    color: 0x5d6166, dustColor: 0x8a8580, sparks: true,
  },
  rha: {
    id: 'rha', name: 'Rolled homogeneous armour', nameTr: 'Haddelenmiş homojen zırh (RHA)', class: 'ductile',
    density: 7850, youngModulus: GPa(207), poisson: 0.29,
    compressiveStrength: MPa(950), yieldStrength: MPa(950), tensileStrength: MPa(1100),
    fractureStrain: 0.14, hardnessBHN: 280, fractureToughness: 120e6,
    soundSpeed: 5900, specificHeat: 460,
    color: 0x4f5550, dustColor: 0x7a776f, sparks: true,
  },
  rebar_b500: {
    id: 'rebar_b500', name: 'Reinforcing steel B500B', nameTr: 'İnşaat demiri B500B', class: 'ductile',
    density: 7850, youngModulus: GPa(200), poisson: 0.3,
    compressiveStrength: MPa(500), yieldStrength: MPa(500), tensileStrength: MPa(575),
    fractureStrain: 0.08, hardnessBHN: 170, fractureToughness: 80e6,
    soundSpeed: 5900, specificHeat: 490,
    color: 0x5a4a3e, dustColor: 0x7d6a5a, sparks: true,
  },
  stainless: {
    id: 'stainless', name: 'Stainless steel 304', nameTr: 'Paslanmaz çelik 304', class: 'ductile',
    density: 8000, youngModulus: GPa(193), poisson: 0.29,
    compressiveStrength: MPa(215), yieldStrength: MPa(215), tensileStrength: MPa(505),
    fractureStrain: 0.4, hardnessBHN: 123, fractureToughness: 200e6,
    soundSpeed: 5790, specificHeat: 500,
    color: 0xc9ccd0, dustColor: 0x9a9a9a, sparks: true,
  },
  glass_tempered: {
    id: 'glass_tempered', name: 'Tempered glass', nameTr: 'Temperli cam', class: 'glass',
    density: 2500, youngModulus: GPa(70), poisson: 0.22,
    compressiveStrength: MPa(1000), tensileStrength: MPa(120), fractureToughness: 0.75e6,
    soundSpeed: 5600, specificHeat: 840,
    color: 0xcfe3e6, dustColor: 0xe8f4f5, sparks: false,
  },
  glass_laminated: {
    id: 'glass_laminated', name: 'Laminated glass (PVB)', nameTr: 'Lamine cam (PVB)', class: 'glass',
    density: 2450, youngModulus: GPa(70), poisson: 0.22,
    compressiveStrength: MPa(1000), tensileStrength: MPa(45), fractureToughness: 0.75e6,
    soundSpeed: 5600, specificHeat: 840,
    color: 0xd6e6e2, dustColor: 0xe8f4f5, sparks: false,
  },
  glass_annealed: {
    id: 'glass_annealed', name: 'Annealed float glass', nameTr: 'Tavlanmış düz cam', class: 'glass',
    density: 2500, youngModulus: GPa(70), poisson: 0.22,
    compressiveStrength: MPa(1000), tensileStrength: MPa(40), fractureToughness: 0.75e6,
    soundSpeed: 5600, specificHeat: 840,
    color: 0xd9ebe8, dustColor: 0xe8f4f5, sparks: false,
  },
  soil: {
    id: 'soil', name: 'Compacted soil', nameTr: 'Sıkıştırılmış toprak', class: 'soil',
    density: 1800, youngModulus: GPa(0.05), poisson: 0.35,
    compressiveStrength: MPa(0.3), tensileStrength: MPa(0.02),
    soundSpeed: 400, specificHeat: 800,
    color: 0x6b5a45, dustColor: 0x8c7a62, sparks: false,
  },
};

export function material(id: MaterialId): MaterialProps {
  return MATERIALS[id];
}

/** Reference armour for "mm RHA" ratings. */
export const RHA = MATERIALS.rha;
