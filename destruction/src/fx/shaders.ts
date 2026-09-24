import * as THREE from 'three';
import { ATMOSPHERE_GLSL, SOFT_FADE_GLSL, atmosphereUniforms, type Atmosphere } from '../render/atmosphere.ts';
import { MOTION_GLSL } from './motion.ts';

/**
 * Particle shaders. All layers share the analytic motion (motion.ts) and the atmosphere block
 * (sun, sky fill, haze, soft depth, sun shadow). Output is premultiplied: smoke is alpha-blended,
 * fire and sparks write alpha 0 so the same blend state makes them purely additive. Under the full
 * Pipeline they render linear HDR into the composer target (the tone-mapping includes compile to
 * nothing there); under BasicPipeline they draw straight to the canvas and tone-map themselves.
 */

const PREMULTIPLIED = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
} as const;

/** Black-body colour (Helland's fit to the CIE 1964 locus, linearised) and a visible-radiance ramp. */
export const BLACKBODY_GLSL = /* glsl */ `
vec3 blackbody(float T) {
  float t = clamp(T, 1000.0, 12000.0) / 100.0;
  float r = t <= 66.0 ? 1.0 : clamp(1.292936186 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
  float g = t <= 66.0 ? clamp(0.3900815788 * log(t) - 0.6318414438, 0.0, 1.0) : clamp(1.129890861 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
  float b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.5432067891 * log(t - 10.0) - 1.1962540891, 0.0, 1.0));
  return pow(vec3(r, g, b), vec3(2.2));
}
/**
 * Visible radiance of an incandescent source relative to a sun-lit white wall: Planck's law in
 * the visible band rises roughly as T^6–T^8 between 1000 and 2500 K (Wien regime), so a 2600 K
 * flame core is ~10× the wall (blooms, burns to white), a 2200 K fireball body is orange-yellow at
 * ~3× and 1300 K embers only glow dull red.
 */
float glow(float T) { return T < 700.0 ? 0.0 : 6.0 * pow(T / 2400.0, 7.0); }
`;

const PARTICLE_VERTEX_HEAD = /* glsl */ `
attribute vec4 a0; // p0.xyz, t0
attribute vec4 a1; // v0.xyz, life
attribute vec4 a2; // drag, gravity scale, floor y, landing time
attribute vec4 a3; // size0, size1, growth tau, spin
attribute vec4 a4; // rgb, opacity
attribute vec4 a5; // seed, atlas cell, heat K, extra
${ATMOSPHERE_GLSL}
${MOTION_GLSL}
varying vec2 vUv;
varying vec4 vColor;
varying float vHeat;
varying float vViewDepth;
varying float vSoft;
varying float vHazeT;
varying vec3 vHazeC;
const vec4 CULLED = vec4(2.0, 2.0, 2.0, 1.0);
vec2 atlasUv(vec2 corner, float cell) {
  return (corner * 0.5 + 0.5 + vec2(mod(cell, 4.0), floor(cell / 4.0))) * 0.25;
}
void hazeAt(vec3 wp) {
  vec3 d = wp - cameraPosition;
  float dist = max(length(d), 1e-3);
  vHazeT = hazeTransmittance(dist, max(cameraPosition.y, 0.0), max(wp.y, 0.0));
  vHazeC = hazeInscatter(d / dist);
}
`;

/** Lit smoke / dust / soot, optionally incandescent (fireball puffs that cool into soot). */
export function createSmokeMaterial(atmo: Atmosphere, atlas: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'fx-smoke',
    uniforms: { ...atmosphereUniforms(atmo), uAtlas: { value: atlas } },
    vertexShader: /* glsl */ `
      ${PARTICLE_VERTEX_HEAD}
      varying vec3 vRight;
      varying vec3 vUp;
      varying vec3 vBack;
      varying vec2 vRot;
      varying vec3 vWorld;
      varying float vSunVis;
      void main() {
        float age = uTime - a0.w;
        float life = a1.w;
        if (age < 0.0 || age > life) { gl_Position = CULLED; return; }
        vec3 vel; float rest;
        vec3 wp = motionBounce(a0.xyz, a1.xyz, a2.x, a2.y, uWind, age, a2.z, a2.w, vel, rest);
        float x = age / life;
        float size = a3.x + (a3.y - a3.x) * (1.0 - exp(-age / a3.z));
        float rot = a5.x * 6.2831853 + a3.w * age;
        float cr = cos(rot), sr = sin(rot);
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        vec2 c = position.xy;
        mv.xy += vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr) * size;
        gl_Position = projectionMatrix * mv;
        vUv = atlasUv(c, a5.y);
        vRot = vec2(cr, sr);
        // Fade in over a few frames, out over the last 45 %; a puff thins as it spreads.
        float fadeIn = smoothstep(0.0, clamp(0.05 * life, 0.015, 0.06), age);
        float fadeOut = 1.0 - smoothstep(0.55, 1.0, x);
        float spread = clamp((size - a3.x) / max(a3.y - a3.x, 1e-4), 0.0, 1.0);
        vColor = vec4(a4.rgb * mix(a5.w, 1.0, smoothstep(0.0, 0.75, x)), a4.a * fadeIn * fadeOut * mix(1.0, 0.4, spread));
        // Incandescent puffs cool into soot within the first third of their life (radiative and
        // entrainment cooling of the detonation products).
        vHeat = a5.z > 0.0 ? a5.z * mix(1.0, 0.3, smoothstep(0.0, 0.45, x)) : 0.0;
        vViewDepth = -mv.z;
        vSoft = clamp(size * 0.3, 0.05, 1.5);
        vRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vBack = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
        vWorld = wp;
        vSunVis = sunVisibility(wp, -mv.z);
        hazeAt(wp);
      }`,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      ${SOFT_FADE_GLSL}
      ${BLACKBODY_GLSL}
      uniform sampler2D uAtlas;
      varying vec2 vUv;
      varying vec4 vColor;
      varying float vHeat;
      varying float vViewDepth;
      varying float vSoft;
      varying float vHazeT;
      varying vec3 vHazeC;
      varying vec3 vRight;
      varying vec3 vUp;
      varying vec3 vBack;
      varying vec2 vRot;
      varying vec3 vWorld;
      varying float vSunVis;
      void main() {
        vec4 tx = texture2D(uAtlas, vUv);
        float dens = tx.a;
        float a = dens * vColor.a;
        if (a < 0.002) discard;
        a *= softFade(vViewDepth, vSoft);
        vec2 n2 = tx.rg * 2.0 - 1.0;
        n2 = vec2(n2.x * vRot.x - n2.y * vRot.y, n2.x * vRot.y + n2.y * vRot.x);
        vec3 N = normalize(vRight * n2.x + vUp * n2.y + vBack * sqrt(max(0.0, 1.0 - dot(n2, n2))));
        vec3 V = normalize(cameraPosition - vWorld);
        // Wrapped diffuse (light diffuses into the puff) and Henyey–Greenstein forward scattering
        // (g = 0.6, typical of smoke / dust aerosol): backlit edges glow, as in photographs.
        float wrap = clamp((dot(N, uSunDir) + 0.45) / 1.45, 0.0, 1.0);
        float cosT = dot(-uSunDir, V);
        float g = 0.6;
        float hg = (1.0 - g * g) / (12.566 * pow(1.0 + g * g - 2.0 * g * cosT, 1.5));
        float edge = 1.0 - dens;
        float selfShadow = 1.0 - 0.5 * tx.b * dens;
        vec3 sun = uSunColor * vSunVis * (wrap * selfShadow + hg * 3.5 * (0.3 + 0.7 * edge));
        // Sky fill from above, sun-lit ground from below, plus multiply-scattered light inside the
        // cloud (it sees the whole sunlit surroundings): a neutral share of the sun term.
        vec3 amb = uSkyAmbient * (0.7 + 0.3 * N.y) + uGroundAmbient * (0.5 - 0.3 * N.y) + uSunColor * 0.035;
        // Multiple scattering inside an optically thick cloud mixes all incoming colours: neutralise.
        amb = mix(amb, vec3(dot(amb, vec3(0.2126, 0.7152, 0.0722))), 0.45 * dens);
        vec3 lit = vColor.rgb * (sun + amb);
        vec3 emis = vHeat > 0.0 ? blackbody(vHeat) * glow(vHeat) * smoothstep(0.1, 0.8, dens) : vec3(0.0);
        vec3 col = mix(vHazeC, lit, vHazeT) * a + emis * a * vHazeT;
        gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
      }`,
    ...PREMULTIPLIED,
  });
}

/** Additive flames, fireball cores, muzzle flashes and rocket exhaust. */
export function createFireMaterial(atmo: Atmosphere, atlas: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'fx-fire',
    uniforms: { ...atmosphereUniforms(atmo), uAtlas: { value: atlas } },
    vertexShader: /* glsl */ `
      ${PARTICLE_VERTEX_HEAD}
      void main() {
        float age = uTime - a0.w;
        float life = a1.w;
        if (age < 0.0 || age > life) { gl_Position = CULLED; return; }
        vec3 vel; float rest;
        vec3 wp = motionBounce(a0.xyz, a1.xyz, a2.x, a2.y, uWind, age, a2.z, a2.w, vel, rest);
        float x = age / life;
        float size = a3.x + (a3.y - a3.x) * (1.0 - exp(-age / a3.z));
        float rot = a5.x * 6.2831853 + a3.w * age;
        float cr = cos(rot), sr = sin(rot);
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        vec2 c = position.xy;
        mv.xy += vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr) * size;
        gl_Position = projectionMatrix * mv;
        vUv = atlasUv(c, a5.y);
        float fade = smoothstep(0.0, max(0.004, 0.06 * life), age) * (1.0 - smoothstep(0.35, 1.0, x));
        vColor = vec4(a4.rgb, a4.a * fade);
        vHeat = a5.z * mix(1.0, 0.55, x);
        vViewDepth = -mv.z;
        vSoft = max(0.03, size * 0.4);
        hazeAt(wp);
      }`,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      ${SOFT_FADE_GLSL}
      ${BLACKBODY_GLSL}
      uniform sampler2D uAtlas;
      varying vec2 vUv;
      varying vec4 vColor;
      varying float vHeat;
      varying float vViewDepth;
      varying float vSoft;
      varying float vHazeT;
      varying vec3 vHazeC;
      void main() {
        vec4 tx = texture2D(uAtlas, vUv);
        float a = tx.a * vColor.a;
        if (a < 0.002) discard;
        a *= softFade(vViewDepth, vSoft);
        float T = vHeat * (0.6 + 0.4 * tx.r);
        vec3 col = blackbody(T) * glow(T) * vColor.rgb * (0.35 + 0.65 * tx.r);
        gl_FragColor = vec4(col * a * vHazeT, 0.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
      }`,
    ...PREMULTIPLIED,
  });
}

/**
 * Velocity-stretched streaks: incandescent sparks and burning fragments (kind 0, black-body
 * colour cooling with age) and glass glitter (kind 1, a tumbling facet that flashes the sun).
 * The streak spans the distance travelled during the exposure, like a photograph.
 */
export function createSparkMaterial(atmo: Atmosphere, shutter: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'fx-sparks',
    uniforms: { ...atmosphereUniforms(atmo), uShutter: shutter },
    vertexShader: /* glsl */ `
      ${PARTICLE_VERTEX_HEAD}
      ${BLACKBODY_GLSL}
      uniform float uShutter;
      varying float vKind;
      varying float vAcross;
      void main() {
        float age = uTime - a0.w;
        float life = a1.w;
        if (age < 0.0 || age > life) { gl_Position = CULLED; return; }
        vec3 vel; float rest;
        vec3 wp = motionBounce(a0.xyz, a1.xyz, a2.x, a2.y, uWind, age, a2.z, a2.w, vel, rest);
        vec3 vel2; float rest2;
        vec3 wq = motionBounce(a0.xyz, a1.xyz, a2.x, a2.y, uWind, max(age - uShutter, 0.0), a2.z, a2.w, vel2, rest2);
        vec4 ch = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        vec4 ct = projectionMatrix * viewMatrix * vec4(wq, 1.0);
        if (ch.w < 0.05 || ct.w < 0.05) { gl_Position = CULLED; return; }
        vec2 sh = ch.xy / ch.w * uResolution * 0.5;
        vec2 st = ct.xy / ct.w * uResolution * 0.5;
        vec2 axis = sh - st;
        float len = length(axis);
        vec2 dir = len > 1e-3 ? axis / len : vec2(1.0, 0.0);
        vec2 nrm = vec2(-dir.y, dir.x);
        // Physical width in pixels, never thinner than 1.3 px (energy kept by brightening).
        float focal = projectionMatrix[1][1] * uResolution.y * 0.5;
        float wpx = a3.x * focal / ch.w;
        float w = max(1.3, wpx);
        float thin = clamp(wpx / w, 0.05, 1.0);
        vec2 corner = position.xy;
        vec2 base = corner.x < 0.0 ? st : sh;
        vec2 px = base + dir * corner.x * w * 0.5 + nrm * corner.y * w;
        vec4 clip = corner.x < 0.0 ? ct : ch;
        gl_Position = vec4(px / (uResolution * 0.5) * clip.w, clip.z, clip.w);
        vUv = corner;
        vAcross = corner.y;
        vKind = a5.w;
        float x = age / life;
        float T = a5.z * exp(-2.2 * x);
        vHeat = T;
        float I;
        vec3 col;
        if (a5.w < 0.5) {
          col = blackbody(T) * glow(T);
        } else {
          // Glitter: the facet normal tumbles; brightness follows the sun's mirror lobe.
          vec3 n = normalize(vec3(sin(a5.x * 91.0 + age * a3.w), cos(a5.x * 57.0 + age * a3.w * 1.3), sin(a5.x * 23.0 - age * a3.w * 0.7)));
          vec3 v = normalize(cameraPosition - wp);
          float spec = pow(max(dot(reflect(-uSunDir, n), v), 0.0), 60.0);
          col = uSunColor * (0.05 + 18.0 * spec) + uSkyAmbient * 0.6;
        }
        // Energy of a sub-pixel-wide streak is spread over its length: short streaks are brighter.
        float spreadLen = max(1.0, len / max(w, 1.0));
        vColor = vec4(col * a4.rgb * thin / sqrt(spreadLen), a4.a * (1.0 - smoothstep(0.7, 1.0, x)));
        vViewDepth = ch.w;
        vSoft = 0.05;
        hazeAt(wp);
      }`,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      ${SOFT_FADE_GLSL}
      varying vec2 vUv;
      varying vec4 vColor;
      varying float vViewDepth;
      varying float vSoft;
      varying float vHazeT;
      varying float vAcross;
      void main() {
        float across = exp(-4.0 * vAcross * vAcross);
        float ends = smoothstep(1.0, 0.6, abs(vUv.x));
        float a = vColor.a * across * ends * softFade(vViewDepth, vSoft);
        if (a < 0.002) discard;
        gl_FragColor = vec4(vColor.rgb * a * vHazeT, 0.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
      }`,
    ...PREMULTIPLIED,
  });
}
