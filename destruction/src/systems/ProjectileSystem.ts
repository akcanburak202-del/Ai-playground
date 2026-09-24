import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Simulation } from '../app/Simulation.ts';
import type { Projectile, ProjectileSystemApi, SimContext, SpawnProjectileOptions, System } from '../app/contracts.ts';
import type { Rng } from '../core/rng.ts';
import type { Destructible, RayHit } from '../destructibles/Destructible.ts';
import { groups, GROUP_DEBRIS, GROUP_STATIC } from '../physics/PhysicsWorld.ts';
import { MATERIALS, type MaterialProps } from '../physics/materials.ts';
import type { AmmoData } from '../physics/ballistics/ammo.ts';
import { stepFlight, type GuidanceTarget } from '../physics/ballistics/flight.ts';
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
 * tandem precursors and behind-armour debris, and self-destruct timers.
 */

const MAX_INTERACTIONS = 8;
const KILL_Y = -50;
const KILL_RANGE = 5000;
const KILL_AGE = 30;
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
  /** Guidance */
  guide: GuidanceTarget | null = null;
  readonly guideTarget = new THREE.Vector3();
  readonly guideLaunch = new THREE.Vector3();
  /** Delay fuze: seconds left once started (< 0 = not started) */
  fuze = -1;
  /** Embedded and waiting for its delay fuze */
  stuck = false;
  stuckTarget: Destructible | null = null;
  stuckDepth = 0;
  /** Time to hold before moving in the next step (sub-step spawn spacing for high rates of fire) */
  delay = 0;
  interactions = 0;
  ricochets = 0;
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
    return this.spawnDelayed(o, 0);
  }

  /** Spawn with a hold time: the round starts moving `delay` s into the next step (sub-step spacing). */
  spawnDelayed(o: SpawnProjectileOptions, delay: number): ProjectileImpl {
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
    p.delay = Math.max(0, delay);
    p.guide = null;
    p.ricochets = 0;
    if (o.ammo.guidance && o.target) {
      p.guideTarget.copy(o.target);
      p.guideLaunch.copy(o.origin);
      p.guide = { target: p.guideTarget, launch: p.guideLaunch };
    }
    this.active.push(p);
    return p;
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
    const list = this.active;
    // New rounds may be appended while we iterate (fragments, follow-through): they fly next step.
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const p = list[i]!;
      if (!p.alive) continue;
      if (p.stuck) {
        p.age += dt;
        p.fuze -= dt;
        if (p.fuze <= 0) this.detonateAt(p, p.position, null, p.stuckTarget, p.stuckDepth);
        continue;
      }
      let step = dt;
      if (p.delay > 0) {
        step = Math.max(0, dt - p.delay);
        p.delay = 0;
        if (step <= 0) continue;
      }
      p.previous.copy(p.position);
      const a = p.ammo as AmmoData;
      stepFlight(p, a, step, p.guide);
      this.sweep(p);
      if (!p.alive) continue;
      if (a.selfDestruct !== undefined && p.age >= a.selfDestruct) {
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

  /** Sweep the segment flown this step; resolve up to MAX_INTERACTIONS hits in order. */
  private sweep(p: ProjectileImpl): void {
    _seg.copy(p.position).sub(p.previous);
    let segLen = _seg.length();
    if (segLen < 1e-9) return;
    _dir.copy(_seg).divideScalar(segLen);
    _from.copy(p.previous);
    p.interactions = 0;
    let ignore: Destructible | undefined;
    while (p.alive && !p.stuck && segLen > 1e-6 && p.interactions < MAX_INTERACTIONS) {
      // A running delay fuze fires where the round is when the time runs out.
      const speed = p.velocity.length();
      let fuzeDist = Infinity;
      if (p.fuze >= 0) fuzeDist = p.fuze * Math.max(speed, 1);
      const reach = Math.min(segLen, fuzeDist);
      this.lastRaycasts++;
      let hit = this.ctx.registry.raycast(_from, _dir, reach, ignore);
      const inert = this.castInert(_from, _dir, hit ? hit.distance : reach);
      if (inert) hit = inert;
      if (!hit) {
        if (fuzeDist <= segLen) {
          _tmp.copy(_from).addScaledVector(_dir, fuzeDist);
          this.detonateAt(p, _tmp, null, null, 0);
          return;
        }
        if (p.fuze >= 0) p.fuze -= segLen / Math.max(speed, 1);
        break;
      }
      if (p.fuze >= 0) p.fuze -= hit.distance / Math.max(speed, 1);
      p.interactions++;
      const before = segLen;
      const cont = this.impact(p, hit, _dir);
      if (!p.alive || p.stuck || !cont) return;
      // Continue from the exit / ricochet point with what is left of this step's travel.
      const vAfter = p.velocity.length();
      const left = Math.max(0, before - hit.distance - cont.consumed) * (speed > 0 ? vAfter / speed : 0);
      _from.copy(cont.from);
      _dir.copy(p.velocity).divideScalar(Math.max(vAfter, 1e-9));
      segLen = left;
      p.position.copy(_from).addScaledVector(_dir, segLen);
      // Only skip the object we just left when we bounced off its face (avoid re-hitting at t = 0).
      ignore = cont.ricochet ? hit.target : undefined;
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
    const h = phys.world.castRayAndGetNormal(ray, maxDist, true, undefined, INERT_GROUPS, undefined, undefined, (c) => !phys.ownerOf(c)?.destructible);
    if (!h) return null;
    const owner = phys.ownerOf(h.collider);
    const body = h.collider.parent();
    const t = this.inert;
    t.physics = phys;
    t.body = body && body.isDynamic() ? body : null;
    t.material = owner?.material ?? (t.body ? MATERIALS.concrete : MATERIALS.soil);
    t.thickness = t.body ? 0.25 : 20;
    t.name = t.body ? `debris (${owner?.kind ?? 'body'})` : 'ground';
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
   * One projectile meets one target. Returns where to continue from (perforation / ricochet),
   * or null when the round is spent.
   */
  private impact(p: ProjectileImpl, hit: RayHit, dir: THREE.Vector3): { from: THREE.Vector3; consumed: number; ricochet: boolean } | null {
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
      return null;
    }
    const target = hit.target;
    const probe = target.probe(hit, dir, this.probeDepth(a));
    _vel.copy(dir).multiplyScalar(speed);
    const ev = resolveImpact({ ammo: a, position: hit.point, velocity: _vel, mass: p.mass, length: p.length, perforations: p.perforations }, hit, probe, this.rng);
    this.emitImpact(ev, target);

    // Delay fuze: starts on first contact; if it runs out inside the material the charge is buried.
    if (a.fuze === 'delay' && a.explosiveTNT) {
      if (p.fuze < 0) p.fuze = a.fuzeDelay ?? 0.001;
      const vOut = ev.outcome === 'perforate' ? ev.residualSpeed : 0;
      const tIn = ev.outcome === 'ricochet' ? 0 : (2 * ev.depth) / Math.max(speed + vOut, 1);
      if (p.fuze <= tIn && ev.depth > 0) {
        const f = tIn > 0 ? p.fuze / tIn : 1;
        const depth = ev.depth * Math.sqrt(clamp01(f));
        _tmp.copy(hit.point).addScaledVector(dir, depth);
        this.detonateAt(p, _tmp, hit.normal, target === this.inert ? null : target, depth);
        if (!p.alive) return null;
      } else p.fuze -= tIn;
    }

    switch (ev.outcome) {
      case 'perforate': {
        p.perforations++;
        p.mass = ev.residualMass;
        p.length = ev.residualLength;
        const d = ev.residualDirection ?? dir;
        p.velocity.copy(d).multiplyScalar(ev.residualSpeed);
        const from = ev.exitPoint ? ev.exitPoint.clone() : hit.point.clone().addScaledVector(dir, ev.depth);
        from.addScaledVector(d, 1e-3);
        if (ev.residualSpeed < 1) {
          p.alive = false;
          return null;
        }
        return { from, consumed: ev.depth, ricochet: false };
      }
      case 'ricochet': {
        // A round that has skipped twice is tumbling badly; the next graze buries it.
        if (++p.ricochets > 2) {
          p.alive = false;
          return null;
        }
        p.mass = ev.residualMass;
        const d = ev.residualDirection!;
        p.velocity.copy(d).multiplyScalar(ev.residualSpeed);
        return { from: hit.point.clone().addScaledVector(hit.normal, 2e-3), consumed: 0, ricochet: true };
      }
      default:
        if (p.fuze > 0 && a.explosiveTNT) {
          // Embedded penetrator waiting for its delay fuze (BLU-109 in a thick wall).
          p.stuck = true;
          p.stuckTarget = target === this.inert ? null : target;
          p.stuckDepth = ev.depth;
          p.position.copy(hit.point).addScaledVector(dir, ev.depth);
          p.velocity.set(0, 0, 0);
          return null;
        }
        p.alive = false;
        return null;
    }
  }

  private emitImpact(ev: ImpactEvent, target: Destructible): void {
    ev.time = this.ctx.time.now;
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
    if (a.tandem && a.precursorRHA) this.jet(a, a.precursorRHA, cone * 0.4, origin, d, 'precursor jet');
    this.jet(a, a.heatPenetrationRHA ?? 0, cone, origin, d, 'jet');
    if (a.followThrough) this.spawnFollowThrough(a, hit, d, p.velocity.length());
    if (a.explosiveTNT) {
      _tmp.copy(hit.point).addScaledVector(hit.normal, 0.05);
      this.detonateWith(a, _tmp, hit.normal, hit.target === this.inert ? null : hit.target, 0, d, p.velocity.length(), 'shaped');
    }
  }

  /**
   * Shaped-charge jet with `capacity` metres of RHA penetration from `origin` along `dir`: resolves
   * against each target in turn; after a perforation the jet loses coherence with distance
   * (capacity × (1 − s / 30 CD)) and throws behind-armour debris. Also used by linear cutters.
   */
  jet(a: AmmoSpec, capacity: number, cone: number, origin: THREE.Vector3, dir: THREE.Vector3, label: string, maxDist = 0.5): void {
    let c = capacity;
    const from = origin.clone();
    let reach = maxDist;
    for (let k = 0; k < MAX_INTERACTIONS && c > 1e-4; k++) {
      let hit = this.ctx.registry.raycast(from, dir, reach);
      const inert = this.castInert(from, dir, hit ? hit.distance : reach);
      if (inert) hit = inert;
      if (!hit) return;
      c *= clamp01(1 - hit.distance / (30 * cone));
      if (c <= 1e-4) return;
      const probe = hit.target.probe(hit, dir, c * 8);
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
      this.spawn({ ammo: spec, origin: ev.exitPoint!.clone().addScaledVector(d, 2e-3), velocity: d.multiplyScalar(speed) });
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
    const p = this.spawnDelayed({ ammo: spec, origin: hit.point.clone().addScaledVector(hit.normal, 0.05), velocity: dir.clone().multiplyScalar(Math.min(ft.speed, speed)) }, 0);
    p.fuze = ft.delay;
  }

  /** Detonate a projectile's filler at a point. AP rounds with a small charge (Mk 211) keep flying. */
  private detonateAt(p: ProjectileImpl, point: THREE.Vector3, normal: THREE.Vector3 | null, contact: Destructible | null, buried: number): void {
    const a = p.ammo as AmmoData;
    const kind: BlastKind = a.kind === 'thermobaric' ? 'thermobaric' : a.kind === 'hesh' ? 'hesh' : 'he';
    if (a.explosiveTNT) this.detonateWith(a, point, normal, contact, buried, p.velocity.lengthSq() > 0 ? p.velocity.clone().normalize() : null, p.velocity.length(), kind);
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
      source: a, label: a.name, tamping,
    };
    this.ctx.blasts.detonate(req);
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
