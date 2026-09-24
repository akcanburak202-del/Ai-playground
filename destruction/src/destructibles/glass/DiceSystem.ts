import * as THREE from 'three';
import type { SimContext } from '../../app/contracts.ts';
import { createDiceMaterial } from './look.ts';

/** Scene-wide cap on live dice; the oldest are recycled first. */
export const DICE_CAP = 60000;

export interface DieSpawn {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Absolute simulation time the die leaves the pane, s */
  release: number;
  /** Flight time to first ground contact (from release), s */
  flight: number;
  /** Linearised drag rate, 1/s */
  drag: number;
  /** 0..1 per-die random (spin axis, spin rate, resting face, heading) */
  seed: number;
  /** Size along the pane width / height, and thickness, m */
  sx: number; sy: number; sz: number;
  /** Height of the die's centre when it rests on the floor, m */
  floor: number;
  /** Initial orientation (the pane's) */
  qx: number; qy: number; qz: number; qw: number;
  /** Albedo (linear, 0..1) */
  r: number; g: number; b: number;
  /** Absolute time the die starts fading into its heap decal, s */
  fadeAt: number;
  /** Size of the individual dice (a spawn larger than this is a clump of several), m */
  cell: number;
}

const systems = new WeakMap<SimContext, DiceSystem>();
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * Every tempered-glass die in the scene: one instanced mesh drawn in a single call whose vertex
 * shader evaluates each die's closed-form motion from its launch state (look.ts). Spawning writes a
 * ring buffer once; nothing is simulated or uploaded per frame. Shared by all panes of a scene and
 * reference-counted by them.
 */
export class DiceSystem {
  static acquire(ctx: SimContext): DiceSystem {
    let s = systems.get(ctx);
    if (!s || s.disposed) {
      s = new DiceSystem(ctx);
      systems.set(ctx, s);
    }
    s.refs++;
    return s;
  }

  readonly time: THREE.IUniform<number> = { value: 0 };
  readonly mesh: THREE.Mesh;
  disposed = false;
  /** Dice written since creation */
  spawned = 0;
  private refs = 0;
  private readonly ctx: SimContext;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly p0: THREE.InstancedBufferAttribute;
  private readonly v0: THREE.InstancedBufferAttribute;
  private readonly t: THREE.InstancedBufferAttribute;
  private readonly s: THREE.InstancedBufferAttribute;
  private readonly q: THREE.InstancedBufferAttribute;
  private readonly e: THREE.InstancedBufferAttribute;
  private head = 0;
  private dirtyFrom = -1;
  private dirtyCount = 0;
  /** Recent spawn requests (simulation time, dice) for the adaptive per-pane budget */
  private demand: { t: number; n: number }[] = [];

  private constructor(ctx: SimContext) {
    this.ctx = ctx;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(box.getIndex());
    g.setAttribute('position', box.getAttribute('position'));
    g.setAttribute('normal', box.getAttribute('normal'));
    g.setAttribute('uv', box.getAttribute('uv'));
    box.dispose();
    const attr = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(DICE_CAP * n), n).setUsage(THREE.DynamicDrawUsage);
    this.p0 = attr(3);
    this.v0 = attr(3);
    this.t = attr(4);
    this.s = attr(4);
    this.q = attr(4);
    this.e = attr(4);
    g.setAttribute('aP0', this.p0);
    g.setAttribute('aV0', this.v0);
    g.setAttribute('aT', this.t);
    g.setAttribute('aS', this.s);
    g.setAttribute('aQ', this.q);
    g.setAttribute('aE', this.e);
    g.instanceCount = 0;
    this.geometry = g;
    this.material = createDiceMaterial(this.time);
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'glass-dice';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    ctx.scene.add(this.mesh);
  }

  /**
   * Dice a newly broken pane may use: the scene-wide ring is shared, so when many panes break at
   * once (a blast along a curtain wall) each gets a geometrically smaller share and throws coarser
   * clumps instead of recycling the dice of its neighbours mid-air.
   */
  budget(now: number, max: number): number {
    this.demand = this.demand.filter((d) => now - d.t < 1.5);
    let recent = 0;
    for (const d of this.demand) recent += d.n;
    const n = Math.round(Math.min(max, Math.max(1500, 0.35 * (DICE_CAP - recent))));
    this.demand.push({ t: now, n });
    return n;
  }

  /** Ring slot the next write goes to. */
  get next(): number {
    return this.head;
  }

  /** Set the fade time of `count` dice written from ring slot `from` (they fade into their heap). */
  setFade(from: number, count: number, fadeAt: number): void {
    const e = this.e.array as Float32Array;
    for (let k = 0; k < Math.min(count, DICE_CAP); k++) e[4 * ((from + k) % DICE_CAP) + 1] = fadeAt;
  }

  /** Live dice slots in use. */
  get count(): number {
    return this.geometry.instanceCount;
  }

  /** Write one die into the ring (overwriting the oldest when full). */
  write(d: DieSpawn): void {
    const i = this.head;
    this.head = (this.head + 1) % DICE_CAP;
    this.spawned++;
    if (this.geometry.instanceCount < DICE_CAP) this.geometry.instanceCount++;
    if (this.dirtyFrom < 0) this.dirtyFrom = i;
    this.dirtyCount = Math.min(DICE_CAP, this.dirtyCount + 1);
    const p = this.p0.array as Float32Array, v = this.v0.array as Float32Array;
    const t = this.t.array as Float32Array, s = this.s.array as Float32Array;
    const q = this.q.array as Float32Array, e = this.e.array as Float32Array;
    p[3 * i] = d.x; p[3 * i + 1] = d.y; p[3 * i + 2] = d.z;
    v[3 * i] = d.vx; v[3 * i + 1] = d.vy; v[3 * i + 2] = d.vz;
    t[4 * i] = d.release; t[4 * i + 1] = d.flight; t[4 * i + 2] = d.drag; t[4 * i + 3] = d.seed;
    s[4 * i] = d.sx; s[4 * i + 1] = d.sy; s[4 * i + 2] = d.sz; s[4 * i + 3] = d.floor;
    q[4 * i] = d.qx; q[4 * i + 1] = d.qy; q[4 * i + 2] = d.qz; q[4 * i + 3] = d.qw;
    e[4 * i] = byte(d.r) * 65536 + byte(d.g) * 256 + byte(d.b);
    e[4 * i + 1] = d.fadeAt;
    e[4 * i + 2] = d.cell;
    e[4 * i + 3] = 0;
  }

  /** Queue the GPU upload of everything written since the last flush (only the touched slots). */
  flush(): void {
    if (this.dirtyFrom < 0) return;
    const from = this.dirtyFrom, n = this.dirtyCount;
    this.dirtyFrom = -1;
    this.dirtyCount = 0;
    for (const a of [this.p0, this.v0, this.t, this.s, this.q, this.e]) {
      const k = a.itemSize;
      if (from + n <= DICE_CAP) a.addUpdateRange(from * k, n * k);
      else {
        a.addUpdateRange(from * k, (DICE_CAP - from) * k);
        a.addUpdateRange(0, (from + n - DICE_CAP) * k);
      }
      a.needsUpdate = true;
    }
  }

  update(now: number): void {
    this.time.value = now;
    this.flush();
  }

  release(): void {
    if (--this.refs <= 0) this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    if (systems.get(this.ctx) === this) systems.delete(this.ctx);
  }
}
