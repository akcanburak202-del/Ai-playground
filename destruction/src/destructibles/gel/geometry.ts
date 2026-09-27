import * as THREE from 'three';
import type { BoneSpec, Section, ShellSpec, V3 } from './anatomy.ts';

/**
 * Geometry of the gel pieces: lofted, watertight shells (so a ray's crossings pair up into
 * entry/exit), exact ray tests against their triangles, analytic ray tests against the synthetic
 * bones, and a cheap "how deep inside am I" estimate. Everything is in the segment's local frame
 * (dummy frame minus the segment origin). Pure THREE math: no DOM, testable under Node.
 */

const _v = new THREE.Vector3();

function interp(sections: Section[], t: number): Required<Section> {
  const s = sections;
  let i = 0;
  while (i < s.length - 2 && t > s[i + 1]!.t) i++;
  const a = s[i]!, b = s[Math.min(i + 1, s.length - 1)]!;
  const span = b.t - a.t;
  const x = span > 1e-9 ? THREE.MathUtils.clamp((t - a.t) / span, 0, 1) : 0;
  const k = x * x * (3 - 2 * x);
  const mix = (p: number | undefined, q: number | undefined, def: number) => (p ?? def) + ((q ?? def) - (p ?? def)) * k;
  return { t, w: mix(a.w, b.w, 0), d: mix(a.d, b.d, 0), ox: mix(a.ox, b.ox, 0), oz: mix(a.oz, b.oz, 0), n: mix(a.n, b.n, 2) };
}

/** Point of a superellipse |x/w|^n + |y/d|^n = 1 at parameter angle θ. */
function superellipse(theta: number, w: number, d: number, n: number, out: { x: number; y: number }): void {
  const c = Math.cos(theta), s = Math.sin(theta);
  const e = 2 / n;
  out.x = w * Math.sign(c) * Math.pow(Math.abs(c), e);
  out.y = d * Math.sign(s) * Math.pow(Math.abs(s), e);
}

/** A closed lofted gel surface with its frame, triangles and bounds (segment-local). */
export class GelShell {
  readonly spec: ShellSpec;
  readonly a = new THREE.Vector3();
  readonly u = new THREE.Vector3();
  readonly e1 = new THREE.Vector3();
  readonly e2 = new THREE.Vector3();
  readonly len: number;
  readonly positions: Float32Array;
  readonly index: Uint32Array;
  readonly box = new THREE.Box3();

  constructor(spec: ShellSpec, origin: V3, radial = 32) {
    this.spec = spec;
    this.a.set(spec.a[0] - origin[0], spec.a[1] - origin[1], spec.a[2] - origin[2]);
    const b = new THREE.Vector3(spec.b[0] - origin[0], spec.b[1] - origin[1], spec.b[2] - origin[2]);
    this.u.copy(b).sub(this.a);
    this.len = this.u.length();
    this.u.divideScalar(Math.max(this.len, 1e-9));
    const h = new THREE.Vector3(...(spec.across ?? [1, 0, 0]));
    if (Math.abs(h.dot(this.u)) > 0.95) h.set(0, 0, 1);
    this.e1.copy(h).addScaledVector(this.u, -h.dot(this.u)).normalize();
    // Depth axis: e1 × u, so a vertical shell with width along +x has its depth along +z (front).
    this.e2.crossVectors(this.e1, this.u).normalize();

    // Rings: dome (or flat) cap at a, barrel, cap at b; poles close both ends.
    const rings: { ax: number; t: number; scale: number }[] = [];
    const [capA, capB] = spec.caps;
    const K = 6;
    if (capA > 0) for (let k = K - 1; k >= 1; k--) {
      const phi = (k / K) * Math.PI * 0.5;
      rings.push({ ax: -capA * Math.sin(phi), t: 0, scale: Math.cos(phi) });
    }
    const nb = Math.min(48, Math.max(6, Math.ceil(this.len / 0.018)));
    for (let i = 0; i <= nb; i++) rings.push({ ax: (i / nb) * this.len, t: i / nb, scale: 1 });
    if (capB > 0) for (let k = 1; k <= K - 1; k++) {
      const phi = (k / K) * Math.PI * 0.5;
      rings.push({ ax: this.len + capB * Math.sin(phi), t: 1, scale: Math.cos(phi) });
    }
    const nr = rings.length;
    const pos = new Float32Array((nr * radial + 2) * 3);
    const pt = { x: 0, y: 0 };
    let w = 0;
    for (const r of rings) {
      const s = interp(spec.sections, r.t);
      for (let j = 0; j < radial; j++) {
        superellipse((j / radial) * Math.PI * 2, s.w * r.scale, s.d * r.scale, s.n, pt);
        _v.copy(this.a).addScaledVector(this.u, r.ax).addScaledVector(this.e1, pt.x + s.ox).addScaledVector(this.e2, pt.y + s.oz);
        pos[w++] = _v.x; pos[w++] = _v.y; pos[w++] = _v.z;
      }
    }
    const s0 = interp(spec.sections, 0), s1 = interp(spec.sections, 1);
    _v.copy(this.a).addScaledVector(this.u, -capA).addScaledVector(this.e1, s0.ox).addScaledVector(this.e2, s0.oz);
    pos[w++] = _v.x; pos[w++] = _v.y; pos[w++] = _v.z;
    _v.copy(this.a).addScaledVector(this.u, this.len + capB).addScaledVector(this.e1, s1.ox).addScaledVector(this.e2, s1.oz);
    pos[w++] = _v.x; pos[w++] = _v.y; pos[w++] = _v.z;
    const poleA = nr * radial, poleB = poleA + 1;
    const idx: number[] = [];
    // Winding: the ring runs e1 → e2 and rings advance along u, so (i, i+1 on the next ring…)
    // gives outward normals (e1 × e2 = −u … checked by the unit tests).
    for (let r = 0; r < nr - 1; r++) {
      for (let j = 0; j < radial; j++) {
        const j1 = (j + 1) % radial;
        const p00 = r * radial + j, p01 = r * radial + j1, p10 = (r + 1) * radial + j, p11 = (r + 1) * radial + j1;
        idx.push(p00, p10, p01, p01, p10, p11);
      }
    }
    for (let j = 0; j < radial; j++) {
      const j1 = (j + 1) % radial;
      idx.push(poleA, j, j1);
      idx.push(poleB, (nr - 1) * radial + j1, (nr - 1) * radial + j);
    }
    this.positions = pos;
    this.index = Uint32Array.from(idx);
    this.box.makeEmpty();
    for (let i = 0; i < pos.length; i += 3) this.box.expandByPoint(_v.set(pos[i]!, pos[i + 1]!, pos[i + 2]!));
  }

  /** A fresh render geometry of this shell (the caller owns and disposes it). */
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.positions.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(this.index.slice(), 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  /**
   * Every crossing of the line o + t·d (d normalised; t of either sign when o is inside the
   * bounds) with the surface, appended to `out` (unsorted); `tri` gets each crossing's triangle.
   */
  crossings(o: THREE.Vector3, d: THREE.Vector3, out: number[], tri?: number[]): void {
    if (!this.box.containsPoint(o) && rayBox(this.box, o, d) === Infinity) return;
    const p = this.positions, ix = this.index;
    const ox = o.x, oy = o.y, oz = o.z, dx = d.x, dy = d.y, dz = d.z;
    for (let k = 0; k < ix.length; k += 3) {
      const i0 = ix[k]! * 3, i1 = ix[k + 1]! * 3, i2 = ix[k + 2]! * 3;
      const ax = p[i0]!, ay = p[i0 + 1]!, az = p[i0 + 2]!;
      const e1x = p[i1]! - ax, e1y = p[i1 + 1]! - ay, e1z = p[i1 + 2]! - az;
      const e2x = p[i2]! - ax, e2y = p[i2 + 1]! - ay, e2z = p[i2 + 2]! - az;
      // Möller–Trumbore, two-sided.
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const tx = ox - ax, ty = oy - ay, tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      out.push(t);
      tri?.push(k / 3);
    }
  }

  /** Unit normal of triangle `tri` (outward), segment-local. */
  triangleNormal(tri: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.positions, ix = this.index;
    const i0 = ix[tri * 3]! * 3, i1 = ix[tri * 3 + 1]! * 3, i2 = ix[tri * 3 + 2]! * 3;
    const ax = p[i1]! - p[i0]!, ay = p[i1 + 1]! - p[i0 + 1]!, az = p[i1 + 2]! - p[i0 + 2]!;
    const bx = p[i2]! - p[i0]!, by = p[i2 + 1]! - p[i0 + 1]!, bz = p[i2 + 2]! - p[i0 + 2]!;
    return out.set(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx).normalize();
  }

  /**
   * Signed depth of a point inside this shell, m: > 0 inside (≈ the distance to the nearest
   * surface across the section or to the end), < 0 outside. An estimate, good to a few mm.
   */
  depthOf(p: THREE.Vector3): number {
    _v.copy(p).sub(this.a);
    const ax = _v.dot(this.u);
    const [capA, capB] = this.spec.caps;
    let scale = 1;
    let t = ax / Math.max(this.len, 1e-9);
    let endDist = Math.min(ax + capA, this.len + capB - ax);
    if (ax < 0) {
      if (capA <= 0) return ax;
      const f = -ax / capA;
      if (f >= 1) return -(ax + capA);
      scale = Math.sqrt(1 - f * f);
      t = 0;
    } else if (ax > this.len) {
      if (capB <= 0) return this.len - ax;
      const f = (ax - this.len) / capB;
      if (f >= 1) return this.len + capB - ax;
      scale = Math.sqrt(1 - f * f);
      t = 1;
    }
    if (capA <= 0) endDist = Math.min(endDist, ax);
    if (capB <= 0) endDist = Math.min(endDist, this.len - ax);
    const s = interp(this.spec.sections, THREE.MathUtils.clamp(t, 0, 1));
    const x = _v.dot(this.e1) - s.ox, y = _v.dot(this.e2) - s.oz;
    const w = s.w * scale, d = s.d * scale;
    const rho = Math.pow(Math.pow(Math.abs(x / w), s.n) + Math.pow(Math.abs(y / d), s.n), 1 / s.n);
    const across = (1 - rho) * Math.min(w, d);
    return Math.min(across, endDist);
  }

  /** Half-size of the cross-section (the smaller of half width and half depth) at a point's axial position, m. */
  sectionRadius(p: THREE.Vector3): number {
    _v.copy(p).sub(this.a);
    const t = THREE.MathUtils.clamp(_v.dot(this.u) / Math.max(this.len, 1e-9), 0, 1);
    const s = interp(this.spec.sections, t);
    return Math.min(s.w, s.d);
  }

  /** Enclosed volume, m³ (divergence theorem over the triangles). */
  volume(): number {
    const p = this.positions, ix = this.index;
    let v = 0;
    for (let k = 0; k < ix.length; k += 3) {
      const a = ix[k]! * 3, b = ix[k + 1]! * 3, c = ix[k + 2]! * 3;
      v += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!)
        - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!)
        + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
    }
    return Math.abs(v) / 6;
  }
}

/** Slab test (origin outside) returning the entry distance or Infinity. */
export function rayBox(box: THREE.Box3, o: THREE.Vector3, d: THREE.Vector3): number {
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
    const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
    const lo = a === 0 ? box.min.x : a === 1 ? box.min.y : box.min.z;
    const hi = a === 0 ? box.max.x : a === 1 ? box.max.y : box.max.z;
    if (Math.abs(da) < 1e-12) {
      if (oa < lo || oa > hi) return Infinity;
      continue;
    }
    let n = (lo - oa) / da, f = (hi - oa) / da;
    if (n > f) { const t = n; n = f; f = t; }
    if (n > t0) t0 = n;
    if (f < t1) t1 = f;
    if (t1 < t0) return Infinity;
  }
  return t0;
}

/**
 * Pair the sorted crossings of one closed surface into [in, out) intervals, appended to `out`
 * as flat pairs. Near-duplicate crossings (a ray through a shared edge) are merged first.
 */
export function pairCrossings(ts: number[], out: number[], tri?: number[], entryTri?: number[]): void {
  const order = ts.map((_, i) => i).sort((a, b) => ts[a]! - ts[b]!);
  const t: number[] = [];
  const k: number[] = [];
  for (const i of order) {
    if (t.length && ts[i]! - t[t.length - 1]! <= 1e-6) continue;
    t.push(ts[i]!);
    k.push(tri ? tri[i]! : -1);
  }
  for (let i = 0; i + 1 < t.length; i += 2) {
    out.push(t[i]!, t[i + 1]!);
    entryTri?.push(k[i]!);
  }
}

/** Union of flat interval pairs, sorted, in place. */
export function unionIntervals(iv: number[]): number[] {
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < iv.length; i += 2) pairs.push([iv[i]!, iv[i + 1]!]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [a, b] of pairs) {
    if (out.length && a <= out[out.length - 1]! + 1e-6) out[out.length - 1] = Math.max(out[out.length - 1]!, b);
    else out.push(a, b);
  }
  return out;
}

// ─── Bones ─────────────────────────────────────────────────────────────────────────────────

/** A synthetic bone in segment-local coordinates with its ray test. */
export class Bone {
  readonly spec: BoneSpec;
  readonly a = new THREE.Vector3();
  readonly w = new THREE.Vector3();
  readonly len: number = 0;
  readonly c = new THREE.Vector3();
  readonly r = new THREE.Vector3();
  /** Rib cage height range, segment-local y */
  readonly y0: number = 0;
  readonly y1: number = 0;
  /** Where the bone was broken (segment-local points) */
  readonly breaks: THREE.Vector3[] = [];

  constructor(spec: BoneSpec, origin: V3) {
    this.spec = spec;
    if (spec.type === 'tube') {
      this.a.set(spec.a[0] - origin[0], spec.a[1] - origin[1], spec.a[2] - origin[2]);
      this.w.set(spec.b[0] - spec.a[0], spec.b[1] - spec.a[1], spec.b[2] - spec.a[2]);
      this.len = this.w.length();
      this.w.divideScalar(Math.max(this.len, 1e-9));
    } else if (spec.type === 'shell') {
      this.c.set(spec.c[0] - origin[0], spec.c[1] - origin[1], spec.c[2] - origin[2]);
      this.r.set(...spec.r);
    } else {
      this.c.set(spec.cx - origin[0], 0, spec.cz - origin[2]);
      this.r.set(spec.rx, 0, spec.rz);
      this.y0 = spec.y0 - origin[1];
      this.y1 = spec.y1 - origin[1];
    }
  }

  /** Intervals of bone along the ray (flat pairs, ascending), for t ≥ 0. */
  intervals(o: THREE.Vector3, d: THREE.Vector3, out: number[]): void {
    const s = this.spec;
    const tmp: number[] = [];
    if (s.type === 'tube') {
      const outer = cylinder(o, d, this.a, this.w, this.len, s.ro);
      if (!outer) return;
      const inner = s.ri > 0 ? cylinder(o, d, this.a, this.w, this.len, s.ri) : null;
      subtract(outer, inner, tmp);
    } else if (s.type === 'shell') {
      const outer = ellipsoid(o, d, this.c, this.r.x, this.r.y, this.r.z);
      if (!outer) return;
      const inner = ellipsoid(o, d, this.c, this.r.x - s.t, this.r.y - s.t, this.r.z - s.t);
      subtract(outer, inner, tmp);
    } else {
      const outer = ellipticCylinder(o, d, this.c, s.rx, s.rz);
      if (!outer) return;
      const inner = ellipticCylinder(o, d, this.c, s.rx - s.t, s.rz - s.t);
      const band: number[] = [];
      subtract(outer, inner, band);
      const y0 = this.y0, y1 = this.y1;
      for (let i = 0; i + 1 < band.length; i += 2) {
        let t0 = band[i]!, t1 = band[i + 1]!;
        // Clip to the cage's height.
        if (Math.abs(d.y) > 1e-9) {
          let ta = (y0 - o.y) / d.y, tb = (y1 - o.y) / d.y;
          if (ta > tb) { const t = ta; ta = tb; tb = t; }
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
        } else if (o.y < y0 || o.y > y1) continue;
        if (t1 <= t0) continue;
        // Rib or the gap between two ribs?
        const ym = o.y + d.y * 0.5 * (t0 + t1);
        const f = (((ym - y0) / s.pitch) % 1 + 1) % 1;
        if (f < s.width / s.pitch) tmp.push(t0, t1);
      }
    }
    for (let i = 0; i + 1 < tmp.length; i += 2) {
      const t0 = Math.max(0, tmp[i]!), t1 = tmp[i + 1]!;
      if (t1 > t0) out.push(t0, t1);
    }
  }
}

function subtract(a: [number, number], b: [number, number] | null, out: number[]): void {
  if (!b || b[1] <= a[0] || b[0] >= a[1]) {
    out.push(a[0], a[1]);
    return;
  }
  if (b[0] > a[0]) out.push(a[0], b[0]);
  if (b[1] < a[1]) out.push(b[1], a[1]);
}

function quad(a: number, b: number, c: number): [number, number] | null {
  if (Math.abs(a) < 1e-14) return c <= 0 ? [-1e9, 1e9] : null;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const q = Math.sqrt(disc);
  return [(-b - q) / (2 * a), (-b + q) / (2 * a)];
}

/** Ray against a finite solid cylinder (axis from p along unit w, length h, radius r). */
function cylinder(o: THREE.Vector3, d: THREE.Vector3, p: THREE.Vector3, w: THREE.Vector3, h: number, r: number): [number, number] | null {
  const ocx = o.x - p.x, ocy = o.y - p.y, ocz = o.z - p.z;
  const dw = d.x * w.x + d.y * w.y + d.z * w.z;
  const ow = ocx * w.x + ocy * w.y + ocz * w.z;
  const dpx = d.x - dw * w.x, dpy = d.y - dw * w.y, dpz = d.z - dw * w.z;
  const opx = ocx - ow * w.x, opy = ocy - ow * w.y, opz = ocz - ow * w.z;
  const q = quad(dpx * dpx + dpy * dpy + dpz * dpz, 2 * (dpx * opx + dpy * opy + dpz * opz), opx * opx + opy * opy + opz * opz - r * r);
  if (!q) return null;
  let [t0, t1] = q;
  if (Math.abs(dw) > 1e-12) {
    let ta = -ow / dw, tb = (h - ow) / dw;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
  } else if (ow < 0 || ow > h) return null;
  return t1 > t0 ? [t0, t1] : null;
}

function ellipsoid(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, rx: number, ry: number, rz: number): [number, number] | null {
  const ox = (o.x - c.x) / rx, oy = (o.y - c.y) / ry, oz = (o.z - c.z) / rz;
  const dx = d.x / rx, dy = d.y / ry, dz = d.z / rz;
  return quad(dx * dx + dy * dy + dz * dz, 2 * (ox * dx + oy * dy + oz * dz), ox * ox + oy * oy + oz * oz - 1);
}

function ellipticCylinder(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, rx: number, rz: number): [number, number] | null {
  const ox = (o.x - c.x) / rx, oz = (o.z - c.z) / rz;
  const dx = d.x / rx, dz = d.z / rz;
  return quad(dx * dx + dz * dz, 2 * (ox * dx + oz * dz), ox * ox + oz * oz - 1);
}
