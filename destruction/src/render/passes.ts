import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOShader, generateMagicSquareNoise } from 'three/addons/shaders/GTAOShader.js';
import { PoissonDenoiseShader, generatePdSamplePointInitializer } from 'three/addons/shaders/PoissonDenoiseShader.js';
import { ATMOSPHERE_GLSL, atmosphereUniforms, type Atmosphere } from './atmosphere.ts';

/**
 * Frame-shared state of the pipeline passes: which depth texture holds this frame's scene depth
 * (the composer ping-pongs two targets, each with its own depth texture).
 */
export interface FrameState {
  depth: THREE.DepthTexture | null;
}

/** Largest value the half-float scene target can hold (65 504), rounded down. */
export const HDR_MAX = 6.0e4;

/**
 * GLSL: replace non-finite HDR values. A mirror highlight above the half-float range is written as
 * +Inf (e.g. the sun in glass at GGX roughness 0.015: D = 1/(π r⁴) ≈ 6·10⁶, Walter et al. 2007), and
 * Inf − Inf or 0 · Inf in a later shader make NaN; bloom's blur chain spreads either over the whole
 * frame. +Inf becomes the largest finite value (it is the brightest thing in view), NaN becomes 0.
 * Written with ordered comparisons (false for NaN) so no NaN-folding optimiser can remove the test.
 */
export const FINITE_GLSL = /* glsl */ `
float finiteHdr(float x) { return abs(x) <= ${HDR_MAX.toFixed(1)} ? x : (x > 0.0 ? ${HDR_MAX.toFixed(1)} : 0.0); }
vec4 finiteHdr(vec4 c) {
  return vec4(finiteHdr(c.r), finiteHdr(c.g), finiteHdr(c.b), c.a >= 0.0 && c.a <= 1.0 ? c.a : 1.0);
}
`;

/**
 * Bloom input guard: UnrealBloomPass's luminosity high pass is the only input of its blur chain, so
 * making it pass only finite values keeps a single overflowing pixel from turning into a frame-wide
 * NaN. The input is also scaled down to at most `cap` per channel (hue kept): an optically thick
 * body cannot outshine a black body at its temperature, but additive flame billboards stack to
 * several hundred where a fireball's cores overlap, and the glare of that sum veiled the whole frame
 * white. 48 ≈ the radiance of 2200–2300 K gas (fx glow()): white-hot surfaces bloom fully, stacked
 * layers add nothing more to the glare. Patched once per material; sets `userData.nanGuard`.
 */
export function guardBloomInput(m: THREE.ShaderMaterial | undefined, cap = 48): void {
  if (!m || m.userData.nanGuard) return;
  const src = 'vec4 texel = texture2D( tDiffuse, vUv );';
  if (!m.fragmentShader.includes(src)) throw new Error('three UnrealBloomPass high-pass shader changed: update guardBloomInput');
  m.fragmentShader = m.fragmentShader.replace(
    'void main() {',
    `${FINITE_GLSL}\nvoid main() {`,
  ).replace(
    src,
    `${src}
			texel = finiteHdr( texel );
			float texelMax = max( max( texel.r, texel.g ), texel.b );
			if ( texelMax > ${cap.toFixed(1)} ) texel.rgb *= ${cap.toFixed(1)} / texelMax;`,
  );
  m.userData.nanGuard = true;
  m.needsUpdate = true;
}

/**
 * Opaque scene into the composer's read buffer (with a depth texture). The effects root is hidden
 * here: particles are composited later with soft depth, after AO and haze, so AO never darkens
 * smoke and haze is applied to them per particle.
 */
export class ScenePass extends Pass {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private frame: FrameState;
  private atmo: Atmosphere;
  private clearColor = new THREE.Color();

  constructor(scene: THREE.Scene, camera: THREE.Camera, frame: FrameState, atmo: Atmosphere) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.frame = frame;
    this.atmo = atmo;
    this.needsSwap = false;
  }

  override render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    const fx = this.atmo.fxRoot;
    const wasVisible = fx?.visible ?? false;
    if (fx) fx.visible = false;
    const autoClear = renderer.autoClear;
    renderer.getClearColor(this.clearColor);
    const alpha = renderer.getClearAlpha();
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(read);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
    renderer.setClearColor(this.clearColor, alpha);
    if (fx) fx.visible = wasVisible;
    this.frame.depth = read.depthTexture as THREE.DepthTexture;
    this.exportSunShadow();
  }

  /** Hand this frame's sun cascades to the effects shaders (rendered just now with the scene). */
  private exportSunShadow(): void {
    const a = this.atmo;
    a.hasSunShadow.value = 0;
    let sun: { shadow?: unknown } | null = null;
    for (const c of this.scene.children) if ((c as { isSunLight?: boolean }).isSunLight && c.castShadow) sun = c as { shadow?: unknown };
    const sh = sun?.shadow as (THREE.LightShadow & { getMatrix?(i: number): THREE.Matrix4; _cascadeData?: THREE.Vector4[] }) | undefined;
    const map = sh?.map?.depthTexture;
    if (!sh || !map || !sh.getMatrix || !sh._cascadeData) return;
    a.sunShadowMap.value = map;
    a.sunShadowMatrix.value[0]!.copy(sh.getMatrix(0));
    a.sunShadowMatrix.value[1]!.copy(sh.getMatrix(1));
    a.sunShadowSplit.value = sh._cascadeData[0]!.y;
    a.hasSunShadow.value = 1;
  }
}

/**
 * Ground-truth ambient occlusion (Jimenez et al. 2016, "Practical Real-Time Strategies for Accurate
 * Indirect Occlusion", via three's GTAO shader) at half resolution from the depth buffer alone
 * (normals reconstructed from depth, so voxel discards and deformed meshes are honoured without a
 * second geometry pass), Poisson-denoised; then one composite applies AO and aerial perspective.
 */
export class CompositePass extends Pass {
  aoEnabled = true;
  aoIntensity = 0.9;
  private camera: THREE.PerspectiveCamera;
  private frame: FrameState;
  private aoRT: THREE.WebGLRenderTarget;
  private pdRT: THREE.WebGLRenderTarget;
  private gtao: THREE.ShaderMaterial;
  private pd: THREE.ShaderMaterial;
  private composite: THREE.ShaderMaterial;
  private quad = new FullScreenQuad();
  private noiseA: THREE.DataTexture;
  private noiseB: THREE.DataTexture;
  private white: THREE.DataTexture;
  private savedClear = new THREE.Color();

  constructor(camera: THREE.PerspectiveCamera, frame: FrameState, atmo: Atmosphere, samples = 12) {
    super();
    this.camera = camera;
    this.frame = frame;
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.pdRT = this.aoRT.clone();
    this.noiseA = generateMagicSquareNoise();
    this.noiseB = randomNoise(64);
    this.white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.white.needsUpdate = true;

    this.gtao = new THREE.ShaderMaterial({
      defines: { ...GTAOShader.defines, NORMAL_VECTOR_TYPE: 0, DEPTH_SWIZZLING: 'x', SAMPLES: samples },
      uniforms: THREE.UniformsUtils.clone(GTAOShader.uniforms),
      vertexShader: GTAOShader.vertexShader,
      fragmentShader: GTAOShader.fragmentShader,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    const gu = this.gtao.uniforms;
    gu.tNoise!.value = this.noiseA;
    // Architectural scale: ~1.2 m hemisphere catches corners, reveals and rubble contacts.
    gu.radius!.value = 1.2;
    gu.distanceExponent!.value = 1.6;
    gu.thickness!.value = 1.5;
    gu.distanceFallOff!.value = 1.0;
    gu.scale!.value = 1.0;

    this.pd = new THREE.ShaderMaterial({
      defines: { ...PoissonDenoiseShader.defines, NORMAL_VECTOR_TYPE: 0, DEPTH_VALUE_SOURCE: 0, SAMPLES: 16, SAMPLE_VECTORS: generatePdSamplePointInitializer(16, 2, 1) },
      uniforms: THREE.UniformsUtils.clone(PoissonDenoiseShader.uniforms),
      vertexShader: PoissonDenoiseShader.vertexShader,
      fragmentShader: PoissonDenoiseShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    const pu = this.pd.uniforms;
    pu.tDiffuse!.value = this.aoRT.texture;
    pu.tNoise!.value = this.noiseB;
    pu.lumaPhi!.value = 10;
    pu.depthPhi!.value = 2;
    pu.normalPhi!.value = 3;
    pu.radius!.value = 6;

    this.composite = new THREE.ShaderMaterial({
      uniforms: {
        ...atmosphereUniforms(atmo),
        tColor: { value: null },
        tDepth: { value: null },
        tAO: { value: this.white },
        aoIntensity: { value: 0.9 },
        projInv: { value: new THREE.Matrix4() },
        camWorld: { value: new THREE.Matrix4() },
        camPos: { value: new THREE.Vector3() },
      },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        ${ATMOSPHERE_GLSL}
        ${FINITE_GLSL}
        uniform sampler2D tColor;
        uniform highp sampler2D tDepth;
        uniform sampler2D tAO;
        uniform float aoIntensity;
        uniform mat4 projInv;
        uniform mat4 camWorld;
        uniform vec3 camPos;
        varying vec2 vUv;
        void main() {
          // Sanitise the scene HDR once, before AO, haze, particles, bloom and tone mapping.
          vec4 c = finiteHdr(texture2D(tColor, vUv));
          float z = texture2D(tDepth, vUv).x;
          if (z >= 1.0) { gl_FragColor = c; return; }
          // AO darkens the ambient term only; a sun-lit pixel is dominated by direct light that the
          // shadow map already occludes, so fade AO out on bright pixels.
          float ao = texture2D(tAO, vUv).r;
          // Depth-reconstructed normals are wrong on silhouette pixels (their neighbours lie on a
          // far surface or the sky), which rims every outline with false occlusion: fade AO out
          // where the view depth jumps by more than ~6 % between neighbouring pixels.
          vec2 px = 1.0 / vec2(textureSize(tDepth, 0));
          float zc = linearizeDepth(z);
          float zl = linearizeDepth(texture2D(tDepth, vUv - vec2(px.x, 0.0)).x);
          float zr = linearizeDepth(texture2D(tDepth, vUv + vec2(px.x, 0.0)).x);
          float zd = linearizeDepth(texture2D(tDepth, vUv - vec2(0.0, px.y)).x);
          float zu = linearizeDepth(texture2D(tDepth, vUv + vec2(0.0, px.y)).x);
          float jump = max(max(abs(zl - zc), abs(zr - zc)), max(abs(zd - zc), abs(zu - zc))) / zc;
          ao = mix(ao, 1.0, smoothstep(0.03, 0.08, jump));
          float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
          float w = aoIntensity * (1.0 - 0.55 * smoothstep(0.35, 1.6, lum));
          c.rgb *= mix(1.0, ao, w);
          vec4 v = projInv * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
          vec3 wp = (camWorld * vec4(v.xyz / v.w, 1.0)).xyz;
          c.rgb = applyHaze(c.rgb, wp, camPos);
          gl_FragColor = c;
        }`,
      depthTest: false,
      depthWrite: false,
    });
  }

  setSamples(n: number): void {
    if (this.gtao.defines.SAMPLES !== n) {
      this.gtao.defines.SAMPLES = n;
      this.gtao.needsUpdate = true;
    }
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.aoRT.setSize(w, h);
    this.pdRT.setSize(w, h);
    this.gtao.uniforms.resolution!.value.set(w, h);
    this.pd.uniforms.resolution!.value.set(w, h);
  }

  override render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    const cam = this.camera;
    const depth = this.frame.depth;
    const cu = this.composite.uniforms;
    let ao: THREE.Texture = this.white;
    if (this.aoEnabled && depth) {
      const gu = this.gtao.uniforms;
      gu.tDepth!.value = depth;
      gu.cameraNear!.value = cam.near;
      gu.cameraFar!.value = cam.far;
      gu.cameraProjectionMatrix!.value.copy(cam.projectionMatrix);
      gu.cameraProjectionMatrixInverse!.value.copy(cam.projectionMatrixInverse);
      gu.cameraWorldMatrix!.value.copy(cam.matrixWorld);
      // Sky pixels are discarded by the AO shader: clear to "unoccluded" so bilinear upsampling at
      // silhouettes does not pull in stale texels (a dark dotted fringe along every skyline).
      this.draw(renderer, this.gtao, this.aoRT, true);
      const pu = this.pd.uniforms;
      pu.tDepth!.value = depth;
      pu.cameraProjectionMatrixInverse!.value.copy(cam.projectionMatrixInverse);
      this.draw(renderer, this.pd, this.pdRT);
      ao = this.pdRT.texture;
    }
    cu.tColor!.value = read.texture;
    cu.tDepth!.value = depth;
    cu.tAO!.value = ao;
    cu.aoIntensity!.value = this.aoEnabled ? this.aoIntensity : 0;
    cu.projInv!.value.copy(cam.projectionMatrixInverse);
    cu.camWorld!.value.copy(cam.matrixWorld);
    cu.camPos!.value.setFromMatrixPosition(cam.matrixWorld);
    this.draw(renderer, this.composite, this.renderToScreen ? null : write);
  }

  private draw(renderer: THREE.WebGLRenderer, m: THREE.Material, target: THREE.WebGLRenderTarget | null, clearWhite = false): void {
    this.quad.material = m;
    renderer.setRenderTarget(target);
    if (clearWhite) {
      renderer.getClearColor(this.savedClear);
      const a = renderer.getClearAlpha();
      renderer.setClearColor(0xffffff, 1);
      renderer.clear(true, false, false);
      renderer.setClearColor(this.savedClear, a);
    }
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.aoRT.dispose();
    this.pdRT.dispose();
    this.gtao.dispose();
    this.pd.dispose();
    this.composite.dispose();
    this.quad.dispose();
    this.noiseA.dispose();
    this.noiseB.dispose();
    this.white.dispose();
  }
}

/**
 * Transparent effects (smoke, dust, fire, sparks, tracers) over the composited frame. They are
 * depth-tested in their own shaders against this frame's scene depth (soft particles), so the
 * target's own depth attachment is never read and never needs to match.
 */
export class FxPass extends Pass {
  private camera: THREE.Camera;
  private frame: FrameState;
  private atmo: Atmosphere;
  private materials: THREE.Material[] = [];

  constructor(camera: THREE.Camera, frame: FrameState, atmo: Atmosphere) {
    super();
    this.camera = camera;
    this.frame = frame;
    this.atmo = atmo;
    this.needsSwap = false;
  }

  override render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    const root = this.atmo.fxRoot;
    if (!root || !this.frame.depth) return;
    const mats = this.materials;
    mats.length = 0;
    root.traverseVisible((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m)) mats.push(m);
    });
    for (const m of mats) m.depthTest = false;
    this.atmo.sceneDepth.value = this.frame.depth;
    this.atmo.hasSceneDepth.value = 1;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : read);
    renderer.render(root, this.camera);
    renderer.autoClear = autoClear;
    this.atmo.hasSceneDepth.value = 0;
    this.atmo.sceneDepth.value = null;
    for (const m of mats) m.depthTest = true;
  }
}

function randomNoise(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  let s = 0x2545f491;
  for (let i = 0; i < data.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    data[i] = (s >>> 0) & 255;
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}
