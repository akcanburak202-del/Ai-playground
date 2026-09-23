import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Simulation } from '../app/Simulation.ts';
import { installHarness, type Harness } from '../app/harness.ts';
import type { ElementFactories, RenderPipelineApi, SceneDef, SimContext } from '../app/contracts.ts';

/**
 * Shared scaffolding for module sandboxes (sandbox/*.html): full-window canvas, a Simulation with
 * the basic pipeline, orbit camera, and `window.__sim` + `window.__ready` for scripted screenshots.
 *
 *   const kit = await createSandbox({ build(ctx) { ... add destructibles ... } });
 *
 * Add `?manual` to the URL to start without real-time stepping (what scripts/shot.ts does).
 */
export interface SandboxOptions {
  title?: string;
  build: (ctx: SimContext, make: ElementFactories) => void | Promise<void>;
  factories?: Partial<ElementFactories>;
  camera?: { position: [number, number, number]; lookAt: [number, number, number] };
  pipeline?: RenderPipelineApi;
  /** Hook to install real subsystems (projectiles, blasts, fx …) before the scene builds */
  install?: (sim: Simulation) => void | Promise<void>;
}

export interface Sandbox {
  sim: Simulation;
  harness: Harness;
  controls: OrbitControls;
}

export async function createSandbox(o: SandboxOptions): Promise<Sandbox> {
  document.title = o.title ?? 'sandbox';
  document.body.style.margin = '0';
  document.body.style.background = '#111';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100vw;height:100vh';
  document.body.appendChild(canvas);

  const sim = await Simulation.create({ canvas, pipeline: o.pipeline, pixelRatio: 1 });
  const missing = (what: string) => () => {
    throw new Error(`${what} factory not provided to this sandbox`);
  };
  sim.factories = {
    voxel: o.factories?.voxel ?? missing('voxel'),
    plate: o.factories?.plate ?? missing('plate'),
    beam: o.factories?.beam ?? missing('beam'),
    glass: o.factories?.glass ?? missing('glass'),
  };
  await o.install?.(sim);
  const harness = installHarness(sim);
  const cam = o.camera ?? { position: [6, 3, 8], lookAt: [0, 1, 0] };
  const scene: SceneDef = {
    id: 'sandbox', name: o.title ?? 'sandbox', nameTr: o.title ?? 'sandbox', blurb: '', blurbTr: '',
    spawn: { position: cam.position, lookAt: cam.lookAt },
    build: o.build,
  };
  await sim.loadScene(scene);

  const controls = new OrbitControls(sim.ctx.camera, canvas);
  controls.target.set(...cam.lookAt);
  controls.update();
  sim.onFrame(() => controls.update());

  const resize = () => sim.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', resize);
  resize();

  sim.manual = new URLSearchParams(location.search).has('manual');
  sim.start();
  (window as unknown as { __ready: boolean }).__ready = true;
  return { sim, harness, controls };
}

export { THREE };
