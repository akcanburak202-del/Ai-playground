import * as THREE from 'three';

/**
 * The look of ballistic gelatin: clear pale amber, glossy, seen through to the channels and the
 * skeleton inside. Drawn like the glass (glass/look.ts), without a screen-space transmission pass:
 * one pass multiplies what lies behind by the gel's spectral transmittance through both faces
 * (a longer path towards the silhouette), the milky channels and tears draw next, and an additive
 * pass puts the Fresnel reflections on top.
 *
 * The vertex shader opens the temporary cavity: a point at distance r from a channel moves to
 * √(r² + R²) (an incompressible gel column around a cavity of radius R), so the surface bulges
 * where the round passed, pulsates for a few milliseconds, then the block wobbles and settles.
 */

/** Cavity slots animated per gel piece (the latest hits) */
export const CAVITY_SLOTS = 4;
/** Radius samples per slot along its channel */
export const CAVITY_SAMPLES = 8;

export interface CavityUniforms {
  uCavO: { value: THREE.Vector3[] };
  uCavD: { value: THREE.Vector3[] };
  /** x: cavity opening 0..1, y: signed wobble amplitude, z: channel length, w: active */
  uCavS: { value: THREE.Vector4[] };
  uCavR: { value: Float32Array };
}

export function createCavityUniforms(): CavityUniforms {
  return {
    uCavO: { value: Array.from({ length: CAVITY_SLOTS }, () => new THREE.Vector3()) },
    uCavD: { value: Array.from({ length: CAVITY_SLOTS }, () => new THREE.Vector3(0, 0, 1)) },
    uCavS: { value: Array.from({ length: CAVITY_SLOTS }, () => new THREE.Vector4()) },
    uCavR: { value: new Float32Array(CAVITY_SLOTS * CAVITY_SAMPLES) },
  };
}

const VERTEX_DECL = /* glsl */ `
uniform vec3 uCavO[${CAVITY_SLOTS}];
uniform vec3 uCavD[${CAVITY_SLOTS}];
uniform vec4 uCavS[${CAVITY_SLOTS}];
uniform float uCavR[${CAVITY_SLOTS * CAVITY_SAMPLES}];
`;

const VERTEX_BODY = /* glsl */ `
vec3 transformed = vec3( position );
for ( int i = 0; i < ${CAVITY_SLOTS}; i ++ ) {
  vec4 S = uCavS[ i ];
  if ( S.w < 0.5 ) continue;
  vec3 rel = position - uCavO[ i ];
  vec3 dd = uCavD[ i ];
  float t = dot( rel, dd );
  float L = max( S.z, 1e-4 );
  float f = clamp( t / L, 0.0, 1.0 ) * ${(CAVITY_SAMPLES - 1).toFixed(1)};
  int k = int( floor( min( f, ${(CAVITY_SAMPLES - 1).toFixed(1)} - 0.001 ) ) );
  float R = mix( uCavR[ i * ${CAVITY_SAMPLES} + k ], uCavR[ i * ${CAVITY_SAMPLES} + k + 1 ], f - float( k ) );
  R *= smoothstep( -0.04, 0.0, t ) * ( 1.0 - smoothstep( L, L + 0.04, t ) );
  vec3 radial = rel - t * dd;
  float r = length( radial );
  vec3 rn = r > 1e-5 ? radial / r : vec3( 0.0 );
  float Rc = R * S.x;
  float disp = sqrt( r * r + Rc * Rc ) - r + S.y * R * R / max( r, 0.02 );
  transformed += rn * disp;
}
`;

/**
 * Spectral transmittance of the gel through one piece at normal incidence (linear RGB): 10 %
 * gelatin is clear with a pale amber cast; ≈ 20 cm of it passes ≈ 90 % red, 75 % green, 45 % blue.
 */
export const GEL_TINT = new THREE.Color(0.9, 0.75, 0.45);

const TRANSMISSION_VERTEX = /* glsl */ `
${VERTEX_DECL}
varying vec3 vViewPos;
varying vec3 vViewNormal;
void main() {
  ${VERTEX_BODY}
  vec4 mv = modelViewMatrix * vec4( transformed, 1.0 );
  vViewPos = mv.xyz;
  vViewNormal = normalize( normalMatrix * normal );
  gl_Position = projectionMatrix * mv;
}
`;

const TRANSMISSION_FRAGMENT = /* glsl */ `
uniform vec3 uTint;
uniform vec4 uPath;
varying vec3 vViewPos;
varying vec3 vViewNormal;
void main() {
  // Path length through the gel grows towards the silhouette (a thick body seen edge-on), and the
  // Fresnel reflection at the surface (Schlick, F0 = 0.02 for n = 1.34) takes its share. Front
  // and back faces each carry part of the path (uPath.xy front, .zw back: face-on, edge-on).
  float c = clamp( abs( dot( normalize( vViewPos ), normalize( vViewNormal ) ) ), 0.0, 1.0 );
  vec2 p = gl_FrontFacing ? uPath.xy : uPath.zw;
  float path = mix( p.y, p.x, c );
  float F = 0.02 + 0.98 * pow( 1.0 - c, 5.0 );
  gl_FragColor = vec4( pow( uTint, vec3( path ) ) * ( 1.0 - F ), 1.0 );
}
`;

export interface GelMaterials {
  /**
   * Multiplies what lies behind by the gel's transmittance, both faces in one draw (multiplying is
   * order-independent, so front and back faces need no sorting)
   */
  transmission: THREE.ShaderMaterial;
  /** Adds the surface reflection and the faint scattered glow of the gel (front faces) */
  surface: THREE.MeshPhysicalMaterial;
}

function transmission(cav: CavityUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'gel-transmission',
    uniforms: { ...cav, uTint: { value: GEL_TINT }, uPath: { value: new THREE.Vector4(0.45, 1.6, 0.45, 0.8) } },
    vertexShader: TRANSMISSION_VERTEX,
    fragmentShader: TRANSMISSION_FRAGMENT,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}

/**
 * The two passes of one gel piece, both displaced by its cavity uniforms: an order-independent
 * multiply (dst · T) through front and back faces, then — after the channels — an additive surface
 * pass (reflections of sky and sun on the wet-glossy gel, n = 1.34, and a little light scattered
 * inside it).
 */
export function gelMaterials(cav: CavityUniforms): GelMaterials {
  const surface = new THREE.MeshPhysicalMaterial({
    color: 0x2a1a08,
    roughness: 0.06,
    metalness: 0,
    ior: 1.34,
    specularIntensity: 1,
    clearcoat: 0.4,
    clearcoatRoughness: 0.03,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  surface.name = 'gel-surface';
  surface.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, cav);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERTEX_DECL}`).replace('#include <begin_vertex>', VERTEX_BODY);
  };
  surface.customProgramCacheKey = () => 'ballistic-gel-surface-v1';
  return { transmission: transmission(cav), surface };
}

/**
 * Materials every gel piece shares (channels, tears, bone, bullets, the stand), reference-counted
 * so the last piece to go disposes them.
 */
export class GelLook {
  private static shared: GelLook | null = null;
  private static refs = 0;
  // Crushed and torn gel scatters light: the channel reads milky white, the tears as bright flakes.
  readonly channel = new THREE.MeshStandardMaterial({ color: 0xfffaf0, emissive: 0x1c160c, roughness: 0.55, transparent: true, opacity: 0.85, depthWrite: false });
  readonly tear = new THREE.MeshStandardMaterial({ color: 0xfffbf2, emissive: 0x14100a, roughness: 0.35, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
  readonly bone = new THREE.MeshStandardMaterial({ color: 0xe4d9c1, roughness: 0.58 });
  readonly boneInside = new THREE.MeshStandardMaterial({ color: 0xcfbf9c, roughness: 0.8, side: THREE.DoubleSide });
  readonly hole = new THREE.MeshBasicMaterial({ color: 0x2c2018 });
  readonly bullet = new THREE.MeshStandardMaterial({ color: 0xb8753a, metalness: 0.85, roughness: 0.35 });
  readonly chunk = new THREE.MeshPhysicalMaterial({
    color: 0xecd08e, roughness: 0.08, clearcoat: 0.5, transparent: true, opacity: 0.42, depthWrite: false, emissive: 0x2a1604,
  });
  readonly steel = new THREE.MeshStandardMaterial({ color: 0x3a3e42, roughness: 0.45, metalness: 0.75 });

  static acquire(): GelLook {
    if (!GelLook.shared) GelLook.shared = new GelLook();
    GelLook.refs++;
    return GelLook.shared;
  }

  static release(): void {
    if (--GelLook.refs > 0 || !GelLook.shared) return;
    const s = GelLook.shared;
    for (const m of [s.channel, s.tear, s.bone, s.boneInside, s.hole, s.bullet, s.chunk, s.steel]) m.dispose();
    GelLook.shared = null;
    GelLook.refs = 0;
  }
}

/** Render order of the gel passes: transmission, channels, surface (all before particles at 10). */
export const ORDER_TRANSMISSION = 1, ORDER_CHANNEL = 2, ORDER_SURFACE = 3;
