import * as THREE from 'three';
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
   * Scale of the sky's image-based light (scene.environmentIntensity). The environment map has no
   * sky occlusion and carries the Preetham circumsolar glow at full strength, so at low sun it
   * lights a sun-facing wall about as much as the sun does and washes golden hour out to overcast;
   * ~0.55 restores the direct-to-diffuse balance of a clear low-sun sky (≈ 3–5 : 1 on a sunlit
   * wall, cf. Perez et al. 1990).
   */
  ambient?: number;
  /** Vertical field of view at the spawn, degrees (the player adopts it as its base) */
  fov?: number;
  /** Meteorological visibility, m: extinction 3.912 / V at ground level (Koschmieder) */
  visibility?: number;
  /**
   * Local cube-map reflection probes for this scene's glass. Each probe recapture renders the
   * scene six times; the glass module recaptures every probe in the same frame after a blast or
   * collapse (see the M7 report), so scenes with many panes turn them off and reflect the sky.
   */
  glassProbes?: boolean;
}

/** What the look needs from the render pipeline (the production Pipeline has all of it). */
export interface LookablePipeline {
  skyParams?: SkyParams;
  exposureBias?: number;
}

/** The bloom pass of the production pipeline (a private member; read defensively). */
interface BloomHost {
  bloomPass?: { materialHighPassFilter?: THREE.ShaderMaterial } | null;
}

const DEFAULT_SKY: SkyParams = { turbidity: 2.6, rayleigh: 2.4, mieCoefficient: 0.0035, mieDirectionalG: 0.8 };

/** Before `sim.loadScene(def)`: sky constants, exposure and glass probes. */
export function applyLookBeforeLoad(pipeline: LookablePipeline, look: SceneLook | undefined): void {
  if (pipeline.skyParams) Object.assign(pipeline.skyParams, DEFAULT_SKY, look?.sky ?? {});
  if (pipeline.exposureBias !== undefined) pipeline.exposureBias = look?.exposure ?? 1;
  ReflectionProbes.enabled = look?.glassProbes ?? true;
  guardBloomInput(pipeline as LookablePipeline & BloomHost);
}

/**
 * Workaround for a render/glass defect (see the M7 report): the glass reflection pass lowers the
 * GGX roughness floor to r = 0.015, where the peak of the GGX distribution is D = 1/(π r⁴) ≈ 6·10⁶
 * (Walter et al. 2007, α = r²), so the sun's mirror highlight in a pane overflows the half-float
 * scene target (max 65 504) to +Inf. UnrealBloom's blur chain
 * turns one Inf pixel into NaN over the whole frame and the image goes black (tower, from under
 * the pilotis). The bloom's luminosity high pass is its only input, so it is made to pass only
 * finite values, clamped at 6·10⁴ (half-float max 65 504). The offending pixel itself stays a
 * single dark speck until the owners fix the source. Patched once per material.
 */
function guardBloomInput(pipeline: BloomHost): void {
  const m = pipeline.bloomPass?.materialHighPassFilter;
  if (!m || m.userData.nanGuard) return;
  const src = 'vec4 texel = texture2D( tDiffuse, vUv );';
  if (!m.fragmentShader.includes(src)) return;
  m.fragmentShader = m.fragmentShader.replace(
    src,
    `${src}
			// Inf and NaN from an overflowing highlight must not reach the blur chain.
			if ( any( isnan( texel ) ) || any( isinf( texel ) ) ) texel = vec4( 0.0 );
			texel = min( texel, vec4( 6.0e4 ) );`,
  );
  m.userData.nanGuard = true;
  m.needsUpdate = true;
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
  ctx.scene.environmentIntensity = look?.ambient ?? 0.55;
  subdivideSkyBox(ctx.scene);
}

/**
 * Workaround for the render module's sky dome (see the M7 report): a 12-triangle box drawn with
 * gl_Position.z = w. Every vertex sits on the far plane, so a face that crosses the near plane is
 * cut where w = 0 — a point at infinity — and a rasteriser that clips before dividing (SwiftShader)
 * smears one huge face across the sky as a hazy wedge with a straight edge. Small faces keep that
 * cut on a small triangle. Swaps the geometry once; the pipeline disposes the new one with its sky.
 */
function subdivideSkyBox(scene: THREE.Scene): void {
  const sky = scene.getObjectByName('sky');
  if (!(sky instanceof THREE.Mesh) || !(sky.geometry instanceof THREE.BoxGeometry)) return;
  if (sky.geometry.parameters.widthSegments > 1) return;
  const old = sky.geometry;
  sky.geometry = new THREE.BoxGeometry(1, 1, 1, 16, 16, 16);
  old.dispose();
}
