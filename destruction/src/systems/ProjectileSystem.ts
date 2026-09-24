import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Simulation } from '../app/Simulation.ts';
import type { Projectile, ProjectileSystemApi, SimContext, SpawnProjectileOptions, System } from '../app/contracts.ts';
import type { Rng } from '../core/rng.ts';
import { rayBoxEntry, type Destructible, type RayHit } from '../destructibles/Destructible.ts';
import { groups, GROUP_DEBRIS, GROUP_STATIC } from '../physics/PhysicsWorld.ts';
import { MATERIALS, type MaterialProps } from '../physics/materials.ts';
import type { AmmoData } from '../physics/ballistics/ammo.ts';
import { LoftPath, stepFlight, stepLoft, type LoftState } from '../physics/ballistics/flight.ts';
import { resolveImpact, resolveJet, type ResolvedImpact } from '../physics/ballistics/penetration.ts';
import { fragmentAmmo } from '../physics/ballistics/fragments.ts';
import type { AmmoSpec, BlastKind, BlastLoad, ImpactEvent, ThicknessProbe } from '../physics/ballistics/types.ts';
import type { ExtendedBlastRequest } from './BlastSystem.ts';

/**
 * Flies every projectile: integrates flight each fixed step, sweeps the step as a segment through
 * the destructible registry (and loose Rapier debris / the default ground), resolves impacts with
 * the terminal-ballistics models, lets the target realise them, and continues perforating or
 * ricocheting rounds within the same step. Handles fuzes: impact (HE detonates on the surface),
 * delay (penetrate, then detonate — BLU-109, M908, Mk 211, follow-through charges), HEAT jets with
 * tandem precursors and behind-armour debris, and self-destruct timers. The top-attack launcher
 * flies a scripted cosmetic arc (`LoftPath`); nothing is guided.
 *
 * Time inside the step: the sweep converts distance along the flown segment to time, so impact
 * events, detonations (→ BlastSystem arrival times) and the rounds they throw carry the moment
 * they happened rather than the end of the fixed step.
 */

const MAX_INTERACTIONS = 8;
/** How far behind the stated origin a jet's first ray starts, m */
const JET_BACKOFF = 0.1;
const KILL_Y = -50;
const KILL_RANGE = 5000;
const KILL_AGE = 30;
/** Longest first step a round born earlier in a step may fly to catch up with the clock, s */
const MAX_FIRST_STEP = 2 / 60;
/** Rapier query groups: static + debris colliders, not the tiny chips. */
const INERT_GROUPS = groups(0xffff, GROUP_STATIC | GROUP_DEBRIS);

class ProjectileImpl implements Projectile {
  id = 0;
  ammo!: AmmoSpec;
  readonly position = new THREE.Vector3();
  readonly previous = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly origin = new THREE.Vector3();
  mass = 0;
  length = 0;
  age = 0;
  alive = false;
  tracer = false;
  perforations = 0;
  burning = false;
  /** Scripted top-attack arc while it is being flown (cosmetic; see flight.ts LoftPath) */
  loft: LoftState | null = null;
  private loftPath: LoftPath | null = null;
  private readonly loftState: LoftState = { path: null as unknown as LoftPath, s: 0 };
  /** The explosive filler has functioned (a penetrator like Mk 211 flies on, but only fires once) */
  spent = false;
  /** Delay fuze: seconds left once started (< 0 = not started) */
  fuze = -1;
  /** Embedded and waiting for its delay fuze */
  stuck = false;
  stuckTarget: Destructible | null = null;
  stuckDepth = 0;
  /** Outward normal of the face the buried round went in through */
  readonly stuckNormal = new THREE.Vector3();
  /**
   * Simulation time at which the round leaves its origin (sub-step spawn spacing for high rates of
   * fire, fragments of a detonation part-way through a step). NaN: at the start of the next update.
   */
  start = NaN;
  interactions = 0;
  ricochets = 0;

  /** Start flying a scripted loft from the current position to `target`. */
  startLoft(target: THREE.Vector3, loftHeight: number): void {
    this.loftPath = this.loftPath ? this.loftPath.set(this.position, target, loftHeight) : new LoftPath(this.position, target, loftHeight);
    this.loftState.path = this.loftPath;
    this.loftState.s = 0;
    this.loft = this.loftState;
    // Leave the tube along the start of the arc at the launch speed.
    const v = this.velocity.length();
    this.loftPath.tangentAtParam(0, this.velocity).multiplyScalar(v);
  }
}

/** Stand-in "destructible" for Rapier colliders that are not destructibles (default ground, loose debris). */
class InertTarget implements Destructible {
  readonly id = -1;
  readonly kind = 'terrain' as const;
  readonly root = new THREE.Object3D();
  readonly bounds = new THREE.Box3();
  readonly disposed = false;
  name = 'ground';
  material: MaterialProps = MATERIALS.soil;
  thickness = 20;
  body: RAPIER.RigidBody | null = null;
  physics: SimContext['physics'] | null = null;
  raycast(): RayHit | null {
    return null;
  }
  probe(): ThicknessProbe {
    // Loose rubble and the ground never count as perforated: rounds stop in (or bounce off) them.
    return { segments: [{ material: this.material, start: 0, end: this.thickness, strength: 1 }], exits: false };
  }
  applyImpact(e: ImpactEvent): void {
    if (this.body && this.physics && this.body.isDynamic()) this.physics.applyImpulseAt(this.body, e.momentum, e.point);
  }
  applyBlast(_l: BlastLoad): void {}
  dispose(): void {}
}

const _seg = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _from = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _v = new THREE.Vector3();

export class ProjectileSystem implements System, ProjectileSystemApi {
  readonly name = 'projectiles';
  readonly active: ProjectileImpl[] = [];
  private pool: ProjectileImpl[] = [];
  private nextId = 1;
  private readonly ctx: SimContext;
  private readonly rng: Rng;
  private ray: RAPIER.Ray | null = null;
  private inert = new InertTarget();
  private inertHit: RayHit = { target: this.inert, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, material: MATERIALS.soil };
  private followThroughSpecs = new Map<string, AmmoSpec>();
  /** Rapier filter for `castInert` (allocated once, not per ray) */
  private readonly notDestructible = (c: RAPIER.Collider): boolean => !this.ctx.physics.ownerOf(c)?.destructible;
  /** Union of every live destructible's bounds this step: segments that miss it skip the registry. */
  private readonly worldBounds = new THREE.Box3();
  /**
   * Simulation time of the interaction being resolved: where inside the fixed step the round
   * struck (or its fuze ran out). Impact events, detonations and the rounds they throw carry it,
   * so a blast's contact target is loaded in the same step and arrival times are not rounded up.
   */
  private eventTime = 0;
  /** Where `impact()` says the round carries on from, and whether to skip that target this step */
  private readonly contFrom = new THREE.Vector3();
  private contConsumed = 0;
  private contSkip = false;
  /** Last fixed-step cost, ms, and the number of segment ray casts it made (telemetry) */
  lastStepMs = 0;
  lastRaycasts = 0;
  /** Everything emitted as 'impact' is also passed here (sandbox/debug hooks) */
  onImpact: ((e: ImpactEvent) => void) | null = null;

  constructor(sim: Simulation) {
    this.ctx = sim.ctx;
    this.rng = sim.ctx.rng.fork();
  }

  spawn(o: SpawnProjectileOptions): Projectile {
    return this.spawnAt(o, NaN);
  }

  /**
   * Spawn a round that leaves its origin at simulation time `start` (NaN: with the next update).
   * A time inside the step being simulated (weapon cyclic rate, fragments of a detonation part-way
   * through the step) makes the round's first step shorter or longer so it is where it would be;
   * whichever order the systems run in, nothing is late by a step.
   */
  spawnAt(o: SpawnProjectileOptions, start: number): ProjectileImpl {
    const p = this.pool.pop() ?? new ProjectileImpl();
    p.id = this.nextId++;
    p.ammo = o.ammo;
    p.position.copy(o.origin);
    p.previous.copy(o.origin);
    p.origin.copy(o.origin);
    p.velocity.copy(o.velocity);
    p.mass = o.ammo.mass;
    p.length = o.ammo.length;
    p.age = 0;
    p.alive = true;
    p.tracer = o.tracer ?? !!o.ammo.tracer;
    p.perforations = 0;
    p.burning = false;
    p.fuze = -1;
    p.stuck = false;
    p.stuckTarget = null;
    p.stuckDepth = 0;
    p.start = start;
    p.loft = null;
    p.spent = false;
    p.ricochets = 0;
    p.interactions = 0;
    const g = o.ammo.guidance;
    if (g?.mode === 'topAttack' && o.target && o.target.distanceTo(o.origin) > 5) p.startLoft(o.target, g.loftHeight ?? 150);
    this.active.push(p);
    return p;
  }

  /** Spawn with a hold time: the round starts moving `delay` s after the start of the next update. */
  spawnDelayed(o: SpawnProjectileOptions, delay: number): ProjectileImpl {
    return this.spawnAt(o, delay > 0 ? this.ctx.time.now + delay : NaN);
  }

  reset(): void {
    for (const p of this.active) {
      p.alive = false;
      this.pool.push(p);
    }
    this.active.length = 0;
    this.ray = null;
  }

  fixedUpdate(dt: number): void {
    const t0 = performance.now();
    this.lastRaycasts = 0;
    const now = this.ctx.time.now;
    this.worldBounds.makeEmpty();
    for (const d of this.ctx.registry.all()) if (!d.disposed) this.worldBounds.union(d.bounds);
    const list = this.active;
    // New rounds may be appended while we iterate (fragments, follow-through): they fly next step,
    // catching up from the moment they were thrown (`start`).
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const p = list[i]!;
      if (!p.alive) continue;
      if (p.stuck) {
        const left = p.fuze;
        p.age += dt;
        p.fuze -= dt;
        if (p.fuze <= 0) {
          this.eventTime = now - dt + clamp01(left / dt) * dt;
          this.detonateAt(p, p.position, p.stuckNormal, p.stuckTarget, p.stuckDepth);
        }
        continue;
      }
      // This step covers [now − dt, now]; a round born inside it flies only from its birth, one born
      // before it (thrown during the previous step's update) catches up.
      let step = dt;
      if (!Number.isNaN(p.start)) {
        if (p.start >= now - 1e-9) continue;
        step = Math.min(now - p.start, MAX_FIRST_STEP);
        p.start = NaN;
      }
      p.previous.copy(p.position);
      const a = p.ammo as AmmoData;
      if (p.loft) {
        if (stepLoft(p, a, p.loft, step)) p.loft = null;
      } else stepFlight(p, a, step);
      this.sweep(p, step);
      if (!p.alive) continue;
      if (a.selfDestruct !== undefined && p.age >= a.selfDestruct && !p.spent) {
        this.eventTime = now - Math.min(step, p.age - a.selfDestruct);
        this.detonateAt(p, p.position, null, null, 0);
        continue;
      }
      if (p.position.y < KILL_Y || p.age > KILL_AGE || p.position.distanceToSquared(p.origin) > KILL_RANGE * KILL_RANGE) p.alive = false;
    }
    // Compact: return dead rounds to the pool.
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      if (p.alive) list[w++] = p;
      else this.pool.push(p);
    }
    list.length = w;
    this.lastStepMs = performance.now() - t0;
  }

  /**
   * Sweep the segment flown this step (`step` seconds ending now); resolve up to MAX_INTERACTIONS
   * hits in order. Tracks the time along the segment so every event carries when it happened.
   */
  private sweep(p: ProjectileImpl, step: number): void {
    _seg.copy(p.position).sub(p.previous);
    let segLen = _seg.length();
    if (segLen < 1e-9) return;
    const now = this.ctx.time.now;
    _dir.copy(_seg).divideScalar(segLen);
    _from.copy(p.previous);
    p.interactions = 0;
    let tLeft = step;
    let ignore: Destructible | undefined;
    while (p.alive && !p.stuck && segLen > 1e-6 && p.interactions < MAX_INTERACTIONS) {
      // Mean speed over what is left of the step: converts distance along the segment to time.
      const rate = segLen / Math.max(tLeft, 1e-9);
      // A running delay fuze fires where the round is when the time runs out.
      const fuzeDist = p.fuze >= 0 ? p.fuze * rate : Infinity;
      const reach = Math.min(segLen, fuzeDist);
      this.lastRaycasts++;
      // Nothing registered anywhere near this stretch (rounds fired at the sky): skip the registry.
      let hit = rayBoxEntry(this.worldBounds, _from, _dir, reach) < Infinity ? this.ctx.registry.raycast(_from, _dir, reach, ignore) : null;
      const inert = this.castInert(_from, _dir, hit ? hit.distance : reach);
      if (inert) hit = inert;
      if (!hit) {
        if (fuzeDist <= segLen) {
          const tf = p.fuze;
          this.eventTime = now - tLeft + tf;
          _tmp.copy(_from).addScaledVector(_dir, fuzeDist);
          this.detonateAt(p, _tmp, null, null, 0);
          if (!p.alive) return;
          // A penetrator whose small charge just functioned (Mk 211) sweeps on through the rest of the step.
          _from.copy(_tmp);
          segLen -= fuzeDist;
          tLeft = Math.max(0, tLeft - tf);
          ignore = undefined;
          continue;
        }
        if (p.fuze >= 0) p.fuze -= tLeft;
        break;
      }
      const tHit = hit.distance / rate;
      if (p.fuze >= 0) p.fuze -= tHit;
      this.eventTime = now - tLeft + tHit;
      p.interactions++;
      const before = segLen;
      const speed = p.velocity.length();
      if (!this.impact(p, hit, _dir)) return;
      // Continue from the exit / ricochet point with what is left of this step's travel.
      const vAfter = p.velocity.length();
      const used = hit.distance + this.contConsumed;
      const left = Math.max(0, before - used) * (speed > 0 ? vAfter / speed : 0);
      tLeft = Math.max(0, tLeft - used / rate);
      _from.copy(this.contFrom);
      _dir.copy(p.velocity).divideScalar(Math.max(vAfter, 1e-9));
      segLen = left;
      p.position.copy(_from).addScaledVector(_dir, segLen);
      // Only skip the object we just left when we bounced off its face (avoid re-hitting at t = 0).
      ignore = this.contSkip ? hit.target : undefined;
    }
  }

  /** Nearest non-destructible Rapier collider (default ground, loose debris) along the segment. */
  private castInert(from: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    const phys = this.ctx.physics;
    const R = phys.R;
    if (!this.ray) this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const ray = this.ray;
    ray.origin.x = from.x; ray.origin.y = from.y; ray.origin.z = from.z;
    ray.dir.x = dir.x; ray.dir.y = dir.y; ray.dir.z = dir.z;
    const h = phys.world.castRayAndGetNormal(ray, maxDist, true, undefined, INERT_GROUPS, undefined, undefined, this.notDestructible);
    if (!h) return null;
    const owner = phys.ownerOf(h.collider);
    const body = h.collider.parent();
    const t = this.inert;
    t.physics = phys;
    t.body = body && body.isDynamic() ? body : null;
    t.material = owner?.material ?? (t.body ? MATERIALS.concrete : MATERIALS.soil);
    t.thickness = t.body ? 0.25 : 20;
    t.name = t.body ? `debris (${owner?.kind ?? 'body'})` : (owner?.kind ?? 'ground');
    const hit = this.inertHit;
    hit.point.copy(dir).multiplyScalar(h.timeOfImpact).add(from);
    hit.normal.set(h.normal.x, h.normal.y, h.normal.z);
    if (hit.normal.dot(dir) > 0) hit.normal.negate();
    hit.distance = h.timeOfImpact;
    hit.material = t.material;
    return hit;
  }

  /** Probe depth budget: generous upper bound of what this round could ever penetrate. */
  private probeDepth(a: AmmoData): number {
    switch (a.kind) {
      case 'apfsds': return 4;
      case 'heat': return Math.max(0.5, (a.heatPenetrationRHA ?? 0.5) * 7);
      case 'fragment': return 0.3;
      case 'ball': return 0.8;
      case 'ap': return a.mass > 0.2 ? 2.5 : 1.5;
      default: return a.mass > 100 ? 6 : a.mass > 5 ? 3 : 1.5;
    }
  }

  /**
   * One projectile meets one target. Returns true when the round carries on (perforation /
   * ricochet) from `contFrom`, false when it is spent, buried or detonated.
   */
  private impact(p: ProjectileImpl, hit: RayHit, dir: THREE.Vector3): boolean {
    const a = p.ammo as AmmoData;
    const speed = p.velocity.length();
    // Impact-fuzed warheads function on the surface (graze-sensitive fuzes).
    if (a.fuze === 'impact' || (a.kind === 'heat' && a.fuze !== 'delay')) {
      if (a.kind === 'heat' && a.heatPenetrationRHA) this.fireHeat(p, hit, dir);
      else {
        _tmp.copy(hit.point).addScaledVector(hit.normal, Math.max(0.02, 0.5 * a.diameter));
        this.detonateAt(p, _tmp, hit.normal, hit.target === this.inert ? null : hit.target, 0);
      }
      p.alive = false;
      return false;
    }
    const target = hit.target;
    const probe = target.probe(hit, dir, this.probeDepth(a));
    if (probe.segments.length === 0) {
      // The target's ray test and its probe disagree (no material on the shot line, e.g. the
      // rim of a hole): pass through without an event and without striking it again this step.
      this.contFrom.copy(hit.point).addScaledVector(dir, 1e-3);
      this.contConsumed = 0;
      this.contSkip = true;
      return true;
    }
    _vel.copy(dir).multiplyScalar(speed);
    const ev = resolveImpact({ ammo: a, position: hit.point, velocity: _vel, mass: p.mass, length: p.length, perforations: p.perforations }, hit, probe, this.rng);
    this.emitImpact(ev, target);

    p.loft = null;
    const contact = target === this.inert ? null : target;
    // Delay fuze: starts on first contact; if it runs out inside the material the charge is buried.
    // Fuze time left at first contact with this target (the penetration itself is resolved instantly).
    let fuzeAtContact = -1;
    if (a.fuze === 'delay' && a.explosiveTNT && !p.spent) {
      if (p.fuze < 0) p.fuze = a.fuzeDelay ?? 0.001;
      fuzeAtContact = p.fuze;
      const vOut = ev.outcome === 'perforate' ? ev.residualSpeed : 0;
      // Uniform deceleration from v0 to v1 over the run: T = 2x / (v0 + v1).
      const tIn = ev.outcome === 'ricochet' ? 0 : (2 * ev.depth) / Math.max(speed + vOut, 1);
      if (p.fuze <= tIn && ev.depth > 0) {
        // Where the round is after the fraction f of T: x/x_run = (2 v0 f + (v1 − v0) f²) / (v0 + v1).
        const f = tIn > 0 ? clamp01(p.fuze / tIn) : 1;
        const depth = (ev.depth * (2 * speed * f + (vOut - speed) * f * f)) / Math.max(speed + vOut, 1e-6);
        _tmp.copy(hit.point).addScaledVector(dir, depth);
        if (a.kind === 'ap') {
          // Small charge of a penetrator (Mk 211): functions now, the core carries on.
          this.eventTime += p.fuze;
          this.detonateAt(p, _tmp, hit.normal, contact, depth);
        } else {
          // The fuze runs out inside the material: the round is buried there and fires when the
          // remaining delay has elapsed in sim time (BLU-109: ≈ 15 ms after first contact).
          p.position.copy(_tmp);
          this.bury(p, contact, depth, hit.normal, p.fuze);
          return false;
        }
      } else p.fuze -= tIn;
    }

    switch (ev.outcome) {
      case 'perforate': {
        p.perforations++;
        p.mass = ev.residualMass;
        p.length = ev.residualLength;
        const d = ev.residualDirection ?? dir;
        p.velocity.copy(d).multiplyScalar(ev.residualSpeed);
        if (ev.exitPoint) this.contFrom.copy(ev.exitPoint);
        else this.contFrom.copy(hit.point).addScaledVector(dir, ev.depth);
        this.contFrom.addScaledVector(d, 1e-3);
        if (ev.residualSpeed < 1) {
          // Barely through: it drops at the exit. A live delay-fuzed charge still fires there.
          if (this.armed(p)) {
            p.position.copy(this.contFrom);
            this.bury(p, contact, ev.depth, hit.normal, p.fuze);
          } else p.alive = false;
          return false;
        }
        this.contConsumed = ev.depth;
        this.contSkip = false;
        return true;
      }
      case 'ricochet': {
        // A round that has skipped twice is tumbling badly; the next graze buries it (a live
        // delay-fuzed charge still fires where it came to rest).
        if (++p.ricochets > 2) {
          if (this.armed(p)) {
            p.position.copy(hit.point);
            this.bury(p, contact, 0, hit.normal, p.fuze);
          } else p.alive = false;
          return false;
        }
        p.mass = ev.residualMass;
        const d = ev.residualDirection!;
        p.velocity.copy(d).multiplyScalar(ev.residualSpeed);
        this.contFrom.copy(hit.point).addScaledVector(hit.normal, 2e-3);
        this.contConsumed = 0;
        this.contSkip = true;
        return true;
      }
      default:
        if (this.armed(p)) {
          // Embedded penetrator waiting for its delay fuze (BLU-109 in a thick wall). The penetration
          // was resolved at the moment of contact, so the whole remaining delay runs from contact.
          p.position.copy(hit.point).addScaledVector(dir, ev.depth);
          this.bury(p, contact, ev.depth, hit.normal, fuzeAtContact > 0 ? fuzeAtContact : p.fuze);
          return false;
        }
        p.alive = false;
        return false;
    }
  }

  /** A delay-fuzed round whose fuze is running and whose charge has not fired yet. */
  private armed(p: ProjectileImpl): boolean {
    const a = p.ammo as AmmoData;
    return a.fuze === 'delay' && !!a.explosiveTNT && !p.spent && p.fuze >= 0;
  }

  /**
   * A delay-fuzed round comes to rest inside a target (already moved to where it stopped). Its
   * charge fires `fuzeLeft` seconds after `eventTime`: within this step, at once (stamped with
   * that time); otherwise the rest of the delay counts down from the end of this step.
   */
  private bury(p: ProjectileImpl, target: Destructible | null, depth: number, normal: THREE.Vector3, fuzeLeft: number): void {
    p.stuck = true;
    p.stuckTarget = target;
    p.stuckDepth = depth;
    p.stuckNormal.copy(normal);
    p.velocity.set(0, 0, 0);
    const tFire = this.eventTime + Math.max(0, fuzeLeft);
    const now = this.ctx.time.now;
    if (tFire <= now) {
      this.eventTime = tFire;
      this.detonateAt(p, p.position, p.stuckNormal, target, depth);
    } else p.fuze = tFire - now;
  }

  private emitImpact(ev: ImpactEvent, target: Destructible): void {
    ev.time = this.eventTime;
    target.applyImpact(ev);
    this.ctx.events.emit('impact', ev);
    this.onImpact?.(ev);
  }

  /** HEAT: optional tandem precursor, the main jet through successive targets, BAD cone, then the blast. */
  private fireHeat(p: ProjectileImpl, hit: RayHit, dir: THREE.Vector3): void {
    const a = p.ammo as AmmoData;
    const cone = a.heatConeDiameter ?? a.diameter * 0.8;
    const origin = hit.point.clone().addScaledVector(hit.normal, 0.01);
    const d = dir.clone();
    if (a.tandem && a.precursorRHA) this.jetFrom(a, a.precursorRHA, cone * 0.4, origin, d, 'precursor jet');
    this.jetFrom(a, a.heatPenetrationRHA ?? 0, cone, origin, d, 'jet');
    if (a.followThrough) this.spawnFollowThrough(a, hit, d, p.velocity.length());
    if (a.explosiveTNT) {
      _tmp.copy(hit.point).addScaledVector(hit.normal, 0.05);
      this.detonateWith(a, _tmp, hit.normal, hit.target === this.inert ? null : hit.target, 0, d, p.velocity.length(), 'shaped');
    }
  }

  /**
   * Shaped-charge jet with `capacity` metres of RHA penetration from `origin` along `dir`: resolves
   * against each target in turn; after a perforation the jet loses coherence with distance
   * (capacity × (1 − s / 30 CD)) and throws behind-armour debris. Also used by linear cutters
   * (placed charges: the jet's events are stamped with `time`, default the current simulation time).
   */
  jet(a: AmmoSpec, capacity: number, cone: number, origin: THREE.Vector3, dir: THREE.Vector3, label: string, maxDist = 0.5, time = this.ctx.time.now): void {
    this.eventTime = Math.min(time, this.ctx.time.now);
    this.jetFrom(a, capacity, cone, origin, dir, label, maxDist);
  }

  /** `jet` at the current `eventTime` (a HEAT round functioning part-way through a step). */
  private jetFrom(a: AmmoSpec, capacity: number, cone: number, origin: THREE.Vector3, dir: THREE.Vector3, label: string, maxDist = 0.5): void {
    let c = capacity;
    // Start the first ray a little way back along the jet axis: some targets' ray tests reject
    // origins right at (or inside the envelope of) their surface. The rating already includes the
    // warhead's stand-off, so that first stretch costs no coherence.
    const from = origin.clone().addScaledVector(dir, -JET_BACKOFF);
    let reach = maxDist + JET_BACKOFF;
    let free = JET_BACKOFF;
    let skip: Destructible | undefined;
    for (let k = 0; k < MAX_INTERACTIONS && c > 1e-4; k++) {
      let hit = this.ctx.registry.raycast(from, dir, reach, skip);
      const inert = this.castInert(from, dir, hit ? hit.distance : reach);
      if (inert) hit = inert;
      if (!hit) return;
      c *= clamp01(1 - Math.max(0, hit.distance - free) / (30 * cone));
      if (c <= 1e-4) return;
      const probe = hit.target.probe(hit, dir, c * 8);
      if (probe.segments.length === 0) {
        // Ray test and probe disagree (rim of a hole): pass it without an event, as rounds do.
        free = Math.max(0, free - hit.distance);
        reach -= hit.distance + 1e-3;
        from.copy(hit.point).addScaledVector(dir, 1e-3);
        skip = hit.target;
        continue;
      }
      free = 0;
      skip = undefined;
      const ev = resolveJet(a, c, cone, hit, dir, probe, this.rng, label);
      this.emitImpact(ev, hit.target);
      if (ev.outcome !== 'perforate' || !ev.exitPoint) return;
      this.spawnBehindArmourDebris(a, ev);
      c = ev.residualCapacity ?? 0;
      from.copy(ev.exitPoint).addScaledVector(dir, 1e-3);
      reach = 30 * cone;
    }
  }

  /**
   * Behind-armour debris: a cone of target material and jet particles (half-angle ≈ 25–35°,
   * speeds ≈ 0.3–1.5 km/s; Held, "Behind-armour debris", Propellants Explos. 1999).
   */
  private spawnBehindArmourDebris(a: AmmoSpec, ev: ResolvedImpact): void {
    const m = ev.material;
    const steel = m.class === 'ductile';
    const count = steel ? 10 : 6;
    const half = THREE.MathUtils.degToRad(steel ? 28 : 35);
    for (let i = 0; i < count; i++) {
      const mass = steel ? this.rng.range(0.002, 0.02) : this.rng.range(0.005, 0.05);
      const speed = steel ? this.rng.range(400, 1500) : this.rng.range(150, 600);
      const d = this.rng.inCone(ev.direction, half * Math.sqrt(this.rng.next()), new THREE.Vector3());
      const spec = fragmentAmmo(mass, speed, a, steel ? 7850 : m.density);
      this.spawnAt({ ammo: spec, origin: _v.copy(ev.exitPoint!).addScaledVector(d, 2e-3), velocity: d.multiplyScalar(speed) }, this.eventTime);
    }
  }

  /** ASM 509: the HE follow-through charge rides in behind the precursor and fires on its own delay. */
  private spawnFollowThrough(a: AmmoData, hit: RayHit, dir: THREE.Vector3, speed: number): void {
    const ft = a.followThrough!;
    let spec = this.followThroughSpecs.get(a.id);
    if (!spec) {
      const s: AmmoData = {
        id: `${a.id}-ft`, name: `${a.name} follow-through`, caliber: a.caliber, kind: 'he', mass: 0.9, diameter: 0.05, length: 0.15,
        muzzleVelocity: ft.speed, dragCd: 0.5, coreDensity: 7850, noseFactor: 1.0, deformable: false, fuze: 'delay', fuzeDelay: ft.delay,
        explosiveTNT: ft.tntKg, casingMass: ft.casingMass, gurney: 2700, note: 'follow-through HE charge', source: a.source,
      };
      spec = s;
      this.followThroughSpecs.set(a.id, spec);
    }
    const p = this.spawnAt({ ammo: spec, origin: _v.copy(hit.point).addScaledVector(hit.normal, 0.05), velocity: _vel.copy(dir).multiplyScalar(Math.min(ft.speed, speed)) }, this.eventTime);
    p.fuze = ft.delay;
  }

  /**
   * Detonate a projectile's filler at a point (once). AP rounds with a small charge (Mk 211) keep
   * flying as an inert penetrator.
   */
  private detonateAt(p: ProjectileImpl, point: THREE.Vector3, normal: THREE.Vector3 | null, contact: Destructible | null, buried: number): void {
    const a = p.ammo as AmmoData;
    const kind: BlastKind = a.kind === 'thermobaric' ? 'thermobaric' : a.kind === 'hesh' ? 'hesh' : 'he';
    if (a.explosiveTNT && !p.spent) this.detonateWith(a, point, normal, contact, buried, p.velocity.lengthSq() > 0 ? p.velocity.clone().normalize() : null, p.velocity.length(), kind);
    p.spent = true;
    p.fuze = -1;
    if (a.kind === 'ap' && !p.stuck) return;
    p.alive = false;
    p.stuck = false;
  }

  private detonateWith(a: AmmoData, point: THREE.Vector3, normal: THREE.Vector3 | null, contact: Destructible | null, buried: number, travelDir: THREE.Vector3 | null, travelSpeed: number, kind: BlastKind): void {
    const W = a.explosiveTNT ?? 0;
    if (W <= 0) return;
    // FM 5-250: a fully tamped charge is ~3.6× as effective as one lying on the surface.
    const tamping = buried > 0 ? 1 + 2.6 * clamp01(buried / (0.3 * Math.cbrt(W))) : 1;
    const req: ExtendedBlastRequest = {
      center: point.clone(), tntKg: W, kind, normal: normal?.clone(), contactTargetId: contact?.id,
      casingMass: a.casingMass, gurney: a.gurney, travelDirection: travelDir ?? undefined, travelSpeed,
      source: a, label: a.name, tamping, time: this.eventTime,
    };
    this.ctx.blasts.detonate(req);
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
