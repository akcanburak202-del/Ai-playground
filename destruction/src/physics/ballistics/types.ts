import type * as THREE from 'three';
import type { MaterialProps } from '../materials.ts';

/**
 * How a round defeats a target. This decides which terminal-ballistics model applies.
 * - ball: jacketed small-arms bullet (lead core, possibly a steel tip like M855)
 * - ap: hardened steel / tungsten-carbide core small-arms or HMG round
 * - apfsds: long-rod kinetic penetrator (tungsten or depleted uranium)
 * - heat: shaped charge; the copper jet does the penetration, a small blast follows
 * - he: high-explosive (blast + fragments), impact / delay / airburst fuzes
 * - hesh: high-explosive squash head; plasters onto the surface, then scabs the far side
 * - thermobaric: fuel-air / enhanced-blast warhead (long positive-phase impulse)
 * - fragment: a casing fragment thrown by a detonation
 */
export type ProjectileKind = 'ball' | 'ap' | 'apfsds' | 'heat' | 'he' | 'hesh' | 'thermobaric' | 'fragment';

export type FuzeKind = 'impact' | 'delay' | 'none';

export interface RocketMotor {
  /** Thrust, N */
  thrust: number;
  /** Burn duration, s */
  burnTime: number;
  /** Delay after launch before ignition, s (RPG-7 sustainer ignites ~11 m from the tube) */
  ignitionDelay: number;
  /** Propellant mass burnt, kg (mass decreases linearly during burn) */
  propellantMass: number;
}

export interface Guidance {
  /** 'direct': steer towards the aim point; 'topAttack': climb then dive onto the target (Javelin) */
  mode: 'direct' | 'topAttack';
  /** Max lateral acceleration, m/s² */
  maxAccel: number;
  /** Cruise altitude above launch for top-attack, m */
  loftHeight?: number;
}

export interface AmmoSpec {
  id: string;
  /** Display name, e.g. "M855 ball" */
  name: string;
  /** Cartridge / calibre label, e.g. "5.56×45 mm NATO" */
  caliber: string;
  kind: ProjectileKind;
  /** Projectile (or penetrator, for APFSDS after sabot discard) mass in flight, kg */
  mass: number;
  /** Projectile / penetrator diameter, m */
  diameter: number;
  /** Projectile / penetrator length, m */
  length: number;
  /** Muzzle (or launch) velocity, m/s */
  muzzleVelocity: number;
  /** Drag coefficient referenced to the frontal area of `diameter` (supersonic average) */
  dragCd: number;
  /** Density of the penetrating core, kg/m³ (lead ~11 340, steel 7 850, WC 15 600, W alloy 17 600, DU 18 600) */
  coreDensity: number;
  /** Mass of the hard core if different from the whole projectile (M855 steel tip, M2 AP core), kg */
  coreMass?: number;
  /** NDRC nose-shape factor N: 0.72 flat, 0.84 blunt, 1.0 hemispherical, 1.14 sharp ogive */
  noseFactor: number;
  /** Core deforms on hard targets (lead-core ball ammo): lowers penetration into concrete and steel */
  deformable: boolean;
  /** TNT-equivalent explosive filler, kg */
  explosiveTNT?: number;
  /** Casing mass that becomes fragments, kg */
  casingMass?: number;
  /** Gurney constant sqrt(2E) of the filler, m/s (TNT ~2 440, Comp B ~2 700, A-IX-1 ~2 600) */
  gurney?: number;
  /** Rated shaped-charge penetration into RHA, m (HEAT only) */
  heatPenetrationRHA?: number;
  /** Shaped-charge liner / cone diameter, m (HEAT only) */
  heatConeDiameter?: number;
  /** Tandem charge (a precursor defeats reactive/spaced layers) */
  tandem?: boolean;
  fuze: FuzeKind;
  /** For 'delay' fuzes: time after first impact before detonation, s */
  fuzeDelay?: number;
  rocket?: RocketMotor;
  guidance?: Guidance;
  /** Tracer composition burns (every round of this type is a tracer) */
  tracer?: boolean;
  /** One-line physically-grounded description shown in the HUD */
  note: string;
}

/** Instantaneous state of a flying projectile, as seen by the terminal-ballistics resolver. */
export interface ProjectileState {
  ammo: AmmoSpec;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Current mass (eroding penetrators lose mass; a perforating bullet may lose its jacket) */
  mass: number;
  /** Current penetrator length (long rods erode), m */
  length: number;
  /** Number of targets already perforated */
  perforations: number;
}

/**
 * One contiguous run of solid material along the shot line starting at the entry point. A run may
 * mix materials (concrete cover → rebar → concrete). `strength` scales the material's resistance
 * to account for accumulated damage (1 = pristine, 0.2 = rubble that barely resists).
 */
export interface ProbeSegment {
  material: MaterialProps;
  /** Distance from the entry point where this segment starts, m */
  start: number;
  /** Distance from the entry point where it ends, m */
  end: number;
  /** Damage-reduced strength factor in (0, 1] */
  strength: number;
}

export interface ThicknessProbe {
  segments: ProbeSegment[];
  /** True if the run ended because material ended (there is air behind), false if clipped by maxDepth */
  exits: boolean;
}

export type ImpactOutcome = 'ricochet' | 'embed' | 'perforate' | 'shatter';

/**
 * The resolved result of one projectile meeting one target. Computed by the terminal-ballistics
 * module from physics formulas; the target then realises it (carves voxels, dents a plate, cracks
 * a pane). Distances are metres, energies joules.
 */
export interface ImpactEvent {
  time: number;
  ammo: AmmoSpec;
  /** 'jet' when this is the shaped-charge jet of a HEAT round, 'fragment' for casing fragments */
  agent: 'projectile' | 'jet' | 'fragment';
  point: THREE.Vector3;
  /** Unit direction of travel at impact */
  direction: THREE.Vector3;
  /** Outward surface normal at the entry point */
  normal: THREE.Vector3;
  /** Angle between the shot line and the surface normal, radians (0 = square-on) */
  obliquity: number;
  /** Impact speed, m/s */
  speed: number;
  /** Mass at impact, kg */
  mass: number;
  kineticEnergy: number;
  outcome: ImpactOutcome;
  /** Penetration depth achieved in this target along the shot line, m */
  depth: number;
  /** Exit point when perforated */
  exitPoint?: THREE.Vector3;
  /** Speed after perforation or ricochet, m/s */
  residualSpeed: number;
  /** Direction after ricochet / perforation (may deflect) */
  residualDirection?: THREE.Vector3;
  /** Entry crater radius at the surface, m */
  craterRadius: number;
  /** Entry crater depth (for brittle targets the cone before the tunnel), m */
  craterDepth: number;
  /** Tunnel / hole radius, m */
  tunnelRadius: number;
  /** Rear-face spall (scab) crater radius, m; 0 if none */
  spallRadius: number;
  /** Rear-face spall depth, m */
  spallDepth: number;
  /** Radius of the micro-cracked / plastically strained zone around the impact, m */
  damageRadius: number;
  /** Energy dissipated in this target, J */
  energyAbsorbed: number;
  /** Momentum given to the target, N·s (vector, world) */
  momentum: THREE.Vector3;
  /** Material that was struck first */
  material: MaterialProps;
  /** Which kind of destructible was struck (voxel, plate, beam, glass, terrain, rebar …) */
  targetKind: string;
  targetName?: string;
  /** Short human-readable explanation of the model result for the telemetry panel */
  summary: string;
}

export type BlastKind = 'he' | 'thermobaric' | 'hesh' | 'contact' | 'shaped';

/** Request to detonate an explosive charge. */
export interface BlastRequest {
  center: THREE.Vector3;
  /** TNT-equivalent mass, kg */
  tntKg: number;
  kind: BlastKind;
  /** Outward normal of the surface the charge sits on / struck (contact and HESH) */
  normal?: THREE.Vector3;
  /** Destructible the charge is in contact with, if any (contact charges, HESH, impact-fuzed HE) */
  contactTargetId?: number;
  /** Casing that fragments, kg (0/undefined: no fragments) */
  casingMass?: number;
  gurney?: number;
  /** Direction the round was travelling (fragment spray is biased forward for moving shells) */
  travelDirection?: THREE.Vector3;
  travelSpeed?: number;
  source?: AmmoSpec;
  label?: string;
}

/**
 * A blast as experienced by one target. Pressures are side-on (incident) values from the
 * Kingery-Bulmash fits; use `reflectedPressureAt` for a surface facing the charge.
 */
export interface BlastLoad {
  center: THREE.Vector3;
  tntKg: number;
  kind: BlastKind;
  normal?: THREE.Vector3;
  contactTargetId?: number;
  time: number;
  /** Peak incident overpressure at p, Pa */
  overpressureAt(p: THREE.Vector3): number;
  /** Incident positive-phase specific impulse at p, Pa·s */
  impulseAt(p: THREE.Vector3): number;
  /** Peak reflected overpressure on a surface at p with outward normal n, Pa */
  reflectedPressureAt(p: THREE.Vector3, n: THREE.Vector3): number;
  /** Reflected specific impulse on a surface at p with outward normal n, Pa·s */
  reflectedImpulseAt(p: THREE.Vector3, n: THREE.Vector3): number;
  /** Shock arrival time after detonation at distance of p, s */
  arrivalTime(p: THREE.Vector3): number;
  /**
   * Effects of a contact / near-contact charge (or a HESH pat) on a wall or plate of `thickness`
   * made of `material`, directly under the charge. Targets only realise these numbers.
   */
  contactDamage(material: MaterialProps, thickness: number): ContactDamage;
  /**
   * Pressure–impulse damage number for a surface patch at p with outward normal n, of a member of
   * `thickness` made of `material` (glass panes, walls, slabs): < 1 no damage, 1 onset of cracking
   * / pane failure, ≥ 2 severe damage / breach. Built from P–I diagram asymptotes.
   */
  damageAt(p: THREE.Vector3, n: THREE.Vector3, material: MaterialProps, thickness: number): number;
}

export interface ContactDamage {
  /** Front-face crater radius and depth, m */
  craterRadius: number;
  craterDepth: number;
  /** True when the member is holed through */
  breach: boolean;
  /** Radius of the through-hole when breached, m */
  breachRadius: number;
  /** Rear-face spall (scab) radius and depth, m (0 when none) */
  spallRadius: number;
  spallDepth: number;
  /** Speed of rear spall fragments, m/s */
  spallVelocity: number;
}
