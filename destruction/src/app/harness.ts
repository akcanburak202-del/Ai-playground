import * as THREE from 'three';
import type { Simulation } from './Simulation.ts';
import type { BlastKind } from '../physics/ballistics/types.ts';

/**
 * Scripting surface exposed as `window.__sim` for automated tests and screenshots
 * (see scripts/shot.ts). Everything here is deterministic when `manual` is on.
 */
export interface Harness {
  sim: Simulation;
  THREE: typeof THREE;
  /** Stop real-time stepping; the page only advances through `advance()` */
  setManual(on: boolean): void;
  advance(seconds: number): void;
  render(): void;
  setCamera(position: [number, number, number], lookAt: [number, number, number], fov?: number): void;
  /**
   * Fire `count` rounds of `ammoId` from `from` towards `at`, one every `interval` seconds of sim
   * time (the harness advances time between shots). Spread is a normal angular jitter in MOA.
   */
  fire(o: { ammo: string; from: [number, number, number]; at: [number, number, number]; count?: number; interval?: number; spreadMOA?: number; settle?: number }): void;
  detonate(o: { at: [number, number, number]; tntKg: number; kind?: BlastKind; normal?: [number, number, number] }): void;
  /** Summary of the last impacts (outcome, depth, target) for assertions */
  impacts(n?: number): { ammo: string; target: string; material: string; outcome: string; depth: number; speed: number; residual: number; summary: string }[];
  stats(): Record<string, number>;
}

export function installHarness(sim: Simulation): Harness {
  const v = (a: [number, number, number]) => new THREE.Vector3(a[0], a[1], a[2]);
  const h: Harness = {
    sim,
    THREE,
    setManual(on) {
      sim.manual = on;
    },
    advance(seconds) {
      sim.advance(seconds);
    },
    render() {
      sim.render(1 / 60);
    },
    setCamera(position, lookAt, fov) {
      const c = sim.ctx.camera;
      c.position.copy(v(position));
      c.lookAt(v(lookAt));
      if (fov) {
        c.fov = fov;
        c.updateProjectionMatrix();
      }
    },
    fire({ ammo, from, at, count = 1, interval = 0.075, spreadMOA = 0, settle = 0.5 }) {
      const spec = sim.ctx.ammo(ammo);
      const origin = v(from);
      const aim = v(at).sub(origin).normalize();
      const rng = sim.ctx.rng;
      const sigma = (spreadMOA / 60) * (Math.PI / 180);
      for (let i = 0; i < count; i++) {
        const dir = aim.clone();
        if (sigma > 0) {
          const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
          const right = new THREE.Vector3().crossVectors(dir, up).normalize();
          const up2 = new THREE.Vector3().crossVectors(right, dir);
          dir.addScaledVector(right, rng.gaussian(0, sigma)).addScaledVector(up2, rng.gaussian(0, sigma)).normalize();
        }
        sim.ctx.projectiles.spawn({ ammo: spec, origin: origin.clone(), velocity: dir.multiplyScalar(spec.muzzleVelocity), tracer: !!spec.tracer, target: v(at) });
        sim.advance(interval);
      }
      if (settle > 0) sim.advance(settle);
    },
    detonate({ at, tntKg, kind = 'he', normal }) {
      sim.ctx.blasts.detonate({ center: v(at), tntKg, kind, normal: normal ? v(normal).normalize() : undefined });
    },
    impacts(n = 20) {
      return sim.impactLog.slice(-n).map((e) => ({
        ammo: e.ammo.id, target: e.targetName ?? e.targetKind, material: e.material.id, outcome: e.outcome,
        depth: e.depth, speed: e.speed, residual: e.residualSpeed, summary: e.summary,
      }));
    },
    stats() {
      const info = sim.ctx.renderer.info;
      return {
        destructibles: sim.ctx.registry.size,
        dynamicBodies: sim.ctx.physics.dynamicCount,
        projectiles: sim.ctx.projectiles.active.length,
        triangles: info.render.triangles,
        drawCalls: info.render.calls,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        simTime: sim.ctx.time.now,
      };
    },
  };
  (window as unknown as { __sim: Harness }).__sim = h;
  return h;
}
