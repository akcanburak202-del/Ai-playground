import * as THREE from 'three';
import { createSandbox } from './sandboxKit.ts';
import type { Simulation } from '../app/Simulation.ts';
import type { SceneDef, System, WeaponControllerApi } from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import type { BlastKind } from '../physics/ballistics/types.ts';
import { createElementFactories } from '../app/elements.ts';
import { Pipeline } from '../render/Pipeline.ts';
import { installFx } from '../fx/index.ts';
import { installBallistics } from '../systems/index.ts';
import { createWeaponController } from '../weapons/index.ts';
import { installAudio } from '../audio/index.ts';
import { installPlayer } from '../player/index.ts';
import { installHud } from '../ui/index.ts';
import { installStructure, type StructureGraph } from '../structure/index.ts';
import { SCENES, SCENE_LOOKS, sceneById, Site } from '../scenes/index.ts';
import { applyLookAfterLoad, applyLookBeforeLoad } from '../scenes/look.ts';

/**
 * The architecture scenes with everything wired — effectively the app: production pipeline,
 * effects, ballistics and the weapon controller, audio, the player, the HUD with its scene menu,
 * and the structure graph. `?scene=<id>` loads a scene directly (menu closed); `?hud=0` hides the
 * HUD for clean stills; `?q=0|1|2` sets the pipeline quality.
 *
 * `window.__scenes` scripts screenshots and measurements (see scripts/shot.ts): load(), view(),
 * charge()/detonate(), fire (via __sim.fire), flush(), stats(), perf().
 */

const params = new URLSearchParams(location.search);
const initial = params.get('scene');
const quality = Number(params.get('q') ?? 1) as 0 | 1 | 2;

let weapons: WeaponControllerApi | null = null;
let graph: StructureGraph | null = null;

// ─── Frame-time instrumentation ─────────────────────────────────────────────────────────────

/** Rolling samples of the simulation's per-step and per-frame CPU cost, ms. */
const perf = { step: [] as number[], frame: [] as number[], render: [] as number[], structure: [] as number[] };
/** Accumulated per-frame CPU time by destructible kind / system since the last reset, ms */
const byKind: Record<string, number> = {};
const keep = (a: number[], v: number) => {
  a.push(v);
  if (a.length > 4000) a.splice(0, a.length - 4000);
};
function instrument(sim: Simulation): void {
  const step = sim.fixedStep.bind(sim);
  sim.fixedStep = (dt: number) => {
    const t0 = performance.now();
    step(dt);
    keep(perf.step, performance.now() - t0);
    if (graph) keep(perf.structure, graph.stats.lastUpdateMs);
  };
  // Per-frame work, timed by destructible kind and by system (same order as Simulation.frameStep).
  const systems = (sim as unknown as { systems: System[] }).systems;
  const listeners = (sim as unknown as { frameListeners: Set<(realDt: number) => void> }).frameListeners;
  sim.frameStep = (simDt: number, realDt: number) => {
    const t0 = performance.now();
    for (const d of sim.ctx.registry.all()) {
      if (d.disposed || !d.frameUpdate) continue;
      const a = performance.now();
      d.frameUpdate(simDt);
      byKind[d.kind] = (byKind[d.kind] ?? 0) + performance.now() - a;
    }
    for (const sys of systems) {
      if (!sys.frameUpdate) continue;
      const a = performance.now();
      sys.frameUpdate(simDt, realDt);
      byKind[`sys:${sys.name}`] = (byKind[`sys:${sys.name}`] ?? 0) + performance.now() - a;
    }
    for (const fn of listeners) fn(realDt);
    keep(perf.frame, performance.now() - t0);
  };
  const render = sim.render.bind(sim);
  sim.render = (dt?: number) => {
    const t0 = performance.now();
    render(dt);
    keep(perf.render, performance.now() - t0);
  };
}
function summary(a: number[]): { n: number; mean: number; p95: number; max: number } {
  if (!a.length) return { n: 0, mean: 0, p95: 0, max: 0 };
  const s = [...a].sort((x, y) => x - y);
  const r = (x: number) => Math.round(x * 100) / 100;
  return { n: a.length, mean: r(a.reduce((x, y) => x + y, 0) / a.length), p95: r(s[Math.floor(0.95 * (s.length - 1))]!), max: r(s[s.length - 1]!) };
}

// ─── Charges placed by script (the player places them through the weapon controller) ─────────

interface ScriptCharge {
  at: THREE.Vector3;
  normal: THREE.Vector3;
  kg: number;
  target: Destructible | null;
  fireAt: number;
}
const charges: ScriptCharge[] = [];
const armed: ScriptCharge[] = [];
const chargeSystem: System = {
  name: 'script-charges',
  fixedUpdate() {
    const now = kit.sim.ctx.time.now;
    for (let i = armed.length - 1; i >= 0; i--) {
      const c = armed[i]!;
      if (c.fireAt > now) continue;
      armed.splice(i, 1);
      kit.sim.ctx.blasts.detonate({
        center: c.at, tntKg: c.kg, kind: 'contact', normal: c.normal, contactTargetId: c.target?.id, source: kit.sim.ctx.ammo('c4'), label: 'C4', time: now,
      });
    }
  },
  reset() {
    charges.length = 0;
    armed.length = 0;
  },
};

// ─── Page ───────────────────────────────────────────────────────────────────────────────────

const timing = { scene: '', buildMs: 0, loadMs: 0, firstFrameMs: 0, parts: {} as Record<string, number> };

const pipeline = new Pipeline({ quality });
const kit = await createSandbox({
  title: 'Destruction — scenes',
  pipeline,
  camera: { position: [0, 1.7, 12], lookAt: [0, 1.5, 0] },
  install(sim) {
    sim.factories = createElementFactories(sim.ctx);
    graph = installStructure(sim);
    installBallistics(sim);
    weapons = createWeaponController(sim);
    installFx(sim);
    installAudio(sim);
    sim.addSystem(chargeSystem);
    instrument(sim);
  },
  build() {},
});

const sim = kit.sim;
const ctx = sim.ctx;
ctx.renderer.domElement.addEventListener('webglcontextlost', () => console.error('WebGL context lost'));
// The player owns the camera.
kit.controls.enabled = false;
kit.controls.update = () => false;
kit.controls.dispose();
installPlayer(sim, weapons!, { canvas: ctx.renderer.domElement, touch: params.has('touch') });

async function load(id: string): Promise<typeof timing> {
  const def = sceneById(id);
  if (!def) throw new Error(`unknown scene ${id}`);
  let buildMs = 0;
  const timed: SceneDef = {
    ...def,
    async build(c, make) {
      const t = performance.now();
      await def.build(c, make);
      buildMs = performance.now() - t;
    },
  };
  const t0 = performance.now();
  applyLookBeforeLoad(pipeline, SCENE_LOOKS[id]);
  await sim.loadScene(timed);
  applyLookAfterLoad(ctx, SCENE_LOOKS[id]);
  timing.scene = id;
  timing.loadMs = Math.round(performance.now() - t0);
  timing.buildMs = Math.round(buildMs);
  timing.parts = Object.fromEntries(Object.entries(Site.last?.timings ?? {}).map(([k, v]) => [k, Math.round(v)]));
  const t1 = performance.now();
  sim.render(1 / 60);
  const gl = ctx.renderer.getContext();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  timing.firstFrameMs = Math.round(performance.now() - t1);
  for (const k of Object.keys(perf) as (keyof typeof perf)[]) perf[k].length = 0;
  return { ...timing };
}

const hudHandle = installHud(sim, weapons!, {
  scenes: SCENES,
  onSelectScene: (id) => load(id).then(() => undefined),
  startWithMenu: !initial && params.get('menu') !== '0',
});
/** Clean stills: the whole overlay (reticle included) goes. */
function showHud(on: boolean): void {
  hudHandle.hud.setVisible(on);
  hudHandle.hud.root.style.display = on ? '' : 'none';
}
if (params.get('hud') === '0') showHud(false);

const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

function find(name: string): Destructible | null {
  const all = ctx.registry.all();
  return all.find((d) => d.name === name) ?? all.find((d) => d.name.startsWith(name)) ?? null;
}

type Flushable = { flushMeshes?: () => void };

const api = {
  sim, timing, samples: perf,
  load,
  scenes: () => SCENES.map((s) => s.id),
  /** Camera pose the player adopts. */
  view(position: number[], target: number[], fov?: number) {
    ctx.camera.position.copy(v3(position));
    ctx.camera.lookAt(v3(target));
    if (fov) {
      ctx.camera.fov = fov;
      ctx.camera.updateProjectionMatrix();
    }
    ctx.camera.updateMatrixWorld();
  },
  find,
  list() {
    return ctx.registry.all().map((d) => {
      const c = d.bounds.getCenter(new THREE.Vector3());
      return { name: d.name, kind: d.kind, c: [c.x, c.y, c.z].map((x) => Math.round(x * 100) / 100), failed: d.structural?.hasFailed() ?? null };
    });
  },
  /**
   * Stick a contact charge (C4, TNT-equivalent kg) where the ray from `from` towards `to` meets
   * the first element. Fired by detonate().
   */
  charge(from: number[], to: number[], kg = 2.3) {
    const o = v3(from), dir = v3(to).sub(o).normalize();
    const hit = ctx.registry.raycast(o, dir, 200);
    if (!hit) return null;
    const c: ScriptCharge = { at: hit.point.clone().addScaledVector(hit.normal, 0.03), normal: hit.normal.clone(), kg, target: hit.target, fireAt: Infinity };
    charges.push(c);
    return { target: hit.target.name, at: [c.at.x, c.at.y, c.at.z] };
  },
  /** Fire every placed charge, `sequence` s apart (in placement order). */
  detonate(sequence = 0) {
    const now = ctx.time.now;
    charges.forEach((c, i) => {
      c.fireAt = now + i * sequence;
      armed.push(c);
    });
    charges.length = 0;
  },
  blast(at: number[], kg: number, kind: BlastKind = 'he') {
    ctx.blasts.detonate({ center: v3(at), tntKg: kg, kind });
  },
  /** Remesh every damaged voxel chunk now (stills right after damage). */
  flush() {
    for (const d of ctx.registry.all()) (d as Flushable).flushMeshes?.();
  },
  hud(on: boolean) {
    showHud(on);
  },
  stats() {
    const info = ctx.renderer.info;
    const kinds: Record<string, number> = {};
    for (const d of ctx.registry.all()) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
    return {
      destructibles: ctx.registry.size, kinds, dynamicBodies: ctx.physics.dynamicCount, drawCalls: info.render.calls, triangles: info.render.triangles,
      geometries: info.memory.geometries, textures: info.memory.textures, simTime: +ctx.time.now.toFixed(3),
      structure: graph ? { ...graph.stats } : null, contextLost: ctx.renderer.getContext().isContextLost(),
    };
  },
  perf() {
    const kinds = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, Math.round(v)]));
    return { step: summary(perf.step), frame: summary(perf.frame), render: summary(perf.render), structure: summary(perf.structure), frameByKindMs: kinds };
  },
  resetPerf() {
    for (const k of Object.keys(perf) as (keyof typeof perf)[]) perf[k].length = 0;
    for (const k of Object.keys(byKind)) delete byKind[k];
  },
  /** Whole rendered frames with a 1-px read-back (GPU finished), ms each. */
  frameCost(frames = 5) {
    const gl = ctx.renderer.getContext();
    const px = new Uint8Array(4);
    const out: number[] = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      sim.render(1 / 60);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.push(performance.now() - t0);
    }
    const info = ctx.renderer.info.render;
    return { frameMs: summary(out), drawCalls: info.calls, triangles: info.triangles };
  },
  /** Advance in small steps (slow motion) and report anything non-finite in the scene. */
  slowRun(seconds: number, dt = 0.001) {
    let t = 0;
    while (t < seconds - 1e-9) {
      const h = Math.min(dt, seconds - t);
      sim.fixedStep(h);
      t += h;
      if (Math.round(t / dt) % 16 === 0) sim.frameStep(16 * dt, 1 / 60);
    }
    const bad: string[] = [];
    for (const d of ctx.registry.all()) {
      const b = d.bounds;
      if (!b.isEmpty() && ![b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite)) bad.push(d.name);
    }
    return { simTime: ctx.time.now, bad };
  },
};
(window as unknown as { __scenes: typeof api }).__scenes = api;

if (initial) await load(initial);
(window as unknown as { __scenesReady: boolean }).__scenesReady = true;
