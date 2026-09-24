import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { SunLight } from 'three/addons/lights/SunLight.js';
import type { RenderPipelineApi, SceneDef, SimContext } from '../app/contracts.ts';
import { getAtmosphere, type Atmosphere } from './atmosphere.ts';
import { deriveLighting, GOLDEN_HOUR_SKY, sunDirection, type SkyParams, type SunLighting } from './skyModel.ts';
import { createSkyRig, type SkyRig } from './sky.ts';
import { CompositePass, FxPass, ScenePass, guardBloomInput, type FrameState } from './passes.ts';
import { hasGroundProvider } from '../fx/ground.ts';

export type Quality = 0 | 1 | 2;

/** Default mood: low warm sun raking across the facades from the south-west. */
export const DEFAULT_SUN = { elevation: 13, azimuth: 232 };

interface QualitySettings {
  pixelRatio: number;
  ao: boolean;
  aoSamples: number;
  bloom: boolean;
  /** Per-cascade shadow map size (the SunLight atlas holds two cascades side by side) */
  shadowMap: number;
  /** Farthest distance that receives sun shadows, m */
  shadowFar: number;
  smaa: boolean;
}

const QUALITY: Record<Quality, QualitySettings> = {
  0: { pixelRatio: 1, ao: false, aoSamples: 8, bloom: false, shadowMap: 1024, shadowFar: 90, smaa: false },
  1: { pixelRatio: 1.25, ao: true, aoSamples: 8, bloom: true, shadowMap: 2048, shadowFar: 120, smaa: true },
  2: { pixelRatio: 2, ao: true, aoSamples: 16, bloom: true, shadowMap: 2048, shadowFar: 150, smaa: true },
};

const _savedPos = new THREE.Vector3();
const _savedQuat = new THREE.Quaternion();
const _shakeQuat = new THREE.Quaternion();
const _kickEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _grey = new THREE.Color();

/**
 * The production render pipeline: golden-hour physical sky with matching sun, sky-derived image
 * based lighting, two-cascade sun shadows that follow the camera, depth-based GTAO, aerial
 * perspective, soft-particle effects, bloom for emissive fire / tracers / hot metal, ACES filmic tone
 * mapping and SMAA.
 *
 *   RenderPass-like ScenePass (opaque world, effects hidden) → CompositePass (GTAO + haze)
 *   → FxPass (particles, soft depth) → UnrealBloomPass → OutputPass (ACES, sRGB) → SMAA/FXAA
 *
 * `setup` is idempotent and runs on every scene load (sun direction may change per scene).
 */
export class Pipeline implements RenderPipelineApi {
  quality: Quality;
  /** Sky constants of the current scene */
  skyParams: SkyParams = { ...GOLDEN_HOUR_SKY };
  lighting: SunLighting | null = null;
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  /** Wall-clock cost of the last `render` call (CPU submit), ms */
  lastFrameMs = 0;
  /** Tone-mapping exposure multiplier on top of the automatic one */
  exposureBias = 1;

  private ctx: SimContext | null = null;
  private atmo: Atmosphere | null = null;
  private composer: EffectComposer | null = null;
  private frame: FrameState = { depth: null };
  private scenePass: ScenePass | null = null;
  private compositePass: CompositePass | null = null;
  private fxPass: FxPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private outputPass: OutputPass | null = null;
  private smaaPass: SMAAPass | null = null;
  private fxaaPass: FXAAPass | null = null;
  private sky: SkyRig | null = null;
  private sun = new SunLight(0xffffff, 3);
  private hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  private ground: THREE.Mesh;
  private skyKey = '';
  private width = 1;
  private height = 1;
  private clock = 0;
  private kickPitch = 0;
  private kickYaw = 0;

  constructor(opts: { quality?: Quality } = {}) {
    this.quality = opts.quality ?? 2;
    this.sun.name = 'sun';
    this.sun.castShadow = true;
    this.hemi.name = 'sky-fill';
    // Fallback ground for scenes without terrain; createTerrain() hides it like BasicPipeline's.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x77705f, roughness: 0.95 }),
    );
    this.ground.name = 'basic-ground';
    this.ground.receiveShadow = true;
  }

  setup(ctx: SimContext, scene: SceneDef | null): void {
    const first = this.ctx === null;
    this.ctx = ctx;
    const atmo = (this.atmo = getAtmosphere(ctx.scene));
    const r = ctx.renderer;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.info.autoReset = false;
    if (first) this.build(ctx);

    const s = ctx.scene;
    s.background = null;
    s.fog = null;
    for (const o of [this.sun, this.hemi, this.ground, this.sky!.mesh]) if (o.parent !== s) s.add(o);
    // The fallback plane only stands in for a missing terrain: a terrain hides it when it is created
    // and shows it again when disposed, so a re-setup (new sky, quality) must not bring it back.
    if (!hasGroundProvider(s)) this.ground.visible = true;

    const sunDef = scene?.sun ?? DEFAULT_SUN;
    const [dx, dy, dz] = sunDirection(sunDef.elevation, sunDef.azimuth);
    this.sunDirection.set(dx, dy, dz);
    const L = deriveLighting(sunDef.elevation, sunDef.azimuth, this.skyParams);
    this.lighting = L;
    this.sun.position.copy(this.sunDirection).multiplyScalar(100);
    this.sun.color.setRGB(...L.sunColor);
    this.sun.intensity = L.sunIntensity;
    // Extra sky/ground fill for the multiple bounces the environment map does not contain.
    this.hemi.color.setRGB(L.skyIrradiance[0] / Math.PI, L.skyIrradiance[1] / Math.PI, L.skyIrradiance[2] / Math.PI);
    this.hemi.groundColor.setRGB(...L.groundRadiance);
    this.hemi.intensity = 0.3;
    // A photographer exposes for the lit facade: brighten low suns partially (not fully — golden hour
    // is a little moodier than noon). Anchor: luminance irradiance of a wall facing the sun.
    r.toneMappingExposure = this.exposureBias * 1.15 * Math.pow(6 / Math.max(L.wallIrradiance, 0.3), 0.6);

    const key = `${sunDef.elevation}/${sunDef.azimuth}/${JSON.stringify(this.skyParams)}`;
    if (key !== this.skyKey) {
      this.skyKey = key;
      // Sun disc ≈ 25× a lit white wall: blooms like the real thing without flooding the frame.
      this.sky!.update(r, this.sunDirection, this.skyParams, L, 25 * L.sunIntensity * 0.25);
    }
    s.environment = this.sky!.env!.texture;
    s.environmentIntensity = 1;

    atmo.sunDirection.value.copy(this.sunDirection);
    atmo.sunColor.value.setRGB(L.sunColor[0] * L.sunIntensity, L.sunColor[1] * L.sunIntensity, L.sunColor[2] * L.sunIntensity);
    // Same partial desaturation as the lighting environment (see sky.ts).
    atmo.skyAmbient.value.setRGB(L.skyIrradiance[0] / Math.PI, L.skyIrradiance[1] / Math.PI, L.skyIrradiance[2] / Math.PI);
    const lum = atmo.skyAmbient.value.r * 0.2126 + atmo.skyAmbient.value.g * 0.7152 + atmo.skyAmbient.value.b * 0.0722;
    atmo.skyAmbient.value.lerp(_grey.setScalar(lum), 0.3);
    atmo.groundAmbient.value.setRGB(...L.groundRadiance);
    atmo.hazeColor.value.setRGB(...L.horizon);
    atmo.skyCube.value = this.sky!.cube.texture;
    atmo.hasSkyCube.value = 1;
    atmo.hazeFar.value = Math.min(1900, ctx.camera.far * 0.95);
    atmo.pipelineHandlesShake = true;
    this.applyQuality();
  }

  private build(ctx: SimContext): void {
    const r = ctx.renderer;
    const atmo = this.atmo!;
    this.sky = createSkyRig();
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    this.width = Math.max(1, size.x / r.getPixelRatio());
    this.height = Math.max(1, size.y / r.getPixelRatio());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(size.x, size.y),
    });
    rt.texture.name = 'Pipeline.rt1';
    const composer = new EffectComposer(r, rt);
    this.composer = composer;
    this.scenePass = new ScenePass(ctx.scene, ctx.camera, this.frame, atmo);
    this.compositePass = new CompositePass(ctx.camera, this.frame, atmo);
    this.fxPass = new FxPass(ctx.camera, this.frame, atmo);
    // Threshold above any sun-lit diffuse surface (≈1.5): only fire, tracers, hot metal, flashes
    // and the sun disc bloom. Incandescent sources run at 10–100× the lit wall (see fx glow()), so
    // the strength stays low: veiling glare of a real lens is a few per cent of the source.
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.1, 0.3, 7.0);
    guardBloomInput(this.bloomPass.materialHighPassFilter);
    this.outputPass = new OutputPass();
    this.smaaPass = new SMAAPass();
    this.fxaaPass = new FXAAPass();
    composer.addPass(this.scenePass);
    composer.addPass(this.compositePass);
    composer.addPass(this.fxPass);
    composer.addPass(this.bloomPass);
    composer.addPass(this.outputPass);
    composer.addPass(this.smaaPass);
    composer.addPass(this.fxaaPass);
  }

  private applyQuality(): void {
    const q = QUALITY[this.quality];
    const ctx = this.ctx;
    if (!ctx || !this.composer) return;
    const r = ctx.renderer;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const pr = Math.min(q.pixelRatio, Math.max(1, dpr));
    if (r.getPixelRatio() !== pr) {
      r.setPixelRatio(pr);
      this.resize(this.width, this.height);
    }
    this.compositePass!.aoEnabled = q.ao;
    this.compositePass!.setSamples(q.aoSamples);
    this.bloomPass!.enabled = q.bloom;
    this.smaaPass!.enabled = q.smaa;
    this.fxaaPass!.enabled = !q.smaa;
    const sh = this.sun.shadow;
    if (sh.mapSize.x !== q.shadowMap) {
      sh.mapSize.set(q.shadowMap, q.shadowMap);
      sh.map?.dispose();
      sh.map = null;
    }
    sh.camera.far = q.shadowFar;
    sh.camera.near = 0.5;
    // Normal-offset bias sized for the low golden-hour sun: a surface lit at grazing elevation θ
    // needs an offset n with n / sin θ larger than the depth spread of the PCF kernel,
    // r·s / tan θ (kernel radius r texels of size s) — ≈ 0.1 m for θ ≈ 13°, 1.5 texels of ~4 cm.
    sh.bias = -0.00002;
    sh.normalBias = 0.1;
    // ≈ the penumbra of the 0.53° solar disc a few metres behind an occluder.
    sh.radius = 1.5;
  }

  render(realDt: number): void {
    const ctx = this.ctx;
    const composer = this.composer;
    if (!ctx || !composer) return;
    const t0 = performance.now();
    const r = ctx.renderer;
    const cam = ctx.camera;
    const atmo = this.atmo!;
    r.info.reset();
    this.clock += realDt;
    this.sky!.material.uniforms.time!.value = this.clock;
    atmo.time.value = ctx.time.now;
    atmo.cameraNear.value = cam.near;
    atmo.cameraFar.value = cam.far;
    r.getDrawingBufferSize(atmo.resolution.value);

    // Render-only view offsets (camera shake, recoil kick): applied around the frame and undone after,
    // so the aim ray and everything simulated keep the true camera.
    const shake = atmo.shake;
    const kicked = this.kickPitch !== 0 || this.kickYaw !== 0;
    const moved = shake.active || kicked;
    if (moved) {
      _savedPos.copy(cam.position);
      _savedQuat.copy(cam.quaternion);
      if (kicked) cam.quaternion.multiply(_shakeQuat.setFromEuler(_kickEuler.set(this.kickPitch, this.kickYaw, 0, 'YXZ')));
      if (shake.active) {
        cam.position.add(shake.position);
        cam.quaternion.multiply(_shakeQuat.setFromEuler(shake.rotation));
      }
    }
    cam.updateMatrixWorld();
    composer.render(realDt);
    atmo.hasSunShadow.value = 0;
    if (moved) {
      cam.position.copy(_savedPos);
      cam.quaternion.copy(_savedQuat);
      cam.updateMatrixWorld();
    }
    this.lastFrameMs = performance.now() - t0;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const ctx = this.ctx;
    if (!ctx) return;
    const r = ctx.renderer;
    r.setSize(this.width, this.height, false);
    ctx.camera.aspect = this.width / this.height;
    ctx.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(r.getPixelRatio());
      this.composer.setSize(this.width, this.height);
    }
  }

  /**
   * Recoil kick for the next frames: a view rotation (radians; +pitch looks up, +yaw turns left)
   * applied only while rendering. The caller drives its decay and calls this every frame.
   */
  viewKick(pitch: number, yaw: number): void {
    this.kickPitch = Number.isFinite(pitch) ? pitch : 0;
    this.kickYaw = Number.isFinite(yaw) ? yaw : 0;
  }

  setQuality(level: Quality): void {
    this.quality = level;
    this.applyQuality();
  }

  /** Replace the sky constants (turbidity etc.) and re-derive the lighting. */
  setSky(p: Partial<SkyParams>, scene: SceneDef | null = null): void {
    Object.assign(this.skyParams, p);
    if (this.ctx) this.setup(this.ctx, scene);
  }

  dispose(): void {
    this.composer?.dispose();
    for (const p of [this.scenePass, this.compositePass, this.fxPass, this.bloomPass, this.outputPass, this.smaaPass, this.fxaaPass]) p?.dispose();
    this.sky?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.sun.removeFromParent();
    this.hemi.removeFromParent();
    this.ground.removeFromParent();
    this.ctx = null;
    this.composer = null;
  }
}
