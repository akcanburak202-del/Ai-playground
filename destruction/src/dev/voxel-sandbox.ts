import * as THREE from 'three';
import { createSandbox } from './sandboxKit.ts';
import type { SimContext, StructureApi, VoxelElementSpec } from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { createVoxelElement, schedulerFor, VoxelElement } from '../destructibles/voxel/index.ts';
import { STUB_AMMO, fireStub, makeBlastLoadStub, measureCrater, resolveBulletStub } from '../destructibles/voxel/testing.ts';
import type { AmmoSpec, BlastLoad, BlastRequest, ImpactEvent, ProjectileState, ThicknessProbe } from '../physics/ballistics/types.ts';
import type { RayHit } from '../destructibles/Destructible.ts';
import type { Rng } from '../core/rng.ts';
import type { Simulation } from '../app/Simulation.ts';

// The ballistics module (M1) is used when present; the local stand-ins keep the sandbox working
// without it.
type Resolve = (p: ProjectileState, hit: RayHit, probe: ThicknessProbe, rng: Rng) => ImpactEvent;
type MakeLoad = (req: BlastRequest, time: number) => BlastLoad;
let m1Resolve: Resolve | null = null;
let m1Load: MakeLoad | null = null;
let m1Install: ((sim: Simulation) => unknown) | null = null;
/** True once installBallistics wired the real ProjectileSystem / BlastSystem into ctx */
let m1Systems = false;
try {
  m1Resolve = (await import('../physics/ballistics/penetration.ts')).resolveImpact as Resolve;
  m1Load = (await import('../physics/ballistics/blast.ts')).createBlastLoad as MakeLoad;
  m1Install = (await import('../systems/index.ts')).installBallistics as (sim: Simulation) => unknown;
} catch (err) {
  console.warn('voxel sandbox: ballistics module unavailable, using local stand-ins', err);
}

/**
 * Voxel sandbox: a board-formed RC wall, a fluted marble column, a brick wall, a travertine block
 * and a slab on two walls. Impacts come from the local ballistics stand-in (testing.ts) until the
 * ballistics module is wired; `window.__voxelDemo` drives scripted scenarios (scripts/shot.ts).
 */

/** Minimal support graph for the sandbox: releases anchors whose supporter lost its material. */
class SandboxStructure implements StructureApi {
  private links: { id: string; supporter: Destructible | 'ground'; supported: Destructible; region: THREE.Box3 }[] = [];
  private n = 0;
  private clock = 0;
  link(supporter: Destructible | 'ground', supported: Destructible, regionWorld: THREE.Box3): string {
    const id = `sb-${++this.n}`;
    this.links.push({ id, supporter, supported, region: regionWorld.clone() });
    supported.structural?.addAnchor(id, regionWorld);
    return id;
  }
  touch(): void {
    this.clock = 1;
  }
  remove(): void {
    this.clock = 1;
  }
  update(dt: number): void {
    this.clock += dt;
    if (this.clock < 0.1) return;
    this.clock = 0;
    for (const l of [...this.links]) {
      if (l.supporter === 'ground') continue;
      const s = l.supporter;
      const presence = s.disposed || s.structural?.hasFailed() ? 0 : (s.structural?.supportPresence(l.region) ?? 0);
      if (l.supported.disposed || presence < 0.3) {
        this.links.splice(this.links.indexOf(l), 1);
        if (!l.supported.disposed) l.supported.structural?.releaseAnchor(l.id);
      }
    }
    // Gravity load flow: each supported element's weight shared by its live supporters.
    const load = new Map<Destructible, number>();
    const byChild = new Map<Destructible, Destructible[]>();
    for (const l of this.links) {
      if (l.supporter === 'ground') continue;
      let list = byChild.get(l.supported);
      if (!list) byChild.set(l.supported, (list = []));
      list.push(l.supporter);
    }
    for (const [child, sups] of byChild) {
      const w = child.structural?.weight() ?? 0;
      for (const s of sups) load.set(s, (load.get(s) ?? 0) + w / sups.length);
    }
    for (const [s, n] of load) s.structural?.setImposedLoad(n);
  }
}

/** Golden-hour sky gradient, used for the environment map and the backdrop. */
function skyTexture(renderer: THREE.WebGLRenderer): { env: THREE.Texture; dispose: () => void } {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(50, 64, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { sun: { value: new THREE.Vector3(-0.55, 0.37, 0.75).normalize() } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vDir; uniform vec3 sun;
      void main(){
        float y = vDir.y;
        vec3 zenith = vec3(0.23, 0.38, 0.68), horizon = vec3(0.95, 0.72, 0.5), ground = vec3(0.32, 0.28, 0.24);
        vec3 c = y > 0.0 ? mix(horizon, zenith, pow(y, 0.55)) : mix(horizon * 0.8, ground, pow(-y, 0.4));
        float s = max(0.0, dot(vDir, sun));
        c += vec3(1.0, 0.75, 0.45) * (pow(s, 12.0) * 0.6 + pow(s, 400.0) * 20.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.02);
  pmrem.dispose();
  geo.dispose();
  mat.dispose();
  return { env: rt.texture, dispose: () => rt.dispose() };
}

const elements: Record<string, VoxelElement> = {};

function add(ctx: SimContext, spec: VoxelElementSpec, groundAnchor = true): VoxelElement {
  const el = createVoxelElement(ctx, spec) as VoxelElement;
  elements[spec.name] = el;
  if (groundAnchor) {
    const b = el.bounds;
    ctx.structure.link('ground', el, new THREE.Box3(new THREE.Vector3(b.min.x, -0.05, b.min.z), new THREE.Vector3(b.max.x, 0.06, b.max.z)));
  }
  return el;
}

const kit = await createSandbox({
  title: 'voxel sandbox',
  camera: { position: [2.5, 2.6, 9.5], lookAt: [1.2, 1.3, 0] },
  install(sim) {
    sim.ctx.structure = new SandboxStructure();
    try {
      if (m1Install) {
        m1Install(sim);
        m1Systems = true;
      }
    } catch (err) {
      console.warn('voxel sandbox: installBallistics failed', err);
    }
  },
  build(ctx) {
    // Golden-hour raking light across the wall faces (BasicPipeline's sun, repositioned here).
    const sky = skyTexture(ctx.renderer);
    ctx.scene.environment = sky.env;
    ctx.scene.background = new THREE.Color(0xc9b8a4);
    ctx.scene.environmentIntensity = 0.55;
    ctx.scene.traverse((o) => {
      if (o instanceof THREE.DirectionalLight) {
        o.position.set(-0.55, 0.37, 0.75).normalize().multiplyScalar(60);
        o.color.set(0xffdcb0);
        o.intensity = 2.8;
        const c = o.shadow.camera;
        c.left = -10; c.right = 10; c.top = 10; c.bottom = -10; c.near = 1; c.far = 150;
        c.updateProjectionMatrix();
        o.shadow.mapSize.set(4096, 4096);
        o.shadow.bias = -0.0002;
        o.shadow.normalBias = 0.015;
        o.shadow.map?.dispose();
        o.shadow.map = null as unknown as THREE.WebGLRenderTarget;
      }
      if (o instanceof THREE.HemisphereLight) o.intensity = 0.25;
    });

    add(ctx, {
      name: 'rc-wall', material: 'concrete', finish: 'board-formed-concrete', shape: { type: 'box', size: [4, 3, 0.25] },
      position: [0, 1.5, 0], rebar: { diameter: 0.016, spacing: 0.2, cover: 0.04, layout: 'two-faces' },
    });
    add(ctx, {
      name: 'marble-column', material: 'marble', finish: 'marble', shape: { type: 'cylinder', radius: 0.3, height: 3.2, flutes: 20, taper: 0.1 },
      position: [-3.4, 1.6, 1.2], voxelSize: 0.02,
    });
    add(ctx, {
      name: 'brick-wall', material: 'brick', finish: 'brick', shape: { type: 'box', size: [2.5, 2.0, 0.23] },
      position: [4.1, 1.0, 0.8], rotation: [0, -0.35, 0],
    });
    add(ctx, {
      name: 'travertine-block', material: 'travertine', finish: 'travertine', shape: { type: 'box', size: [1.2, 0.8, 0.8] },
      position: [-1.6, 0.4, 3.0], rotation: [0, 0.3, 0],
    });
    // Slab on two walls.
    const wA = add(ctx, { name: 'support-A', material: 'concrete', finish: 'smooth-concrete', shape: { type: 'box', size: [0.2, 2.4, 2.4] }, position: [5.6, 1.2, -4], rebar: { diameter: 0.012, spacing: 0.2, cover: 0.03, layout: 'two-faces' } });
    const wB = add(ctx, { name: 'support-B', material: 'concrete', finish: 'smooth-concrete', shape: { type: 'box', size: [0.2, 2.4, 2.4] }, position: [9.4, 1.2, -4], rebar: { diameter: 0.012, spacing: 0.2, cover: 0.03, layout: 'two-faces' } });
    const slab = add(ctx, {
      name: 'slab', material: 'concrete', finish: 'smooth-concrete', shape: { type: 'box', size: [4.2, 0.2, 2.6] }, position: [7.5, 2.5, -4],
      voxelSize: 0.035, rebar: { diameter: 0.012, spacing: 0.2, cover: 0.03, layout: 'two-faces' },
    }, false);
    ctx.structure.link(wA, slab, new THREE.Box3(new THREE.Vector3(5.5, 2.35, -5.2), new THREE.Vector3(5.7, 2.45, -2.8)));
    ctx.structure.link(wB, slab, new THREE.Box3(new THREE.Vector3(9.3, 2.35, -5.2), new THREE.Vector3(9.5, 2.45, -2.8)));
    // Materials board: one block per finish.
    const finishes = ['board-formed-concrete', 'smooth-concrete', 'exposed-aggregate', 'marble', 'travertine', 'granite', 'onyx', 'brick'] as const;
    const mats = { 'board-formed-concrete': 'concrete', 'smooth-concrete': 'concrete', 'exposed-aggregate': 'concrete', marble: 'marble', travertine: 'travertine', granite: 'granite', onyx: 'onyx', brick: 'brick' } as const;
    finishes.forEach((f, i) => {
      add(ctx, { name: `board-${f}`, material: mats[f], finish: f, shape: { type: 'box', size: [0.6, 0.6, 0.6] }, position: [-3.85 + i * 1.1, 0.3, 6.5], rotation: [0, 0.25, 0] });
    });
    ctx.world.userData.disposeSky = sky.dispose;
  },
});

const { sim, controls } = kit;
const ctx = sim.ctx;
const v3 = (a: [number, number, number]) => new THREE.Vector3(a[0], a[1], a[2]);

function voxelElements(): VoxelElement[] {
  return ctx.registry.all().filter((d): d is VoxelElement => d instanceof VoxelElement && !d.disposed);
}

/** One round resolved by the ballistics module's terminal model (what its ProjectileSystem does). */
function fireM1(ammo: AmmoSpec, from: THREE.Vector3, at: THREE.Vector3): ImpactEvent | null {
  const dir = at.clone().sub(from).normalize();
  const hit = ctx.registry.raycast(from, dir, 1000);
  if (!hit) return null;
  const probe = hit.target.probe(hit, dir, 3);
  // Muzzle velocity less ~3 % for 25 m of flight.
  const v = ammo.muzzleVelocity * 0.97;
  const state: ProjectileState = { ammo, position: hit.point.clone(), velocity: dir.clone().multiplyScalar(v), mass: ammo.mass, length: ammo.length, perforations: 0 };
  let e: ImpactEvent;
  try {
    e = m1Resolve!(state, hit, probe, ctx.rng);
  } catch {
    e = resolveBulletStub(ammo, hit, dir, probe, ctx.time.now);
  }
  e.time = ctx.time.now;
  hit.target.applyImpact(e);
  ctx.events.emit('impact', e);
  return e;
}

function makeLoad(req: BlastRequest): BlastLoad {
  if (m1Load) {
    try {
      return m1Load(req, ctx.time.now);
    } catch {
      /* fall back */
    }
  }
  return makeBlastLoadStub(req.center, req.tntKg, { normal: req.normal, contactTargetId: req.contactTargetId, time: ctx.time.now });
}

/**
 * Detonate through the ballistics module's BlastSystem when it is installed (shock arrival times,
 * rigid-body pushes, fragments), advancing one fixed step so the near field lands; otherwise hand
 * the stand-in load to every destructible in `range` and push loose pieces here. Returns wall ms.
 */
function detonate(req: BlastRequest, range: number): number {
  const t0 = performance.now();
  if (m1Systems) {
    ctx.blasts.detonate(req);
    sim.advance(1 / 60);
    return performance.now() - t0;
  }
  const load = makeLoad(req);
  for (const d of ctx.registry.querySphere(req.center, range)) d.applyBlast(load);
  const phys = ctx.physics;
  for (const b of phys.bodiesInSphere(req.center, range)) {
    const t = b.translation();
    const p = new THREE.Vector3(t.x, t.y, t.z);
    const away = p.clone().sub(req.center);
    const r = Math.max(0.05, away.length());
    away.divideScalar(r);
    // Reflected impulse over the presented area of an equivalent sphere (as the BlastSystem does).
    const rEq = Math.cbrt((3 * (b.mass() / 2400)) / (4 * Math.PI));
    const J = Math.min(load.reflectedImpulseAt(p, away.clone().negate()) * Math.PI * rEq * rEq, 60 * b.mass());
    phys.applyImpulseAt(b, away.multiplyScalar(J), p);
  }
  return performance.now() - t0;
}

/** Scripting helpers for scripts/shot.ts scenarios. */
const demo = {
  elements,
  sim,
  ballistics: m1Resolve ? 'm1' : 'stub',
  /** Camera pose that survives the orbit controls. */
  view(position: [number, number, number], lookAt: [number, number, number], fov?: number) {
    ctx.camera.position.set(...position);
    controls.target.set(...lookAt);
    if (fov) {
      ctx.camera.fov = fov;
      ctx.camera.updateProjectionMatrix();
    }
    controls.update();
    ctx.camera.lookAt(...lookAt);
  },
  /** Fire `count` stand-in rounds at `at` (normal jitter σ in the target plane), advancing time. */
  /**
   * Fire `count` rounds of `ammo` at `at` (normal jitter σ in the target plane), advancing time.
   * Uses the ballistics module's terminal model when present (resolver 'm1'), else the stand-in.
   */
  burst(o: { at: [number, number, number]; from: [number, number, number]; count: number; sigma?: number; ammo?: string; interval?: number; resolver?: 'm1' | 'stub' }) {
    const useM1 = (o.resolver ?? 'm1') === 'm1' && !!m1Resolve;
    const id = o.ammo ?? 'm855';
    let ammo: AmmoSpec = STUB_AMMO[id as 'm855'] ?? STUB_AMMO.m855;
    if (useM1) {
      try {
        ammo = ctx.ammo(id);
      } catch {
        /* keep the stand-in spec */
      }
    }
    const from = v3(o.from), at = v3(o.at);
    const dir = at.clone().sub(from).normalize();
    const u = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const w = new THREE.Vector3().crossVectors(u, dir);
    const sigma = o.sigma ?? 0.025;
    let carve = 0, n = 0;
    const t0 = performance.now();
    for (let i = 0; i < o.count; i++) {
      const p = at.clone().addScaledVector(u, ctx.rng.gaussian(0, sigma)).addScaledVector(w, ctx.rng.gaussian(0, sigma));
      const e = useM1 ? fireM1(ammo, from, p) : fireStub(ctx, ammo, from, p);
      if (e) {
        const el = ctx.registry.all().find((d) => d.name === e.targetName) as VoxelElement | undefined;
        if (el) { carve += el.stats.lastCarveMs; n++; }
      }
      sim.advance(o.interval ?? 0.075);
    }
    return { hits: n, carveMsPerHit: n ? carve / n : 0, wallMs: performance.now() - t0 };
  },
  /** Contact charge on the surface point hit by a ray from `from` towards `at`. */
  contact(o: { at: [number, number, number]; from: [number, number, number]; tntKg: number }) {
    const from = v3(o.from);
    const dir = v3(o.at).sub(from).normalize();
    const hit = ctx.registry.raycast(from, dir, 100);
    if (!hit) return null;
    const center = hit.point.clone().addScaledVector(hit.normal, 0.05);
    const req: BlastRequest = { center, tntKg: o.tntKg, kind: 'contact', normal: hit.normal.clone(), contactTargetId: hit.target.id };
    return { target: hit.target.name, ms: detonate(req, 6) };
  },
  /** Free-field detonation. */
  blast(o: { at: [number, number, number]; tntKg: number }) {
    return { ms: detonate({ center: v3(o.at), tntKg: o.tntKg, kind: 'he' }, 12) };
  },
  /** Remesh everything pending right now (before screenshots). */
  flush() {
    const t0 = performance.now();
    schedulerFor(ctx).run(Infinity);
    for (const el of voxelElements()) el.flushMeshes();
    return performance.now() - t0;
  },
  /** Debug: show Surface Nets geometry (normals + wireframe) instead of the material. */
  debug(on: boolean) {
    const nm = new THREE.MeshNormalMaterial({ wireframe: false });
    const wm = new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.25 });
    ctx.world.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.name.includes(':chunk')) return;
      if (on) {
        o.userData.mat ??= o.material;
        o.material = nm;
        if (!o.userData.wire) {
          const w = new THREE.Mesh(o.geometry, wm);
          w.name = 'debug-wire';
          o.add(w);
          o.userData.wire = w;
        }
      } else if (o.userData.mat) {
        o.material = o.userData.mat;
        o.userData.wire?.removeFromParent();
        delete o.userData.wire;
      }
    });
  },
  crater(name: string, at: [number, number, number], normal: [number, number, number], radius = 0.3) {
    const el = ctx.registry.all().find((d) => d.name === name);
    return el ? measureCrater(el, v3(at), v3(normal), radius, 0.01) : null;
  },
  stats() {
    const els = voxelElements();
    const s = schedulerFor(ctx);
    return {
      elements: els.length,
      pieces: els.filter((e) => e.dynamic).length,
      triangles: els.reduce((a, e) => a + e.stats.triangles, 0),
      meshedChunks: els.reduce((a, e) => a + e.stats.meshedChunks, 0),
      remeshPending: s.pending,
      remeshLastFrameMs: s.lastFrameMs,
      remeshTotalMs: s.totalMs,
      remeshTotalChunks: s.totalChunks,
      dynamicBodies: ctx.physics.dynamicCount,
      renderTriangles: ctx.renderer.info.render.triangles,
      drawCalls: ctx.renderer.info.render.calls,
      checkMs: Math.max(...els.map((e) => e.stats.lastCheckMs)),
      releaseMs: Math.max(...els.map((e) => e.stats.lastReleaseMs)),
    };
  },
  /** Time building a fresh 6 × 3 × 0.3 m RC wall (textures already cached) and a connectivity check. */
  perfWall() {
    const t0 = performance.now();
    const el = createVoxelElement(ctx, {
      name: 'perf-wall', material: 'concrete', finish: 'board-formed-concrete', shape: { type: 'box', size: [6, 3, 0.3] },
      position: [0, 1.5, 12], rebar: { diameter: 0.016, spacing: 0.2, cover: 0.04, layout: 'two-faces' },
    }) as VoxelElement;
    const build = performance.now() - t0;
    ctx.structure.link('ground', el, new THREE.Box3(new THREE.Vector3(-3, -0.05, 11.8), new THREE.Vector3(3, 0.05, 12.2)));
    const e = fireStub(ctx, STUB_AMMO.m855, new THREE.Vector3(0, 1.5, 20), new THREE.Vector3(0, 1.5, 12));
    const carve = el.stats.lastCarveMs;
    sim.advance(0.2);
    const check = el.stats.lastCheckMs;
    const t1 = performance.now();
    this.flush();
    const mesh = performance.now() - t1;
    const out = { buildMs: build, carveMs: carve, checkMs: check, flushMs: mesh, hit: !!e, triangles: el.stats.triangles };
    el.dispose();
    ctx.registry.sweep();
    return out;
  },
};
(window as unknown as { __voxelDemo: typeof demo }).__voxelDemo = demo;
