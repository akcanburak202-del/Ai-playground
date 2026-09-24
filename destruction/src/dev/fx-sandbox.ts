import * as THREE from 'three';
import { createSandbox } from './sandboxKit.ts';
import { Pipeline, type Quality } from '../render/Pipeline.ts';
import { BasicPipeline } from '../render/BasicPipeline.ts';
import { Noise3 } from '../core/noise.ts';
import { createTerrain } from '../destructibles/terrain/index.ts';
import type { PlazaFinish } from '../destructibles/terrain/material.ts';
import { installFx, type FxSystem } from '../fx/index.ts';
import { MATERIALS, type MaterialId } from '../physics/materials.ts';
import type { AmmoSpec, BlastKind, ImpactEvent } from '../physics/ballistics/types.ts';
import type { Simulation } from '../app/Simulation.ts';
import type { SimContext } from '../app/contracts.ts';
import { allocateDestructibleId, rayBoxEntry, type Destructible, type RayHit } from '../destructibles/Destructible.ts';
import type { MaterialProps } from '../physics/materials.ts';
import type { BlastLoad, ThicknessProbe } from '../physics/ballistics/types.ts';

/**
 * A static axis-aligned block that projectiles and blasts can hit, so the sandbox exercises the
 * real impact pipeline (ballistics → ImpactEvent → effects) without the voxel / steel modules.
 * It does not change shape.
 */
class SandboxBlock implements Destructible {
  readonly id = allocateDestructibleId();
  readonly kind = 'voxel' as const;
  readonly root = new THREE.Object3D();
  readonly bounds: THREE.Box3;
  readonly disposed = false;
  readonly name: string;
  readonly material: MaterialProps;
  constructor(name: string, box: THREE.Box3, material: MaterialProps) {
    this.name = name;
    this.bounds = box.clone();
    this.material = material;
  }
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    const t = rayBoxEntry(this.bounds, origin, dir, maxDist);
    if (!Number.isFinite(t) || t > maxDist) return null;
    const point = origin.clone().addScaledVector(dir, t);
    const b = this.bounds;
    const e = 1e-4;
    const normal = new THREE.Vector3(
      Math.abs(point.x - b.min.x) < e ? -1 : Math.abs(point.x - b.max.x) < e ? 1 : 0,
      Math.abs(point.y - b.min.y) < e ? -1 : Math.abs(point.y - b.max.y) < e ? 1 : 0,
      Math.abs(point.z - b.min.z) < e ? -1 : Math.abs(point.z - b.max.z) < e ? 1 : 0,
    );
    if (normal.lengthSq() === 0) normal.copy(dir).negate();
    normal.normalize();
    return { target: this, point, normal, distance: t, material: this.material };
  }
  probe(hit: RayHit, dir: THREE.Vector3, maxDepth: number): ThicknessProbe {
    // Exit distance through the box along the shot line.
    const inv = [1 / dir.x, 1 / dir.y, 1 / dir.z];
    const o = [hit.point.x, hit.point.y, hit.point.z];
    const lo = [this.bounds.min.x, this.bounds.min.y, this.bounds.min.z];
    const hi = [this.bounds.max.x, this.bounds.max.y, this.bounds.max.z];
    let tExit = Infinity;
    for (let a = 0; a < 3; a++) {
      const t0 = (lo[a]! - o[a]!) * inv[a]!, t1 = (hi[a]! - o[a]!) * inv[a]!;
      tExit = Math.min(tExit, Math.max(t0, t1));
    }
    const end = Math.max(1e-4, Math.min(tExit, maxDepth));
    return { segments: [{ material: this.material, start: 0, end, strength: 1 }], exits: tExit <= maxDepth };
  }
  applyImpact(): void {}
  applyBlast(_l: BlastLoad): void {}
  dispose(): void {}
}

/**
 * FX / render sandbox: the production pipeline, a terrain with a stone plaza, a few plain
 * concrete volumes (a "golden hour architecture" still), the effects system, and — when the
 * ballistics module is present — real projectiles and blasts. `window.__fx` scripts scenarios
 * for scripts/shot.ts: synthetic impacts per material, blasts, tracer bursts, rockets, smoke,
 * quality switching and frame timing.
 */

type Install = (sim: Simulation) => unknown;
let installBallistics: Install | null = null;
try {
  installBallistics = (await import('../systems/index.ts')).installBallistics as Install;
} catch (err) {
  console.warn('fx sandbox: ballistics module unavailable', err);
}

/** Procedural cast-in-place concrete: soft mottling, faint form-panel seams and tie holes. */
function concreteTexture(): THREE.DataTexture {
  const n = 512;
  const data = new Uint8Array(n * n * 4);
  const noise = new Noise3(7);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      let c = 0.72 + 0.05 * noise.fbm(u * 6, v * 6, 0.5, 4) + 0.025 * noise.noise3(u * 90, v * 90, 1.7);
      const px = (u * 4) % 1, py = (v * 2) % 1;
      if (Math.min(px, 1 - px) < 0.0025 || Math.min(py, 1 - py) < 0.004) c -= 0.05;
      const tx = ((u * 4 + 0.5) % 1) - 0.5, ty = ((v * 4 + 0.5) % 1) - 0.5;
      if (tx * tx + ty * ty < 0.00012) c -= 0.35;
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = Math.round(255 * Math.max(0, Math.min(1, c)));
      data[i + 2] = Math.round(255 * Math.max(0, Math.min(1, c * 0.97)));
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

const params = new URLSearchParams(location.search);
const pipeline = new Pipeline({ quality: (Number(params.get('q') ?? 2) as Quality) });
// `?basic` renders the same sandbox through BasicPipeline (compatibility check for other sandboxes).
const basic = params.has('basic') ? new BasicPipeline() : null;
let fx: FxSystem | null = null;
const disposables: { dispose(): void }[] = [];

const kit = await createSandbox({
  title: 'fx sandbox',
  pipeline: basic ?? pipeline,
  camera: { position: [16, 3.2, 17], lookAt: [0, 3, 0] },
  install(sim) {
    try {
      installBallistics?.(sim);
    } catch (err) {
      console.warn('fx sandbox: installBallistics failed', err);
    }
    fx = installFx(sim) as FxSystem;
  },
  build(ctx) {
    // Scene reloads rebuild everything: free the previous build's sandbox resources first.
    for (const d of disposables.splice(0)) d.dispose();
    const finish = (params.get('finish') ?? 'pavers') as PlazaFinish;
    createTerrain(ctx, { plaza: { halfX: 22, halfZ: 16, finish } });
    const tex = concreteTexture();
    disposables.push(tex);
    const mk = (w: number, h: number, d: number, x: number, y: number, z: number, tint = 0xffffff) => {
      const t = tex.clone();
      t.repeat.set(Math.max(w, d) / 4, h / 4);
      t.needsUpdate = true;
      const geo = new THREE.BoxGeometry(w, h, d);
      const mat = new THREE.MeshStandardMaterial({ color: tint, map: t, roughness: 0.85 });
      disposables.push(t, geo, mat);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y + h / 2, z);
      m.castShadow = m.receiveShadow = true;
      ctx.world.add(m);
      ctx.addDestructible(new SandboxBlock(`block-${x}-${z}`, new THREE.Box3().setFromObject(m), MATERIALS.concrete));
      return m;
    };
    // A small Ando-like composition: long wall, a tall slab, a cantilevered roof on two blades.
    mk(18, 5, 0.4, 0, 0, -3);
    mk(0.4, 9, 7, -6, 0, 1.5);
    mk(0.4, 4, 6, 5, 0, 1);
    mk(0.4, 4, 6, 9, 0, 1);
    mk(7, 0.35, 8, 7, 4, 1);
    mk(2.2, 2.2, 2.2, 1, 0, 5, 0xf2efe8);
    mk(1, 1, 1, 13, 0, 8, 0xd8d2c6);
    // A weathering-steel plate and a glass pane as impact targets (visual stand-ins).
    const steel = new THREE.Mesh(new THREE.BoxGeometry(2, 2.5, 0.03), new THREE.MeshStandardMaterial({ color: 0x5a3a26, roughness: 0.6, metalness: 0.6 }));
    steel.position.set(-4, 1.25, 4);
    steel.castShadow = steel.receiveShadow = true;
    const glass = new THREE.Mesh(new THREE.BoxGeometry(2, 2.5, 0.012), new THREE.MeshPhysicalMaterial({ color: 0xcfe3e6, roughness: 0.02, metalness: 0, transparent: true, opacity: 0.25 }));
    glass.position.set(-1.3, 1.25, 4);
    disposables.push(steel.geometry, steel.material as THREE.Material, glass.geometry, glass.material as THREE.Material);
    ctx.world.add(steel, glass);
    ctx.addDestructible(new SandboxBlock('steel plate', new THREE.Box3().setFromObject(steel), MATERIALS.steel_s355));
    ctx.addDestructible(new SandboxBlock('glass pane', new THREE.Box3().setFromObject(glass), MATERIALS.glass_tempered));
  },
});

const sim = kit.sim;
const ctx: SimContext = sim.ctx;
const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

/** Build an ImpactEvent the way the ballistics module would, for a round `ammoId` on `material`. */
function syntheticImpact(ammoId: string, material: MaterialId, point: number[], normal: number[], dir?: number[]): ImpactEvent {
  const ammo: AmmoSpec = ctx.ammo(ammoId);
  const d = dir ? v3(dir).normalize() : v3(normal).negate().normalize();
  const n = v3(normal).normalize();
  const m = MATERIALS[material];
  const v = ammo.muzzleVelocity * 0.95;
  const E = 0.5 * ammo.mass * v * v;
  const crater = m.class === 'brittle' ? ammo.diameter * 3 : m.class === 'soil' ? ammo.diameter * 4 : ammo.diameter;
  return {
    time: ctx.time.now, ammo, agent: 'projectile', point: v3(point), direction: d, normal: n, obliquity: Math.acos(Math.min(1, -d.dot(n))),
    speed: v, mass: ammo.mass, kineticEnergy: E, outcome: 'embed', depth: crater * 0.6, residualSpeed: 0,
    craterRadius: crater, craterDepth: crater * 0.6, tunnelRadius: ammo.diameter / 2, spallRadius: 0, spallDepth: 0,
    damageRadius: crater * 4, energyAbsorbed: E, momentum: d.clone().multiplyScalar(ammo.mass * v), material: m,
    targetKind: m.class === 'soil' ? 'terrain' : 'voxel', targetName: 'sandbox', summary: 'synthetic',
  };
}

const api = {
  THREE, pipeline, kit,
  get fx() { return fx; },
  /** Camera pose that survives the orbit controls (they re-aim at their target every frame). */
  view(position: number[], target: number[], fov?: number) {
    kit.controls.target.set(target[0]!, target[1]!, target[2]!);
    ctx.camera.position.set(position[0]!, position[1]!, position[2]!);
    if (fov) {
      ctx.camera.fov = fov;
      ctx.camera.updateProjectionMatrix();
    }
    kit.controls.update();
  },
  /** Synthetic impact event (effects only, or also realised on the ground when `onGround`). */
  impact(ammoId: string, material: MaterialId, point: number[], normal: number[], dir?: number[]) {
    const e = syntheticImpact(ammoId, material, point, normal, dir);
    const hit = ctx.registry.raycast(v3(point).addScaledVector(e.normal, 0.5), e.normal.clone().negate(), 1);
    if (hit && hit.target.kind === 'terrain') hit.target.applyImpact(e);
    ctx.events.emit('impact', e);
  },
  /** Real blast through the ballistics module when present (crater, shake), else a synthetic event. */
  blast(at: number[], tntKg: number, kind: BlastKind = 'he', onGround = true) {
    const center = v3(at);
    const terrain = ctx.registry.all().find((d) => d.kind === 'terrain');
    const req = { center, tntKg, kind, normal: onGround ? new THREE.Vector3(0, 1, 0) : undefined, contactTargetId: onGround ? terrain?.id : undefined, casingMass: 0 };
    if (installBallistics) ctx.blasts.detonate(req);
    else ctx.events.emit('blast', { ...req, time: ctx.time.now, fireballRadius: 1.75 * Math.cbrt(tntKg) * (kind === 'thermobaric' ? 1.6 : 1) });
  },
  /** A burst of tracer rounds (real projectiles when ballistics is present). */
  tracerBurst(from: number[], at: number[], count = 12, ammoId = 'm80', interval = 0.03, spreadMOA = 20) {
    const spec = ctx.ammo(ammoId);
    const o = v3(from);
    const aim = v3(at).sub(o).normalize();
    for (let i = 0; i < count; i++) {
      const d = aim.clone();
      const s = (spreadMOA / 60) * (Math.PI / 180);
      d.x += ctx.rng.gaussian(0, s); d.y += ctx.rng.gaussian(0, s); d.z += ctx.rng.gaussian(0, s);
      d.normalize();
      ctx.projectiles.spawn({ ammo: spec, origin: o.clone(), velocity: d.multiplyScalar(spec.muzzleVelocity), tracer: true });
      ctx.events.emit('shot', { time: ctx.time.now, weapon: { id: 'm240b', name: 'M240B', role: '', category: 'mg', ammo: [ammoId], rpm: 750, fireMode: 'auto', dispersionMOA: 3, tracerEvery: 1, delivery: 'direct', recoil: 0.18, sound: '', zoom: 1, muzzleOffset: [0, 0, 0] }, ammo: spec, origin: o.clone(), direction: aim.clone() });
      sim.advance(interval);
    }
  },
  /** Launch a rocket (PG-7VL by default) at a point. */
  rocket(from: number[], at: number[], ammoId = 'pg7vl') {
    const spec = ctx.ammo(ammoId);
    const o = v3(from);
    const d = v3(at).sub(o).normalize();
    ctx.projectiles.spawn({ ammo: spec, origin: o.clone(), velocity: d.clone().multiplyScalar(spec.muzzleVelocity), target: v3(at) });
    ctx.events.emit('shot', { time: ctx.time.now, weapon: { id: 'rpg7', name: 'RPG-7V2', role: '', category: 'launcher', ammo: [ammoId], rpm: 4, fireMode: 'single', dispersionMOA: 3, tracerEvery: 0, delivery: 'direct', recoil: 0.3, sound: '', zoom: 1, muzzleOffset: [0, 0, 0] }, ammo: spec, origin: o, direction: d });
  },
  smoke(at: number[], radius = 1, duration = 20, color = 0x5a5650) {
    ctx.fx.smoke({ position: v3(at), radius, duration, color, rise: 1.5 });
  },
  setQuality(q: Quality) {
    pipeline.setQuality(q);
  },
  /**
   * Time `frames` renders (each forced to finish with a 1-pixel read-back) and the FX CPU cost.
   * Returns ms per frame: total, pipeline submit, fx frame update.
   */
  perf(frames = 10) {
    const gl = ctx.renderer.getContext();
    const px = new Uint8Array(4);
    sim.render();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let total = 0, submit = 0, fxMs = 0;
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      sim.frameStep(0, 1 / 60);
      fxMs += fx?.lastFrameMs ?? 0;
      sim.render(1 / 60);
      submit += pipeline.lastFrameMs;
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      total += performance.now() - t0;
    }
    const info = ctx.renderer.info.render;
    return { totalMs: total / frames, submitMs: submit / frames, fxMs: fxMs / frames, drawCalls: info.calls, triangles: info.triangles };
  },
  stats() {
    return { ...(fx?.stats() ?? {}), ...kit.harness.stats() };
  },
  dispose() {
    for (const d of disposables) d.dispose();
  },
};
(window as unknown as { __fx: typeof api }).__fx = api;
