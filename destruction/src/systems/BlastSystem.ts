import * as THREE from 'three';
import type { Simulation } from '../app/Simulation.ts';
import type { BlastSystemApi, SimContext, SpawnProjectileOptions, System } from '../app/contracts.ts';
import type { Rng } from '../core/rng.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { bodyBlastImpulse, createBlastLoad, fireballRadius, gasLoad, hemisphericalCharge, rangeForOverpressure, type Enclosure, type ExtendedBlastLoad, type GasLoad } from '../physics/ballistics/blast.ts';
import { fragmentAmmo, fragmentBudget, sampleFragments } from '../physics/ballistics/fragments.ts';
import type { BlastLoad, BlastRequest } from '../physics/ballistics/types.ts';

/** BlastRequest with the extras the projectile system knows about. */
export interface ExtendedBlastRequest extends BlastRequest {
  /** Tamping factor for charges that detonated buried inside a target (≥ 1) */
  tamping?: number;
  /**
   * Simulation time of the detonation when it happened part-way through the current fixed step
   * (a shell striking mid-step); default and upper bound: `ctx.time.now`.
   */
  time?: number;
}

/** Anything that can throw a round from a given moment (ProjectileSystem.spawnAt). */
interface TimedSpawner {
  spawnAt(o: SpawnProjectileOptions, start: number): unknown;
}

/** Radius of effect: where peak incident overpressure has fallen to 2 kPa (window-rattling), capped. */
const EFFECT_PA = 2000;
const MAX_RANGE = 400;
/** Rigid bodies are pushed out to where incident overpressure is still ~10 kPa. */
const BODY_PA = 10000;
/** A wall between the charge and a target transmits roughly this fraction of the load (diffraction). */
const OCCLUSION = 0.3;
const MAX_BODY_DV = 400;
/** Confinement probe: rays from the charge, and how far a surface still counts as part of its room, m */
const ENCLOSURE_RANGE = 15;
const ENCLOSURE_RAYS = 64;
/** Unit directions on a Fibonacci sphere (even solid-angle coverage) */
const RAY_DIRS: THREE.Vector3[] = (() => {
  const out: THREE.Vector3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < ENCLOSURE_RAYS; i++) {
    const y = 1 - (2 * (i + 0.5)) / ENCLOSURE_RAYS;
    const r = Math.sqrt(1 - y * y);
    out.push(new THREE.Vector3(Math.cos(ga * i) * r, y, Math.sin(ga * i) * r));
  }
  return out;
})();
/** Charges below this (TNT-e, kg) are not probed for confinement */
const ENCLOSURE_MIN_KG = 0.01;
/** A probe is reused for detonations within 1 m and this many seconds of it */
const ENCLOSURE_REUSE_S = 0.5;
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];

interface PendingTarget { time: number; target: Destructible; load: BlastLoad }
interface PendingBody { time: number; handle: number; impulse: THREE.Vector3; point: THREE.Vector3 }

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _sz = new THREE.Vector3();

/**
 * Detonations: emits 'blast' at once (fireball), then delivers the load to every destructible in
 * range when the shock front reaches it (Kingery–Bulmash arrival time, in simulation time, so a
 * blast in slow motion visibly ripples outward), pushes loose rigid bodies with the reflected
 * impulse, throws casing fragments as projectiles and shakes the camera.
 */
export class BlastSystem implements System, BlastSystemApi {
  readonly name = 'blasts';
  private readonly ctx: SimContext;
  private readonly rng: Rng;
  private pending: PendingTarget[] = [];
  private bodies: PendingBody[] = [];
  private shakes: { time: number; amount: number }[] = [];
  /** Blasts detonated since the scene loaded (telemetry) */
  count = 0;
  /** Gas load of the last confined detonation (telemetry / tests) */
  lastGas: GasLoad | null = null;
  /** Ids of the destructibles that bounded it */
  readonly lastEnclosureIds = new Set<number>();
  private encCache: { time: number; center: THREE.Vector3; enc: Enclosure | null } | null = null;

  constructor(sim: Simulation) {
    this.ctx = sim.ctx;
    this.rng = sim.ctx.rng.fork();
  }

  detonate(req: BlastRequest): void {
    const ctx = this.ctx;
    const ext = req as ExtendedBlastRequest;
    // Detonation time: inside the step being simulated when the projectile system knows it, so the
    // contact target is loaded in this same step and far targets exactly when the front arrives
    // (loads are applied at the end of the step in which they arrive, never before).
    const now = Math.min(ctx.time.now, Number.isFinite(ext.time) ? ext.time! : ctx.time.now);
    const load = createBlastLoad(req, now, { tamping: ext.tamping });
    const thermo = req.kind === 'thermobaric';
    this.count++;
    ctx.events.emit('blast', { ...req, center: req.center.clone(), time: now, fireballRadius: fireballRadius(req.tntKg, thermo) });

    const onSurface = !!req.normal || req.kind === 'contact' || req.kind === 'hesh';
    const W = hemisphericalCharge(req.tntKg, req.center.y, onSurface);
    const range = Math.min(MAX_RANGE, rangeForOverpressure(W, EFFECT_PA));
    const center = load.center;

    // Confined detonation: the surfaces that bound the charge's room also carry the quasi-static
    // gas pressure (UFC 3-340-02 ch. 2). Only they do — the gas pushes equally on both sides of
    // anything standing inside the room.
    const enclosureIds = this.lastEnclosureIds;
    // Rapid fire into the same room (cannon HE, bursts) reuses the probe for 0.5 s / 1 m.
    const cached = this.encCache && now - this.encCache.time < ENCLOSURE_REUSE_S && center.distanceToSquared(this.encCache.center) < 1;
    const enc = req.tntKg < ENCLOSURE_MIN_KG ? (enclosureIds.clear(), null) : cached ? this.encCache!.enc : this.measureEnclosure(center, enclosureIds);
    if (!cached && req.tntKg >= ENCLOSURE_MIN_KG) this.encCache = { time: now, center: center.clone(), enc };
    const gas = enc ? gasLoad(req.tntKg, thermo, enc) : null;
    this.lastGas = gas;
    if (!gas) enclosureIds.clear();
    const gasLoadFor = gas ? createBlastLoad(req, now, { tamping: ext.tamping, gas }) : null;

    for (const d of ctx.registry.querySphere(center, Math.max(range, gas ? gas.radius : 0))) {
      d.bounds.clampPoint(center, _p);
      const dist = _p.distanceTo(center);
      let l: ExtendedBlastLoad = load;
      if (gasLoadFor && enclosureIds.has(d.id)) l = gasLoadFor;
      else if (d.id !== req.contactTargetId && dist > 0.05) {
        _d.copy(_p).sub(center).divideScalar(dist);
        const blocker = ctx.registry.raycast(center, _d, dist * 0.98, d);
        if (blocker && blocker.target.id !== d.id) l = createBlastLoad(req, now, { attenuation: OCCLUSION, tamping: ext.tamping });
        else if (gasLoadFor && gas && dist <= gas.radius && !this.standsInRoom(center, _d, d, enclosureIds, gas.enclosure.radius)) {
          // In plain view and part of the room's boundary (a panel the 64 rays happened to miss).
          enclosureIds.add(d.id);
          l = gasLoadFor;
        }
      }
      this.pending.push({ time: now + load.arrivalTime(_p), target: d, load: l });
    }

    // Loose rigid bodies: impulse ≈ reflected impulse × presented area, outward, at the near side.
    const bodyRange = Math.min(range, rangeForOverpressure(W, BODY_PA));
    const phys = ctx.physics;
    for (const b of phys.bodiesInSphere(center, bodyRange)) {
      const m = b.mass();
      if (!(m > 0)) continue;
      const t = b.translation();
      const owner = b.numColliders() > 0 ? phys.ownerOf(b.collider(0)) : undefined;
      const rho = owner?.material?.density ?? 2400;
      const rEq = Math.cbrt((3 * (m / rho)) / (4 * Math.PI));
      _d.set(t.x - center.x, t.y - center.y, t.z - center.z);
      const dist = _d.length();
      if (dist < 1e-4) _d.set(0, 1, 0);
      else _d.divideScalar(dist);
      const point = new THREE.Vector3(t.x, t.y, t.z).addScaledVector(_d, -Math.min(rEq, dist * 0.9));
      // Reflected impulse over the presented area at the body's standoff, cleared at its edges,
      // and never more momentum than the charge can put into the solid angle it subtends.
      const J = Math.min(bodyBlastImpulse({ tntKg: req.tntKg, W, thermobaric: thermo, dist, rEq, gurney: req.gurney }), MAX_BODY_DV * m);
      this.bodies.push({ time: now + load.arrivalTime(point), handle: b.handle, impulse: _d.clone().multiplyScalar(J), point });
    }

    // Camera shake scales with the incident overpressure that reaches the viewer.
    ctx.camera.getWorldPosition(_cam);
    const pCam = load.overpressureAt(_cam);
    const shake = Math.min(1, Math.max(0, 0.3 * Math.log10(pCam / 300)));
    if (shake > 0.01) this.shakes.push({ time: now + load.arrivalTime(_cam), amount: shake });

    // Casing fragments fly as real projectiles.
    const casing = req.casingMass ?? 0;
    if (casing > 0) {
      const timed = (ctx.projectiles as Partial<TimedSpawner>).spawnAt ? (ctx.projectiles as unknown as TimedSpawner) : null;
      for (const f of sampleFragments(req, fragmentBudget(casing), this.rng)) {
        const spec = fragmentAmmo(f.mass, f.speed, req.source);
        const o = { ammo: spec, origin: center.clone().addScaledVector(f.direction, 0.02), velocity: f.direction.multiplyScalar(f.speed) };
        // Thrown at the moment of detonation: they catch up with the clock on their first step.
        if (timed) timed.spawnAt(o, now);
        else ctx.projectiles.spawn(o);
      }
    }
  }

  /**
   * How enclosed the charge is: rays in 64 directions out to 15 m. A ray that meets a solid
   * destructible (or the ground plane) bounds the room; one that escapes, or meets glazing (which
   * fails long before the walls do), is an opening. Returns null when fewer than 5 of 6 axis rays
   * meet a surface (open air: most detonations) or less than half the directions are closed.
   * Volume ≈ Σ ΔΩ r³/3, vent area ≈ Σ ΔΩ r² over the openings (escaped rays at the mean wall
   * distance). `ids` receives the destructibles that bound it.
   */
  measureEnclosure(center: THREE.Vector3, ids: Set<number>): Enclosure | null {
    ids.clear();
    const reg = this.ctx.registry;
    const reach = (dir: THREE.Vector3): { r: number; glass: boolean; target: Destructible | null } | null => {
      const floor = dir.y < -1e-6 ? center.y / -dir.y : Infinity;
      const hit = reg.raycast(center, dir, Math.min(ENCLOSURE_RANGE, floor));
      if (hit) return { r: hit.distance, glass: hit.material.class === 'glass' || hit.target.kind === 'glass', target: hit.target };
      return floor <= ENCLOSURE_RANGE ? { r: floor, glass: false, target: null } : null;
    };
    const firstDir = new Map<Destructible, THREE.Vector3>();
    let axisHits = 0;
    for (const a of AXES) if (reach(a)) axisHits++;
    if (axisHits < 5) return null;
    const dOmega = (4 * Math.PI) / RAY_DIRS.length;
    let closed = 0, rSum = 0, rMax = 0, vol = 0, vent = 0, open = 0;
    for (const dir of RAY_DIRS) {
      const h = reach(dir);
      if (!h) {
        open++;
        continue;
      }
      const r3 = h.r * h.r * h.r;
      vol += (dOmega * r3) / 3;
      rMax = Math.max(rMax, h.r);
      if (h.target) {
        ids.add(h.target.id);
        // Keep the most horizontal ray per target for the "is it inside the room?" test below.
        const prev = firstDir.get(h.target);
        if (!prev || Math.abs(dir.y) < Math.abs(prev.y)) firstDir.set(h.target, dir);
      }
      if (h.glass) vent += dOmega * h.r * h.r;
      else {
        closed++;
        rSum += h.r;
      }
    }
    const frac = closed / RAY_DIRS.length;
    if (frac < 0.5 || closed === 0) {
      ids.clear();
      return null;
    }
    // Something standing inside the room (a column, furniture) has the room's boundary behind it:
    // the gas presses on it from all sides, so it is not part of the enclosure.
    for (const [t, dir] of firstDir) if (this.standsInRoom(center, dir, t, ids, rMax)) ids.delete(t.id);
    const rMean = rSum / closed;
    vol += (open * dOmega * rMean * rMean * rMean) / 3;
    vent += open * dOmega * rMean * rMean;
    return { volume: vol, ventArea: vent, closed: frac, radius: rMax };
  }

  /**
   * Does `d` stand inside the room (a column, a free-standing block) rather than bound it? It must
   * be compact — no wider than 0.3 × the room radius in plan (walls and slabs are not, even when
   * they run on outside the room, like the chapel's slicing wall) — and the room's own boundary
   * must lie behind it along `dir` (the ground, which runs under everything, does not count).
   */
  private standsInRoom(center: THREE.Vector3, dir: THREE.Vector3, d: Destructible, room: Set<number>, roomRadius: number): boolean {
    if (d.kind === 'terrain') return true;
    d.bounds.getSize(_sz);
    if (Math.max(_sz.x, _sz.z) > 0.3 * roomRadius) return false;
    const floor = dir.y < -1e-6 ? center.y / -dir.y : Infinity;
    const behind = this.ctx.registry.raycast(center, dir, Math.min(ENCLOSURE_RANGE, floor), d);
    return !!behind && behind.target.kind !== 'terrain' && room.has(behind.target.id);
  }

  fixedUpdate(): void {
    const now = this.ctx.time.now;
    if (this.pending.length) {
      let w = 0;
      for (let i = 0; i < this.pending.length; i++) {
        const e = this.pending[i]!;
        if (e.time <= now) {
          if (!e.target.disposed) e.target.applyBlast(e.load);
        } else this.pending[w++] = e;
      }
      this.pending.length = w;
    }
    if (this.bodies.length) {
      const phys = this.ctx.physics;
      let w = 0;
      for (let i = 0; i < this.bodies.length; i++) {
        const e = this.bodies[i]!;
        if (e.time <= now) {
          const b = phys.world.getRigidBody(e.handle);
          if (b && b.isValid() && b.isDynamic()) phys.applyImpulseAt(b, e.impulse, e.point);
        } else this.bodies[w++] = e;
      }
      this.bodies.length = w;
    }
    if (this.shakes.length) {
      let w = 0;
      for (let i = 0; i < this.shakes.length; i++) {
        const e = this.shakes[i]!;
        if (e.time <= now) this.ctx.fx.shake(e.amount);
        else this.shakes[w++] = e;
      }
      this.shakes.length = w;
    }
  }

  reset(): void {
    this.pending.length = 0;
    this.bodies.length = 0;
    this.shakes.length = 0;
    this.count = 0;
    this.lastGas = null;
    this.lastEnclosureIds.clear();
    this.encCache = null;
  }
}
