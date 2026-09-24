import * as THREE from 'three';
import { RELIEF_DEEP, RELIEF_SPAN } from './relief.ts';

export type PlazaFinish = 'pavers' | 'travertine' | 'concrete';

export interface GroundMaterialOptions {
  noise: THREE.Texture;
  splat: THREE.Texture;
  /** World rectangle covered by the splat texture: x0, z0, size */
  splatRect: [number, number, number];
  plaza: { halfX: number; halfZ: number; finish: PlazaFinish } | null;
}

export const FINISH_ID: Record<PlazaFinish, number> = { pavers: 0, travertine: 1, concrete: 2 };

/**
 * World-space procedural ground: the plaza finish (granite setts in running bond with sand joints
 * and bevels, honed travertine slabs with voids and bedding bands, or broom-finished concrete with
 * saw cuts), a granite curb, and golden-hour grass / soil beyond; then the dynamic splat on top:
 * soot and scorch, disturbed soil and ejecta, shattered paving. Albedo, roughness and a bump
 * normal are all derived from one analytic height/colour field so they stay consistent at any
 * distance (filter widths come from screen-space derivatives).
 */
export function createGroundMaterial(o: GroundMaterialOptions): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  m.name = 'ground';
  const uniforms = {
    uNoise: { value: o.noise },
    uSplat: { value: o.splat },
    uSplatRect: { value: new THREE.Vector4(o.splatRect[0], o.splatRect[1], o.splatRect[2], 1 / o.splatRect[2]) },
    uPlaza: { value: new THREE.Vector4(o.plaza?.halfX ?? 0, o.plaza?.halfZ ?? 0, 0.3, o.plaza ? 1 : 0) },
    uFinish: { value: o.plaza ? FINISH_ID[o.plaza.finish] : 0 },
  };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGWorld;\nvarying vec3 vGNormal;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvGWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvGNormal = normalize(mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GROUND_GLSL}`)
      .replace('#include <map_fragment>', 'GroundSample gs = groundSample(vGWorld.xz);\ndiffuseColor.rgb *= gs.albedo;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * gs.roughness;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec3 gn = normalize(mix(vGNormal, gs.relief, gs.reliefW));
          vec3 wn = normalize(gn + vec3(-gs.slope.x, 0.0, -gs.slope.y));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`,
      )
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= gs.cavity;\nreflectedLight.indirectSpecular *= gs.cavity;');
  };
  m.customProgramCacheKey = () => 'destruction-ground-v1';
  return m;
}

const GROUND_GLSL = /* glsl */ `
varying vec3 vGWorld;
varying vec3 vGNormal;
uniform sampler2D uNoise;
uniform sampler2D uSplat;
uniform vec4 uSplatRect;
uniform vec4 uPlaza;
uniform float uFinish;

struct GroundSample { vec3 albedo; float roughness; vec2 slope; float cavity; vec3 relief; float reliefW; };
const float RELIEF_DEEP = ${RELIEF_DEEP.toFixed(3)};
const float RELIEF_SPAN = ${RELIEF_SPAN.toFixed(3)};
float reliefAt(vec2 uv) { return texture2D(uSplat, uv).a * RELIEF_SPAN - RELIEF_DEEP; }

float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec4 gNoise(vec2 p) { return texture2D(uNoise, p); }

/**
 * Coverage of a joint of half-width w at distance e from its centre line, box-filtered over the
 * pixel footprint fw: a sub-pixel joint contributes its area fraction, not a one-pixel line.
 */
float jointCover(float e, float w, float fw, vec2 cellSize) {
  float f = max(fw, 1e-5);
  float line = clamp((w - e) / f + 0.5, 0.0, 1.0) * min(1.0, 2.0 * w / f + 0.15);
  // Once a unit spans only a few pixels, point-sampled lines alias into moiré: fade to the joints'
  // area fraction (2w per unit in each direction).
  float avg = 2.0 * w / cellSize.x + 2.0 * w / cellSize.y;
  return mix(line, avg, smoothstep(0.08, 0.3, f / min(cellSize.x, cellSize.y)));
}

/**
 * Masonry cell of a running-bond layout: size (sx, sz), rows staggered by half a unit.
 * Returns local offsets to the nearest joint (x: along the unit, y: across) and the cell id.
 */
vec4 runningBond(vec2 p, vec2 s) {
  float row = floor(p.y / s.y);
  float off = mod(row, 2.0) * 0.5 * s.x;
  float col = floor((p.x + off) / s.x);
  vec2 local = vec2(p.x + off - col * s.x, p.y - row * s.y);
  vec2 toEdge = min(local, s - local);
  return vec4(toEdge, col, row);
}

// Soil / grass colour field (golden-hour late summer: straw, olive, bare soil).
vec3 fieldColor(vec2 p, out float rough, out float h) {
  vec4 a = gNoise(p * 0.011);
  vec4 b = gNoise(p * 0.047 + 0.31);
  vec4 c = gNoise(p * 0.61);
  vec4 d = gNoise(p * 3.1);
  vec3 straw = vec3(0.23, 0.19, 0.095);
  vec3 olive = vec3(0.095, 0.11, 0.038);
  vec3 soil = vec3(0.15, 0.11, 0.075);
  float g = smoothstep(0.35, 0.7, a.r * 0.7 + b.g * 0.5 - 0.1);
  vec3 col = mix(straw, olive, g);
  float bare = smoothstep(0.62, 0.78, b.r * 0.8 + a.g * 0.35);
  col = mix(col, soil, bare * 0.85);
  // Clump-scale and blade-scale variation (dark gaps between tufts).
  col *= 0.78 + 0.4 * c.b + 0.14 * (d.b - 0.5);
  rough = 0.97;
  // Tuft relief only (the blade-scale noise would alias into sparkle as a normal).
  h = 0.012 * c.b;
  return col;
}

GroundSample groundSample(vec2 p) {
  GroundSample s;
  float fw = max(fwidth(p.x), fwidth(p.y));
  float rough;
  float h;
  vec3 col = fieldColor(p, rough, h);
  float cavity = 1.0;
  vec2 slope = vec2(0.0);
  // Millimetre relief (joints, arrises, speckle) only while a pixel is smaller than a few mm.
  float detail = clamp(1.0 - fw * 120.0, 0.0, 1.0);
  float hMicro = 0.0;

  // Plaza with a granite curb.
  if (uPlaza.w > 0.5) {
    vec2 q = abs(p) - uPlaza.xy;
    float outside = max(q.x, q.y);
    float inPlaza = 1.0 - smoothstep(-fw, fw, outside);
    float inCurb = (1.0 - smoothstep(uPlaza.z - fw, uPlaza.z + fw, outside)) * (1.0 - inPlaza);
    if (inPlaza + inCurb > 0.0) {
      vec3 pc;
      float pr;
      float hm = 0.0;
      float joint = 0.0;
      vec4 fine = gNoise(p * 2.3);
      vec4 grain = gNoise(p * 9.0);
      if (uFinish < 0.5) {
        // Granite setts 0.6 × 0.3 m, 8 mm sand joints, 5 mm arrises.
        vec4 rb = runningBond(p, vec2(0.6, 0.3));
        float e = min(rb.x, rb.y);
        float hsh = gHash(rb.zw);
        joint = jointCover(e, 0.004, fw, vec2(0.6, 0.3));
        float arris = (1.0 - smoothstep(0.004, 0.011, e)) * detail;
        // Per-sett colour variation fades to its mean once a sett is only a few pixels wide.
        float vary = clamp(1.0 - fw * 18.0, 0.0, 1.0);
        pc = vec3(0.27, 0.26, 0.24) * (1.0 + vary * 0.34 * (hsh - 0.5));
        pc = mix(pc, pc * vec3(1.08, 0.98, 0.86), vary * gHash(rb.zw + 3.1));
        // Flamed-granite mottling inside each sett and grime settled along the joints.
        pc *= 1.0 + vary * 0.16 * (gNoise(p * 0.9 + rb.zw * 0.37).g - 0.5);
        pc *= mix(0.86, 1.0, smoothstep(0.004, 0.03, e));
        // Feldspar / mica speckle, fading to its mean with distance.
        float speck = mix(0.5, grain.b, detail);
        pc *= 0.84 + 0.32 * speck;
        pc = mix(pc, vec3(0.2, 0.18, 0.15), joint);
        pr = mix(0.72, 0.98, joint);
        hm = -0.006 * arris - 0.01 * joint * detail + 0.0012 * vary * (gHash(rb.zw + 7.0) - 0.5);
        cavity = 1.0 - 0.45 * joint;
      } else if (uFinish < 1.5) {
        // Honed Roman travertine slabs 1.2 × 0.6 m, 3 mm joints, bedding bands and open voids.
        vec4 rb = runningBond(p, vec2(1.2, 0.6));
        float e = min(rb.x, rb.y);
        float hsh = gHash(rb.zw);
        joint = jointCover(e, 0.0015, fw, vec2(1.2, 0.6));
        float vary = clamp(1.0 - fw * 8.0, 0.0, 1.0);
        float bands = gNoise(vec2(p.x * 0.35 + hsh * 7.0, p.y * 4.5)).r;
        pc = vec3(0.52, 0.45, 0.34) * (1.0 + vary * 0.16 * (hsh - 0.5)) * (0.9 + 0.2 * mix(0.5, bands, vary));
        float voids = smoothstep(0.78, 0.84, gNoise(vec2(p.x * 1.1, p.y * 7.0) + hsh).g) * detail;
        pc = mix(pc, pc * 0.45, voids);
        pc = mix(pc, vec3(0.42, 0.37, 0.28), joint);
        pr = mix(0.55, 0.9, max(joint, voids));
        hm = -0.003 * voids - 0.004 * joint * detail;
        cavity = 1.0 - 0.4 * voids - 0.3 * joint;
      } else {
        // Broom-finished concrete, saw-cut joints every 4 m.
        vec2 cellp = fract(p / 4.0) * 4.0;
        float e = min(min(cellp.x, 4.0 - cellp.x), min(cellp.y, 4.0 - cellp.y));
        joint = jointCover(e, 0.002, fw, vec2(4.0, 4.0));
        float broom = mix(0.5, gNoise(vec2(p.x * 0.4, p.y * 26.0)).b, detail);
        pc = vec3(0.33, 0.32, 0.30) * (0.9 + 0.2 * fine.r) * (0.95 + 0.1 * broom);
        pc = mix(pc, pc * 0.35, joint);
        pr = 0.86;
        hm = -0.008 * joint * detail + 0.0008 * broom;
        cavity = 1.0 - 0.5 * joint;
      }
      // Weathering: faint darker patina along traffic-free edges and drip-free centre mottling.
      pc *= 0.93 + 0.14 * fine.g;
      vec3 curb = vec3(0.24, 0.235, 0.225) * (0.9 + 0.2 * grain.b);
      col = mix(col, pc, inPlaza);
      col = mix(col, curb, inCurb);
      rough = mix(rough, pr, inPlaza);
      rough = mix(rough, 0.7, inCurb);
      h = mix(h, 0.0, inPlaza);
      hMicro = mix(hMicro, hm, inPlaza);
    }
  }

  // Dynamic damage splat: r = soot, g = disturbed soil, b = paving shattered, a = unused.
  vec2 suv = (p - uSplatRect.xy) * uSplatRect.w;
  vec4 sp = vec4(0.0, 0.0, 0.0, RELIEF_DEEP / RELIEF_SPAN);
  s.relief = vec3(0.0, 1.0, 0.0);
  s.reliefW = 0.0;
  if (suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) {
    sp = texture2D(uSplat, suv);
    float r0 = sp.a * RELIEF_SPAN - RELIEF_DEEP;
    // Crater shading normal from the fine relief (finite differences over one splat texel or the
    // pixel footprint, whichever is larger).
    float texel = 1.0 / (uSplatRect.w * float(textureSize(uSplat, 0).x));
    float e = max(texel, fw);
    float rx = reliefAt(suv + vec2(e * uSplatRect.w, 0.0)) - reliefAt(suv - vec2(e * uSplatRect.w, 0.0));
    float rz = reliefAt(suv + vec2(0.0, e * uSplatRect.w)) - reliefAt(suv - vec2(0.0, e * uSplatRect.w));
    s.relief = normalize(vec3(-rx / (2.0 * e), 1.0, -rz / (2.0 * e)));
    s.reliefW = smoothstep(0.004, 0.03, abs(r0) + abs(rx) + abs(rz));
    // Deeper crater floors are darker (moist, freshly turned soil in their own shade).
    cavity *= 1.0 - 0.35 * smoothstep(0.05, 0.6, -r0);
  }
  if (sp.b > 0.003) {
    // Shattered paving: bedding sand and broken sett fragments; cracked ring where partial.
    vec4 cr = gNoise(p * 1.7);
    float removed = smoothstep(0.75, 0.95, sp.b);
    float cracks = smoothstep(0.55, 0.9, cr.a) * smoothstep(0.02, 0.4, sp.b) * (1.0 - removed);
    vec3 bed = vec3(0.2, 0.17, 0.13) * (0.8 + 0.4 * gNoise(p * 5.0).b);
    float frag = step(0.72, gHash(floor(p * 9.0))) * removed;
    bed = mix(bed, vec3(0.34, 0.32, 0.29), frag);
    col = mix(col, bed, removed);
    col *= 1.0 - 0.6 * cracks;
    rough = mix(rough, 0.95, removed);
    // The setts (and their joints and arrises) are gone where the paving was blown out.
    cavity = mix(cavity, 1.0, removed) * (1.0 - 0.3 * cracks);
    hMicro *= 1.0 - removed;
  }
  if (sp.g > 0.003) {
    vec4 cl = gNoise(p * 4.3 + 0.7);
    vec3 dirt = vec3(0.155, 0.118, 0.082) * (0.7 + 0.6 * cl.b);
    // Clods: the cover is patchy at its edge and continuous in the crater.
    float cover = smoothstep(0.0, 1.0, sp.g * (0.65 + 0.7 * cl.r));
    col = mix(col, dirt, cover);
    rough = mix(rough, 0.98, cover);
    h += 0.02 * cover * cl.b;
  }
  if (sp.r > 0.003) {
    // Soot deposit: near-black at the seat of the blast, brown-grey smudge further out, with
    // radial streaks already baked into the splat.
    vec4 sn = gNoise(p * 0.9 + 0.2);
    float soot = clamp(sp.r * (0.6 + 0.6 * sn.g), 0.0, 1.0);
    // Soot darkens the surface multiplicatively (a thin deposit) and only turns it truly black
    // where it is heaviest.
    col *= mix(1.0, 0.22, soot);
    col = mix(col, vec3(0.02, 0.018, 0.016), 0.45 * soot * soot);
    rough = mix(rough, 1.0, soot);
  }

  // Bump from the analytic height via screen-space derivatives. Millimetre relief is only kept
  // while resolved; centimetre relief (tufts, clods) fades out over a larger footprint.
  h = h * clamp(1.0 - fw * 25.0, 0.0, 1.0) + hMicro * detail;
  float hx = dFdx(h), hy = dFdy(h);
  vec2 dpx = dFdx(p), dpy = dFdy(p);
  float det = dpx.x * dpy.y - dpx.y * dpy.x;
  if (abs(det) > 1e-12) {
    slope = vec2(hx * dpy.y - hy * dpx.y, hy * dpx.x - hx * dpy.x) / det;
    slope = clamp(slope, vec2(-2.0), vec2(2.0));
  }
  s.albedo = col;
  s.roughness = rough;
  s.slope = slope;
  s.cavity = cavity;
  return s;
}
`;
