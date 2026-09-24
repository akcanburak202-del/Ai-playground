import * as THREE from 'three';
import { SITE_JITTER, NEVER } from './dicing.ts';
import { CRACK_SPEED } from './model.ts';

/**
 * How glass is drawn. A thin pane is split into two order-independent passes instead of one alpha
 * blend (which cannot tint what is behind it per colour channel):
 *
 *   transmission pass   dst ← dst · T        T = τ^(t/cosθ_t) · (1 − R_slab(θ)) · frost/crack losses
 *   reflection pass     dst ← dst + L_r      Fresnel-weighted environment + sun (MeshPhysicalMaterial)
 *
 * T and R come from the same Fresnel term (Schlick with F0 = 0.04, both faces of the slab:
 * R = 2F/(1 + F), Born & Wolf), so energy is conserved and reflections take over at grazing angles.
 * Neither pass writes depth, and multiply-then-add of several panes is nearly order-independent, so
 * overlapping panes need no sorting. Holes, frost, cracks and the tempered crazing are read from the
 * per-pane damage texture (see raster.ts) and the shared dicing GLSL.
 */

export interface GlassUniforms {
  [k: string]: THREE.IUniform;
  uCrack: THREE.IUniform<THREE.Texture>;
  /** (width, height, thickness, seed) */
  uPane: THREE.IUniform<THREE.Vector4>;
  /** Internal transmittance at normal incidence through the full thickness (linear RGB) */
  uTint: THREE.IUniform<THREE.Color>;
  uTime: THREE.IUniform<number>;
  /** Tempered fracture: (origin x, origin y in pane-corner metres, start time, active) */
  uBreak: THREE.IUniform<THREE.Vector4>;
  /** (hold s, unzip m/s, frame bite m, corner fitting radius m) */
  uCollapse: THREE.IUniform<THREE.Vector4>;
  /** (cluster cell s, visual die size d) */
  uDice: THREE.IUniform<THREE.Vector2>;
  /** Pane-wide milkiness 0..1 (PVB delamination of blast-loaded laminated glass) */
  uHaze: THREE.IUniform<number>;
}

export function createGlassUniforms(crack: THREE.Texture, w: number, h: number, t: number, seed: number, tint: THREE.Color): GlassUniforms {
  return {
    uCrack: { value: crack },
    uPane: { value: new THREE.Vector4(w, h, t, seed) },
    uTint: { value: tint },
    uTime: { value: 0 },
    uBreak: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCollapse: { value: new THREE.Vector4(0.05, 10, 0, 0) },
    uDice: { value: new THREE.Vector2(0.008, 0.008) },
    uHaze: { value: 0 },
  };
}

/** Integer hash and dicing sites — must stay bit-identical to dicing.ts. */
const DICING_GLSL = /* glsl */ `
uniform sampler2D uCrack;
uniform vec4 uPane;
uniform vec3 uTint;
uniform float uTime;
uniform vec4 uBreak;
uniform vec4 uCollapse;
uniform vec2 uDice;
uniform float uHaze;

uint gHash(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
float gHash01(int i, int j, uint salt) {
  uint inner = gHash(uint(j) + salt * 0x85ebca77u);
  uint h = gHash((uint(i) * 0x9e3779b1u) ^ inner);
  return float(h & 0xffffffu) / 16777216.0;
}
vec2 gSite(int i, int j, float s, uint salt) {
  vec2 q = (vec2(float(i), float(j)) + 0.5 + (vec2(gHash01(i, j, salt), gHash01(i, j, salt + 1u)) - 0.5) * ${SITE_JITTER.toFixed(4)}) * s;
  float m = 0.3 * s;
  return clamp(q, vec2(m), uPane.xy - m);
}
float gRelease(vec2 site, int i, int j, uint salt) {
  vec2 P = uPane.xy;
  if (uCollapse.z > 0.0 && min(min(site.x, site.y), min(P.x - site.x, P.y - site.y)) < uCollapse.z) return ${NEVER.toFixed(1)};
  if (uCollapse.w > 0.0) {
    vec2 c = min(site, P - site);
    if (dot(c, c) < uCollapse.w * uCollapse.w) return ${NEVER.toFixed(1)};
  }
  float r = length(site - uBreak.xy);
  return uBreak.z + r / ${CRACK_SPEED.toFixed(1)} + uCollapse.x * (0.5 + gHash01(i, j, salt + 2u)) + r / uCollapse.y;
}

struct GlassState {
  float crack;
  float frost;
  float hole;
  vec2 crackDir;
  vec2 facet;
  float crazed;
  float lod;
  float glint;
  /** The line of sight meets the fracture face of a hole within the glass thickness (0..1) */
  float edge;
  /** In-plane normal of that fracture face (pane x, y), pointing into the hole */
  vec2 edgeN;
};

/**
 * Fracture faces of holes without rim geometry: the view ray entering at uv crosses the slab to
 * the other face (refracted, Snell n = 1.52, or straight through the air of a hole); where one end
 * is glass and the other hole, it meets the fracture face on the way — a band t·tan θ wide, zero
 * head-on and widening at grazing angles, exactly as the walls of a real hole show.
 */
void glassEdge(inout GlassState g, vec2 uv, vec3 objView) {
  vec3 V = normalize(objView);
  vec2 tIn = -V.xy / 1.52;
  vec2 run = g.hole > 0.5 ? -V.xy / max(abs(V.z), 0.05) : tIn / sqrt(max(1.0 - dot(tIn, tIn), 0.05));
  run *= uPane.z;
  if (dot(run, run) < 1e-10) return;
  vec2 uv2 = uv + run / uPane.xy;
  float far = texture(uCrack, uv2, -0.75).b;
  float e = g.hole > 0.5 ? 1.0 - far : far * (1.0 - g.hole);
  if (e < 0.02) return;
  g.edge = e;
  // Face orientation: gradient of the hole channel half-way across.
  vec2 px = 1.0 / vec2(textureSize(uCrack, 0));
  vec2 m = uv + 0.5 * run / uPane.xy;
  vec2 gr = vec2(texture(uCrack, m + vec2(px.x, 0.0)).b - texture(uCrack, m - vec2(px.x, 0.0)).b,
                 texture(uCrack, m + vec2(0.0, px.y)).b - texture(uCrack, m - vec2(0.0, px.y)).b) / (px * uPane.xy);
  g.edgeN = dot(gr, gr) > 1e-8 ? normalize(gr) : normalize(run);
}

GlassState glassState(vec2 uv, float shard, vec3 objView) {
  GlassState g;
  // Slightly sharpened lookup (LOD bias): hairline cracks stay visible a little further away, as
  // they do in reality because they catch the light.
  vec4 c = texture(uCrack, uv, -0.75);
  g.crack = min(1.0, 1.5 * c.r);
  g.frost = c.g;
  g.hole = shard > 0.5 ? 0.0 : c.b;
  float ang = c.a * 3.14159265;
  g.crackDir = vec2(-sin(ang), cos(ang));
  g.facet = vec2(0.0);
  g.crazed = 0.0;
  g.lod = 0.0;
  g.glint = 0.0;
  g.edge = 0.0;
  g.edgeN = vec2(0.0);
  if (shard < 0.5) glassEdge(g, uv, objView);
  if (uHaze > 0.0) {
    // Blotchy whitening (value noise on a ~4 cm lattice).
    vec2 q = uv * uPane.xy / 0.04;
    vec2 i0 = floor(q), f = fract(q);
    f = f * f * (3.0 - 2.0 * f);
    uint hs = uint(uPane.w) + 31u;
    float n = mix(mix(gHash01(int(i0.x), int(i0.y), hs), gHash01(int(i0.x) + 1, int(i0.y), hs), f.x),
                  mix(gHash01(int(i0.x), int(i0.y) + 1, hs), gHash01(int(i0.x) + 1, int(i0.y) + 1, hs), f.x), f.y);
    g.frost = max(g.frost, uHaze * (0.35 + 0.65 * n));
  }
  if (uBreak.w > 0.5) {
    vec2 p = uv * uPane.xy;
    vec2 rel = p - uBreak.xy;
    float r = length(rel);
    float front = (uTime - uBreak.z) * ${CRACK_SPEED.toFixed(1)};
    // The front is not a perfect circle: branching cracks lead and lag by a few per cent.
    float th = atan(rel.y, rel.x);
    float wob = 1.0 + 0.045 * sin(5.0 * th + uPane.w) + 0.03 * sin(11.0 * th - 0.7 * uPane.w) + 0.02 * sin(23.0 * th);
    if (r < front * wob + 0.004) {
      uint salt = uint(uPane.w);
      // Released dice: nearest cluster site whose release time has passed leaves a hole.
      float s = uDice.x;
      ivec2 cc = ivec2(floor(p / s));
      float best = 1e9; ivec2 bi = cc; vec2 bs = p;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        ivec2 q = cc + ivec2(x, y);
        if (q.x < 0 || q.y < 0) continue;
        vec2 st = gSite(q.x, q.y, s, salt);
        float d = dot(st - p, st - p);
        if (d < best) { best = d; bi = q; bs = st; }
      }
      if (shard < 0.5 && uTime >= gRelease(bs, bi.x, bi.y, salt)) {
        g.hole = 1.0;
        g.edge = 0.0;
      }
      // The visible crazing: Voronoi of the dice (edge distance, Quilez 2012 two-pass method).
      float d = uDice.y;
      uint vsalt = abs(s - d) < 1e-6 ? salt : salt + 17u;
      ivec2 dc = ivec2(floor(p / d));
      float b1 = 1e9; vec2 a = p; ivec2 ai = dc;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        ivec2 q = dc + ivec2(x, y);
        if (q.x < 0 || q.y < 0) continue;
        vec2 st = gSite(q.x, q.y, d, vsalt);
        float dd = dot(st - p, st - p);
        if (dd < b1) { b1 = dd; a = st; ai = q; }
      }
      // A die only shows once the front has reached it (a jagged, die-by-die front edge).
      if (length(a - uBreak.xy) < front * wob) {
        float md = 1e9; vec2 en = vec2(1.0, 0.0);
        for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
          ivec2 q = ai + ivec2(x, y);
          if (q.x < 0 || q.y < 0 || q == ai) continue;
          vec2 st = gSite(q.x, q.y, d, vsalt);
          vec2 dir = st - a;
          float l = length(dir);
          if (l < 1e-7) continue;
          dir /= l;
          float e = dot(0.5 * (a + st) - p, dir);
          if (e < md) { md = e; en = dir; }
        }
        float fw = length(fwidth(p));
        float lineW = 0.00025 + 0.5 * fw;
        float line = 1.0 - smoothstep(lineW, lineW + fw, md);
        // Far away the network is below a pixel: keep its average darkening and let the random
        // facet orientations show as glitter instead of aliasing lines.
        float lod = smoothstep(0.15 * d, 0.6 * d, fw);
        line = mix(line, 0.22, lod);
        g.crazed = 1.0;
        g.lod = lod;
        g.crack = max(g.crack, line);
        if (line > 0.3) g.crackDir = en;
        float h1 = gHash01(ai.x, ai.y, vsalt + 5u), h2 = gHash01(ai.x, ai.y, vsalt + 6u);
        g.facet = (vec2(h1, h2) - 0.5) * 0.22;
        g.glint = step(0.93, gHash01(ai.x, ai.y, vsalt + 7u));
        // Fresh micro-cracking right behind the running tips.
        g.frost = max(g.frost, 0.3 * (1.0 - smoothstep(0.0, 0.04, front * wob - r)));
      }
    }
  }
  return g;
}

/** Cotangent frame from screen-space derivatives (Schüler 2013), valid for flat, bent and moving glass. */
void glassFrame(vec3 N, vec3 viewPos, vec2 uv, out vec3 T, out vec3 B) {
  vec3 q0 = dFdx(viewPos), q1 = dFdy(viewPos);
  vec2 st0 = dFdx(uv), st1 = dFdy(uv);
  vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
  T = q1perp * st0.x + q0perp * st1.x;
  B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  T *= sc;
  B *= sc;
}
`;

/** Shards: per-piece rigid transforms from a float texture (3 texels = a 3×4 matrix per shard). */
const SHARD_VERTEX_PARS = /* glsl */ `
#ifdef GLASS_SHARDS
uniform highp sampler2D uShardTex;
attribute float aShard;
mat4 shardMatrix() {
  int k = int(aShard + 0.5);
  vec4 r0 = texelFetch(uShardTex, ivec2(0, k), 0);
  vec4 r1 = texelFetch(uShardTex, ivec2(1, k), 0);
  vec4 r2 = texelFetch(uShardTex, ivec2(2, k), 0);
  return transpose(mat4(r0, r1, r2, vec4(0.0, 0.0, 0.0, 1.0)));
}
#endif
`;

export interface GlassPassOptions {
  shards?: boolean;
  shardTex?: THREE.IUniform<THREE.Texture | null>;
}

/**
 * Reflection pass: MeshPhysicalMaterial (IOR 1.52, slab reflectance through specularIntensity)
 * with black diffuse, except where the glass is crushed (frost scatters diffusely) and at cut
 * edges (light piped along the pane leaves through the edge, tinted by the long path). Crack faces
 * act as tiny mirrors standing perpendicular to the surface: their normal is blended into the
 * shading normal so cracks glint where the sun lines up and read as dark or bright lines elsewhere.
 */
export function createReflectionMaterial(u: GlassUniforms, o: GlassPassOptions = {}): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    roughness: 0.035,
    metalness: 0,
    ior: 1.52,
    // Two faces: R_slab ≈ 2F/(1+F) → F0 ≈ 0.077 (F90 stays 1).
    specularIntensity: 1.92,
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
  m.name = o.shards ? 'glass-shard-reflection' : 'glass-reflection';
  if (o.shards) m.defines = { GLASS_SHARDS: '' };
  const shardU = o.shardTex ?? { value: null };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.uniforms.uShardTex = shardU;
    shader.uniforms.uShardMode = { value: o.shards ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aRim;\nvarying vec2 vGlassUv;\nvarying float vRim;\nvarying vec3 vObjView;\n${SHARD_VERTEX_PARS}`)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvGlassUv = uv;\nvRim = aRim;')
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n#ifdef GLASS_SHARDS\nmat4 shardM = shardMatrix();\nobjectNormal = mat3(shardM) * objectNormal;\n#endif',
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        mat3 gRot = mat3(modelMatrix);
        #ifdef GLASS_SHARDS
        transformed = (shardM * vec4(transformed, 1.0)).xyz;
        gRot = gRot * mat3(shardM);
        #endif
        // Eye direction in the pane's own (uv-aligned) frame; the transforms are rigid.
        vObjView = transpose(gRot) * (cameraPosition - (modelMatrix * vec4(transformed, 1.0)).xyz);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vGlassUv;\nvarying float vRim;\nvarying vec3 vObjView;\nuniform float uShardMode;\n${DICING_GLSL}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        GlassState gs = glassState(vGlassUv, uShardMode, vObjView);
        float gCover = max(1.0 - gs.hole, gs.edge);
        if (gCover < 0.004) discard;
        vec3 frostCol = mix(vec3(0.80, 0.84, 0.83), uTint, 0.25);
        diffuseColor.rgb = frostCol * min(1.0, 0.7 * gs.frost + 0.08 * gs.crack + 0.1 * gs.crazed);
        // Fracture faces: conchoidal chipping at the lips scatters a little, tinted by the glass.
        diffuseColor.rgb = mix(diffuseColor.rgb, pow(uTint, vec3(2.0)) * 0.22, gs.edge);
        if (vRim > 0.5) diffuseColor.rgb = pow(uTint, vec3(4.0)) * 0.3;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.6, max(gs.frost, vRim * 0.8));
        roughnessFactor = mix(roughnessFactor, 0.25, gs.crack);
        roughnessFactor = mix(roughnessFactor, 0.18, gs.edge);
        // Sub-pixel dice facets scatter the reflection (a rough mirror), except the few that line up.
        roughnessFactor = mix(roughnessFactor, 0.22, gs.crazed * gs.lod * (1.0 - gs.glint));`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        if (vRim < 0.5) {
          vec3 gT, gB;
          glassFrame(normal, -vViewPosition, vGlassUv, gT, gB);
          vec3 cn = gT * gs.crackDir.x + gB * gs.crackDir.y;
          if (dot(cn, cn) > 1e-6) {
            cn = normalize(cn);
            if (dot(cn, normalize(vViewPosition)) < 0.0) cn = -cn;
            normal = normalize(mix(normal, normalize(0.35 * normal + 0.94 * cn), 0.92 * gs.crack));
          }
          normal = normalize(normal + (gT * gs.facet.x + gB * gs.facet.y) * gs.crazed);
          if (gs.edge > 0.0 && dot(gT, gT) > 1e-12 && dot(gB, gB) > 1e-12) {
            // The hole wall stands across the pane: its normal is in-plane, facing the eye.
            vec3 en = normalize(normalize(gT) * gs.edgeN.x + normalize(gB) * gs.edgeN.y);
            if (dot(en, vViewPosition) < 0.0) en = -en;
            normal = normalize(mix(normal, en, gs.edge));
          }
        }`,
      )
      .replace('#include <opaque_fragment>', 'outgoingLight *= gCover;\n#include <opaque_fragment>')
      // Float glass is optically flat: allow a much tighter sun highlight than three's default
      // roughness floor (which exists to hide cube-map mip aliasing on rough materials).
      .replace('#include <lights_physical_fragment>', THREE.ShaderChunk.lights_physical_fragment.replace('max( roughnessFactor, 0.0525 )', 'max( roughnessFactor, 0.015 )'));
  };
  m.customProgramCacheKey = () => (o.shards ? 'glass-refl-shards' : 'glass-refl');
  return m;
}

const TRANSMISSION_VERTEX = /* glsl */ `
attribute float aRim;
varying vec2 vGlassUv;
varying float vRim;
varying vec3 vNrm;
varying vec3 vView;
varying vec3 vObjView;
${SHARD_VERTEX_PARS}
void main() {
  vGlassUv = uv;
  vRim = aRim;
  vec3 p = position;
  vec3 n = normal;
  mat3 rot = mat3(modelMatrix);
#ifdef GLASS_SHARDS
  mat4 sm = shardMatrix();
  p = (sm * vec4(p, 1.0)).xyz;
  n = mat3(sm) * n;
  rot = rot * mat3(sm);
#endif
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = -mv.xyz;
  vNrm = normalize(normalMatrix * n);
  vObjView = transpose(rot) * (cameraPosition - (modelMatrix * vec4(p, 1.0)).xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const TRANSMISSION_FRAGMENT = /* glsl */ `
varying vec2 vGlassUv;
varying float vRim;
varying vec3 vNrm;
varying vec3 vView;
varying vec3 vObjView;
uniform float uShardMode;
${DICING_GLSL}
void main() {
  GlassState gs = glassState(vGlassUv, uShardMode, vObjView);
  float cover = max(1.0 - gs.hole, gs.edge);
  if (cover < 0.004) discard;
  float cosV = clamp(abs(dot(normalize(vNrm), normalize(vView))), 0.0, 1.0);
  // Schlick Fresnel at one face, both faces of the slab: R = 2F / (1 + F).
  float F = 0.04 + 0.96 * pow(1.0 - cosV, 5.0);
  float R = 2.0 * F / (1.0 + F);
  // Beer–Lambert along the refracted path: t / cos θ_t, Snell with n = 1.52.
  float cosT = sqrt(max(1.0 - (1.0 - cosV * cosV) / 2.3104, 0.05));
  vec3 T = pow(max(uTint, vec3(1e-3)), vec3(1.0 / cosT)) * (1.0 - R);
  // Seen through a cut edge the light has run a long way inside the glass: dark sea green.
  if (vRim > 0.5) T = pow(max(uTint, vec3(1e-3)), vec3(7.0)) * 0.85;
  // Through a fracture face the view is bent and partly totally reflected: a dark green band.
  T = mix(T, pow(max(uTint, vec3(1e-3)), vec3(3.0)) * 0.3, gs.edge);
  T *= (1.0 - 0.85 * gs.frost) * (1.0 - 0.92 * gs.crack) * (1.0 - 0.4 * gs.crazed);
  gl_FragColor = vec4(mix(vec3(1.0), T, cover), 1.0);
  #include <colorspace_fragment>
}
`;

/** Transmission pass: multiplies what is behind by the pane's spectral transmittance. */
export function createTransmissionMaterial(u: GlassUniforms, o: GlassPassOptions = {}): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name: o.shards ? 'glass-shard-transmission' : 'glass-transmission',
    uniforms: { ...u, uShardTex: o.shardTex ?? { value: null }, uShardMode: { value: o.shards ? 1 : 0 } },
    vertexShader: TRANSMISSION_VERTEX,
    fragmentShader: TRANSMISSION_FRAGMENT,
    defines: o.shards ? { GLASS_SHARDS: '' } : {},
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.FrontSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  return m;
}

// ─── Dice ────────────────────────────────────────────────────────────────────────────────

/**
 * Tempered-glass dice: one instanced draw for the whole scene, motion evaluated in the vertex shader
 * from the launch state (closed-form drag flight, one hop, slide, rest — see dicing.ts), so nothing
 * is uploaded per frame. Opaque, faceted and glossy: each die tumbles and flashes the sun.
 */
const DICE_VERTEX_PARS = /* glsl */ `
attribute vec3 aP0;
attribute vec3 aV0;
attribute vec4 aT;
attribute vec4 aS;
attribute vec4 aQ;
attribute vec4 aE;
uniform float uTime;
varying vec3 vDiceTint;
varying vec3 vDieLocal;
varying vec3 vDieSize;
varying vec3 vDieNrm;
varying float vDieCell;
vec3 qRot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec4 qMul(vec4 a, vec4 b) { return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz)); }
vec4 qAxis(vec3 ax, float an) { return vec4(ax * sin(0.5 * an), cos(0.5 * an)); }
float dragA(float c, float t) { float ct = c * t; return ct < 1e-3 ? t * (1.0 - 0.5 * ct + ct * ct / 6.0) : (1.0 - exp(-ct)) / c; }
float dragB(float c, float t) { float ct = c * t; return ct < 1e-3 ? 0.5 * t * t * (1.0 - ct / 3.0 + ct * ct / 12.0) : (t - (1.0 - exp(-ct)) / c) / c; }
vec3 gDicePos; vec4 gDiceRot; float gDiceScale;
void diceState() {
  const float G = 9.80665;
  const float E = 0.3;
  const float MU = 0.5;
  float t = uTime - aT.x;
  float c = aT.z, t1 = aT.y, seed = aT.w;
  gDiceScale = (t < 0.0 ? 0.0 : 1.0) * (1.0 - clamp((uTime - aE.y) / 1.5, 0.0, 1.0));
  t = max(t, 0.0);
  vec3 axis = normalize(vec3(fract(seed * 127.13) - 0.5, fract(seed * 311.71) - 0.5, fract(seed * 74.77) - 0.5) + 1e-4);
  float spin = mix(6.0, 40.0, fract(seed * 43.31)) * min(1.0, length(aV0) * 0.4 + 0.25);
  float tf = min(t, t1);
  vec3 g = vec3(0.0, -G, 0.0);
  vec3 p = aP0 + aV0 * dragA(c, tf) + g * dragB(c, tf);
  float tumble = min(t, t1);
  float settle = 0.0;
  if (t > t1) {
    float e1 = exp(-c * t1);
    vec3 v1 = aV0 * e1 + g * dragA(c, t1);
    float vn = max(0.0, -v1.y);
    float vhl = length(v1.xz);
    float keep = vhl > 1e-6 ? max(0.0, 1.0 - MU * (1.0 + E) * vn / vhl) : 0.0;
    vec2 hv = v1.xz * keep;
    float hop = E * vn;
    float t2 = hop > 0.3 ? 2.0 * hop / G : 0.0;
    float th = min(t - t1, t2);
    p.xz += hv * th;
    p.y = aS.w + hop * th - 0.5 * G * th * th;
    tumble += th;
    if (t > t1 + t2) {
      float vs = length(hv);
      float t3 = vs / (MU * G);
      float ts = min(t - t1 - t2, t3);
      p.xz += hv * (ts - 0.5 * ts * ts / max(t3, 1e-6));
      p.y = aS.w;
      settle = clamp((t - t1 - t2) / max(t3, 0.12), 0.0, 1.0);
    }
  }
  vec4 q = qMul(qAxis(axis, spin * tumble), aQ);
  // Resting pose: a face down (mostly the broad face), random heading.
  float k = fract(seed * 17.31);
  vec4 lie = k < 0.6 ? vec4(-0.70710678, 0.0, 0.0, 0.70710678) : k < 0.8 ? vec4(0.0, 0.0, 0.70710678, 0.70710678) : vec4(0.0, 0.0, 0.0, 1.0);
  vec4 rest = qMul(qAxis(vec3(0.0, 1.0, 0.0), 6.2831853 * fract(seed * 91.7)), lie);
  if (dot(q, rest) < 0.0) rest = -rest;
  gDiceRot = normalize(mix(q, rest, settle * settle * (3.0 - 2.0 * settle)));
  gDicePos = p;
  // Albedo packed as 8-bit RGB in one float (exact below 2^24).
  float c8 = aE.x;
  vDiceTint = vec3(floor(c8 / 65536.0), mod(floor(c8 / 256.0), 256.0), mod(c8, 256.0)) / 255.0;
  vDieCell = aE.z;
}
`;

export function createDiceMaterial(time: THREE.IUniform<number>): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0, flatShading: true });
  m.name = 'glass-dice';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DICE_VERTEX_PARS}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\ndiceState();\nobjectNormal = qRot(gDiceRot, objectNormal);')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        // Irregular dice: every corner of the unit box moves by a per-die hash.
        vec3 corner = step(0.0, position);
        float h = fract(sin(dot(corner + aT.w * 13.1, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        vec3 local = position * (0.8 + 0.4 * vec3(h, fract(h * 7.1), fract(h * 3.7)));
        transformed = gDicePos + qRot(gDiceRot, local * aS.xyz * gDiceScale);
        vDieLocal = position * aS.xyz;
        vDieSize = aS.xyz;
        vDieNrm = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDiceTint;\nvarying vec3 vDieLocal;\nvarying vec3 vDieSize;\nvarying vec3 vDieNrm;\nvarying float vDieCell;')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        diffuseColor.rgb *= vDiceTint;
        // Clusters of dice still interlocked (large panes throw clumps): the dicing cracks on their faces.
        vec3 an = abs(vDieNrm);
        vec2 fp = an.x > 0.5 ? vDieLocal.yz : an.y > 0.5 ? vDieLocal.xz : vDieLocal.xy;
        vec2 sz = an.x > 0.5 ? vDieSize.yz : an.y > 0.5 ? vDieSize.xz : vDieSize.xy;
        vec2 q = (fp + 0.5 * sz) / max(vDieCell, 1e-4);
        q += 0.12 * sin(q.yx * 2.7 + vDieSize.x * 900.0);
        vec2 f = min(fract(q), 1.0 - fract(q));
        float ln = 0.0;
        if (sz.x > 1.4 * vDieCell) ln = max(ln, 1.0 - smoothstep(0.02, 0.09, f.x));
        if (sz.y > 1.4 * vDieCell) ln = max(ln, 1.0 - smoothstep(0.02, 0.09, f.y));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.8, 0.78), 0.55 * ln);`,
      );
  };
  m.customProgramCacheKey = () => 'glass-dice';
  return m;
}

// ─── Heap decal ──────────────────────────────────────────────────────────────────────────

/**
 * Settled dice become a flat, glittering heap: a ground quad whose density texture (where the dice
 * came to rest) masks a procedural mosaic of dice facets, each with its own tilt so the heap
 * sparkles as the viewer moves.
 */
export function createHeapMaterial(density: THREE.Texture, size: THREE.Vector2, dieSize: number, tint: THREE.Color, fade: THREE.IUniform<THREE.Vector2>, time: THREE.IUniform<number>): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.1, metalness: 0, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  m.name = 'glass-heap';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uDensity = { value: density };
    shader.uniforms.uHeapSize = { value: size };
    shader.uniforms.uDie = { value: dieSize };
    shader.uniforms.uHeapTint = { value: tint };
    shader.uniforms.uFade = fade;
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vHeapUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvHeapUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec2 vHeapUv;
        uniform sampler2D uDensity;
        uniform vec2 uHeapSize;
        uniform float uDie;
        uniform vec3 uHeapTint;
        uniform vec2 uFade;
        uniform float uTime;
        vec2 heapHash(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
        vec3 gHeapFacet;
        float gHeapEdge;`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        float dens = texture2D(uDensity, vHeapUv).r;
        vec2 hp = vHeapUv * uHeapSize / uDie;
        vec2 cell = floor(hp);
        float b1 = 9.0, b2 = 9.0; vec2 id = cell;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          vec2 q = cell + vec2(float(x), float(y));
          vec2 s = q + 0.5 + (heapHash(q) - 0.5) * 0.8;
          float d = length(s - hp);
          if (d < b1) { b2 = b1; b1 = d; id = q; } else if (d < b2) b2 = d;
        }
        vec2 r = heapHash(id + 7.0);
        // Coverage grows with density; a die is present if its random rank is below the density.
        float present = step(r.x, dens * 1.35);
        gHeapEdge = smoothstep(0.02, 0.1, b2 - b1);
        gHeapFacet = normalize(vec3((r - 0.5) * 0.9, 1.0));
        float appear = clamp((uTime - uFade.x) / max(uFade.y, 1e-3), 0.0, 1.0);
        diffuseColor.a = present * appear * gHeapEdge * smoothstep(0.02, 0.12, dens);
        diffuseColor.rgb = uHeapTint * (0.55 + 0.45 * r.y);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(gHeapFacet.x, gHeapFacet.z, gHeapFacet.y, 0.0)).xyz);`,
      );
  };
  m.customProgramCacheKey = () => 'glass-heap';
  return m;
}

// ─── Fittings ────────────────────────────────────────────────────────────────────────────

/** Polished stainless point fixings (rotule bolts) for frameless glazing. */
export function createFittingMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xd8dadc, metalness: 1, roughness: 0.18 });
  m.name = 'glass-fitting';
  return m;
}
