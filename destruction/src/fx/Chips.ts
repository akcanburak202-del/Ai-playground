import * as THREE from 'three';
import { MOTION_GLSL } from './motion.ts';
import type { Atmosphere } from '../render/atmosphere.ts';

export type ChipKind = 'stone' | 'glass' | 'metal';
const KIND_ID: Record<ChipKind, number> = { stone: 0, glass: 1, metal: 2 };

/**
 * Solid debris too small to be rigid bodies: concrete chips, stone flakes, paver fragments, soil
 * clods, glass grit, metal slivers. Instanced faceted rocks drawn with the standard PBR material
 * (so they take the sun, the sky, the shadows and the haze like the geometry they came from),
 * moved analytically on the GPU with drag, gravity, one bounce and tumbling that stops at rest.
 */
export class Chips {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.MeshStandardMaterial;
  private c0: THREE.InstancedBufferAttribute;
  private c1: THREE.InstancedBufferAttribute;
  private c2: THREE.InstancedBufferAttribute;
  private c3: THREE.InstancedBufferAttribute;
  private col: THREE.InstancedBufferAttribute;
  private head = 0;
  private dirty0 = -1;
  private dirty1 = -1;
  /** Slots written since the GPU last received them (see ParticleLayer.flush) */
  private pend0 = -1;
  private pend1 = -1;
  private lastDeath = -Infinity;
  emitted = 0;

  constructor(atmo: Atmosphere, capacity: number) {
    this.capacity = capacity;
    // An irregular faceted pebble (icosahedron with jittered vertices, flat shading).
    const src = new THREE.IcosahedronGeometry(0.5, 0);
    // Polyhedra are already non-indexed in current three.js (flat facets need split vertices).
    const ico = src.index ? src.toNonIndexed() : src;
    if (ico !== src) src.dispose();
    const p = ico.getAttribute('position') as THREE.BufferAttribute;
    const jitter = new Map<string, number>();
    for (let i = 0; i < p.count; i++) {
      const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
      let j = jitter.get(key);
      if (j === undefined) {
        j = 0.75 + 0.5 * ((Math.sin(i * 12.9898 + jitter.size * 78.233) * 43758.5453) % 1 + 1) % 1;
        jitter.set(key, j);
      }
      p.setXYZ(i, p.getX(i) * j, p.getY(i) * j * 0.7, p.getZ(i) * j);
    }
    ico.computeVertexNormals();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', ico.getAttribute('position'));
    g.setAttribute('normal', ico.getAttribute('normal'));
    const mk = (fill?: (a: Float32Array) => void) => {
      const arr = new Float32Array(capacity * 4);
      fill?.(arr);
      const a = new THREE.InstancedBufferAttribute(arr, 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.c0 = mk((a) => { for (let i = 0; i < capacity; i++) a[i * 4 + 3] = 1e9; });
    this.c1 = mk();
    this.c2 = mk();
    this.c3 = mk();
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('c0', this.c0);
    g.setAttribute('c1', this.c1);
    g.setAttribute('c2', this.c2);
    g.setAttribute('c3', this.c3);
    g.setAttribute('color', this.col);
    g.instanceCount = capacity;
    this.c0.onUpload(() => {
      this.pend0 = this.pend1 = -1;
    });
    ico.dispose();
    this.geometry = g;

    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    m.name = 'fx-chips';
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = atmo.time;
      shader.uniforms.uWind = atmo.wind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 c0; attribute vec4 c1; attribute vec4 c2; attribute vec4 c3;
          uniform float uTime; uniform vec3 uWind;
          varying float vChipKind;
          ${MOTION_GLSL}
          mat3 chipRot(vec3 axis, float ang) {
            float c = cos(ang), s = sin(ang), t = 1.0 - c;
            vec3 a = axis;
            return mat3(t*a.x*a.x + c, t*a.x*a.y + s*a.z, t*a.x*a.z - s*a.y,
                        t*a.x*a.y - s*a.z, t*a.y*a.y + c, t*a.y*a.z + s*a.x,
                        t*a.x*a.z + s*a.y, t*a.y*a.z - s*a.x, t*a.z*a.z + c);
          }`)
        .replace('#include <beginnormal_vertex>', `
          float chipAge = uTime - c0.w;
          bool chipAlive = chipAge >= 0.0 && chipAge <= c1.w;
          vec3 chipAxis = normalize(vec3(sin(c3.z * 17.0), cos(c3.z * 29.0), sin(c3.z * 41.0 + 1.0)));
          float chipSpinT = c2.w > 0.0 ? min(chipAge, c2.w + 0.25) : chipAge;
          mat3 chipR = chipRot(chipAxis, c3.z * 6.2831 + c3.y * chipSpinT);
          vec3 chipScale = c3.x * vec3(0.8 + 0.5 * fract(c3.z * 13.1), 0.6 + 0.5 * fract(c3.z * 7.7), 0.8 + 0.5 * fract(c3.z * 3.3));
          vec3 objectNormal = normalize(chipR * (normal / chipScale));
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3( tangent.xyz );
          #endif`)
        .replace('#include <begin_vertex>', `
          vec3 chipVel; float chipRest;
          vec3 chipPos = motionBounce(c0.xyz, c1.xyz, c2.x, c2.y, uWind * 0.3, max(chipAge, 0.0), c2.z, c2.w, chipVel, chipRest);
          float chipFade = 1.0 - smoothstep(0.85, 1.0, chipAge / max(c1.w, 1e-3));
          vec3 transformed = chipAlive ? chipPos + chipR * (position * chipScale * chipFade) : vec3(0.0, -1e5, 0.0);
          vChipKind = c3.w;`)
        .replace('#include <shadowmap_vertex>', `#include <shadowmap_vertex>
          #if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
            // A chip is far smaller than a shadow texel of the ground it rests on: shade it as a
            // point a little above its centre, or the ground's own depth darkens its sun-facing
            // facets (resting granite chips rendered as black pepper).
            vSunShadowWorldPosition.xyz = chipPos + vec3(0.0, 0.12, 0.0);
            vSunShadowWorldNormal = vec3(0.0);
          #endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vChipKind;')
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vChipKind < 0.5 ? 0.92 : (vChipKind < 1.5 ? 0.06 : 0.38);')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vChipKind > 1.5 ? 1.0 : 0.0;');
    };
    m.customProgramCacheKey = () => 'fx-chips-v2';
    this.material = m;
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = 'fx-chips';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
  }

  /**
   * One chip: position, velocity, drag, gravity scale, floor & landing time (−1: none), size (m),
   * spin (rad/s), seed, kind, linear colour.
   */
  emit(t0: number, life: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number,
    drag: number, floor: number, tLand: number, size: number, spin: number, seed: number, kind: ChipKind,
    r: number, g: number, b: number): void {
    if (!Number.isFinite(px + py + pz + vx + vy + vz)) return;
    const i = this.head;
    this.head = (i + 1) % this.capacity;
    const o = i * 4;
    const a0 = this.c0.array as Float32Array, a1 = this.c1.array as Float32Array, a2 = this.c2.array as Float32Array, a3 = this.c3.array as Float32Array;
    a0[o] = px; a0[o + 1] = py; a0[o + 2] = pz; a0[o + 3] = t0;
    a1[o] = vx; a1[o + 1] = vy; a1[o + 2] = vz; a1[o + 3] = life;
    a2[o] = Math.max(1e-4, drag); a2[o + 1] = 1; a2[o + 2] = floor; a2[o + 3] = tLand;
    a3[o] = size; a3[o + 1] = spin; a3[o + 2] = seed; a3[o + 3] = KIND_ID[kind];
    const c = this.col.array as Float32Array;
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
    if (this.dirty0 < 0) this.dirty0 = this.dirty1 = i;
    else if (i === this.dirty1 + 1) this.dirty1 = i;
    else { this.dirty0 = 0; this.dirty1 = this.capacity - 1; }
    this.emitted++;
    this.lastDeath = Math.max(this.lastDeath, t0 + life);
    this.mesh.visible = true;
  }

  /** Queue new chips for the GPU: the union of everything written since the last upload. */
  flush(now: number): void {
    if (this.dirty0 >= 0) {
      this.pend0 = this.pend0 < 0 ? this.dirty0 : Math.min(this.pend0, this.dirty0);
      this.pend1 = Math.max(this.pend1, this.dirty1);
      this.queue(this.pend0, this.pend1 - this.pend0 + 1);
      this.dirty0 = this.dirty1 = -1;
    }
    this.mesh.visible = now <= this.lastDeath;
  }

  private queue(first: number, n: number): void {
    for (const a of [this.c0, this.c1, this.c2, this.c3]) {
      a.clearUpdateRanges();
      a.addUpdateRange(first * 4, n * 4);
      a.needsUpdate = true;
    }
    this.col.clearUpdateRanges();
    this.col.addUpdateRange(first * 3, n * 3);
    this.col.needsUpdate = true;
  }

  clear(): void {
    const a0 = this.c0.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) a0[i * 4 + 3] = 1e9;
    this.pend0 = 0;
    this.pend1 = this.capacity - 1;
    this.queue(0, this.capacity);
    this.dirty0 = this.dirty1 = -1;
    this.lastDeath = -Infinity;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
