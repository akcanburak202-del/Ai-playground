/**
 * Contracts between subsystems. Every module codes against these interfaces, never against another
 * module's concrete classes, so the pieces can be built and tested independently and wired together
 * in `Simulation`.
 */
import type * as THREE from 'three';
import type { Rng } from '../core/rng.ts';
import type { EventBus } from '../core/events.ts';
import type { MaterialId, MaterialProps } from '../physics/materials.ts';
import type { AmmoSpec, BlastRequest, ImpactEvent } from '../physics/ballistics/types.ts';
import type { PhysicsWorld } from '../physics/PhysicsWorld.ts';
import type { DestructibleRegistry } from '../destructibles/Registry.ts';
import type { Destructible } from '../destructibles/Destructible.ts';

// ─── Events ──────────────────────────────────────────────────────────────────────────────────

export interface ShotEvent {
  time: number;
  weapon: WeaponSpec;
  ammo: AmmoSpec;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
}

export interface BlastEvent extends BlastRequest {
  time: number;
  /** Fireball radius used for visuals, m */
  fireballRadius: number;
}

export interface FractureEvent {
  time: number;
  position: THREE.Vector3;
  /** Volume that broke loose, m³ */
  volume: number;
  pieces: number;
  material: MaterialProps;
  /** Direction debris was thrown, if any */
  direction?: THREE.Vector3;
}

export interface DebrisContactEvent {
  time: number;
  position: THREE.Vector3;
  /** Approximate impulse of the contact, N·s */
  impulse: number;
  /** Characteristic size of the debris piece, m */
  size: number;
  material: MaterialProps;
}

export interface ShatterEvent {
  time: number;
  position: THREE.Vector3;
  /** Pane area that let go, m² */
  area: number;
  material: MaterialProps;
}

export interface StructuralFailureEvent {
  time: number;
  position: THREE.Vector3;
  label: string;
  /** Mass that started to fall, kg */
  mass: number;
  cause: 'crushing' | 'buckling' | 'support-lost' | 'severed' | 'overload';
}

export interface ChargeEvent {
  time: number;
  id: number;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  tntKg: number;
  label: string;
}

export interface SimEvents extends Record<string, unknown> {
  shot: ShotEvent;
  impact: ImpactEvent;
  blast: BlastEvent;
  fracture: FractureEvent;
  debrisContact: DebrisContactEvent;
  shatter: ShatterEvent;
  structuralFailure: StructuralFailureEvent;
  chargePlaced: ChargeEvent;
  chargeRemoved: { id: number };
  sceneLoaded: { id: string };
}

// ─── Weapons ─────────────────────────────────────────────────────────────────────────────────

export type WeaponCategory = 'rifle' | 'mg' | 'sniper' | 'launcher' | 'cannon' | 'artillery' | 'airstrike' | 'demolition';

export interface WeaponSpec {
  id: string;
  name: string;
  /** Short origin/role line, e.g. "US Army carbine" */
  role: string;
  category: WeaponCategory;
  /** Selectable ammunition ids (first is default) */
  ammo: string[];
  /** Cyclic rate, rounds/min (single-shot weapons: sustained rate) */
  rpm: number;
  fireMode: 'auto' | 'semi' | 'single';
  /** Dispersion, MOA (1 MOA ≈ 0.29 mrad); applied as a normal distribution */
  dispersionMOA: number;
  /** Every Nth round is a tracer (0 = none) */
  tracerEvery: number;
  /**
   * 'direct': fired from the viewer's position along the aim ray;
   * 'indirect': shell arrives from the sky onto the aimed point (artillery, air-dropped bombs);
   * 'placed': a charge is attached to the aimed surface and fired by the detonator.
   */
  delivery: 'direct' | 'indirect' | 'placed';
  /** Recoil impulse felt by the camera (arbitrary 0..1 scale for camera kick) */
  recoil: number;
  /** Sound profile key used by the audio system */
  sound: string;
  /** Scoped zoom factor for aim-down-sights (1 = none) */
  zoom: number;
  /** Launch offset from the viewer (right, down, forward) in metres for visuals */
  muzzleOffset: [number, number, number];
}

// ─── Subsystem APIs ──────────────────────────────────────────────────────────────────────────

export interface Projectile {
  readonly id: number;
  readonly ammo: AmmoSpec;
  readonly position: THREE.Vector3;
  readonly previous: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  mass: number;
  length: number;
  age: number;
  alive: boolean;
  tracer: boolean;
  perforations: number;
  /** Rocket motor currently burning (for exhaust visuals) */
  burning: boolean;
}

export interface SpawnProjectileOptions {
  ammo: AmmoSpec;
  origin: THREE.Vector3;
  velocity: THREE.Vector3;
  tracer?: boolean;
  /** Aim point for guided munitions */
  target?: THREE.Vector3;
}

export interface ProjectileSystemApi {
  spawn(o: SpawnProjectileOptions): Projectile;
  readonly active: readonly Projectile[];
}

/** Firing logic for the viewer's weapon: rate of fire, dispersion, tracers, charges. */
export interface WeaponControllerApi {
  readonly weapons: readonly WeaponSpec[];
  readonly current: WeaponSpec;
  readonly currentAmmo: AmmoSpec;
  select(weaponId: string): void;
  setAmmo(ammoId: string): void;
  cycleAmmo(): void;
  /** Hold/release the trigger. Auto weapons fire at their cyclic rate while held. */
  setTrigger(down: boolean): void;
  /** Placed charges waiting for the detonator */
  readonly charges: readonly ChargeEvent[];
  /** Fire all placed charges (optionally with a delay between them, s) */
  detonate(sequenceDelay?: number): void;
  /** Rounds fired since the scene loaded */
  readonly roundsFired: number;
  /** Seconds until the weapon can fire again (reload / cycling), for the HUD */
  readonly cooldown: number;
  /** Where the aim ray currently meets the world (for indirect fire and charge placement) */
  readonly aimPoint: THREE.Vector3 | null;
}

export interface BlastSystemApi {
  detonate(req: BlastRequest): void;
}

/** Imperative effects the destructibles may request directly (in addition to reacting to events). */
export interface FxApi {
  /** Small solid bits thrown from a point (concrete chips, glass grit, brick crumbs) */
  chips(o: { position: THREE.Vector3; direction: THREE.Vector3; spread: number; speed: number; count: number; size: number; color: number; kind?: 'stone' | 'glass' | 'metal' }): void;
  /** Dust cloud */
  dust(o: { position: THREE.Vector3; velocity?: THREE.Vector3; radius: number; amount: number; color: number }): void;
  /** Sparks (steel strikes) */
  sparks(o: { position: THREE.Vector3; direction: THREE.Vector3; count: number; speed: number; hot?: number }): void;
  /** Lingering smoke source */
  smoke(o: { position: THREE.Vector3; radius: number; duration: number; color?: number; rise?: number }): void;
  /** Short-lived light flash */
  flash(o: { position: THREE.Vector3; color: number; intensity: number; radius: number; duration: number }): void;
  /** Camera shake trauma 0..1 */
  shake(amount: number): void;
}

export interface AudioApi {
  /** Resume the audio context (must be called from a user gesture) */
  unlock(): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
}

/** Support relations and gravity-load flow between structural elements. */
export interface StructureApi {
  /**
   * Declare that `supporter` holds up `supported` through a world-space contact region.
   * Returns the anchor id the supported element was told about.
   */
  link(supporter: Destructible | 'ground', supported: Destructible, regionWorld: THREE.Box3): string;
  /** Ask the graph to re-check an element soon (after it was damaged) */
  touch(el: Destructible): void;
  /** Remove an element (fell / disposed) — dependents re-evaluate */
  remove(el: Destructible): void;
  update(dt: number): void;
}

// ─── Element specifications (what scenes ask the element factories for) ─────────────────────

export type Vec3Like = [number, number, number] | THREE.Vector3;

export type BrittleFinish =
  | 'board-formed-concrete' // Ando-style: timber board imprint + form-tie holes
  | 'smooth-concrete'
  | 'exposed-aggregate'
  | 'marble'
  | 'travertine'
  | 'granite'
  | 'onyx'
  | 'brick';

export type VoxelShape =
  | { type: 'box'; size: Vec3Like }
  | { type: 'cylinder'; radius: number; height: number; flutes?: number; taper?: number }
  /** Arbitrary signed distance (negative inside) in element-local metres within bounds centred on the origin */
  | { type: 'sdf'; bounds: Vec3Like; sdf: (x: number, y: number, z: number) => number };

export interface RebarSpec {
  /** Bar diameter, m (0.012 – 0.025) */
  diameter: number;
  /** Centre-to-centre spacing, m */
  spacing: number;
  /** Concrete cover to the bar surface, m */
  cover: number;
  /** Layers: a mesh near both faces, near the face with local +Z/−Z only, or a column cage */
  layout: 'two-faces' | 'center' | 'cage';
}

export interface VoxelElementSpec {
  name: string;
  material: MaterialId;
  finish: BrittleFinish;
  shape: VoxelShape;
  position: Vec3Like;
  /** Euler XYZ radians or quaternion */
  rotation?: Vec3Like | THREE.Quaternion;
  /** Voxel edge length, m (default 0.025). Implementations may coarsen very large elements. */
  voxelSize?: number;
  rebar?: RebarSpec;
  /** Start as a (sleeping) rigid body instead of a fixed structural element */
  dynamic?: boolean;
  /** Tint multiplier for the finish */
  tint?: number;
}

export interface SteelPlateSpec {
  name: string;
  material: 'steel_s355' | 'rha' | 'stainless';
  width: number;
  height: number;
  thickness: number;
  position: Vec3Like;
  rotation?: Vec3Like | THREE.Quaternion;
  /** Which edges are welded/bolted to something rigid (local: bottom = −Y, left = −X) */
  edges: { top: boolean; bottom: boolean; left: boolean; right: boolean };
  finish: 'mill-scale' | 'painted' | 'corten' | 'polished' | 'armor';
  paintColor?: number;
  /** Particle spacing, m (default ≈ 0.05) */
  resolution?: number;
}

export type BeamProfile =
  | { type: 'I'; h: number; b: number; tw: number; tf: number }
  | { type: 'cruciform'; arm: number; t: number }
  | { type: 'tube'; d: number; t: number }
  | { type: 'box'; h: number; b: number; t: number };

export interface SteelBeamSpec {
  name: string;
  material: 'steel_s355' | 'stainless';
  profile: BeamProfile;
  start: Vec3Like;
  end: Vec3Like;
  /** Orientation of the profile's local "up" (web direction for I-sections) */
  up?: Vec3Like;
  /** End conditions: fixed (moment connection), pinned, or free */
  ends: { start: 'fixed' | 'pinned' | 'free'; end: 'fixed' | 'pinned' | 'free' };
  finish: 'mill-scale' | 'painted' | 'chrome' | 'fireproofed';
  paintColor?: number;
}

export interface GlassPaneSpec {
  name: string;
  type: 'tempered' | 'laminated' | 'annealed';
  width: number;
  height: number;
  thickness: number;
  position: Vec3Like;
  rotation?: Vec3Like | THREE.Quaternion;
  tint?: number;
  /** Supported on all four edges by a frame/mullions (otherwise point-fixed at the corners) */
  framed: boolean;
}

/** Factories the scenes use. Implemented by the element modules and collected in `elements.ts`. */
export interface ElementFactories {
  voxel(spec: VoxelElementSpec): Destructible;
  plate(spec: SteelPlateSpec): Destructible;
  beam(spec: SteelBeamSpec): Destructible;
  glass(spec: GlassPaneSpec): Destructible;
}

// ─── Scenes ──────────────────────────────────────────────────────────────────────────────────

export interface SceneDef {
  id: string;
  name: string;
  nameTr: string;
  /** Architect / style reference and what it is made of */
  blurb: string;
  blurbTr: string;
  /** Viewer start pose */
  spawn: { position: [number, number, number]; lookAt: [number, number, number] };
  /** Sun elevation/azimuth in degrees for this scene's mood */
  sun?: { elevation: number; azimuth: number };
  build(ctx: SimContext, make: ElementFactories): void | Promise<void>;
}

// ─── The shared context ──────────────────────────────────────────────────────────────────────

export interface SimTime {
  /** Simulation seconds since the scene loaded */
  now: number;
  /** Slow-motion factor applied to wall-clock time (1 = real time) */
  scale: number;
  /** Last fixed step length, s */
  fixedDt: number;
}

export interface System {
  readonly name: string;
  /** Fixed-rate simulation step in simulation seconds */
  fixedUpdate?(dt: number): void;
  /** Once per rendered frame; simDt is scaled by slow motion, realDt is wall-clock */
  frameUpdate?(simDt: number, realDt: number): void;
  /** Called when the scene is cleared */
  reset?(): void;
}

export interface SimContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly physics: PhysicsWorld;
  readonly registry: DestructibleRegistry;
  readonly events: EventBus<SimEvents>;
  readonly rng: Rng;
  readonly time: SimTime;
  /** Parent object for everything a scene builds; cleared on scene change */
  readonly world: THREE.Group;
  /** Subsystems; stubs until the real modules are wired */
  projectiles: ProjectileSystemApi;
  blasts: BlastSystemApi;
  fx: FxApi;
  audio: AudioApi;
  structure: StructureApi;
  /** Register a destructible: adds it to the registry and its root to the world group */
  addDestructible(d: Destructible): void;
  /** Look up ammo / weapons by id (filled by the arsenal module) */
  ammo(id: string): AmmoSpec;
}

// ─── Rendering ───────────────────────────────────────────────────────────────────────────────

/** The render pipeline owns renderer settings, lights, sky, post-processing and the ground visuals. */
export interface RenderPipelineApi {
  /** Called once after construction and on every scene load */
  setup(ctx: SimContext, scene: SceneDef | null): void;
  render(realDt: number): void;
  resize(width: number, height: number): void;
  /** Toggle expensive effects (SSAO, bloom) for slow machines; 0 = minimal, 2 = full */
  setQuality(level: 0 | 1 | 2): void;
}
