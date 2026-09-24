import type { Simulation } from '../app/Simulation.ts';
import type { BlastSystemApi, ProjectileSystemApi } from '../app/contracts.ts';
import { ProjectileSystem } from './ProjectileSystem.ts';
import { BlastSystem } from './BlastSystem.ts';

export { ProjectileSystem } from './ProjectileSystem.ts';
export { BlastSystem, type ExtendedBlastRequest } from './BlastSystem.ts';

/**
 * Wire the ballistics subsystems into a simulation: sets `ctx.projectiles` and `ctx.blasts` and
 * registers both as fixed-step systems (projectiles before blasts, so a detonation's contact
 * target is loaded in the same step).
 */
export function installBallistics(sim: Simulation): { projectiles: ProjectileSystemApi; blasts: BlastSystemApi } {
  const projectiles = new ProjectileSystem(sim);
  const blasts = new BlastSystem(sim);
  sim.ctx.projectiles = projectiles;
  sim.ctx.blasts = blasts;
  sim.addSystem(projectiles);
  sim.addSystem(blasts);
  return { projectiles, blasts };
}
