import * as THREE from 'three';
import { GRAVITY, driftA, driftB } from './motion.ts';

/**
 * Everything one particle needs, written once at spawn (see motion.ts: the GPU evaluates the
 * trajectory analytically, so particles cost nothing on the CPU after they are born). Callers
 * fill the shared `P` record and call `emit()`; nothing is allocated per particle.
 */
export interface ParticleRecord {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Absolute simulation time of birth, s */
  t0: number;
  life: number;
  /** Linear drag rate towards the wind, 1/s */
  drag: number;
  /** Gravity scale (1 falls, < 0 rises) */
  gravity: number;
  /** Floor height for the bounce, m, and the time it is reached (−1: never) */
  floor: number;
  tLand: number;
  size0: number;
  size1: number;
  /** Growth time constant, s */
  growth: number;
  /** Spin, rad/s */
  spin: number;
  /** Linear colour (albedo for lit smoke, tint for emissive) and peak opacity */
  r: number; g: number; b: number;
  opacity: number;
  seed: number;
  /** Atlas cell 0..15 */
  variant: number;
  /** Initial temperature for emissive particles, K (0 = not glowing) */
  heat: number;
  /** Layer-specific: smoke → starting darkness (soot) multiplier; sparks → kind */
  extra: number;
}

export function newRecord(): ParticleRecord {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t0: 0, life: 1, drag: 1, gravity: 0, floor: -1e4, tLand: -1,
    size0: 0.1, size1: 0.1, growth: 1, spin: 0, r: 1, g: 1, b: 1, opacity: 1, seed: 0, variant: 0, heat: 0, extra: 1,
  };
}

const ATTRS = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'] as const;

export interface ParticleLayerOptions {
  /**
   * Draw back to front (alpha 'over' blending is order dependent). The ring then lives on the CPU
   * and `sort()` writes only the live particles, farthest first, into the draw buffers.
   */
  sorted?: boolean;
}

/**
 * A pool of camera-facing (or velocity-stretched) quads in one instanced draw call. New particles
 * overwrite the oldest in a ring; only the written slots are uploaded (update ranges). A sorted
 * layer instead re-orders its live particles by view depth right before each draw.
 */
export class ParticleLayer {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  readonly sorted: boolean;
  private geometry: THREE.InstancedBufferGeometry;
  /** Draw buffers (the attributes' arrays) */
  private arrays: Float32Array[] = [];
  /** Where emit() writes: the draw buffers themselves, or the CPU ring of a sorted layer */
  private store: Float32Array[] = [];
  private a0!: Float32Array;
  private a1!: Float32Array;
  private a2!: Float32Array;
  private a3!: Float32Array;
  private a4!: Float32Array;
  private a5!: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[] = [];
  private head = 0;
  private dirtyStart = -1;
  private dirtyEnd = -1;
  /** Slots written since the GPU last received them (union over frames stepped without a draw) */
  private pendStart = -1;
  private pendEnd = -1;
  /** Particles emitted since creation (telemetry) */
  emitted = 0;
  /** Latest death time among live particles (lets the layer skip drawing when idle) */
  private lastDeath = -Infinity;
  // Sorted layers: per-live-particle depth keys and the radix-sort scratch.
  private keys: Float32Array | null = null;
  private qkeys: Uint16Array | null = null;
  private order: Uint32Array | null = null;
  private order2: Uint32Array | null = null;
  private order3: Uint32Array | null = null;
  private buckets = new Uint32Array(256);
  /** State of the last sort (skip re-sorting an unchanged view) */
  private sortStamp = { now: NaN, emitted: -1, x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0 };
  /** Live particles written to the draw buffers by the last sort (telemetry, tests) */
  drawn = 0;

  constructor(name: string, capacity: number, material: THREE.ShaderMaterial, opts: ParticleLayerOptions = {}) {
    this.capacity = capacity;
    this.sorted = !!opts.sorted;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    for (const a of ATTRS) {
      const arr = new Float32Array(capacity * 4);
      // Unborn slots: t0 far in the future so they are culled in the vertex shader.
      if (a === 'a0') for (let i = 0; i < capacity; i++) arr[i * 4 + 3] = 1e9;
      const attr = new THREE.InstancedBufferAttribute(arr, 4);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(a, attr);
      this.arrays.push(arr);
      this.attrs.push(attr);
    }
    g.instanceCount = this.sorted ? 0 : capacity;
    if (this.sorted) {
      for (let k = 0; k < ATTRS.length; k++) {
        const arr = new Float32Array(capacity * 4);
        if (k === 0) for (let i = 0; i < capacity; i++) arr[i * 4 + 3] = 1e9;
        this.store.push(arr);
      }
      this.keys = new Float32Array(capacity);
      this.qkeys = new Uint16Array(capacity);
      this.order = new Uint32Array(capacity);
      this.order2 = new Uint32Array(capacity);
      this.order3 = new Uint32Array(capacity);
    } else this.store = this.arrays;
    [this.a0, this.a1, this.a2, this.a3, this.a4, this.a5] = this.store as [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
    // All six attributes go up in the same draw; the first one reports it.
    this.attrs[0]!.onUpload(() => {
      this.pendStart = this.pendEnd = -1;
    });
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  emit(p: ParticleRecord): void {
    if (!(p.life > 0) || !Number.isFinite(p.x + p.y + p.z + p.vx + p.vy + p.vz + p.t0)) return;
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const o = i * 4;
    const a0 = this.a0, a1 = this.a1, a2 = this.a2, a3 = this.a3, a4 = this.a4, a5 = this.a5;
    a0[o] = p.x; a0[o + 1] = p.y; a0[o + 2] = p.z; a0[o + 3] = p.t0;
    a1[o] = p.vx; a1[o + 1] = p.vy; a1[o + 2] = p.vz; a1[o + 3] = p.life;
    a2[o] = Math.max(1e-4, p.drag); a2[o + 1] = p.gravity; a2[o + 2] = p.floor; a2[o + 3] = p.tLand;
    a3[o] = p.size0; a3[o + 1] = p.size1; a3[o + 2] = Math.max(1e-3, p.growth); a3[o + 3] = p.spin;
    a4[o] = p.r; a4[o + 1] = p.g; a4[o + 2] = p.b; a4[o + 3] = p.opacity;
    a5[o] = p.seed; a5[o + 1] = p.variant; a5[o + 2] = p.heat; a5[o + 3] = p.extra;
    this.emitted++;
    this.lastDeath = Math.max(this.lastDeath, p.t0 + p.life);
    this.mesh.visible = true;
    if (this.sorted) return;
    if (this.dirtyStart < 0) {
      this.dirtyStart = i;
      this.dirtyEnd = i;
    } else if (i === this.dirtyEnd + 1) {
      this.dirtyEnd = i;
    } else {
      // Wrapped around the ring: upload everything this frame.
      this.dirtyStart = 0;
      this.dirtyEnd = this.capacity - 1;
    }
  }

  /**
   * Queue this frame's new particles for the GPU; hide the draw when every particle is dead.
   * three.js uploads (and forgets) an attribute's update ranges only when the mesh is drawn, and
   * frames can be stepped without a draw (Simulation.advance, scripted runs), so the range queued
   * is the union of everything written since the last actual upload.
   */
  flush(now: number): void {
    if (this.sorted) {
      // The draw buffers are rebuilt by sort() right before the draw.
      this.mesh.visible = now <= this.lastDeath;
      return;
    }
    if (this.dirtyStart >= 0) {
      this.pendStart = this.pendStart < 0 ? this.dirtyStart : Math.min(this.pendStart, this.dirtyStart);
      this.pendEnd = Math.max(this.pendEnd, this.dirtyEnd);
      const start = this.pendStart * 4, count = (this.pendEnd - this.pendStart + 1) * 4;
      for (const a of this.attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(start, count);
        a.needsUpdate = true;
      }
      this.dirtyStart = this.dirtyEnd = -1;
    }
    this.mesh.visible = now <= this.lastDeath;
  }

  /**
   * Sorted layers: write the particles alive at `now` into the draw buffers, farthest from the camera
   * first, so premultiplied 'over' blending composites them in the right order (painter's
   * algorithm). Positions come from the same closed-form motion the vertex shader evaluates
   * (motion.ts; the single floor bounce is approximated by clamping to the floor). A 16-bit LSD
   * radix sort keeps the whole pass O(n) (≈ 0.2 ms to sort 9 000 particles); only the live
   * particles are uploaded and drawn. Skipped when neither the time, the view nor the pool changed.
   */
  sort(camera: THREE.Camera, now: number, wind: THREE.Vector3): void {
    if (!this.sorted) return;
    const e = camera.matrixWorld.elements;
    const cx = e[12]!, cy = e[13]!, cz = e[14]!;
    const fx = -e[8]!, fy = -e[9]!, fz = -e[10]!;
    const st = this.sortStamp;
    if (st.now === now && st.emitted === this.emitted && st.x === cx && st.y === cy && st.z === cz && st.fx === fx && st.fy === fy && st.fz === fz) return;
    st.now = now; st.emitted = this.emitted; st.x = cx; st.y = cy; st.z = cz; st.fx = fx; st.fy = fy; st.fz = fz;
    const [s0, s1, s2] = this.store as [Float32Array, Float32Array, Float32Array];
    const keys = this.keys!, idx = this.order!;
    const wx = wind.x, wy = wind.y, wz = wind.z;
    let n = 0;
    let lo = Infinity, hi = -Infinity;
    if (now <= this.lastDeath) {
      for (let i = 0; i < this.capacity; i++) {
        const o = i * 4;
        const age = now - s0[o + 3]!;
        if (age < 0 || age > s1[o + 3]!) continue;
        const k = s2[o]!;
        const A = driftA(k, age), B = driftB(k, age);
        const x = s0[o]! + wx * age + (s1[o]! - wx) * A;
        let y = s0[o + 1]! + wy * age + (s1[o + 1]! - wy) * A - GRAVITY * s2[o + 1]! * B;
        const z = s0[o + 2]! + wz * age + (s1[o + 2]! - wz) * A;
        if (s2[o + 3]! >= 0 && age > s2[o + 3]!) y = Math.max(y, s2[o + 2]!);
        const d = (x - cx) * fx + (y - cy) * fy + (z - cz) * fz;
        keys[n] = d;
        idx[n] = i;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
        n++;
      }
    }
    // Radix-sort positions 0..n−1 by quantised depth (far → 0 … near → 65535, ascending = far first).
    const q = this.qkeys!, a = this.order2!, b = this.order3!, c = this.buckets;
    const s = 65535 / Math.max(hi - lo, 1e-6);
    for (let j = 0; j < n; j++) {
      q[j] = Math.min(65535, Math.max(0, Math.round((hi - keys[j]!) * s)));
      a[j] = j;
    }
    for (let pass = 0; pass < 2; pass++) {
      const sh = pass * 8;
      const from = pass === 0 ? a : b, to = pass === 0 ? b : a;
      c.fill(0);
      for (let j = 0; j < n; j++) c[(q[from[j]!]! >> sh) & 255]!++;
      let sum = 0;
      for (let k = 0; k < 256; k++) {
        const v = c[k]!;
        c[k] = sum;
        sum += v;
      }
      for (let j = 0; j < n; j++) {
        const p = from[j]!;
        to[c[(q[p]! >> sh) & 255]!++] = p;
      }
    }
    // Copy the live particles, in draw order, into the attribute arrays.
    const dst = this.arrays;
    const src = this.store;
    for (let j = 0; j < n; j++) {
      const from = idx[a[j]!]! * 4, to = j * 4;
      for (let k = 0; k < 6; k++) {
        const S = src[k]!, D = dst[k]!;
        D[to] = S[from]!; D[to + 1] = S[from + 1]!; D[to + 2] = S[from + 2]!; D[to + 3] = S[from + 3]!;
      }
    }
    this.drawn = n;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      for (const a of this.attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * 4);
        a.needsUpdate = true;
      }
    }
  }

  /** Kill everything (scene change). */
  clear(): void {
    const a0 = this.arrays[0]!;
    for (let i = 0; i < this.capacity; i++) a0[i * 4 + 3] = 1e9;
    if (this.sorted) {
      const s0 = this.store[0]!;
      for (let i = 0; i < this.capacity; i++) s0[i * 4 + 3] = 1e9;
      this.geometry.instanceCount = 0;
      this.drawn = 0;
      this.sortStamp.emitted = -1;
    }
    this.pendStart = 0;
    this.pendEnd = this.capacity - 1;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.capacity * 4);
      a.needsUpdate = true;
    }
    this.lastDeath = -Infinity;
    this.mesh.visible = false;
    this.dirtyStart = this.dirtyEnd = -1;
  }

  /** Number of particles alive at time `now` (CPU scan; telemetry only). */
  countAlive(now: number): number {
    const a0 = this.store[0]!, a1 = this.store[1]!;
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      const age = now - a0[i * 4 + 3]!;
      if (age >= 0 && age <= a1[i * 4 + 3]!) n++;
    }
    return n;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
