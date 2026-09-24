import * as THREE from 'three';

/**
 * The steel look: one MeshStandardMaterial patched through onBeforeCompile, shared by plates and
 * beams. Everything that varies over the surface comes from
 *  - a per-element detail texture (RGBA8): R = material present (holes are discarded), G = bare
 *    metal (paint chipped, mill scale knocked off, fireproofing gone), B = soot, A = local crater
 *    depth (bump);
 *  - a heat texture (float RGBA): R = peak temperature rise of a hot spot, G = the sim time it was
 *    heated, B = spot radius, A = the highest temperature the metal reached (temper colours);
 *  - vertex attributes: coarse temperature (°C), equivalent plastic strain, fracture-surface flag.
 * Finishes are procedural (object-space noise), so no image assets are needed.
 */

export type SteelFinish = 'mill-scale' | 'painted' | 'corten' | 'polished' | 'armor' | 'chrome' | 'fireproofed';

export interface SteelLookOptions {
  finish: SteelFinish;
  paintColor?: number;
  detail: THREE.Texture;
  heat: THREE.Texture;
  /** Metres spanned by the detail texture's u and v (noise scale and bump scale) */
  size: [number, number];
  /** Detail texture holds [front | back] halves (plates) */
  split: boolean;
  /** Metres of crater depth per unit of the detail alpha channel */
  dimpleScale: number;
  /** Thermal diffusivity for the hot-spot decay, m²/s */
  diffusivity: number;
  seed: number;
  /** A coating layer (fireproofing) that is gone wherever the detail map marks bare steel */
  coat?: boolean;
}

export interface SteelUniforms {
  uDetail: { value: THREE.Texture };
  uHeatTex: { value: THREE.Texture };
  uTime: { value: number };
  uAlpha: { value: number };
  uSize: { value: THREE.Vector2 };
  uDimple: { value: number };
  uPaint: { value: THREE.Color };
  uSeed: { value: number };
}

const FINISH_DEFINE: Record<SteelFinish, string> = {
  'mill-scale': 'FINISH_MILL',
  painted: 'FINISH_PAINT',
  corten: 'FINISH_CORTEN',
  polished: 'FINISH_POLISHED',
  armor: 'FINISH_ARMOR',
  chrome: 'FINISH_CHROME',
  fireproofed: 'FINISH_FIRE',
};

const VERT_PARS = /* glsl */ `
attribute vec2 aDUv;
attribute float aHeat;
attribute float aStrain;
attribute float aRim;
varying vec2 vDUv;
varying float vHeat;
varying float vStrain;
varying float vRim;
varying vec3 vObj;
`;

const VERT_MAIN = /* glsl */ `
vDUv = aDUv;
vHeat = aHeat;
vStrain = aStrain;
vRim = aRim;
vObj = position;
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D uDetail;
uniform sampler2D uHeatTex;
uniform float uTime;
uniform float uAlpha;
uniform vec2 uSize;
uniform float uDimple;
uniform vec3 uPaint;
uniform float uSeed;
varying vec2 vDUv;
varying float vHeat;
varying float vStrain;
varying float vRim;
varying vec3 vObj;

float stHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float stNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(stHash(i), stHash(i + vec3(1, 0, 0)), f.x), mix(stHash(i + vec3(0, 1, 0)), stHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(stHash(i + vec3(0, 0, 1)), stHash(i + vec3(1, 0, 1)), f.x), mix(stHash(i + vec3(0, 1, 1)), stHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float stFbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * stNoise(p); p = p * 2.07 + 13.1; a *= 0.5; }
  return s / 0.9375;
}
// Cellular noise F2 − F1: thin network of cell borders (paint crazing, mill-scale cracks).
float stCells(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = vec2(stHash(vec3(i + g, 1.7)), stHash(vec3(i + g, 5.3)));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  return sqrt(d2) - sqrt(d1);
}
// Derivative bump mapping in view space (Mikkelsen 2010).
vec3 stPerturb(vec3 N, vec3 p, float h) {
  vec3 dpdx = dFdx(p), dpdy = dFdy(p);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - grad);
}
// Colour of glowing steel (Planck radiance through the eye's response, normalised): dull cherry
// red at 800 K, orange at 1100 K, yellow-white above 1500 K.
vec3 stBlackbody(float T) {
  float t = clamp((T - 750.0) / 900.0, 0.0, 1.0);
  return vec3(1.0, 0.06 + 0.8 * pow(t, 1.25), 0.01 + 0.55 * pow(t, 2.6));
}
// Visible radiance rises very steeply (Wien): the Draper point (≈ 800 K) is barely visible, 1300 K
// glows brightly even in daylight.
float stGlow(float T) {
  float x = max(T - 770.0, 0.0) / 100.0;
  return 0.03 * x * x * x;
}
// Temper (oxide film interference) colours of bare steel by the highest temperature reached, °C:
// straw 220, brown 250, purple 280, blue 300, grey-blue 330, dull grey above 400.
vec3 stTemper(float Tmax) {
  vec3 c = vec3(1.0);
  c = mix(c, vec3(1.05, 0.9, 0.55), smoothstep(205.0, 235.0, Tmax));
  c = mix(c, vec3(0.8, 0.5, 0.25), smoothstep(240.0, 262.0, Tmax));
  c = mix(c, vec3(0.55, 0.28, 0.55), smoothstep(262.0, 285.0, Tmax));
  c = mix(c, vec3(0.25, 0.35, 0.8), smoothstep(285.0, 305.0, Tmax));
  c = mix(c, vec3(0.5, 0.6, 0.7), smoothstep(310.0, 340.0, Tmax));
  c = mix(c, vec3(0.32, 0.31, 0.3), smoothstep(360.0, 450.0, Tmax));
  return c;
}
`;

/**
 * Surface model. Produces stAlbedo, stRough, stMetal, stHeight (bump, m) and stGlowC (emissive).
 * Runs after <map_fragment>; the discard for holes happens first so shadows and colour agree.
 */
const FRAG_SURFACE = /* glsl */ `
vec4 stDet = texture2D(uDetail, vDUv);
if (stDet.r < 0.5) discard;
#ifdef STEEL_COAT
// The coat has flaked off wherever the steel under it was struck, and cracks off in slabs where
// the steel yields beneath it (cementitious SFRM fails in tension at ~0.1 % strain).
float stCoatN = stNoise(vec3(vDUv * uSize * 40.0, 3.0));
if (stDet.g > 0.3 + 0.25 * stCoatN) discard;
if (vStrain > 0.008 + 0.03 * stNoise(vec3(vDUv * uSize * 9.0, 7.0))) discard;
#endif
#ifdef STEEL_SPLIT
vec2 stHeatUv = vec2(fract(vDUv.x * 2.0), vDUv.y);
#else
vec2 stHeatUv = vDUv;
#endif
vec4 stHt = texture2D(uHeatTex, stHeatUv);
vec2 stM = vDUv * uSize;
vec3 stP = vec3(stM, uSeed);
float stN1 = stFbm(stP * 3.0);
float stN2 = stFbm(stP * 22.0 + 7.0);
float stEps = vStrain;
vec3 stAlbedo;
float stRough, stMetal, stHeight = 0.0;
bool stInside = !gl_FrontFacing || vRim > 0.5;
// Millimetre grain (rolling texture, pits), faded out before it would alias.
float stFine = clamp(1.5 - 600.0 * length(fwidth(stM)), 0.0, 1.0);
float stGrain = stFine * (stNoise(stP * 700.0) - 0.5);
// Fresh bright steel (fracture / gouge / exposed metal).
vec3 stBare = vec3(0.4, 0.4, 0.395) * (0.8 + 0.4 * stN2);
#if defined(FINISH_MILL)
  // Hot-rolled mill scale: blue-grey magnetite, mottled, with sparse rust blooms; the brittle scale
  // cracks and spalls where the steel has yielded (Lüders bands / scale flaking).
  stAlbedo = mix(vec3(0.050, 0.056, 0.064), vec3(0.085, 0.088, 0.092), stN1);
  stAlbedo *= (0.85 + 0.3 * stN2) * (1.0 + 0.25 * stGrain);
  stHeight += 0.00003 * stGrain;
  float stRust = smoothstep(0.62, 0.8, stFbm(stP * 1.3 + 3.0)) * 0.6;
  stAlbedo = mix(stAlbedo, vec3(0.16, 0.07, 0.03), stRust);
  stRough = 0.5 + 0.25 * stN2 + 0.2 * stRust;
  stMetal = 0.55 - 0.4 * stRust;
  // Scale is brittle (it cracks near 0.5 % strain and spalls at a few %): first a fine crack
  // network appears (darker hairlines, ~1 cm cells), then centimetre flakes pop off; the flaked
  // fraction grows with the plastic strain. Under the scale the steel is matte grey with a thin
  // wüstite residue, far from the mirror of machined metal.
  vec2 stWarp = stM * 95.0 + 1.5 * vec2(stNoise(stP * 25.0), stNoise(stP * 25.0 + 4.0));
  float stCrk = smoothstep(0.004, 0.04, stEps) * smoothstep(0.025, 0.0, stCells(stWarp));
  stAlbedo *= 1.0 - 0.14 * stCrk;
  float stCov = 0.85 * smoothstep(0.008, 0.15, stEps);
  float stPatch = stFbm(stP * 70.0 + 5.0) * 0.65 + 0.35 * stNoise(stP * 240.0);
  float stFlake = smoothstep(1.0 - stCov - 0.03, 1.0 - stCov + 0.03, stPatch);
  stHeight += 0.00006 * (1.0 - stFlake);
  stAlbedo = mix(stAlbedo, vec3(0.19, 0.19, 0.185) * (0.85 + 0.3 * stN2), stFlake * 0.9);
  stRough = mix(stRough, 0.62, stFlake);
  stMetal = mix(stMetal, 0.85, stFlake);
#elif defined(FINISH_PAINT)
  // Two-coat industrial paint over red-oxide primer: orange-peel sheen; crazes and flakes where the
  // steel under it yielded; chips expose primer then bright steel.
  stAlbedo = uPaint * (0.94 + 0.12 * stN1);
  stRough = 0.36 + 0.1 * stN2;
  stMetal = 0.0;
  stHeight += 0.00004 * stNoise(stP * 900.0);
  float stCraze = smoothstep(0.01, 0.08, stEps) * smoothstep(0.045, 0.0, stCells(stM * 70.0));
  stAlbedo = mix(stAlbedo, stAlbedo * 0.35, stCraze * 0.8);
  stRough = mix(stRough, 0.8, stCraze);
#elif defined(FINISH_CORTEN)
  // Weathering steel patina: dense orange-brown to deep umber, rain streaks, granular.
  float stStreak = stFbm(vec3(stM.x * 8.0, stM.y * 0.8, uSeed + 2.0));
  stAlbedo = mix(vec3(0.14, 0.045, 0.018), vec3(0.32, 0.12, 0.04), stN1);
  stAlbedo = mix(stAlbedo, vec3(0.07, 0.03, 0.02), smoothstep(0.55, 0.8, stStreak) * 0.6);
  stAlbedo *= 0.8 + 0.4 * stN2;
  stRough = 0.88;
  stMetal = 0.05;
  stHeight += 0.0002 * stNoise(stP * 400.0);
#elif defined(FINISH_POLISHED)
  // Brushed / polished stainless: bright, low roughness with directional brushing; plastic strain
  // roughens it into orange peel.
  float stBrush = stNoise(vec3(stM.x * 3.0, stM.y * 900.0, uSeed));
  stAlbedo = vec3(0.62, 0.63, 0.64) * (0.96 + 0.06 * stBrush);
  stRough = 0.1 + 0.06 * stBrush;
  stMetal = 1.0;
  stRough = mix(stRough, 0.42, smoothstep(0.005, 0.08, stEps));
  stHeight += smoothstep(0.005, 0.08, stEps) * 0.0002 * stNoise(stP * 500.0);
#elif defined(FINISH_CHROME)
  // Chrome plating (Mies cruciform columns): near-perfect mirror; plating crazes where the steel
  // under it bends.
  stAlbedo = vec3(0.72, 0.73, 0.75);
  stRough = 0.035 + 0.015 * stN2;
  stMetal = 1.0;
  float stCz = smoothstep(0.003, 0.05, stEps);
  stRough = mix(stRough, 0.35, stCz);
  stAlbedo = mix(stAlbedo, vec3(0.4, 0.4, 0.42), stCz * smoothstep(0.1, 0.0, stCells(stM * 50.0)));
#elif defined(FINISH_ARMOR)
  // Armour plate in olive-drab paint over a rolled / cast surface texture.
  float stCast = stFbm(stP * 60.0);
  stAlbedo = mix(vec3(0.075, 0.08, 0.045), vec3(0.11, 0.11, 0.065), stN1) * (0.85 + 0.3 * stN2);
  stRough = 0.72 + 0.1 * stCast;
  stMetal = 0.0;
  stHeight += 0.0004 * stCast;
#else
  // Sprayed fireproofing (cementitious SFRM): light grey, very rough, lumpy. Noise in object space:
  // the coat is much thicker than the steel faces its texture coordinates come from.
  float stLump = stFbm(vObj * 35.0 + uSeed);
  stAlbedo = vec3(0.42, 0.41, 0.39) * (0.8 + 0.35 * stLump);
  stRough = 0.97;
  stMetal = 0.0;
  stHeight += 0.003 * stLump + 0.0008 * stNoise(vObj * 250.0);
#endif
// Chips / scars: paint → primer → bare metal; mill scale → bright steel; patina → fresh steel.
float stScar = stDet.g;
#if defined(FINISH_PAINT)
  stAlbedo = mix(stAlbedo, vec3(0.22, 0.07, 0.04), smoothstep(0.05, 0.4, stScar));
  stRough = mix(stRough, 0.7, smoothstep(0.05, 0.4, stScar));
#endif
float stBareMix = smoothstep(0.35, 0.75, stScar);
stAlbedo = mix(stAlbedo, stBare, stBareMix);
stRough = mix(stRough, 0.42 + 0.2 * stN2, stBareMix);
stMetal = mix(stMetal, 1.0, stBareMix);
// Scabs and gouges (bare metal at the bottom of a crater): grainy ductile-fracture surface.
float stFrac = stBareMix * smoothstep(0.01, 0.08, stDet.a);
stAlbedo = mix(stAlbedo, vec3(0.36, 0.35, 0.34) * (0.65 + 0.7 * stNoise(stP * 180.0)), stFrac);
stRough = mix(stRough, 0.6, stFrac);
stHeight += stFrac * 0.0005 * stNoise(stP * 240.0 + 3.0);
// Fracture surfaces and the bore of holes: fresh, grainy, rough steel.
float stLip = 1.0 - smoothstep(0.5, 0.95, stDet.r);
if (stInside) {
#ifdef FINISH_FIRE
  stAlbedo = vec3(0.36, 0.35, 0.33) * (0.7 + 0.5 * stN2);
  stRough = 0.98;
  stMetal = 0.0;
#else
  // Ductile fracture / sheared bore: matte, grey, dimpled at the grain scale; darker than rolled
  // surfaces because the micro-dimples trap light.
  stAlbedo = vec3(0.26, 0.255, 0.25) * (0.7 + 0.6 * stNoise(stP * 150.0));
  stRough = 0.78;
  stMetal = 0.85;
  stHeight += 0.0003 * stNoise(stP * 300.0);
  // The inner side of a face, seen only through a hole: the far wall of a narrow bore that the
  // shadow map cannot resolve (the thickness is below its normal bias). Treat it as the occluded
  // cavity it is.
  if (vRim < 0.5) {
    stAlbedo *= 0.3;
    stMetal = 0.5;
    stRough = 0.9;
  }
#endif
}
stAlbedo = mix(stAlbedo, vec3(0.25, 0.24, 0.23), stLip * 0.6);
// Temper colours on bare metal from the highest temperature reached.
float stTmax = max(stHt.a, vHeat);
float stBareAll = stInside ? 1.0 : max(stBareMix, stLip);
stAlbedo *= mix(vec3(1.0), stTemper(stTmax), stBareAll);
// Soot from detonation products.
float stSoot = stDet.b;
stAlbedo *= 1.0 - 0.9 * stSoot;
stRough = mix(stRough, 0.95, stSoot);
stMetal *= 1.0 - stSoot;
// Local craters (bump) — the detail alpha is depth.
stHeight -= stDet.a * uDimple;
// Temperature now: coarse field (vertex) and hot spots that spread by conduction (2-D kernel).
float stAge = max(uTime - stHt.g, 0.0);
// 2-D in-plane spot (b > 0): ΔT₀/(1 + 4αt/r²); heated wall layer (b < 0): ΔT₀·min(1, δ/√(παt)).
float stSpot = stHt.b < 0.0
  ? stHt.r * min(1.0, -stHt.b / sqrt(3.14159265 * uAlpha * max(stAge, 1e-9)))
  : stHt.r / (1.0 + 4.0 * uAlpha * stAge / max(stHt.b * stHt.b, 1e-6));
float stT = 293.15 + max(vHeat - 20.0, stSpot);
vec3 stGlowC = stBlackbody(stT) * stGlow(stT);
diffuseColor.rgb = stAlbedo;
`;

export function createSteelMaterial(o: SteelLookOptions): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial; uniforms: SteelUniforms } {
  const uniforms: SteelUniforms = {
    uDetail: { value: o.detail },
    uHeatTex: { value: o.heat },
    uTime: { value: 0 },
    uAlpha: { value: o.diffusivity },
    uSize: { value: new THREE.Vector2(o.size[0], o.size[1]) },
    uDimple: { value: o.dimpleScale },
    uPaint: { value: new THREE.Color(o.paintColor ?? 0x2b3036) },
    uSeed: { value: o.seed },
  };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.5, side: THREE.DoubleSide });
  material.defines = { [FINISH_DEFINE[o.finish]]: '' };
  if (o.split) material.defines.STEEL_SPLIT = '';
  if (o.coat) material.defines.STEEL_COAT = '';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_SURFACE}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(stRough, 0.02, 1.0);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = clamp(stMetal, 0.0, 1.0);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = stPerturb(normal, -vViewPosition, stHeight);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += stGlowC;');
  };
  material.customProgramCacheKey = () => `steel:${o.finish}:${o.split}:${!!o.coat}`;
  // Shadow pass: the same holes.
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = uniforms.uDetail;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aDUv;\nvarying vec2 vDUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDUv = aDUv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;\nvarying vec2 vDUv;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\nvec4 stD = texture2D(uDetail, vDUv);\nif (stD.r < 0.5${o.coat ? ' || stD.g > 0.4' : ''}) discard;`);
  };
  depth.customProgramCacheKey = () => `steel-depth:${!!o.coat}`;
  return { material, depth, uniforms };
}
