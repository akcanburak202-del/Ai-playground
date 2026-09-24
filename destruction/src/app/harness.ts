import * as THREE from 'three';
import type { Simulation } from './Simulation.ts';
import type { AmmoSpec, BlastKind } from '../physics/ballistics/types.ts';
import { stepFlight } from '../physics/ballistics/flight.ts';

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
   * Unguided rounds are zeroed (superelevated) so they arrive at `at` despite drop; pass
   * `zero: false` to fire straight down the line of sight.
   */
  fire(o: { ammo: string; from: [number, number, number]; at: [number, number, number]; count?: number; interval?: number; spreadMOA?: number; settle?: number; zero?: boolean }): void;
  /**
   * Detonate a charge. `target` (a destructible's name, name prefix or id) makes it a true contact
   * charge on that element (contactTargetId), as a placed demolition charge would be.
   */
  detonate(o: { at: [number, number, number]; tntKg: number; kind?: BlastKind; normal?: [number, number, number]; target?: string | number }): void;
  /**
   * Summary of the last impacts for assertions. `agent` tells rounds from fragments and HEAT jets;
   * `prior` counts targets the round had already perforated (0 = primary hit).
   */
  impacts(n?: number): { ammo: string; agent: string; projectileId: number | null; prior: number; target: string; material: string; outcome: string; depth: number; speed: number; residual: number; summary: string }[];
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
    fire({ ammo, from, at, count = 1, interval = 0.075, spreadMOA = 0, settle = 0.5, zero = true }) {
      const spec = sim.ctx.ammo(ammo);
      const origin = v(from);
      const aim = zero ? zeroedDirection(spec, origin, v(at)) : v(at).sub(origin).normalize();
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
    detonate({ at, tntKg, kind = 'he', normal, target }) {
      let contactTargetId: number | undefined;
      if (target !== undefined) {
        const all = sim.ctx.registry.all();
        const hit = typeof target === 'number'
          ? all.find((d) => d.id === target)
          : all.find((d) => d.name === target) ?? all.find((d) => d.name.startsWith(target));
        contactTargetId = hit?.id;
      }
      sim.ctx.blasts.detonate({
        center: v(at), tntKg, kind: target !== undefined && kind === 'he' ? 'contact' : kind,
        normal: normal ? v(normal).normalize() : undefined, contactTargetId,
      });
    },
    impacts(n = 20) {
      return sim.impactLog.slice(-n).map((e) => ({
        ammo: e.ammo.id, agent: e.agent, projectileId: e.projectileId ?? null, prior: e.priorPerforations ?? 0,
        target: e.targetName ?? e.targetKind, material: e.material.id, outcome: e.outcome,
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

/**
 * Launch direction that makes an unguided round pass through `at` (bisection on the elevation
 * over a fine-step trajectory). Guided/lofted rounds and very short ranges aim straight.
 */
export function zeroedDirection(spec: AmmoSpec, from: THREE.Vector3, at: THREE.Vector3): THREE.Vector3 {
  const flat = at.clone().sub(from);
  const range = Math.hypot(flat.x, flat.z);
  const straight = flat.clone().normalize();
  if (spec.guidance || range < 1) return straight;
  const horiz = new THREE.Vector3(flat.x, 0, flat.z).normalize();
  const dirFor = (elev: number) => {
    const pitch = Math.atan2(flat.y, range) + elev;
    return horiz.clone().multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch));
  };
  const heightAt = (elev: number): number => {
    const b = { position: from.clone(), velocity: dirFor(elev).multiplyScalar(spec.muzzleVelocity), mass: spec.mass, age: 0, burning: false };
    const prev = new THREE.Vector3();
    for (let i = 0; i < 20000; i++) {
      prev.copy(b.position);
      stepFlight(b, spec, 1 / 240);
      const r0 = Math.hypot(prev.x - from.x, prev.z - from.z);
      const r1 = Math.hypot(b.position.x - from.x, b.position.z - from.z);
      if (r1 >= range) return prev.y + ((b.position.y - prev.y) * (range - r0)) / Math.max(r1 - r0, 1e-9);
      if (b.velocity.lengthSq() < 1) break;
    }
    return -1e9;
  };
  let lo = -0.05;
  let hi = 0.35;
  for (let i = 0; i < 32; i++) {
    const mid = 0.5 * (lo + hi);
    if (heightAt(mid) < at.y) lo = mid;
    else hi = mid;
  }
  return dirFor(0.5 * (lo + hi));
}
