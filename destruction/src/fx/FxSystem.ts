import * as THREE from 'three';
import type { Simulation } from '../app/Simulation.ts';
import type {
  BlastEvent, DebrisContactEvent, FractureEvent, FxApi, ShatterEvent, ShotEvent, SimContext, StructuralFailureEvent, System,
} from '../app/contracts.ts';
import type { ImpactEvent } from '../physics/ballistics/types.ts';
import type { Rng } from '../core/rng.ts';
import { TNT_ENERGY } from '../core/units.ts';
import { getAtmosphere, type Atmosphere } from '../render/atmosphere.ts';
import { ParticleLayer, newRecord, type ParticleRecord } from './ParticleLayer.ts';
import { Chips, type ChipKind } from './Chips.ts';
import { FlashLights } from './FlashLights.ts';
import { Tracers } from './Tracers.ts';
import { ShockFronts } from './ShockFronts.ts';
import { CameraShake } from './shake.ts';
import { createFireAtlas, createSmokeAtlas } from './textures.ts';
import { createFireMaterial, createSmokeMaterial, createSparkMaterial } from './shaders.ts';
import { landingTime, motionAt, type MotionState } from './motion.ts';
import { groundOf } from './ground.ts';
import { heightOfBurstFactors } from '../destructibles/terrain/crater.ts';

/** Particle budgets (≈ 20 k total, see DESIGN.md §5). */
export const BUDGET = { smoke: 9000, fire: 2500, sparks: 5000, chips: 3500, tracers: 384 };

type Pool = 'smoke' | 'sparks' | 'chips';
/** Mean particle life of routine (per-hit) effects per pool, s: the decay time of the load estimate. */
const POOL_LIFE: Record<Pool, number> = { smoke: 5, sparks: 0.5, chips: 10.5 };
/**
 * Per-hit effects are thinned linearly from POOL_SOFT to nothing at POOL_HARD of a pool's budget.
 * A ring of C slots whose particles live up to L_max recycles none alive while the rate stays under
 * C / L_max, i.e. an estimated load (rate × mean life) under ≈ 0.75 C for chips (7–14 s).
 */
const POOL_SOFT = 0.5;
const POOL_HARD = 0.75;

/** Exact wall rays per chip / spark emission call, per rendered frame, and their reach, m (see wallHit). */
const WALL_RAYS_PER_CALL = 12;
const WALL_RAYS_PER_FRAME = 96;
const WALL_RAY_RANGE = 8;

/** Exposure time of the virtual camera for motion streaks, s (a 180° shutter at 60 fps). */
const SHUTTER = 1 / 120;

/**
 * Peak luminous intensity of a detonation fireball per kg^⅔ of TNT, render candela (see onBlast).
 * One render unit of illuminance is roughly 5–15 klux (the golden-hour sun is ≈ 6).
 */
const FIREBALL_CD = 300;

/**
 * Flash of gas burning with chemical energy E (J): the fireball law (I ∝ W^⅔, cube-root scaling of
 * the luminous radius, Baker et al. 1983) applied to its TNT equivalent. For daylight this keeps a
 * rifle's muzzle flash at ≈ 2 cd (it lights nothing visibly in the sun) and a tank gun at ≈ 500 cd.
 */
function flashCandela(energyJ: number): number {
  return FIREBALL_CD * Math.pow(Math.max(energyJ, 0) / TNT_ENERGY, 2 / 3);
}

/**
 * Radius of the dust puffs raised when a brittle volume V (m³) breaks into n pieces. Airborne fines
 * scale with the new fracture surface, not the volume: cutting a cube into n equal parts adds
 * A ≈ 6 (n^⅓ − 1) V^⅔ (+ V^⅔ where it tore from its parent). At ≈ 0.01 kg of fines (< 20 µm) per m²
 * of fracture face (estimate: a crushed layer of cement paste a fraction of a millimetre thick) and a
 * mass extinction coefficient k ≈ 3Q / (2ρd) ≈ 115 m²/kg (d ≈ 10 µm, ρ = 2600 kg/m³, Q ≈ 2; Seinfeld
 * & Pandis 2006), the cloud reaches optical depth 1 at R = √(1.5 k M / π). emitDust() puffs of
 * radius r spread to ≈ 2.5 r, so r ≈ R / 2.5; kept between 0.15 m and 1.6 m.
 */
export function fractureDustRadius(volume: number, pieces: number): number {
  const a = Math.pow(Math.max(volume, 0), 2 / 3);
  const area = 6 * (Math.cbrt(Math.max(pieces, 1)) - 1) * a + a;
  const R = Math.sqrt((1.5 * 115 * 0.01 * area) / Math.PI);
  return Math.min(1.6, Math.max(0.15, R / 2.5));
}

/**
 * Dust of a structure coming apart (debris landing, members crushing, pieces breaking off): at most
 * COLLAPSE_DUST_RATE puffs per second of simulated time, in bursts of up to COLLAPSE_DUST_BURST
 * (a token bucket). A progressive collapse makes thousands of contacts; each raising its own
 * cloud buried the tower in a 20 m wall of dust within half a second, whereas footage of
 * building demolitions shows the frame coming down for seconds before the cloud from the
 * pulverised floors rolls out along the ground and engulfs the base.
 */
const COLLAPSE_DUST_RATE = 70;
const COLLAPSE_DUST_BURST = 90;
/** Collapse dust within this distance (m) and time (s) of an earlier puff merges into it. */
const COLLAPSE_MERGE_R = 1.6;
const COLLAPSE_MERGE_T = 0.35;
/** Above this height over the ground (m) collapse dust is drawn as thin, short-lived wisps. */
const COLLAPSE_LOW = 2.5;

/** Shape of an emitDust cloud: opacity scale, launch-speed scales and gravity-scale range. */
interface DustStyle { opacity: number; horiz: number; vert: number; gLo: number; gHi: number }
const DUST_BILLOW: DustStyle = { opacity: 1, horiz: 1, vert: 0.6, gLo: -0.02, gHi: 0.01 };
/** Ground-level collapse dust: rolls outward along the ground, barely rises, thins as it spreads. */
const DUST_GROUND: DustStyle = { opacity: 0.55, horiz: 1.7, vert: 0.12, gLo: 0.0, gHi: 0.015 };
/** Dust of members breaking in the air: faint wisps that trail down with the debris. */
const DUST_WISP: DustStyle = { opacity: 0.4, horiz: 0.7, vert: 0.25, gLo: 0.03, gHi: 0.08 };

interface Emitter { x: number; y: number; z: number; radius: number; until: number; color: number; rise: number; acc: number; rate: number }
interface Mark { t: number; x: number; y: number; z: number; bits: number }
const MARK_CHIPS = 1, MARK_DUST = 2, MARK_SPARKS = 4;

const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _w = new THREE.Vector3();
const _j = new THREE.Vector3();
const _o = new THREE.Vector3();
const _hn = new THREE.Vector3();
const _ms: MotionState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Visual effects for the whole simulation: reacts to shots, impacts, blasts, fractures, debris
 * contacts and shattering glass, draws tracers and rocket motors from the live projectile list,
 * and implements the FxApi that destructibles call directly. Everything is pooled and GPU-driven:
 * a frame costs the CPU only the new particles and the tracer list.
 */
export class FxSystem implements System, FxApi {
  readonly name = 'fx';
  readonly root = new THREE.Group();
  readonly solidRoot = new THREE.Group();
  readonly smokeLayer: ParticleLayer;
  readonly fireLayer: ParticleLayer;
  readonly sparkLayer: ParticleLayer;
  readonly chipLayer: Chips;
  readonly tracers: Tracers;
  readonly lights: FlashLights;
  readonly shock: ShockFronts;
  readonly shaker = new CameraShake();
  private ctx: SimContext;
  private atmo: Atmosphere;
  private rng: Rng;
  private P: ParticleRecord = newRecord();
  private shutter = { value: SHUTTER };
  private emitters: Emitter[] = [];
  private marks: Mark[] = [];
  private markHead = 0;
  private trails = new Map<number, { x: number; y: number; z: number; alive: boolean }>();
  private contactsThisFrame = 0;
  private collapseTokens = COLLAPSE_DUST_BURST;
  private collapseClock = 0;
  private recentDust: { x: number; y: number; z: number; t: number }[] = [];
  private recentHead = 0;
  /**
   * Particles emitted recently per pool, decaying with the pool's particle life: an estimate of
   * how many are alive. A GAU-8 (65 rounds/s of 30 mm) would otherwise cycle the chip ring in under
   * a second and make resting debris — and the smoke of earlier blasts — blink out.
   */
  private load: Record<Pool, number> = { smoke: 0, sparks: 0, chips: 0 };
  private counted: Record<Pool, number> = { smoke: 0, sparks: 0, chips: 0 };
  private textures: THREE.Texture[] = [];
  private unsub: (() => void)[] = [];
  private savedPos = new THREE.Vector3();
  private savedQuat = new THREE.Quaternion();
  private shakeApplied = false;
  private lightScan = 0;
  private sceneSun: THREE.DirectionalLight | null = null;
  private sceneHemi: THREE.HemisphereLight | null = null;
  /** Wall-clock cost of the last frameUpdate, ms (telemetry) */
  lastFrameMs = 0;
  /** Wall rays left this frame, and rays cast since creation (telemetry) */
  private rayBudget = WALL_RAYS_PER_FRAME;
  raysCast = 0;
  /** Rays cast by the current emission call (see wallHit) */
  private fan = {
    n: 0,
    dir: new Float32Array(WALL_RAYS_PER_CALL * 3),
    hit: new Uint8Array(WALL_RAYS_PER_CALL),
    pt: new Float32Array(WALL_RAYS_PER_CALL * 3),
    nrm: new Float32Array(WALL_RAYS_PER_CALL * 3),
  };

  constructor(sim: Simulation) {
    const ctx = (this.ctx = sim.ctx);
    this.rng = ctx.rng.fork();
    this.atmo = getAtmosphere(ctx.scene);
    const smokeAtlas = createSmokeAtlas();
    const fireAtlas = createFireAtlas();
    this.textures.push(smokeAtlas, fireAtlas);
    // Smoke, dust and the fireball are alpha-blended ('over'), so they are drawn back to front.
    this.smokeLayer = new ParticleLayer('fx-smoke', BUDGET.smoke, createSmokeMaterial(this.atmo, smokeAtlas), { sorted: true });
    this.fireLayer = new ParticleLayer('fx-fire', BUDGET.fire, createFireMaterial(this.atmo, fireAtlas));
    this.sparkLayer = new ParticleLayer('fx-sparks', BUDGET.sparks, createSparkMaterial(this.atmo, this.shutter));
    this.smokeLayer.mesh.renderOrder = 10;
    this.fireLayer.mesh.renderOrder = 20;
    this.sparkLayer.mesh.renderOrder = 25;
    this.chipLayer = new Chips(this.atmo, BUDGET.chips);
    this.tracers = new Tracers(this.atmo, BUDGET.tracers);
    this.lights = new FlashLights(4);
    this.shock = new ShockFronts(this.atmo, 4);
    this.root.name = 'fx-root';
    this.root.add(this.smokeLayer.mesh, this.fireLayer.mesh, this.sparkLayer.mesh, this.tracers.mesh, this.shock.group);
    this.solidRoot.name = 'fx-solid';
    this.solidRoot.add(this.chipLayer.mesh, this.lights.group);
    ctx.scene.add(this.root, this.solidRoot);
    this.atmo.fxRoot = this.root;
    this.atmo.beforeFx = this.sortForView;

    const ev = ctx.events;
    this.unsub.push(
      ev.on('shot', (e) => this.onShot(e)),
      ev.on('impact', (e) => this.onImpact(e)),
      ev.on('blast', (e) => this.onBlast(e)),
      ev.on('fracture', (e) => this.onFracture(e)),
      ev.on('debrisContact', (e) => this.onDebrisContact(e)),
      ev.on('shatter', (e) => this.onShatter(e)),
      ev.on('structuralFailure', (e) => this.onStructuralFailure(e)),
    );
    // Under a pipeline that does not shake the camera itself, shake around the scene render.
    const scene = ctx.scene;
    const prevBefore = scene.onBeforeRender;
    const prevAfter = scene.onAfterRender;
    scene.onBeforeRender = (...args) => {
      prevBefore.apply(scene, args);
      if (this.atmo.pipelineHandlesShake) return;
      if (this.atmo.shake.active) this.applyShake();
      // The effects are part of this scene render (no separate effects pass): sort them here.
      const cam = args[2] as THREE.Camera | undefined;
      if (cam && this.root.parent === scene) this.sortForView(cam);
    };
    scene.onAfterRender = (...args) => {
      prevAfter.apply(scene, args);
      this.restoreShake();
    };
    this.unsub.push(() => {
      scene.onBeforeRender = prevBefore;
      scene.onAfterRender = prevAfter;
    });
  }

  private get now(): number {
    return this.ctx.time.now;
  }

  /** Depth-sort the alpha-blended particles for the camera about to draw them. */
  private sortForView = (camera: THREE.Camera): void => {
    camera.updateMatrixWorld();
    this.smokeLayer.sort(camera, this.atmo.time.value, this.atmo.wind.value);
  };

  // ─── FxApi ───────────────────────────────────────────────────────────────────────────────

  chips(o: Parameters<FxApi['chips']>[0]): void {
    this.mark(o.position, MARK_CHIPS);
    this.emitChips(o.position, o.direction, o.spread, o.speed, this.thin('chips', o.count), o.size, o.color, o.kind ?? 'stone');
  }

  dust(o: Parameters<FxApi['dust']>[0]): void {
    this.mark(o.position, MARK_DUST);
    const n = this.thin('smoke', Math.min(24, 2 + o.amount * 3));
    // Puffs spread to ≈ 2.5 r: past r ≈ 2 m one call would stand a 10 m cloud in the air (a
    // released roof slab asked for r = 6 m); larger sources should call again at other points.
    this.emitDust(o.position, o.velocity ?? null, Math.min(2, o.radius), n, o.color, 1);
  }

  sparks(o: Parameters<FxApi['sparks']>[0]): void {
    this.mark(o.position, MARK_SPARKS);
    this.emitSparks(o.position, o.direction, this.thin('sparks', o.count), o.speed, 1500 + 800 * (o.hot ?? 0.7), 0.9, 0.0008, 0);
  }

  /**
   * Particle count for a routine (per-hit) effect, thinned in proportion once the pool nears its
   * budget; stochastic rounding keeps the expected count. Blasts are never thinned.
   */
  private thin(pool: Pool, n: number): number {
    this.countEmitted();
    const soft = BUDGET[pool] * POOL_SOFT, hard = BUDGET[pool] * POOL_HARD;
    const k = Math.min(1, Math.max(0, (hard - this.load[pool]) / (hard - soft)));
    const x = Math.max(0, n) * k;
    const whole = Math.floor(x);
    return whole + (this.rng.next() < x - whole ? 1 : 0);
  }

  /** Estimated live particles per pool (telemetry, tests). */
  poolLoad(): Readonly<Record<Pool, number>> {
    this.countEmitted();
    return this.load;
  }

  /** Add everything the pools accepted since the last call to the load estimate. */
  private countEmitted(): void {
    const L = this.load, C = this.counted;
    L.smoke += this.smokeLayer.emitted - C.smoke;
    L.sparks += this.sparkLayer.emitted - C.sparks;
    L.chips += this.chipLayer.emitted - C.chips;
    C.smoke = this.smokeLayer.emitted;
    C.sparks = this.sparkLayer.emitted;
    C.chips = this.chipLayer.emitted;
  }

  /** Let the load estimate decay over dt seconds of simulation time. */
  private decayLoad(dt: number): void {
    this.countEmitted();
    const t = Math.max(0, dt);
    this.load.smoke *= Math.exp(-t / POOL_LIFE.smoke);
    this.load.sparks *= Math.exp(-t / POOL_LIFE.sparks);
    this.load.chips *= Math.exp(-t / POOL_LIFE.chips);
  }

  smokeSource(o: Parameters<FxApi['smoke']>[0]): void {
    if (this.emitters.length >= 48) this.emitters.shift();
    this.emitters.push({
      x: o.position.x, y: o.position.y, z: o.position.z, radius: o.radius, until: this.now + o.duration,
      color: o.color ?? 0x55504a, rise: o.rise ?? 1.2, acc: 0, rate: Math.min(12, 2 + o.radius * 4),
    });
  }

  smoke(o: Parameters<FxApi['smoke']>[0]): void {
    this.smokeSource(o);
  }

  flash(o: Parameters<FxApi['flash']>[0]): void {
    this.lights.fire(this.now, o.position, o.color, o.intensity, o.radius, o.duration);
  }

  shake(amount: number): void {
    this.shaker.add(amount);
  }

  // ─── Dedup of effects a destructible already produced itself ──────────────────────────────

  private mark(p: THREE.Vector3, bits: number): void {
    if (this.marks.length < 32) this.marks.push({ t: this.now, x: p.x, y: p.y, z: p.z, bits });
    else {
      const m = this.marks[this.markHead]!;
      m.t = this.now; m.x = p.x; m.y = p.y; m.z = p.z; m.bits = bits;
      this.markHead = (this.markHead + 1) % 32;
    }
  }

  /** Effects already emitted by the target within 0.6 m of p during this step. */
  private marked(p: THREE.Vector3): number {
    let bits = 0;
    for (const m of this.marks) {
      if (Math.abs(m.t - this.now) > 1e-6) continue;
      const dx = m.x - p.x, dy = m.y - p.y, dz = m.z - p.z;
      if (dx * dx + dy * dy + dz * dz < 0.36) bits |= m.bits;
    }
    return bits;
  }

  // ─── Primitive emitters ──────────────────────────────────────────────────────────────────

  /** Billowing dust puffs of a given colour (sRGB hex), rising slightly and drifting. */
  emitDust(p: THREE.Vector3, vel: THREE.Vector3 | null, radius: number, count: number, color: number, lifeScale: number, t0 = this.now, style: DustStyle = DUST_BILLOW): void {
    const P = this.P;
    const rng = this.rng;
    _c.setHex(color);
    const r = Math.max(0.03, radius);
    // Start the cloud off the surface it came from (along its launch velocity) so the soft-particle
    // fade against that surface does not eat it.
    const vl = vel ? vel.length() : 0;
    const off = vl > 1e-6 ? (r * 0.6) / vl : 0;
    for (let i = 0; i < count; i++) {
      rng.inBall(_u).multiplyScalar(r * 0.45);
      P.x = p.x + _u.x + (vel?.x ?? 0) * off; P.y = p.y + _u.y + (vel?.y ?? 0) * off; P.z = p.z + _u.z + (vel?.z ?? 0) * off;
      rng.onSphere(_d);
      const sp = rng.range(0.3, 1.2) * Math.sqrt(r) * 2.2;
      P.vx = (vel?.x ?? 0) * rng.range(0.4, 1.1) + _d.x * sp * style.horiz;
      P.vy = (vel?.y ?? 0) * rng.range(0.4, 1.1) + Math.abs(_d.y) * sp * style.vert;
      P.vz = (vel?.z ?? 0) * rng.range(0.4, 1.1) + _d.z * sp * style.horiz;
      P.t0 = t0 + rng.range(0, 0.04);
      P.life = rng.range(3, 7) * lifeScale * (0.6 + 0.4 * Math.sqrt(r));
      // Dust relaxes to the air quickly (τ ≈ 0.3–0.6 s for a turbulent puff), then barely settles.
      P.drag = rng.range(1.8, 3.2);
      P.gravity = rng.range(style.gLo, style.gHi);
      P.floor = -1e4; P.tLand = -1;
      P.size0 = r * rng.range(0.4, 0.8);
      P.size1 = r * rng.range(1.6, 2.6);
      P.growth = rng.range(0.25, 0.8) * Math.max(0.4, Math.sqrt(r));
      P.spin = rng.range(-0.4, 0.4);
      const shade = rng.range(0.85, 1.08);
      P.r = _c.r * shade; P.g = _c.g * shade; P.b = _c.b * shade;
      P.opacity = rng.range(0.55, 0.85) * style.opacity;
      P.seed = rng.next(); P.variant = rng.chance(0.7) ? rng.int(8, 16) : rng.int(0, 8); P.heat = 0; P.extra = 1;
      this.smokeLayer.emit(P);
    }
  }

  /**
   * Dust of a structure coming apart, through the collapse budget (see COLLAPSE_DUST_RATE): puffs
   * near the ground become a low cloud rolling outward, puffs higher up faint wisps (radius
   * capped at 1 m / 0.5 m), and puffs close to a recent one merge into it.
   */
  private collapseDust(p: THREE.Vector3, vel: THREE.Vector3 | null, radius: number, count: number, color: number): void {
    const now = this.now;
    const dt = now - this.collapseClock;
    this.collapseClock = now;
    if (dt > 0) this.collapseTokens = Math.min(COLLAPSE_DUST_BURST, this.collapseTokens + dt * COLLAPSE_DUST_RATE);
    for (const d of this.recentDust) {
      if (Math.abs(now - d.t) > COLLAPSE_MERGE_T) continue;
      const dx = d.x - p.x, dy = d.y - p.y, dz = d.z - p.z;
      if (dx * dx + dy * dy + dz * dz < COLLAPSE_MERGE_R * COLLAPSE_MERGE_R) return;
    }
    const low = p.y - groundOf(this.ctx.scene).heightAt(p.x, p.z) < COLLAPSE_LOW;
    const n = Math.min(this.thin('smoke', low ? count : Math.min(3, count)), Math.floor(this.collapseTokens));
    if (n <= 0) return;
    this.collapseTokens -= n;
    if (this.recentDust.length < 24) this.recentDust.push({ x: p.x, y: p.y, z: p.z, t: now });
    else {
      const d = this.recentDust[this.recentHead]!;
      d.x = p.x; d.y = p.y; d.z = p.z; d.t = now;
      this.recentHead = (this.recentHead + 1) % 24;
    }
    if (low) this.emitDust(p, vel, Math.min(1, radius), n, color, 1.1, now, DUST_GROUND);
    else this.emitDust(p, vel, Math.min(0.5, radius), n, color, 0.45, now, DUST_WISP);
  }

  /**
   * The fast cone of pulverised material a hit throws out of its crater — the first ~50 ms of
   * slow-motion footage of rifle and cannon hits on masonry or soil: fine dust leaving at tens of
   * m/s that air drag stops within about a metre (v₀/k), after which it billows like any dust.
   * Without it an impact reads as a cotton ball appearing on the wall.
   */
  emitDustJet(p: THREE.Vector3, axis: THREE.Vector3, halfAngle: number, speed: number, count: number, radius: number, color: number, t0 = this.now): void {
    const P = this.P;
    const rng = this.rng;
    _c.setHex(color);
    for (let i = 0; i < count; i++) {
      rng.inCone(axis, halfAngle, _j);
      const v = speed * rng.range(0.45, 1.0);
      P.x = p.x + _j.x * 0.02; P.y = p.y + _j.y * 0.02; P.z = p.z + _j.z * 0.02;
      P.vx = _j.x * v; P.vy = _j.y * v; P.vz = _j.z * v;
      P.t0 = t0 + rng.range(0, 0.006);
      P.life = rng.range(1.2, 2.6) * (0.7 + Math.min(1.5, radius / 0.5));
      // A turbulent puff punching through still air loses its momentum in ≈ 0.1 s.
      P.drag = rng.range(9, 15);
      P.gravity = rng.range(-0.01, 0.02);
      P.floor = -1e4; P.tLand = -1;
      P.size0 = radius * rng.range(0.3, 0.5);
      P.size1 = radius * rng.range(0.9, 1.5);
      P.growth = rng.range(0.1, 0.3);
      P.spin = rng.range(-1, 1);
      const shade = rng.range(0.9, 1.1);
      P.r = _c.r * shade; P.g = _c.g * shade; P.b = _c.b * shade;
      P.opacity = rng.range(0.45, 0.7);
      P.seed = rng.next(); P.variant = rng.int(8, 16); P.heat = 0; P.extra = 1;
      this.smokeLayer.emit(P);
    }
  }

  // ─── Walls in the way of chips and sparks ─────────────────────────────────────────────────

  /**
   * Distance from p along the unit direction `dir` to the first solid surface of a destructible
   * (not the terrain: the ground is every particle's floor already), or Infinity; its outward normal
   * goes to `outN`. One emission call casts at most WALL_RAYS_PER_CALL exact rays (the first
   * particles' own directions); later particles of the call intersect the surface plane found by
   * the cast ray closest to their direction (within ≈ 25°) — exact for a flat wall — so a 160-chip
   * burst costs a dozen registry rays. A per-frame budget bounds sustained fire; beyond it particles
   * fly unchecked, as before.
   */
  private wallHit(p: THREE.Vector3, dir: THREE.Vector3, range: number, outN: THREE.Vector3): number {
    const fan = this.fan;
    if (fan.n >= WALL_RAYS_PER_CALL || this.rayBudget <= 0 || !this.ctx.registry) {
      let best = 0.9, bi = -1;
      for (let i = 0; i < fan.n; i++) {
        const c = dir.x * fan.dir[i * 3]! + dir.y * fan.dir[i * 3 + 1]! + dir.z * fan.dir[i * 3 + 2]!;
        if (c > best) {
          best = c;
          bi = i;
        }
      }
      if (bi < 0 || !fan.hit[bi]) return Infinity;
      const nx = fan.nrm[bi * 3]!, ny = fan.nrm[bi * 3 + 1]!, nz = fan.nrm[bi * 3 + 2]!;
      const dn = dir.x * nx + dir.y * ny + dir.z * nz;
      if (dn > -0.05) return Infinity;
      const t = ((fan.pt[bi * 3]! - p.x) * nx + (fan.pt[bi * 3 + 1]! - p.y) * ny + (fan.pt[bi * 3 + 2]! - p.z) * nz) / dn;
      if (!(t > 0) || t > range) return Infinity;
      outN.set(nx, ny, nz);
      return t;
    }
    this.rayBudget--;
    this.raysCast++;
    const reg = this.ctx.registry;
    // Start just off the surface the particle leaves; if the origin sits on (or in) its source
    // element, look past that element.
    _o.copy(p).addScaledVector(dir, 0.03);
    let hit = reg.raycast(_o, dir, range);
    if (hit && hit.distance < 0.05 && hit.target.kind !== 'terrain') hit = reg.raycast(_o, dir, range, hit.target);
    const i = fan.n++;
    fan.dir[i * 3] = dir.x; fan.dir[i * 3 + 1] = dir.y; fan.dir[i * 3 + 2] = dir.z;
    const solid = !!hit && hit.target.kind !== 'terrain';
    fan.hit[i] = solid ? 1 : 0;
    if (!hit || !solid) return Infinity;
    fan.pt[i * 3] = hit.point.x; fan.pt[i * 3 + 1] = hit.point.y; fan.pt[i * 3 + 2] = hit.point.z;
    fan.nrm[i * 3] = hit.normal.x; fan.nrm[i * 3 + 1] = hit.normal.y; fan.nrm[i * 3 + 2] = hit.normal.z;
    outN.copy(hit.normal);
    return hit.distance + 0.03;
  }

  /**
   * Time for a particle launched at speed v with linear drag k to cover distance d along its launch
   * direction (motion.ts: s(t) = v·A(t) = v (1 − e^(−kt)) / k, gravity's share neglected over the
   * fraction of a second involved), or −1 if drag stops it first (d ≥ v / k).
   */
  private static timeToCover(d: number, v: number, k: number): number {
    if (!Number.isFinite(d) || v <= 1e-6) return -1;
    const kd = (k * d) / v;
    if (kd >= 0.98) return -1;
    return kd < 1e-4 ? d / v : -Math.log(1 - kd) / k;
  }

  /** Solid chips thrown from p within a cone around dir (half-angle `spread` rad). */
  emitChips(p: THREE.Vector3, dir: THREE.Vector3, spread: number, speed: number, count: number, size: number, color: number, kind: ChipKind, t0 = this.now): void {
    const rng = this.rng;
    const ground = groundOf(this.ctx.scene);
    _c.setHex(color);
    const n = Math.min(160, Math.max(0, Math.round(count)));
    _w.copy(dir);
    if (_w.lengthSq() < 1e-9) _w.set(0, 1, 0);
    _w.normalize();
    this.fan.n = 0;
    const wind = this.atmo.wind.value;
    for (let i = 0; i < n; i++) {
      rng.inCone(_w, Math.min(Math.PI * 0.95, Math.max(0.05, spread)), _d);
      const sp = speed * rng.range(0.35, 1.15);
      const s = size * rng.range(0.4, 1.3);
      // Drag of a tumbling chip: k ≈ 3 ρ_air Cd / (8 ρ_s r), Cd ≈ 1 (Newton drag linearised at ~15 m/s).
      const rho = kind === 'metal' ? 7850 : kind === 'glass' ? 2500 : 2400;
      const k = Math.min(3, (3 * 1.225 * 1.0 * 15) / (8 * rho * Math.max(s * 0.5, 1e-3)));
      const vx = _d.x * sp, vy = _d.y * sp, vz = _d.z * sp;
      // Floor: ground under the (drag-free) landing point, one refinement.
      const tg = Math.max(0.05, (vy + Math.sqrt(Math.max(0, vy * vy + 2 * 9.81 * Math.max(0.1, p.y)))) / 9.81);
      const floor = ground.heightAt(p.x + vx * tg * 0.7, p.z + vz * tg * 0.7) + s * 0.3;
      const tl = landingTime(p.y, vy, k, 1, 0, floor, 12);
      const life = rng.range(7, 14);
      const shade = rng.range(0.75, 1.15);
      const spin = rng.range(4, 25), seed = rng.next();
      const r = _c.r * shade, g = _c.g * shade, b = _c.b * shade;
      // A wall in the way (reached before the ground): the flight ends there and a ricochet
      // continues from the wall — restitution ≈ 0.3 normal, 0.6 tangential (rock-fall rebound
      // tables for hard surfaces, e.g. Chau et al. 2002), then the chip drops at the wall's foot.
      const tHit = FxSystem.timeToCover(this.wallHit(p, _d, Math.min(WALL_RAY_RANGE, sp / k), _hn), sp, k);
      if (tHit > 0 && (tl < 0 || tHit < tl) && tHit < life) {
        const m = motionAt(p.x, p.y, p.z, vx, vy, vz, k, 1, wind.x * 0.3, wind.y * 0.3, wind.z * 0.3, tHit, _ms);
        const vn = m.vx * _hn.x + m.vy * _hn.y + m.vz * _hn.z;
        const bx = 0.6 * (m.vx - vn * _hn.x) - 0.3 * vn * _hn.x;
        const by = 0.6 * (m.vy - vn * _hn.y) - 0.3 * vn * _hn.y;
        const bz = 0.6 * (m.vz - vn * _hn.z) - 0.3 * vn * _hn.z;
        const hx = m.x + _hn.x * s * 0.6, hy = m.y + _hn.y * s * 0.6, hz = m.z + _hn.z * s * 0.6;
        const floor2 = ground.heightAt(hx, hz) + s * 0.3;
        const tl2 = landingTime(hy, by, k, 1, 0, floor2, 12);
        this.chipLayer.emit(t0, tHit, p.x, p.y, p.z, vx, vy, vz, k, -1e4, -1, s, spin, seed, kind, r, g, b, false);
        this.chipLayer.emit(t0 + tHit, life - tHit, hx, hy, hz, bx, by, bz, k, floor2, tl2, s, -spin, seed, kind, r, g, b);
        continue;
      }
      this.chipLayer.emit(t0, life, p.x, p.y, p.z, vx, vy, vz, k, floor, tl, s, spin, seed, kind, r, g, b);
    }
  }

  /** Incandescent sparks / burning fragments; T0 in kelvin. */
  emitSparks(p: THREE.Vector3, dir: THREE.Vector3, count: number, speed: number, T0: number, spread: number, width: number, kind: 0 | 1, life = 0.6, t0 = this.now): void {
    const P = this.P;
    const rng = this.rng;
    const ground = groundOf(this.ctx.scene);
    const n = Math.min(400, Math.max(0, Math.round(count)));
    _w.copy(dir);
    if (_w.lengthSq() < 1e-9) _w.set(0, 1, 0);
    _w.normalize();
    const floor = ground.heightAt(p.x, p.z);
    this.fan.n = 0;
    for (let i = 0; i < n; i++) {
      rng.inCone(_w, Math.min(Math.PI * 0.95, spread), _d);
      const sp = speed * rng.range(0.3, 1.1);
      P.x = p.x; P.y = p.y; P.z = p.z;
      P.vx = _d.x * sp; P.vy = _d.y * sp; P.vz = _d.z * sp;
      P.t0 = t0 + rng.range(0, 0.01);
      P.life = life * rng.range(0.4, 1.3);
      // Steel sparks: ~0.1–0.5 mm burning droplets, drag rate ~ 2–6 1/s.
      P.drag = rng.range(1.5, 5);
      P.gravity = 1;
      P.floor = floor;
      P.tLand = landingTime(p.y, P.vy, P.drag, 1, 0, floor, P.life);
      // A spark that meets a wall first dies there (its droplet splashes and quenches on the cold
      // surface): the streak ends at the wall instead of passing through it.
      const tHit = FxSystem.timeToCover(this.wallHit(p, _d, Math.min(WALL_RAY_RANGE, sp / P.drag), _hn), sp, P.drag);
      if (tHit > 0 && tHit < P.life && (P.tLand < 0 || tHit < P.tLand)) P.life = tHit;
      P.size0 = P.size1 = width * rng.range(0.6, 1.4);
      P.growth = 1;
      P.spin = kind === 1 ? rng.range(8, 30) : 0;
      P.r = 1; P.g = 1; P.b = 1;
      P.opacity = 1;
      P.seed = rng.next(); P.variant = 0;
      P.heat = T0 * rng.range(0.85, 1.1);
      P.extra = kind;
      this.sparkLayer.emit(P);
    }
  }

  /** A flame / flash billboard (premultiplied over: overlapping flames do not add up). */
  private emitFlame(x: number, y: number, z: number, vx: number, vy: number, vz: number, size0: number, size1: number, life: number, T: number, variant: number, t0 = this.now, drag = 6, gravity = -0.2, tint = 1): void {
    const P = this.P;
    P.x = x; P.y = y; P.z = z; P.vx = vx; P.vy = vy; P.vz = vz;
    P.t0 = t0; P.life = life; P.drag = drag; P.gravity = gravity; P.floor = -1e4; P.tLand = -1;
    P.size0 = size0; P.size1 = size1; P.growth = Math.max(0.005, life * 0.3); P.spin = this.rng.range(-2, 2);
    P.r = tint; P.g = tint; P.b = tint; P.opacity = 1;
    P.seed = this.rng.next(); P.variant = variant; P.heat = T; P.extra = 0;
    this.fireLayer.emit(P);
  }

  // ─── Event reactions ─────────────────────────────────────────────────────────────────────

  private onShot(e: ShotEvent): void {
    const w = e.weapon;
    if (w.delivery !== 'direct') return;
    const rng = this.rng;
    const t0 = Math.max(e.time, this.now);
    const a = e.ammo;
    const E = 0.5 * a.mass * a.muzzleVelocity * a.muzzleVelocity;
    const cannon = w.category === 'cannon';
    const launcher = w.category === 'launcher';
    // Visual flash size scales with the propellant gas, ~ cube root of the muzzle energy.
    const s = Math.cbrt(Math.max(E, 50) / 1750) * (cannon ? 1.8 : 1);
    // Propellant burnt: a gun turns ≈ 30 % of the propellant's ≈ 4 MJ/kg into muzzle energy
    // (interior-ballistics energy balance), m_p ≈ E / 1.2 MJ/kg: 1.5 g for 5.56 mm (actual 1.6 g),
    // ≈ 5 kg for a 120 mm APFSDS (7–8 kg). Its gas at ambient pressure, ≈ 0.9 m³/kg (≈ 40 mol/kg of
    // CO, CO₂, H₂O, H₂, N₂ at STP), is the muzzle cloud: radius (3V / 4π)^⅓ ≈ 7 cm for a rifle,
    // ≈ 1 m for a tank gun, which entrainment grows two- to threefold while it thins.
    const rGas = Math.cbrt((3 * 0.9 * (E / 1.2e6)) / (4 * Math.PI));
    const o = e.origin, d = e.direction;
    const size = 0.07 * s;
    {
      this.emitFlame(o.x, o.y, o.z, d.x * 2, d.y * 2, d.z * 2, size * 1.3, size * 1.6, 0.03 + 0.004 * s, 2300, 12 + rng.int(0, 4), t0, 20, 0);
      for (let i = 0; i < 3; i++) {
        const f = (i + 1) * 0.6 * size;
        const v = rng.range(20, 45) * Math.sqrt(s);
        this.emitFlame(o.x + d.x * f, o.y + d.y * f, o.z + d.z * f, d.x * v, d.y * v, d.z * v, size * 0.6, size * 1.1, rng.range(0.025, 0.045), 2000, rng.int(0, 12), t0, 25, 0);
      }
      // Visible flash: the muzzle gases afterburn in air, but modern propellants carry flash
      // suppressants and most of that energy leaves as heat and infrared; count ≈ 10 % of the muzzle
      // energy as fireball-equivalent (estimate) and a life of the secondary flash, ≈ 10–40 ms. It
      // sits in the flash, about one gas radius ahead of the muzzle, and reaches a few tens of metres.
      _v.copy(o).addScaledVector(d, rGas);
      this.lights.fire(t0, _v, 0xffb77a, flashCandela(0.1 * E), 6 + 20 * rGas, 0.01 + 0.03 * rGas);
    }
    // Propellant smoke: the gas cloud a little ahead of the muzzle, pushed along the bore and stopped
    // by drag within a couple of radii; faint for rifles, a real but brief cloud for cannon.
    const smokeN = cannon ? 7 : 2;
    const kSmoke = 4;
    for (let i = 0; i < smokeN; i++) {
      const ahead = rGas * rng.range(0.5, 2.5);
      const v = rng.range(1.5, 4) * rGas * kSmoke;
      rng.inCone(d, 0.35, _u);
      this.puff(o.x + d.x * ahead, o.y + d.y * ahead, o.z + d.z * ahead, _u.x * v, _u.y * v, _u.z * v,
        0.5 * rGas, rGas * rng.range(1.8, 2.8), rng.range(1.2, 2.4) * (0.6 + rGas), 0x9d9a94, cannon ? 0.5 : 0.15, t0, kSmoke, -0.02, 1, true);
    }
    if (launcher) this.backblast(e, t0);
    if (cannon && E > 1e6) {
      // Tank gun: the blast, directed forward, raises a sheet of dust from the ground ahead of the
      // barrel when the muzzle is within a few gas radii of it.
      const g = groundOf(this.ctx.scene);
      _v.copy(o).addScaledVector(_u.set(d.x, 0, d.z).normalize(), 3 * rGas);
      const gy = g.heightAt(_v.x, _v.z);
      if (o.y - gy < 3 * rGas) {
        _v.y = gy + 0.3 * rGas;
        this.emitDust(_v, _j.copy(_u).multiplyScalar(4 * rGas), 1.2 * rGas, 8, g.dustColorAt(_v.x, _v.z), 0.5, t0);
      }
      this.shaker.add(0.35);
    } else if (w.recoil > 0) this.shaker.add(w.recoil * 0.08);
  }

  /** Recoilless / rocket launchers vent a cone of hot gas and smoke behind the tube. */
  private backblast(e: ShotEvent, t0: number): void {
    const rng = this.rng;
    const o = e.origin, d = e.direction;
    const soft = e.ammo.id === 'javelin';
    const n = soft ? 5 : 16;
    for (let i = 0; i < n; i++) {
      rng.inCone(_u.copy(d).negate(), 0.35, _d);
      const v = rng.range(8, soft ? 12 : 35);
      this.puff(o.x - d.x * 0.6, o.y - d.y * 0.6, o.z - d.z * 0.6, _d.x * v, _d.y * v, _d.z * v, 0.2, rng.range(1.2, 2.8), rng.range(4, 9), 0xc9c5bd, 0.55, t0);
    }
    if (!soft) {
      this.emitFlame(o.x - d.x * 0.9, o.y - d.y * 0.9, o.z - d.z * 0.9, -d.x * 30, -d.y * 30, -d.z * 30, 0.35, 1.2, 0.07, 2200, rng.int(0, 12), t0, 12, 0);
      // The booster burns out inside the tube and vents backwards (≈ 10 % efficient): ~3× the flash.
      _v.copy(o).addScaledVector(d, -1.2);
      this.lights.fire(t0, _v, 0xffc58a, flashCandela(3 * 0.5 * e.ammo.mass * e.ammo.muzzleVelocity ** 2), 12, 0.06);
    }
  }

  /** One smoke puff (lit, drifting). */
  private puff(x: number, y: number, z: number, vx: number, vy: number, vz: number, size0: number, size1: number, life: number, color: number, opacity: number, t0 = this.now, drag = 2.2, rise = -0.03, soot = 1, diffuse = false): void {
    const P = this.P;
    const rng = this.rng;
    _c.setHex(color);
    P.x = x; P.y = y; P.z = z; P.vx = vx; P.vy = vy; P.vz = vz;
    P.t0 = t0; P.life = life; P.drag = drag; P.gravity = rise; P.floor = -1e4; P.tLand = -1;
    P.size0 = size0; P.size1 = size1; P.growth = life * 0.35; P.spin = rng.range(-0.3, 0.3);
    const sh = rng.range(0.9, 1.08);
    P.r = _c.r * sh; P.g = _c.g * sh; P.b = _c.b * sh; P.opacity = opacity;
    P.seed = rng.next(); P.variant = diffuse ? rng.int(8, 16) : rng.int(0, 8); P.heat = 0; P.extra = soot;
    this.smokeLayer.emit(P);
  }

  private onImpact(e: ImpactEvent): void {
    const rng = this.rng;
    const m = e.material;
    const done = this.marked(e.point);
    const E = Math.max(e.kineticEnergy, 1);
    // Effects scale with the energy delivered (5.56 mm ball ≈ 1.7 kJ → s = 1).
    const s = Math.cbrt(E / 1750);
    const n = e.normal;
    // Ejecta leave around the surface normal, skewed towards the reflected shot line.
    _d.copy(e.direction).reflect(n).multiplyScalar(0.35).add(n).normalize();
    const incendiary = /api|mk ?211|pgu-14|raufoss/i.test(`${e.ammo.id} ${e.ammo.name}`);
    const hard = e.ammo.kind === 'ap' || e.ammo.kind === 'apfsds';
    const jet = e.agent === 'jet';
    const p = e.point;
    const cls = m.class;
    if (cls === 'brittle' || cls === 'soil') {
      const soil = cls === 'soil';
      if (!(done & MARK_DUST)) {
        // Cloud radius ∝ the cube root of the energy (the mass of pulverised material scales with the
        // crater volume ∝ E): ~0.15 m for 5.56 mm ball, ~0.3 m for .50 AP, ~0.7 m for 30 mm —
        // consistent with slow-motion footage of rifle and cannon hits on masonry.
        const r = Math.min(1.5, Math.max(0.05, (e.craterRadius || 0.02) * 2.5, 0.14 * s) * (soil ? 1.3 : 1));
        this.emitDust(p, _v.copy(_d).multiplyScalar((soil ? 3 : 2) * Math.sqrt(s)), r, this.thin('smoke', Math.min(14, 4 + 2 * s)), m.dustColor, 0.7 + 0.15 * s);
      }
      // The ejecta cone is a ballistic signature of the hit itself: emitted even when the target
      // raised its own (slow, billowing) dust. Soil throws a narrower, steeper plume.
      {
        const r = Math.min(1.2, Math.max(0.06, 0.12 * s));
        this.emitDustJet(p, _d, soil ? 0.35 : 0.6, (soil ? 9 : 10) * Math.pow(s, 0.35), this.thin('smoke', Math.min(12, 5 + 2 * s)), r, m.dustColor);
      }
      if (!(done & MARK_CHIPS)) {
        const count = this.thin('chips', Math.min(90, 6 + 10 * s * s));
        const size = Math.min(0.08, (soil ? 0.012 : 0.008) * Math.sqrt(s));
        this.emitChips(p, _d, soil ? 0.45 : 0.8, (soil ? 9 : 16) * Math.pow(s, 0.3), count, size, soil ? 0x4a3b2c : m.color, 'stone');
      }
      if ((hard || m.sparks) && !(done & MARK_SPARKS)) this.emitSparks(p, _d, this.thin('sparks', hard ? 6 + 4 * s : 3), 60, 1700, 1.0, 0.0007, 0, 0.35);
    } else if (cls === 'ductile') {
      if (!(done & MARK_SPARKS)) {
        // Sparks spray along the surface in the direction of travel (ricochet-like), hotter and
        // more numerous for hard cores and long rods; a HEAT jet throws molten metal.
        _u.copy(e.direction).addScaledVector(n, -e.direction.dot(n)).normalize().multiplyScalar(0.8).add(_d).normalize();
        const count = this.thin('sparks', Math.min(260, (jet ? 80 : hard ? 30 : 16) * Math.sqrt(s)));
        this.emitSparks(p, _u, count, jet ? 45 : 90, jet ? 2300 : 1900, jet ? 1.2 : 0.8, jet ? 0.0025 : 0.0008, 0, jet ? 1.4 : 0.6);
        if (e.outcome === 'perforate' && e.exitPoint) this.emitSparks(e.exitPoint, e.direction, count * 0.6, 120, 2000, 0.6, 0.001, 0, 0.5);
      }
      // Incandescent spray: ≈ 2 % of the impact energy (10 % for a jet) leaves as a visible flash
      // (estimate). The light sits in the spray half a metre off the plate: a point source on the
      // surface would paint a white disc (illuminance ∝ 1/d²).
      _v.copy(p).addScaledVector(n, 0.5);
      this.lights.fire(this.now, _v, jet ? 0xfff0d0 : 0xffa860, flashCandela((jet ? 0.1 : 0.02) * E), 3 + 2 * s, jet ? 0.08 : 0.025);
      if (jet || e.ammo.kind === 'apfsds') this.emitDust(p, _v.copy(n).multiplyScalar(4), 0.25 * s, 6, 0x6d6760, 1);
    } else if (cls === 'glass') {
      this.emitSparks(p, e.direction, this.thin('sparks', Math.min(200, 25 * s)), 6, 0, 1.3, 0.004, 1, 2.5);
      this.emitChips(p, e.direction, 0.9, 5, this.thin('chips', Math.min(60, 10 * s)), 0.006, m.color, 'glass');
      this.emitDust(p, _v.copy(e.direction).multiplyScalar(-1), 0.05, 2, 0xdfe6e6, 0.3);
    }
    if (e.outcome === 'perforate' && e.exitPoint && cls === 'brittle') {
      // Rear-face spall: a cone of dust and fragments out of the back of the wall.
      this.emitDust(e.exitPoint, _v.copy(e.direction).multiplyScalar(5), Math.max(0.08, e.spallRadius * 2), 5, m.dustColor, 1);
      this.emitChips(e.exitPoint, e.direction, 0.5, 20 * Math.pow(s, 0.3), this.thin('chips', Math.min(60, 8 * s)), 0.01, m.color, 'stone');
    }
    if (incendiary) {
      // Incendiary (zirconium / misch-metal) flash on impact: a white burst and burning particles.
      this.emitFlame(p.x + n.x * 0.05, p.y + n.y * 0.05, p.z + n.z * 0.05, 0, 0, 0, 0.12 * s, 0.25 * s, 0.05, 2600, 12 + rng.int(0, 4), this.now, 10, 0);
      this.emitSparks(p, _d, this.thin('sparks', 20 * s), 40, 2400, 1.1, 0.001, 0, 0.5);
      // Incendiary filler ≈ 3 % of the projectile mass burning at ~10 MJ/kg (zirconium, misch metal),
      // a flash of a few milliseconds.
      _v.copy(p).addScaledVector(n, 0.5);
      this.lights.fire(this.now, _v, 0xfff2d8, flashCandela(0.03 * e.mass * 1e7), 6, 0.015);
    }
  }

  private onBlast(e: BlastEvent): void {
    const rng = this.rng;
    const now = e.time;
    const W = Math.max(e.tntKg, 1e-4);
    const w3 = Math.cbrt(W);
    const sw = Math.sqrt(w3);
    const thermo = e.kind === 'thermobaric';
    const Rf = e.fireballRadius;
    const c = e.center;
    const ground = groundOf(this.ctx.scene);
    const gy = ground.heightAt(c.x, c.z);
    const hob = c.y - gy;
    const nearGround = hob < 1.2 * Rf;
    // Luminous fireball duration ∝ W^⅓ (cube-root scaling of fireball phenomena, Baker et al.
    // 1983, "Explosion Hazards and Evaluation"); the constant (≈0.12 s·kg^−⅓) matches high-speed
    // footage of 1–10 kg charges. Thermobaric fills burn in the air ~2.5× longer.
    const tFire = 0.12 * w3 * (thermo ? 2.5 : 1);
    // Blast axis: away from the surface the charge sat on, else up.
    const axis = _w.copy(e.normal ?? UP);
    if (!e.normal && nearGround) axis.set(0, 1, 0);
    const dustHex = ground.dustColorAt(c.x, c.z);
    const P = this.P;

    // Flash. Peak luminous intensity ≈ fireball radiance × projected area (a ~2300 K surface of
    // radius R_f ≈ 1.75 W^⅓), i.e. ≈ 300 W^⅔ render-candela. The white-hot phase is brief: the
    // detonation products cool below bright incandescence within ≈ 15 ms·kg^−⅓ (e-folding ≈ 5 ms;
    // high-speed footage of 1–10 kg charges; cube-root scaling, Baker et al. 1983) — the orange
    // afterburn that follows is drawn by the fireball particles, which light nothing much in daylight. Its reach: where it
    // still adds ≈ 5 % to the sunlight, √(I / 0.05 E_sun), capped at a few fireball radii.
    {
      const I = FIREBALL_CD * Math.pow(W, 2 / 3) * (thermo ? 1.5 : 1);
      const sc = this.atmo.sunColor.value;
      const eSun = Math.max(0.5, 0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b);
      const reach = Math.min(Math.sqrt(I / (0.05 * eSun)), 6 * Rf + 4);
      this.lights.fire(now, _v.copy(c).addScaledVector(axis, 0.4 * Rf), thermo ? 0xffbf73 : 0xffdcae, I, reach, 0.015 * w3 * (thermo ? 2.5 : 1));
    }

    // 1) Fireball body: incandescent turbulent puffs that expand fast, stall and cool into soot.
    const nFire = Math.round(Math.min(260, (36 + 55 * w3) * (thermo ? 1.5 : 1)));
    const kFire = 1 / Math.max(0.01, 0.2 * tFire);
    for (let i = 0; i < nFire; i++) {
      rng.onSphere(_d);
      if (_d.dot(axis) < 0) _d.addScaledVector(axis, -2 * _d.dot(axis));
      const reach = Rf * Math.pow(rng.next(), 0.5) * 0.9;
      const v = reach * kFire;
      P.x = c.x + _d.x * 0.1 * Rf; P.y = c.y + _d.y * 0.1 * Rf; P.z = c.z + _d.z * 0.1 * Rf;
      P.vx = _d.x * v; P.vy = _d.y * v; P.vz = _d.z * v;
      P.t0 = now + rng.range(0, 0.12 * tFire);
      P.life = tFire * rng.range(2.2, 3.6);
      P.drag = kFire; P.gravity = -0.02; P.floor = -1e4; P.tLand = -1;
      // growth τ = 0.3 t_c: the smoke shader reads the puff's cooling time t_c from it (hot puffs).
      // Gas at the rim of the ball entrains cold air first and goes dark first (t_c ≈ 0.6 t_F);
      // the core keeps burning longest (≈ 1.35 t_F): a sooty shell with fire showing through gaps.
      P.size0 = Rf * rng.range(0.15, 0.3); P.size1 = Rf * rng.range(0.45, 0.7); P.growth = tFire * 0.3 * (1.35 - 0.8 * (reach / Rf));
      P.spin = rng.range(-1.5, 1.5);
      // Cooled detonation products: dark grey TNT smoke (soot mixed with fine dust), not carbon
      // black — a thin puff of albedo 0.04 reads as a hole in the cloud.
      const soot = thermo ? 0.1 : 0.075;
      P.r = soot; P.g = soot; P.b = soot * 1.04; P.opacity = 0.85;
      P.seed = rng.next();
      // Turbulent mixing: the fireball is a patchwork of hot and cooler pockets, with tongues of
      // unburnt soot (≈ 20 % of the puffs never glow) — mottled, not a uniform glowing ball.
      const sootTongue = rng.chance(thermo ? 0.1 : 0.22);
      // Soot tongues are torn streamers, not billows: ragged cells, a little thinner.
      P.variant = sootTongue || rng.chance(0.5) ? rng.int(8, 16) : rng.int(0, 8);
      if (sootTongue) P.opacity = 0.65;
      P.heat = sootTongue ? 0 : (thermo ? 2050 : 2250) * rng.range(0.8, 1.06);
      // Young soot is darker than the aged plume, but never below ≈ 0.04 albedo (fresh flame soot
      // clouds; darker reads as holes in the frame, not smoke).
      P.extra = sootTongue ? 0.55 : 0.7;
      this.smokeLayer.emit(P);
    }
    // Flame cores: the hottest, youngest gas in the middle of the ball. They are puffs of the same
    // optically thick medium, drawn in depth order with the rest (premultiplied 'over'), so the
    // emission of a pixel saturates at the temperature of the gas in front instead of summing a
    // stack of additive billboards to white, and soot in front of a core hides it.
    const nCore = Math.round(Math.min(90, 14 + 24 * w3) * (thermo ? 1.6 : 1));
    for (let i = 0; i < nCore; i++) {
      rng.onSphere(_d);
      if (_d.dot(axis) < 0) _d.addScaledVector(axis, -2 * _d.dot(axis));
      const v = Rf * rng.range(0.1, 0.55) * kFire;
      P.x = c.x + _d.x * 0.1 * Rf; P.y = c.y + _d.y * 0.1 * Rf; P.z = c.z + _d.z * 0.1 * Rf;
      P.vx = _d.x * v; P.vy = _d.y * v; P.vz = _d.z * v;
      P.t0 = now + rng.range(0, 0.08 * tFire);
      P.life = tFire * rng.range(0.9, 1.6);
      P.drag = kFire; P.gravity = -0.05; P.floor = -1e4; P.tLand = -1;
      P.size0 = Rf * rng.range(0.18, 0.26); P.size1 = Rf * rng.range(0.35, 0.55); P.growth = tFire * 0.3 * 1.2; // 0.3 t_c (shader)
      P.spin = rng.range(-1.5, 1.5);
      P.r = 0.06; P.g = 0.06; P.b = 0.062; P.opacity = 0.9;
      P.seed = rng.next(); P.variant = rng.int(0, 8);
      P.heat = (thermo ? 2200 : 2380) * rng.range(0.96, 1.04);
      P.extra = 0.7;
      this.smokeLayer.emit(P);
    }

    // 2) Sooty roll-up: the hot products rise as a dark toroidal plume that greys as it dilutes.
    //    Initial rise then decaying buoyancy: v0 up with drag, small terminal rise (entrainment).
    const nRoll = Math.round(Math.min(90, 14 + 16 * w3) * (thermo ? 1.3 : 1));
    const rise = 4 * sw * (thermo ? 1.3 : 1);
    for (let i = 0; i < nRoll; i++) {
      rng.inBall(_d);
      const k = 0.9;
      P.x = c.x + _d.x * Rf * 0.5; P.y = c.y + Math.abs(_d.y) * Rf * 0.4 + 0.3 * Rf; P.z = c.z + _d.z * Rf * 0.5;
      P.vx = _d.x * 1.5; P.vy = rise * rng.range(0.6, 1.3); P.vz = _d.z * 1.5;
      P.t0 = now + tFire * rng.range(0.4, 1.0);
      P.life = rng.range(9, 16) * sw;
      // Terminal rise 0.3–0.6 m/s once the momentum has been shed (k = 0.9 1/s).
      P.drag = k; P.gravity = -(rng.range(0.3, 0.6) * k) / 9.81; P.floor = -1e4; P.tLand = -1;
      P.size0 = Rf * rng.range(0.35, 0.55); P.size1 = Rf * rng.range(1.5, 2.4); P.growth = 2.5 * sw;
      P.spin = rng.range(-0.25, 0.25);
      _c.setHex(0x3d3b38);
      P.r = _c.r; P.g = _c.g; P.b = _c.b; P.opacity = 0.62;
      P.seed = rng.next(); P.variant = rng.int(0, 8);
      P.heat = 0;
      P.extra = 0.4;
      this.smokeLayer.emit(P);
    }

    // 3) Near the ground: the dust cloud is what dominates a surface burst after ~0.2 s.
    if (nearGround) {
      // Crater ejecta dust thrown up in a cone, hanging as a brown-grey cloud — in proportion to
      // the crater the burst digs (the terrain's height-of-burst factor: none above ≈ 0.6 m/kg^⅓,
      // Cooper 1996); a charge on a column 1 m over the paving only sweeps up surface dust.
      const dig = heightOfBurstFactors(hob, W).radius;
      const nCol = Math.round(Math.min(120, 24 + 30 * w3) * (0.15 + 0.85 * dig));
      for (let i = 0; i < nCol; i++) {
        rng.inCone(UP, 0.6, _d);
        const v = rng.range(4, 14) * sw;
        P.x = c.x + _d.x * 0.2 * Rf; P.y = gy + 0.1 * Rf; P.z = c.z + _d.z * 0.2 * Rf;
        P.vx = _d.x * v; P.vy = _d.y * v; P.vz = _d.z * v;
        P.t0 = now + rng.range(0.02, 0.5) * tFire;
        P.life = rng.range(6, 14) * sw;
        P.drag = rng.range(1.6, 2.6); P.gravity = rng.range(0.0, 0.03); P.floor = -1e4; P.tLand = -1;
        P.size0 = Rf * rng.range(0.2, 0.35); P.size1 = Rf * rng.range(1.0, 1.8); P.growth = 1.5 * sw;
        P.spin = rng.range(-0.3, 0.3);
        _c.setHex(dustHex);
        const shade = rng.range(0.8, 1.02);
        P.r = _c.r * shade; P.g = _c.g * shade; P.b = _c.b * shade; P.opacity = 0.5;
        P.seed = rng.next(); P.variant = rng.chance(0.5) ? rng.int(0, 8) : rng.int(8, 16); P.heat = 0; P.extra = rng.range(0.55, 0.85);
        this.smokeLayer.emit(P);
      }
      // Base surge: dust racing outward along the ground behind the shock, then settling.
      const nSkirt = Math.round(Math.min(140, 30 + 30 * w3));
      for (let i = 0; i < nSkirt; i++) {
        const a = rng.range(0, Math.PI * 2);
        const reach = 2.6 * Rf * rng.range(0.5, 1.15);
        const k = 1.4;
        const v = reach * k;
        const x = c.x + Math.cos(a) * 0.3 * Rf, z = c.z + Math.sin(a) * 0.3 * Rf;
        P.x = x; P.y = gy + rng.range(0.05, 0.3) * Rf; P.z = z;
        P.vx = Math.cos(a) * v; P.vy = rng.range(0.2, 1.2) * sw; P.vz = Math.sin(a) * v;
        P.t0 = now + rng.range(0.01, 0.06) * w3;
        P.life = rng.range(4, 9) * sw;
        P.drag = k; P.gravity = 0.01; P.floor = -1e4; P.tLand = -1;
        P.size0 = 0.35 * w3; P.size1 = 1.5 * w3 * rng.range(0.8, 1.3); P.growth = 1.2 * sw;
        P.spin = rng.range(-0.3, 0.3);
        _c.setHex(dustHex);
        P.r = _c.r; P.g = _c.g; P.b = _c.b; P.opacity = 0.38;
        P.seed = rng.next(); P.variant = rng.int(8, 16); P.heat = 0; P.extra = 0.9;
        this.smokeLayer.emit(P);
      }
      // Ejecta: soil clods / shattered paving thrown out of the crater.
      const mat = ground.materialAt(c.x, c.z);
      const nEj = Math.round(Math.min(160, 24 + 50 * w3));
      this.emitChips(_v.set(c.x, gy + 0.05, c.z), UP, 0.9, 16 * Math.pow(w3, 0.35), nEj, Math.min(0.12, 0.03 * sw), mat.class === 'soil' ? 0x4f4033 : mat.color, 'stone', now + 0.005);
      // The front sweeping the ground is drawn by the shock ring (a continuous band); dust puffs placed
      // along it read as a dotted circle, so the ring is all there is.
      this.shock.spawn(now, c, gy, W, _c.setHex(dustHex));
    } else if (W > 2) {
      this.shock.spawn(now, c, gy, W, _c.setHex(dustHex));
    }

    // 4) Burning fragments for cased munitions; burning fuel droplets for thermobaric fills.
    const cased = (e.casingMass ?? 0) > 0;
    if (cased || thermo) {
      const nFrag = Math.round(Math.min(200, (cased ? 30 : 60) * sw));
      this.emitSparks(c, axis, nFrag, thermo ? 25 : 180, thermo ? 1900 : 2100, Math.PI * 0.55, thermo ? 0.004 : 0.0015, 0, thermo ? 2.2 : 0.35, now);
    }
  }

  private onFracture(e: FractureEvent): void {
    const done = this.marked(e.position);
    const V = Math.max(e.volume, 1e-6);
    const size = Math.cbrt(V);
    if (!(done & MARK_DUST) && e.material.class !== 'ductile') {
      const r = fractureDustRadius(V, Math.max(1, e.pieces));
      const n = Math.round(Math.min(18, 3 + 6 * r));
      // A piece driven off by a hit or a blast (it has a direction) billows where it broke; pieces
      // breaking in a collapse raise collapse dust.
      if (e.direction) this.emitDust(e.position, _v.copy(e.direction).multiplyScalar(1.5), r, n, e.material.dustColor, 1);
      else this.collapseDust(e.position, null, r, n, e.material.dustColor);
    }
    if (!(done & MARK_CHIPS)) this.emitChips(e.position, e.direction ?? UP, 1.2, 5, Math.min(60, 8 + e.volume * 60), Math.min(0.05, 0.015 + size * 0.02), e.material.color, e.material.class === 'ductile' ? 'metal' : 'stone');
  }

  private onDebrisContact(e: DebrisContactEvent): void {
    if (this.contactsThisFrame++ > 10) return;
    if (this.marked(e.position) & MARK_DUST) return;
    const m = e.material;
    if (m.class === 'glass') {
      this.emitSparks(e.position, UP, Math.min(30, 4 + e.impulse * 0.5), 3, 0, 1.2, 0.004, 1, 1.5);
      return;
    }
    // Dust in proportion to the impact: fines crushed off the contact corners grow with the energy
    // dissipated there, so the puff radius goes as J^⅓ (J = m·Δv, N·s: 0.2 m at 3 N·s, 0.9 m at
    // 400 N·s — an engineering fit to footage, not a model). Never larger than the piece itself
    // (its `size`); a steel member's `size` is its length, and steel raises no dust of its own —
    // only the ground it lands on does.
    const r = Math.min(0.9, Math.max(0.12, 0.12 * Math.cbrt(e.impulse)));
    const amount = Math.round(Math.min(6, 1 + Math.sqrt(e.impulse) * 0.25));
    if (m.class !== 'ductile') this.collapseDust(e.position, null, Math.min(r, Math.max(0.12, e.size * 0.8)), amount, m.dustColor);
    else {
      const g = groundOf(this.ctx.scene);
      if (e.position.y - g.heightAt(e.position.x, e.position.z) < 0.6) this.collapseDust(e.position, null, r, amount, g.dustColorAt(e.position.x, e.position.z));
    }
    if (e.impulse > 20) this.emitChips(e.position, UP, 1.2, 3, Math.min(20, e.impulse * 0.2), Math.min(0.03, e.size * 0.08), m.color, m.class === 'ductile' ? 'metal' : 'stone');
    if (m.sparks && m.class === 'ductile' && e.impulse > 50) this.emitSparks(e.position, UP, 6, 12, 1400, 1.3, 0.0006, 0, 0.3);
  }

  private onShatter(e: ShatterEvent): void {
    const n = Math.min(300, 30 + e.area * 60);
    this.emitSparks(e.position, UP, n, 5, 0, Math.PI * 0.9, 0.004, 1, 3);
    // Breaking glass makes glitter, not a cloud: a faint wisp of fines (≤ 0.6 m) that falls with the
    // shards (a 10 m² curtain-wall pane had stood a 4 m white billow at the top of the tower).
    this.emitDust(e.position, null, Math.min(0.6, Math.max(0.2, Math.sqrt(e.area) * 0.3)), 3, 0xe9f1f1, 0.6, this.now, DUST_WISP);
  }

  private onStructuralFailure(e: StructuralFailureEvent): void {
    // Losing support, buckling or being severed raises no dust by itself — a collapse's dust comes
    // from material that fractures, crushes and lands (fracture / debrisContact events, and the
    // element's own crushing dust). Only a brittle member failing by crushing puffs here, sized
    // like the fracture of a crushed zone about one member depth long.
    if (e.cause !== 'crushing' || (e.material && e.material.class !== 'brittle')) return;
    if (this.marked(e.position) & MARK_DUST) return;
    const r = fractureDustRadius(Math.min(1, e.mass / 2400 / 20), 12);
    this.collapseDust(e.position, null, r, Math.round(Math.min(12, 3 + 6 * r)), e.material?.dustColor ?? 0xbdb7ac);
  }

  // ─── Per frame ───────────────────────────────────────────────────────────────────────────

  frameUpdate(_simDt: number, realDt: number): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    const now = this.now;
    const atmo = this.atmo;
    atmo.time.value = now;
    ctx.renderer.getDrawingBufferSize(atmo.resolution.value);
    atmo.cameraNear.value = ctx.camera.near;
    atmo.cameraFar.value = ctx.camera.far;
    this.shutter.value = SHUTTER * Math.max(ctx.time.scale, 0.02);
    if (!atmo.pipelineHandlesShake) this.syncLightsFromScene();
    this.contactsThisFrame = 0;
    this.rayBudget = WALL_RAYS_PER_FRAME;
    this.decayLoad(_simDt);
    this.updateEmitters(now, _simDt);
    this.updateProjectiles(now);
    this.lights.update(now);
    this.shock.update(now);
    this.smokeLayer.flush(now);
    this.fireLayer.flush(now);
    this.sparkLayer.flush(now);
    this.chipLayer.flush(now);
    // Camera shake runs on wall-clock time (it is the viewer's body, not the simulation).
    const shaking = this.shaker.update(realDt);
    const o = this.shaker.out;
    atmo.shake.active = shaking;
    atmo.shake.position.set(o.x, o.y, o.z);
    atmo.shake.rotation.set(o.pitch, o.yaw, o.roll);
    this.lastFrameMs = performance.now() - t0;
  }

  private updateEmitters(now: number, dt: number): void {
    const rng = this.rng;
    let w = 0;
    for (let i = 0; i < this.emitters.length; i++) {
      const e = this.emitters[i]!;
      if (now > e.until) continue;
      this.emitters[w++] = e;
      e.acc += e.rate * Math.max(0, dt);
      while (e.acc >= 1) {
        e.acc -= 1;
        this.puff(e.x + rng.range(-1, 1) * e.radius * 0.4, e.y, e.z + rng.range(-1, 1) * e.radius * 0.4, rng.range(-0.2, 0.2), e.rise, rng.range(-0.2, 0.2),
          e.radius * 0.6, e.radius * rng.range(2.5, 4), rng.range(8, 16), e.color, 0.5, now, 0.6, -(e.rise * 0.6) / 9.81 * 0.6, 0.8);
      }
    }
    this.emitters.length = w;
  }

  /** Tracers, rocket flames and smoke trails from the live projectiles. */
  private updateProjectiles(now: number): void {
    const list = this.ctx.projectiles.active;
    const tr = this.tracers;
    tr.begin();
    for (const t of this.trails.values()) t.alive = false;
    const scale = Math.max(this.ctx.time.scale, 0.02);
    for (const p of list) {
      if (!p.alive) continue;
      const speed = p.velocity.length();
      if (p.tracer && speed > 1) {
        // Streak: distance flown during the exposure, never behind the muzzle.
        const len = Math.min(speed * SHUTTER * scale, speed * Math.max(p.age, 0), 60);
        _d.copy(p.velocity).divideScalar(speed);
        const green = p.ammo.id === 'lps';
        // Burning Sr(NO₃)₂ / Mg composition: a few ×10 the sun-lit wall at the pellet, spread over a
        // sub-pixel streak — bright enough to bloom a little, not a laser beam.
        const I = 12;
        tr.add(p.position.x, p.position.y, p.position.z, p.position.x - _d.x * len, p.position.y - _d.y * len, p.position.z - _d.z * len,
          (green ? 0.25 : 1) * I, (green ? 1 : 0.22) * I, (green ? 0.3 : 0.06) * I, Math.max(0.02, p.ammo.diameter * 3));
      }
      if (p.ammo.rocket) this.rocketTrail(p.id, p.position, p.velocity, p.burning, now);
    }
    for (const [id, t] of this.trails) if (!t.alive) this.trails.delete(id);
    tr.end();
  }

  private rocketTrail(id: number, pos: THREE.Vector3, vel: THREE.Vector3, burning: boolean, now: number): void {
    let t = this.trails.get(id);
    if (!t) {
      t = { x: pos.x, y: pos.y, z: pos.z, alive: true };
      this.trails.set(id, t);
      return;
    }
    t.alive = true;
    const dx = pos.x - t.x, dy = pos.y - t.y, dz = pos.z - t.z;
    const dist = Math.hypot(dx, dy, dz);
    if (burning && dist > 1e-3) {
      const rng = this.rng;
      const speed = vel.length();
      _d.copy(vel).divideScalar(Math.max(speed, 1e-6));
      // Exhaust plume: a short flame cone behind the nozzle, re-emitted every frame. Born a
      // little in the past (and placed back along the path) so a frame always shows it.
      const back = 0.012;
      for (let i = 0; i < 4; i++) {
        const off = 0.15 + i * 0.16 + rng.next() * 0.05;
        const x = pos.x - _d.x * off - vel.x * back, y = pos.y - _d.y * off - vel.y * back, z = pos.z - _d.z * off - vel.z * back;
        this.emitFlame(x, y, z, vel.x, vel.y, vel.z, 0.2 - i * 0.03, 0.26 - i * 0.03, 0.045, 2350 - i * 150, rng.int(0, 12), now - back, 0.01, 0);
      }
      // Motor smoke: a continuous white line that spreads into a wispy trail over several seconds
      // and drifts with the wind. Soft (diffuse) puffs every ≤ 0.16 m — under half their width, or
      // the line breaks up into a string of beads. That is ~1 300 puffs for an RPG-7's 200 m burn
      // and ~3 500 for a Javelin; the per-frame cap only bounds a stalled frame.
      const n = Math.min(96, Math.ceil(dist / 0.16));
      for (let i = 0; i < n; i++) {
        const u = (i + rng.next()) / n;
        this.puff(t.x + dx * u, t.y + dy * u, t.z + dz * u, rng.range(-0.3, 0.3), rng.range(-0.1, 0.3), rng.range(-0.3, 0.3),
          0.2, rng.range(0.55, 1.1), rng.range(6, 12), 0xeae7e1, 0.45, now - (1 - u) * (dist / Math.max(speed, 1)), 1.8, -0.006, 1, true);
      }
      // Motor plume: ~1 MW of burning propellant, ≈ 1 % radiated in the visible → ≈ 10⁵ cd, a few
      // render candela (estimate); enough to warm the ground under a low rocket, no more.
      if (rng.chance(0.3)) this.lights.fire(now, pos, 0xffc080, 4, 10, 0.05);
    }
    t.x = pos.x; t.y = pos.y; t.z = pos.z;
  }

  /**
   * Under BasicPipeline nothing writes the atmosphere: light the particles with the scene's own
   * directional sun and hemisphere fill (rescanned once a second in case the scene changes them).
   */
  private syncLightsFromScene(): void {
    const scene = this.ctx.scene;
    if (--this.lightScan <= 0 || !this.sceneSun?.parent) {
      this.lightScan = 60;
      this.sceneSun = null;
      this.sceneHemi = null;
      scene.traverse((o) => {
        if (!this.sceneSun && (o as THREE.DirectionalLight).isDirectionalLight && o.visible) this.sceneSun = o as THREE.DirectionalLight;
        if (!this.sceneHemi && (o as THREE.HemisphereLight).isHemisphereLight && o.visible) this.sceneHemi = o as THREE.HemisphereLight;
      });
    }
    const a = this.atmo;
    const sun = this.sceneSun;
    a.hasSunShadow.value = 0;
    if (sun) {
      sun.getWorldPosition(_u);
      sun.target.getWorldPosition(_v);
      a.sunDirection.value.copy(_u).sub(_v).normalize();
      a.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
      // The light's own PCF map (a depth-compare texture) keeps smoke in building shadows dark.
      // Its matrix is last frame's, which is exact for the fixed sun of BasicPipeline.
      const sh = sun.shadow;
      const map = sun.castShadow ? sh.map?.depthTexture : null;
      if (map && map.compareFunction !== null) {
        a.sunShadowMap.value = map;
        a.sunShadowMatrix.value[0]!.copy(sh.matrix);
        a.sunShadowMatrix.value[1]!.copy(sh.matrix);
        a.sunShadowSplit.value = 1e9;
        a.hasSunShadow.value = 1;
      }
    }
    const hemi = this.sceneHemi;
    if (hemi) {
      // three.js lights a Lambertian surface with hemisphere irradiance × albedo / π: the ambient
      // uniforms hold radiance per unit albedo, so divide by π (the full pipeline does the same).
      a.skyAmbient.value.copy(hemi.color).multiplyScalar(hemi.intensity / Math.PI);
      a.groundAmbient.value.copy(hemi.groundColor).multiplyScalar(hemi.intensity / Math.PI);
    }
    const fog = scene.fog as THREE.Fog | null;
    if (fog?.color) a.hazeColor.value.copy(fog.color);
  }

  // ─── Camera shake under BasicPipeline ────────────────────────────────────────────────────

  private applyShake(): void {
    if (this.shakeApplied) return;
    const cam = this.ctx.camera;
    this.savedPos.copy(cam.position);
    this.savedQuat.copy(cam.quaternion);
    cam.position.add(this.atmo.shake.position);
    cam.quaternion.multiply(_q.setFromEuler(_e.copy(this.atmo.shake.rotation)));
    cam.updateMatrixWorld();
    this.shakeApplied = true;
  }

  private restoreShake(): void {
    if (!this.shakeApplied) return;
    const cam = this.ctx.camera;
    cam.position.copy(this.savedPos);
    cam.quaternion.copy(this.savedQuat);
    cam.updateMatrixWorld();
    this.shakeApplied = false;
  }

  /** Live particles per layer (CPU scan, for the sandbox HUD / tests). */
  stats(): Record<string, number> {
    const now = this.now;
    return {
      smoke: this.smokeLayer.countAlive(now),
      fire: this.fireLayer.countAlive(now),
      sparks: this.sparkLayer.countAlive(now),
      emitted: this.smokeLayer.emitted + this.fireLayer.emitted + this.sparkLayer.emitted + this.chipLayer.emitted,
    };
  }

  reset(): void {
    this.smokeLayer.clear();
    this.fireLayer.clear();
    this.sparkLayer.clear();
    this.chipLayer.clear();
    this.lights.clear();
    this.shock.clear();
    this.emitters.length = 0;
    this.marks.length = 0;
    this.recentDust.length = 0;
    this.recentHead = 0;
    this.collapseTokens = COLLAPSE_DUST_BURST;
    this.collapseClock = this.now;
    this.trails.clear();
    this.shaker.reset();
    this.tracers.begin();
    this.tracers.end();
    this.countEmitted();
    this.load.smoke = this.load.sparks = this.load.chips = 0;
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.smokeLayer.dispose();
    this.fireLayer.dispose();
    this.sparkLayer.dispose();
    this.chipLayer.dispose();
    this.tracers.dispose();
    this.lights.dispose();
    this.shock.dispose();
    for (const t of this.textures) t.dispose();
    this.root.removeFromParent();
    this.solidRoot.removeFromParent();
    if (this.atmo.fxRoot === this.root) this.atmo.fxRoot = null;
    if (this.atmo.beforeFx === this.sortForView) this.atmo.beforeFx = null;
  }
}
