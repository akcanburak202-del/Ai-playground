import * as THREE from 'three';
import type { WoundProfile } from '../../physics/ballistics/types.ts';

/**
 * Geometry of the wound channels inside a gel piece, built from the resolver's wound profiles
 * (segment-local): the permanent (crush) channel as a milky tube, the radial tears as translucent
 * blades running along it (the star-shaped cracks that stay in shot gelatin), fragment side
 * channels as thin tubes, and the bullet itself where it came to rest, turned to its final yaw.
 * Pure THREE geometry (no DOM).
 */

export interface WoundRecord {
  /** Entry point and unit direction, segment-local */
  o: THREE.Vector3;
  u: THREE.Vector3;
  profile: WoundProfile;
  seed: number;
  /** Bullet that stopped in the gel: calibre and length after break-up, m */
  bullet?: { d: number; L: number };
}

export interface WoundGeometry {
  channel: THREE.BufferGeometry;
  tears: THREE.BufferGeometry;
  bullets: THREE.BufferGeometry | null;
}

class Buf {
  pos: number[] = [];
  nor: number[] = [];
  idx: number[] = [];
  vert(p: THREE.Vector3, n: THREE.Vector3): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    return this.pos.length / 3 - 1;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Deterministic value noise in [0, 1] (hash of an integer lattice, smooth in between). */
function noise1(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i;
  const h = (n: number) => {
    const s = Math.sin((n + seed * 17.13) * 127.1) * 43758.5453;
    return s - Math.floor(s);
  };
  const k = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * k;
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Two unit vectors perpendicular to u. */
function basis(u: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): void {
  a.set(Math.abs(u.y) < 0.9 ? 0 : 1, Math.abs(u.y) < 0.9 ? 1 : 0, 0).cross(u).normalize();
  b.crossVectors(u, a).normalize();
}

/** Tube along `from + dir·s` with radius radii(s) at the given stations. */
function tube(buf: Buf, from: THREE.Vector3, dir: THREE.Vector3, stations: number[], radii: (i: number) => number, sides: number, seed: number): void {
  basis(dir, _a, _b);
  const base = buf.pos.length / 3;
  for (let i = 0; i < stations.length; i++) {
    const r = radii(i);
    for (let j = 0; j < sides; j++) {
      const th = (j / sides) * Math.PI * 2;
      const wob = 1 + 0.3 * (noise1(i * 1.7 + j * 3.1, seed) - 0.5);
      _n.copy(_a).multiplyScalar(Math.cos(th)).addScaledVector(_b, Math.sin(th));
      _p.copy(from).addScaledVector(dir, stations[i]!).addScaledVector(_n, r * wob);
      buf.vert(_p, _n);
    }
  }
  for (let i = 0; i < stations.length - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides;
      const a = base + i * sides + j, b = base + i * sides + j1, c = base + (i + 1) * sides + j, d = base + (i + 1) * sides + j1;
      buf.idx.push(a, c, b, b, c, d);
    }
  }
}

/**
 * Build the channel, tear and bullet geometry of every wound in a piece (one draw call each).
 * `maxTears` caps how many of the latest wounds get tears (the channels are always drawn).
 */
export function buildWounds(wounds: readonly WoundRecord[], maxTears = 30): WoundGeometry {
  const ch = new Buf();
  const te = new Buf();
  const bu = new Buf();
  const firstTear = Math.max(0, wounds.length - maxTears);
  wounds.forEach((w, wi) => {
    const pr = w.profile;
    const n = pr.s.length;
    if (n < 1) return;
    const stations = n === 1 ? [0, Math.max(pr.length, 0.005)] : pr.s.map((s, i) => (i === 0 ? 0 : i === n - 1 ? pr.length : s));
    const crushAt = (i: number) => pr.crush[Math.min(i, n - 1)]!;
    tube(ch, w.o, w.u, stations, crushAt, 8, w.seed);
    // Fragment and splinter side channels.
    basis(w.u, _a, _b);
    for (const f of pr.fragments) {
      _c.copy(_a).multiplyScalar(Math.cos(f.azimuth)).addScaledVector(_b, Math.sin(f.azimuth));
      const dir = new THREE.Vector3().copy(w.u).multiplyScalar(Math.cos(f.polar)).addScaledVector(_c, Math.sin(f.polar)).normalize();
      const from = new THREE.Vector3().copy(w.o).addScaledVector(w.u, f.s);
      tube(ch, from, dir, [0, 0.5 * f.length, f.length], (i) => (i === 2 ? 0.0003 : 0.0009), 4, w.seed + f.azimuth);
    }
    if (wi >= firstTear) tears(te, w, stations);
    if (w.bullet && pr.stopped) bullet(bu, w);
  });
  return { channel: ch.build(), tears: te.build(), bullets: bu.pos.length ? bu.build() : null };
}

/**
 * Radial tears: 4–7 blades around the channel, each a ribbon from the crush radius out to a
 * fraction of the tear reach that wanders along the track (gel splits along a few planes).
 */
function tears(buf: Buf, w: WoundRecord, stations: number[]): void {
  const pr = w.profile;
  const n = stations.length;
  const k = 4 + Math.floor(noise1(0.5, w.seed) * 4);
  basis(w.u, _a, _b);
  for (let b = 0; b < k; b++) {
    const phi0 = (b / k) * Math.PI * 2 + noise1(b * 2.3, w.seed) * 1.2;
    const base = buf.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const s = stations[i]!;
      const j = Math.min(i, pr.fissure.length - 1);
      const phi = phi0 + 0.5 * (noise1(s * 9 + b * 5.1, w.seed) - 0.5);
      const reach = pr.crush[j]! + (pr.fissure[j]! - pr.crush[j]!) * (0.25 + 0.75 * noise1(s * 30 + b * 7.7, w.seed + 3));
      _c.copy(_a).multiplyScalar(Math.cos(phi)).addScaledVector(_b, Math.sin(phi));
      _n.crossVectors(w.u, _c).normalize();
      _p.copy(w.o).addScaledVector(w.u, s).addScaledVector(_c, pr.crush[j]! * 0.8);
      buf.vert(_p, _n);
      _p.copy(w.o).addScaledVector(w.u, s).addScaledVector(_c, reach);
      buf.vert(_p, _n);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + 2 * i, c = base + 2 * (i + 1);
      buf.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
}

/** The spent bullet at the end of its channel, a short cylinder turned to its final yaw. */
function bullet(buf: Buf, w: WoundRecord): void {
  const pr = w.profile;
  const yaw = pr.yaw.length ? pr.yaw[pr.yaw.length - 1]! : 0;
  basis(w.u, _a, _b);
  const axis = new THREE.Vector3().copy(w.u).multiplyScalar(Math.cos(yaw)).addScaledVector(_a, Math.sin(yaw)).normalize();
  const c = new THREE.Vector3().copy(w.o).addScaledVector(w.u, pr.length);
  const d = w.bullet!.d, L = Math.max(w.bullet!.L, d);
  const from = c.clone().addScaledVector(axis, -0.5 * L);
  const radii = [0.15 * d, 0.5 * d, 0.5 * d, 0.45 * d];
  const st = [0, 0.3 * L, 0.85 * L, L];
  tube(buf, from, axis, st, (i) => radii[i]!, 8, w.seed);
}
