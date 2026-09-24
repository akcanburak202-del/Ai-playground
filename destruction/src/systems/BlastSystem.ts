import * as THREE from 'three';
import type { Simulation } from '../app/Simulation.ts';
import type { BlastSystemApi, SimContext, System } from '../app/contracts.ts';
import type { Rng } from '../core/rng.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { createBlastLoad, fireballRadius, hemisphericalCharge, rangeForOverpressure } from '../physics/ballistics/blast.ts';
import { fragmentAmmo, fragmentBudget, sampleFragments } from '../physics/ballistics/fragments.ts';
import type { BlastLoad, BlastRequest } from '../physics/ballistics/types.ts';

/** BlastRequest with the extras the projectile system knows about. */
export interface ExtendedBlastRequest extends BlastRequest {
  /** Tamping factor for charges that detonated buried inside a target (≥ 1) */
  tamping?: number;
}

/** Radius of effect: where peak incident overpressure has fallen to 2 kPa (window-rattling), capped. */
const EFFECT_PA = 2000;
const MAX_RANGE = 400;
/** Rigid bodies are pushed out to where incident overpressure is still ~10 kPa. */
const BODY_PA = 10000;
/** A wall between the charge and a target transmits roughly this fraction of the load (diffraction). */
const OCCLUSION = 0.3;
const MAX_BODY_DV = 400;

interface PendingTarget { time: number; target: Destructible; load: BlastLoad }
interface PendingBody { time: number; handle: number; impulse: THREE.Vector3; point: THREE.Vector3 }

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _cam = new THREE.Vector3();

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

  constructor(sim: Simulation) {
    this.ctx = sim.ctx;
    this.rng = sim.ctx.rng.fork();
  }

  detonate(req: BlastRequest): void {
    const ctx = this.ctx;
    const now = ctx.time.now;
    const ext = req as ExtendedBlastRequest;
    const load = createBlastLoad(req, now, { tamping: ext.tamping });
    const thermo = req.kind === 'thermobaric';
    this.count++;
    ctx.events.emit('blast', { ...req, center: req.center.clone(), time: now, fireballRadius: fireballRadius(req.tntKg, thermo) });

    const onSurface = !!req.normal || req.kind === 'contact' || req.kind === 'hesh';
    const W = hemisphericalCharge(req.tntKg, req.center.y, onSurface);
    const range = Math.min(MAX_RANGE, rangeForOverpressure(W, EFFECT_PA));
    const center = load.center;

    for (const d of ctx.registry.querySphere(center, range)) {
      d.bounds.clampPoint(center, _p);
      const dist = _p.distanceTo(center);
      let l = load;
      if (d.id !== req.contactTargetId && dist > 0.05) {
        _d.copy(_p).sub(center).divideScalar(dist);
        const blocker = ctx.registry.raycast(center, _d, dist * 0.98, d);
        if (blocker && blocker.target.id !== d.id) l = createBlastLoad(req, now, { attenuation: OCCLUSION, tamping: ext.tamping });
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
      const Ir = load.reflectedImpulseAt(point, _p.copy(_d).negate());
      const J = Math.min(Ir * Math.PI * rEq * rEq, MAX_BODY_DV * m);
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
      for (const f of sampleFragments(req, fragmentBudget(casing), this.rng)) {
        const spec = fragmentAmmo(f.mass, f.speed, req.source);
        ctx.projectiles.spawn({ ammo: spec, origin: center.clone().addScaledVector(f.direction, 0.02), velocity: f.direction.multiplyScalar(f.speed) });
      }
    }
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
  }
}
