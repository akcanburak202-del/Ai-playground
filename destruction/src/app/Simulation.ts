import * as THREE from 'three';
import { EventBus } from '../core/events.ts';
import { Rng } from '../core/rng.ts';
import { PhysicsWorld } from '../physics/PhysicsWorld.ts';
import { DestructibleRegistry } from '../destructibles/Registry.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { getAmmo } from '../physics/ballistics/ammo.ts';
import type { AmmoSpec, BlastRequest, ImpactEvent } from '../physics/ballistics/types.ts';
import type {
  AudioApi, BlastSystemApi, ElementFactories, FxApi, Projectile, ProjectileSystemApi, RenderPipelineApi,
  SceneDef, SimContext, SimEvents, SimTime, SpawnProjectileOptions, StructureApi, System,
} from './contracts.ts';
import { BasicPipeline } from '../render/BasicPipeline.ts';

/** Largest fixed step, s. Slow motion shrinks it so motion stays smooth. */
export const FIXED_DT = 1 / 60;

export interface SimulationOptions {
  canvas: HTMLCanvasElement;
  seed?: number;
  pipeline?: RenderPipelineApi;
  pixelRatio?: number;
}

/**
 * Owns the shared context and the frame loop. Subsystems are plugged in through `ctx` (APIs) and
 * `addSystem` (update hooks). Deterministic when driven through `advance()`.
 */
export class Simulation {
  readonly ctx: SimContext;
  pipeline: RenderPipelineApi;
  private systems: System[] = [];
  private accumulator = 0;
  private lastFrame = 0;
  private running = false;
  /** When true the RAF loop renders but does not advance the simulation (scripted runs). */
  manual = false;
  paused = false;
  currentScene: SceneDef | null = null;
  factories: ElementFactories | null = null;
  readonly impactLog: ImpactEvent[] = [];
  private frameListeners = new Set<(realDt: number) => void>();

  private constructor(ctx: SimContext, pipeline: RenderPipelineApi) {
    this.ctx = ctx;
    this.pipeline = pipeline;
    ctx.events.on('impact', (e) => {
      this.impactLog.push(e);
      if (this.impactLog.length > 200) this.impactLog.shift();
    });
  }

  static async create(o: SimulationOptions): Promise<Simulation> {
    const physics = await PhysicsWorld.create();
    const renderer = new THREE.WebGLRenderer({ canvas: o.canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    renderer.setPixelRatio(o.pixelRatio ?? Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 2000);
    camera.position.set(0, 1.7, 12);
    const world = new THREE.Group();
    world.name = 'world';
    scene.add(world, camera);
    const registry = new DestructibleRegistry();
    const events = new EventBus<SimEvents>();
    const time: SimTime = { now: 0, scale: 1, fixedDt: FIXED_DT };
    const ctx: SimContext = {
      scene, camera, renderer, physics, registry, events, world, time,
      rng: new Rng(o.seed ?? 20260923),
      projectiles: new NullProjectiles(),
      blasts: new NullBlasts(),
      fx: NULL_FX,
      audio: new NullAudio(),
      structure: new NullStructure(),
      addDestructible(d: Destructible) {
        registry.add(d);
        if (!d.root.parent) world.add(d.root);
      },
      ammo(id: string): AmmoSpec {
        return getAmmo(id);
      },
    };
    const pipeline = o.pipeline ?? new BasicPipeline();
    const sim = new Simulation(ctx, pipeline);
    pipeline.setup(ctx, null);
    sim.addGroundCollider();
    return sim;
  }

  addSystem(s: System): void {
    this.systems.push(s);
  }

  removeSystem(s: System): void {
    const i = this.systems.indexOf(s);
    if (i >= 0) this.systems.splice(i, 1);
  }

  getSystem<T extends System>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  onFrame(fn: (realDt: number) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  /** Static ground slab (top at y = 0). The environment module may replace it with terrain. */
  private addGroundCollider(): void {
    const p = this.ctx.physics;
    p.defaultGround = p.createFixed(new THREE.Vector3(0, -1, 0), undefined, [p.R.ColliderDesc.cuboid(500, 1, 500).setFriction(0.9)], { kind: 'ground' });
  }

  /** Tear down the current scene and build another. */
  async loadScene(def: SceneDef): Promise<void> {
    if (!this.factories) throw new Error('Element factories are not wired');
    const { ctx } = this;
    for (const d of [...ctx.registry.all()]) d.dispose();
    ctx.registry.sweep();
    for (const d of [...ctx.registry.all()]) ctx.registry.remove(d);
    ctx.world.clear();
    for (const s of this.systems) s.reset?.();
    ctx.physics.reset();
    this.addGroundCollider();
    ctx.time.now = 0;
    this.accumulator = 0;
    this.impactLog.length = 0;
    this.currentScene = def;
    this.pipeline.setup(ctx, def);
    await def.build(ctx, this.factories);
    const [px, py, pz] = def.spawn.position;
    const [lx, ly, lz] = def.spawn.lookAt;
    ctx.camera.position.set(px, py, pz);
    ctx.camera.lookAt(lx, ly, lz);
    ctx.events.emit('sceneLoaded', { id: def.id });
  }

  /** One fixed step of everything that simulates. */
  fixedStep(dt: number): void {
    const { ctx } = this;
    ctx.time.fixedDt = dt;
    ctx.time.now += dt;
    for (const s of this.systems) s.fixedUpdate?.(dt);
    ctx.physics.step(dt);
    for (const d of ctx.registry.all()) if (!d.disposed) d.fixedUpdate?.(dt);
    ctx.structure.update(dt);
    ctx.registry.sweep();
  }

  /** Per-frame (non-fixed) work: mesh rebuilds, effects, audio, HUD. */
  frameStep(simDt: number, realDt: number): void {
    for (const d of this.ctx.registry.all()) if (!d.disposed) d.frameUpdate?.(simDt);
    for (const s of this.systems) s.frameUpdate?.(simDt, realDt);
    for (const fn of this.frameListeners) fn(realDt);
  }

  /** Deterministically advance `seconds` of simulation time without rendering. */
  advance(seconds: number, frameEvery = 1 / 30): void {
    let t = 0;
    let sinceFrame = 0;
    while (t < seconds - 1e-9) {
      const dt = Math.min(FIXED_DT, seconds - t);
      this.fixedStep(dt);
      t += dt;
      sinceFrame += dt;
      if (sinceFrame >= frameEvery) {
        this.frameStep(sinceFrame, sinceFrame);
        sinceFrame = 0;
      }
    }
    if (sinceFrame > 0) this.frameStep(sinceFrame, sinceFrame);
  }

  render(realDt = 1 / 60): void {
    this.pipeline.render(realDt);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const realDt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
      this.lastFrame = now;
      if (!this.manual && !this.paused) {
        const scale = this.ctx.time.scale;
        const simDt = realDt * scale;
        const step = FIXED_DT * Math.min(1, Math.max(scale, 0.02));
        this.accumulator += simDt;
        let n = 0;
        while (this.accumulator >= step && n < 4) {
          this.fixedStep(step);
          this.accumulator -= step;
          n++;
        }
        if (n === 4) this.accumulator = 0;
        this.frameStep(simDt, realDt);
      } else {
        this.frameStep(0, realDt);
      }
      this.pipeline.render(realDt);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  resize(width: number, height: number): void {
    this.pipeline.resize(width, height);
  }
}

// ─── Stubs used until the real subsystems are wired ─────────────────────────────────────────

class NullProjectiles implements ProjectileSystemApi {
  readonly active: Projectile[] = [];
  spawn(o: SpawnProjectileOptions): Projectile {
    return {
      id: 0, ammo: o.ammo, position: o.origin.clone(), previous: o.origin.clone(), velocity: o.velocity.clone(),
      mass: o.ammo.mass, length: o.ammo.length, age: 0, alive: false, tracer: false, perforations: 0, burning: false,
    };
  }
}

class NullBlasts implements BlastSystemApi {
  detonate(_req: BlastRequest): void {}
}

const NULL_FX: FxApi = {
  chips() {}, dust() {}, sparks() {}, smoke() {}, flash() {}, shake() {},
};

class NullAudio implements AudioApi {
  muted = true;
  unlock(): void {}
  setMuted(m: boolean): void {
    this.muted = m;
  }
}

/** Minimal graph: registers anchors so elements can be tested, but never propagates failures. */
class NullStructure implements StructureApi {
  private n = 0;
  link(_supporter: Destructible | 'ground', supported: Destructible, regionWorld: THREE.Box3): string {
    const id = `anchor-${++this.n}`;
    supported.structural?.addAnchor(id, regionWorld);
    return id;
  }
  touch(): void {}
  remove(): void {}
  update(): void {}
}
