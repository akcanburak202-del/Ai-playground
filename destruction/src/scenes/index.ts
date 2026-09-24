import type { SceneDef } from '../app/contracts.ts';
import { range } from './range.ts';
import { chapel } from './chapel.ts';
import { pavilion } from './pavilion.ts';
import { tower } from './tower.ts';
import { temple } from './temple.ts';

export { Site, PROFILES, REBAR, region, orientedBox, type V3, type BoxOpts } from './kit.ts';
export { Decor } from './decor.ts';

/** Every scene, in menu order. */
export const SCENES: SceneDef[] = [range, chapel, pavilion, tower, temple];

export function sceneById(id: string): SceneDef | undefined {
  return SCENES.find((s) => s.id === id);
}
