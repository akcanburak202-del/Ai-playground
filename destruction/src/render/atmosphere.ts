import * as THREE from 'three';

/**
 * Lighting and haze state shared by the render pipeline and the effects / terrain shaders of one
 * scene. The pipeline writes it on every scene setup and frame; particle shaders bind the same
 * uniform objects, so they are lit by the same sun and fade into the same haze as the geometry.
 * Defaults describe a plausible golden-hour rig so effects still look right under BasicPipeline.
 */
export interface Atmosphere {
  /** Unit vector towards the sun */
  sunDirection: { value: THREE.Vector3 };
  /** Linear sun colour × intensity (render units) */
  sunColor: { value: THREE.Color };
  /** Average sky radiance on an upward surface (irradiance / π) */
  skyAmbient: { value: THREE.Color };
  /** Radiance of the lit ground (bounce light from below) */
  groundAmbient: { value: THREE.Color };
  /** Haze colour used when no sky cube is available */
  hazeColor: { value: THREE.Color };
  /** Extinction coefficient of the haze at ground level, 1/m (Koschmieder: 3.912 / visibility) */
  hazeDensity: { value: number };
  /** Scale height of the haze, m */
  hazeHeight: { value: number };
  /** Distance where the far horizon has fully faded into the sky, m */
  hazeFar: { value: number };
  /** Pre-blurred sky cube for view-dependent haze colour (null → hazeColor) */
  skyCube: { value: THREE.CubeTexture | THREE.Texture | null };
  hasSkyCube: { value: number };
  /** Scene depth for soft particles (null → hard edges) */
  sceneDepth: { value: THREE.DepthTexture | null };
  hasSceneDepth: { value: number };
  /** Render-target size in pixels (for depth lookups) */
  resolution: { value: THREE.Vector2 };
  cameraNear: { value: number };
  cameraFar: { value: number };
  /** Simulation seconds (particles are evaluated analytically at this time) */
  time: { value: number };
  /** Mean wind at 10 m, m/s (drifts smoke) */
  wind: { value: THREE.Vector3 };
  /** Sun shadow atlas and cascade matrices (so smoke in a building's shadow is not sun-lit) */
  sunShadowMap: { value: THREE.Texture | null };
  sunShadowMatrix: { value: THREE.Matrix4[] };
  /** View depth where the far cascade takes over, m */
  sunShadowSplit: { value: number };
  hasSunShadow: { value: number };
  /** Root of the transparent effects (rendered by the pipeline's soft-particle pass) */
  fxRoot: THREE.Object3D | null;
  /**
   * Set by the full pipeline, which owns these values and applies camera shake around the whole
   * frame. When false (BasicPipeline) the effects derive the lighting from the scene's lights.
   */
  pipelineHandlesShake: boolean;
  /** Camera shake offsets for this frame (written by the FX module, applied by the renderer) */
  shake: { position: THREE.Vector3; rotation: THREE.Euler; active: boolean };
}

const registry = new WeakMap<THREE.Scene, Atmosphere>();

/**
 * A valid 1×1 depth-compare texture for the sun-shadow sampler when no pipeline provides one:
 * three's built-in empty shadow texture is never uploaded, and binding it to a sampler2DShadow is
 * a GL error on strict drivers. One per page.
 */
let fallbackShadow: THREE.DepthTexture | null = null;
function fallbackShadowTexture(): THREE.DepthTexture {
  if (!fallbackShadow) {
    fallbackShadow = new THREE.DepthTexture(1, 1);
    fallbackShadow.compareFunction = THREE.LessEqualCompare;
    fallbackShadow.needsUpdate = true;
  }
  return fallbackShadow;
}

export function getAtmosphere(scene: THREE.Scene): Atmosphere {
  let a = registry.get(scene);
  if (!a) {
    a = {
      sunDirection: { value: new THREE.Vector3(-0.6, 0.21, -0.77).normalize() },
      sunColor: { value: new THREE.Color(1, 0.6, 0.25).multiplyScalar(3.0) },
      skyAmbient: { value: new THREE.Color(0.11, 0.21, 0.35) },
      groundAmbient: { value: new THREE.Color(0.07, 0.07, 0.07) },
      hazeColor: { value: new THREE.Color(0.68, 0.52, 0.41) },
      hazeDensity: { value: 3.912 / 9000 },
      hazeHeight: { value: 250 },
      hazeFar: { value: 1900 },
      skyCube: { value: null },
      hasSkyCube: { value: 0 },
      sceneDepth: { value: null },
      hasSceneDepth: { value: 0 },
      resolution: { value: new THREE.Vector2(1, 1) },
      cameraNear: { value: 0.05 },
      cameraFar: { value: 2000 },
      time: { value: 0 },
      wind: { value: new THREE.Vector3(1.6, 0, 0.7) },
      sunShadowMap: { value: fallbackShadowTexture() },
      sunShadowMatrix: { value: [new THREE.Matrix4(), new THREE.Matrix4()] },
      sunShadowSplit: { value: 30 },
      hasSunShadow: { value: 0 },
      fxRoot: null,
      pipelineHandlesShake: false,
      shake: { position: new THREE.Vector3(), rotation: new THREE.Euler(), active: false },
    };
    registry.set(scene, a);
  }
  return a;
}

/** Uniform block for ShaderMaterials that include `ATMOSPHERE_GLSL`. Shares the uniform objects. */
export function atmosphereUniforms(a: Atmosphere): Record<string, { value: unknown }> {
  return {
    uSunDir: a.sunDirection,
    uSunColor: a.sunColor,
    uSkyAmbient: a.skyAmbient,
    uGroundAmbient: a.groundAmbient,
    uHazeColor: a.hazeColor,
    uHazeDensity: a.hazeDensity,
    uHazeHeight: a.hazeHeight,
    uHazeFar: a.hazeFar,
    uSkyCube: a.skyCube,
    uHasSkyCube: a.hasSkyCube,
    uSceneDepth: a.sceneDepth,
    uHasSceneDepth: a.hasSceneDepth,
    uResolution: a.resolution,
    uCameraNear: a.cameraNear,
    uCameraFar: a.cameraFar,
    uTime: a.time,
    uWind: a.wind,
    uSunShadow: a.sunShadowMap,
    uSunShadowMatrix: a.sunShadowMatrix,
    uSunShadowSplit: a.sunShadowSplit,
    uHasSunShadow: a.hasSunShadow,
  };
}

/**
 * GLSL shared by every haze-aware shader. Aerial perspective is exponential height fog
 * (Beer–Lambert with density ρ(y) = ρ0 e^(−y/H), integrated analytically along the view ray) whose
 * in-scattered colour is the sky radiance just above the horizon in the viewing azimuth, so distant
 * geometry dissolves into exactly the sky behind it.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform vec3 uHazeColor;
uniform float uHazeDensity;
uniform float uHazeHeight;
uniform float uHazeFar;
uniform samplerCube uSkyCube;
uniform float uHasSkyCube;
uniform highp sampler2D uSceneDepth;
uniform float uHasSceneDepth;
uniform vec2 uResolution;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uTime;
uniform vec3 uWind;
uniform highp sampler2DShadow uSunShadow;
uniform mat4 uSunShadowMatrix[2];
uniform float uSunShadowSplit;
uniform float uHasSunShadow;

/** Fraction of direct sun reaching a world point (4-tap PCF on the pipeline's cascade atlas). */
float sunVisibility(vec3 wp, float viewDepth) {
  if (uHasSunShadow < 0.5) return 1.0;
  vec4 c = (viewDepth < uSunShadowSplit ? uSunShadowMatrix[0] : uSunShadowMatrix[1]) * vec4(wp, 1.0);
  c.xyz /= c.w;
  if (c.x <= 0.0 || c.y <= 0.0 || c.x >= 1.0 || c.y >= 1.0 || c.z >= 1.0) return 1.0;
  vec2 o = vec2(1.5) / vec2(textureSize(uSunShadow, 0));
  float z = c.z - 0.0005;
  return 0.25 * (texture(uSunShadow, vec3(c.xy + vec2(-o.x, -o.y), z)) + texture(uSunShadow, vec3(c.xy + vec2(o.x, -o.y), z))
    + texture(uSunShadow, vec3(c.xy + vec2(-o.x, o.y), z)) + texture(uSunShadow, vec3(c.xy + vec2(o.x, o.y), z)));
}

vec3 hazeInscatter(vec3 dir) {
  if (uHasSkyCube < 0.5) return uHazeColor;
  vec3 h = normalize(vec3(dir.x, max(dir.y, 0.0) * 0.5 + 0.035, dir.z));
  return textureLod(uSkyCube, h, 3.0).rgb;
}

/** Transmittance of the haze between a camera at height y0 and a point at height y1, distance d. */
float hazeTransmittance(float d, float y0, float y1) {
  float H = uHazeHeight;
  float dy = y1 - y0;
  float k = abs(dy) > 1e-3 ? (exp(-y0 / H) - exp(-y1 / H)) / (dy / H) : exp(-y0 / H);
  float tau = uHazeDensity * d * max(k, 0.0);
  float T = exp(-tau);
  // The ground ring ends before the camera's far plane: fade it completely into the sky there.
  return T * (1.0 - smoothstep(uHazeFar * 0.72, uHazeFar, d));
}

vec3 applyHaze(vec3 color, vec3 worldPos, vec3 camPos) {
  vec3 v = worldPos - camPos;
  float d = length(v);
  float T = hazeTransmittance(d, max(camPos.y, 0.0), max(worldPos.y, 0.0));
  return mix(hazeInscatter(v / max(d, 1e-4)), color, T);
}

float linearizeDepth(float z) {
  // Perspective depth-buffer value to positive view distance along -Z.
  float ndc = z * 2.0 - 1.0;
  return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - ndc * (uCameraFar - uCameraNear));
}

`;

/** Fragment-only: soft-particle fade against the scene depth (0 at contact, 1 once `soft` m in front). */
export const SOFT_FADE_GLSL = /* glsl */ `
float softFade(float viewDepth, float soft) {
  if (uHasSceneDepth < 0.5) return 1.0;
  float sceneZ = linearizeDepth(texture2D(uSceneDepth, gl_FragCoord.xy / uResolution).x);
  return clamp((sceneZ - viewDepth) / soft, 0.0, 1.0);
}
`;
