import type { SimContext } from '../app/contracts.ts';
import type { SkyParams } from '../render/skyModel.ts';
import { getAtmosphere } from '../render/atmosphere.ts';
import { ReflectionProbes } from '../destructibles/glass/index.ts';

/**
 * Photographic settings of a scene beyond its sun position (SceneDef only carries `sun`): the
 * state of the sky, exposure, the lens, the air, and whether glass uses local reflection probes.
 * The app applies a scene's look before `loadScene` (the pipeline derives its lighting from the
 * sky constants during setup) and again after it (fov, haze).
 */
export interface SceneLook {
  /** Preetham sky constants: turbidity (haze), Rayleigh (blueness), Mie (glow around the sun) */
  sky?: Partial<SkyParams>;
  /** Exposure multiplier on top of the pipeline's automatic one */
  exposure?: number;
  /**
   * Scale of the sky's image-based light (scene.environmentIntensity). The pipeline already
   * balances its lighting copy of the sky to the clear low-sun direct : diffuse ratio on a sunlit
   * wall (≈ 3 : 1, Perez et al. 1990; render/skyModel.deriveLighting), so 1 is physical; a scene
   * lowers it only for the sky occlusion the environment map cannot see (a deep courtyard, a
   * forest edge), never to restore contrast.
   */
  ambient?: number;
  /** Vertical field of view at the spawn, degrees (the player adopts it as its base) */
  fov?: number;
  /** Meteorological visibility, m: extinction 3.912 / V at ground level (Koschmieder) */
  visibility?: number;
  /**
   * Local cube-map reflection probes for this scene's glass (default on). The glass module
   * budgets them — one cube face per rendered frame, recaptured after a debounce once a blast or
   * a collapse has settled (glass/probes.ts) — so every scene can afford them.
   */
  glassProbes?: boolean;
}

/** What the look needs from the render pipeline (the production Pipeline has all of it). */
export interface LookablePipeline {
  skyParams?: SkyParams;
  exposureBias?: number;
}

const DEFAULT_SKY: SkyParams = { turbidity: 2.6, rayleigh: 2.4, mieCoefficient: 0.0035, mieDirectionalG: 0.8 };

/** Before `sim.loadScene(def)`: sky constants, exposure and glass probes. */
export function applyLookBeforeLoad(pipeline: LookablePipeline, look: SceneLook | undefined): void {
  if (pipeline.skyParams) Object.assign(pipeline.skyParams, DEFAULT_SKY, look?.sky ?? {});
  if (pipeline.exposureBias !== undefined) pipeline.exposureBias = look?.exposure ?? 1;
  ReflectionProbes.enabled = look?.glassProbes ?? true;
}

/** After `sim.loadScene(def)`: lens and air. */
export function applyLookAfterLoad(ctx: SimContext, look: SceneLook | undefined): void {
  const cam = ctx.camera;
  const fov = look?.fov ?? 60;
  if (cam.fov !== fov) {
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }
  getAtmosphere(ctx.scene).hazeDensity.value = 3.912 / (look?.visibility ?? 9000);
  ctx.scene.environmentIntensity = look?.ambient ?? 1;
}
