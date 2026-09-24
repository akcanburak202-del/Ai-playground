import type { Simulation } from '../app/Simulation.ts';
import type { AudioApi } from '../app/contracts.ts';
import { AudioSystem } from './AudioSystem.ts';

export { AudioSystem } from './AudioSystem.ts';
export { renderOfflineTest, type OfflineReport, type ClipReport } from './offline.ts';

/**
 * Install procedural audio: sets `sim.ctx.audio` and registers the per-frame system. Nothing is
 * heard until `unlock()` is called from a user gesture (browsers keep audio suspended until then).
 */
export function installAudio(sim: Simulation): AudioApi {
  const audio = new AudioSystem(sim);
  sim.ctx.audio = audio;
  sim.addSystem(audio);
  return audio;
}
