import type { SceneDef } from '../app/contracts.ts';
import type { SceneLook } from './look.ts';
import { range, rangeLook } from './range.ts';
import { chapel, chapelLook } from './chapel.ts';
import { pavilion, pavilionLook } from './pavilion.ts';
import { tower, towerLook } from './tower.ts';
import { temple, templeLook } from './temple.ts';

export { Site, PROFILES, REBAR, region, orientedBox, type V3, type BoxOpts } from './kit.ts';
export { Decor } from './decor.ts';

/** Every scene, in menu order. */
export const SCENES: SceneDef[] = [range, chapel, pavilion, tower, temple];

/** Photographic settings per scene id (apply with applyLookBeforeLoad / applyLookAfterLoad). */
export const SCENE_LOOKS: Record<string, SceneLook> = {
  range: rangeLook, chapel: chapelLook, pavilion: pavilionLook, tower: towerLook, temple: templeLook,
};
export { applyLookBeforeLoad, applyLookAfterLoad, type SceneLook } from './look.ts';

export function sceneById(id: string): SceneDef | undefined {
  return SCENES.find((s) => s.id === id);
}
