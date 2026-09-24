import * as THREE from 'three';

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

/**
 * A pool of camera-facing (or velocity-stretched) quads in one instanced draw call. New particles
 * overwrite the oldest in a ring; only the written slots are uploaded (update ranges).
 */
export class ParticleLayer {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private geometry: THREE.InstancedBufferGeometry;
  private arrays: Float32Array[] = [];
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

  constructor(name: string, capacity: number, material: THREE.ShaderMaterial) {
    this.capacity = capacity;
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
    g.instanceCount = capacity;
    [this.a0, this.a1, this.a2, this.a3, this.a4, this.a5] = this.arrays as [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
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
    this.emitted++;
    this.lastDeath = Math.max(this.lastDeath, p.t0 + p.life);
    this.mesh.visible = true;
  }

  /**
   * Queue this frame's new particles for the GPU; hide the draw when every particle is dead.
   * three.js uploads (and forgets) an attribute's update ranges only when the mesh is drawn, and
   * frames can be stepped without a draw (Simulation.advance, scripted runs), so the range queued
   * is the union of everything written since the last actual upload.
   */
  flush(now: number): void {
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

  /** Kill everything (scene change). */
  clear(): void {
    const a0 = this.arrays[0]!;
    for (let i = 0; i < this.capacity; i++) a0[i * 4 + 3] = 1e9;
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
    const a0 = this.arrays[0]!, a1 = this.arrays[1]!;
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
