import * as THREE from 'three';
import type { BeamProfile } from '../../app/contracts.ts';

/**
 * Profile outlines and the swept member mesh. A profile is a set of closed loops in the section
 * plane (y = profile up, z = sideways); every loop vertex carries its outward normal, and sharp
 * corners are duplicated vertices with a break between them, so flanges stay crisp while root
 * fillets and tubes shade smoothly. `p` is the perimeter parameter (texture u).
 */

export interface OutlineVertex {
  y: number;
  z: number;
  ny: number;
  nz: number;
  p: number;
}

export interface Outline {
  verts: OutlineVertex[];
  /** No quad between vertex i and i+1 (sharp corner, loop end) */
  brk: boolean[];
  perimeter: number;
  /** End-cap polygons: outer contour and optional hole (tube, box) */
  cap: { outer: THREE.Vector2[]; hole?: THREE.Vector2[] };
}

class OutlineBuilder {
  verts: OutlineVertex[] = [];
  brk: boolean[] = [];
  private len = 0;
  private last: { y: number; z: number } | null = null;
  /** Longest straight segment: wide faces get intermediate vertices so a dish can bend them */
  private readonly maxSeg: number;

  constructor(maxSeg: number) {
    this.maxSeg = maxSeg;
  }

  /**
   * Straight face from a to b with outward normal n (own vertices: flat shading), split into
   * segments no longer than maxSeg — a flange drawn as one quad across could only shift, never dish.
   */
  face(ay: number, az: number, by: number, bz: number, ny: number, nz: number): void {
    const k = Math.max(1, Math.ceil(Math.hypot(by - ay, bz - az) / this.maxSeg - 1e-9));
    for (let i = 0; i <= k; i++) this.push(ay + ((by - ay) * i) / k, az + ((bz - az) * i) / k, ny, nz, i === k);
  }

  /** Arc around (cy, cz) from angle a0 to a1 (radians, from +z towards +y); normals point out (convex) or in (concave). */
  arc(cy: number, cz: number, r: number, a0: number, a1: number, n: number, concave: boolean): void {
    for (let k = 0; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n;
      const sz = Math.cos(a), sy = Math.sin(a);
      const s = concave ? -1 : 1;
      this.push(cy + r * sy, cz + r * sz, s * sy, s * sz, k === n);
    }
  }

  private push(y: number, z: number, ny: number, nz: number, breakAfter: boolean): void {
    if (this.last) this.len += Math.hypot(y - this.last.y, z - this.last.z);
    this.last = { y, z };
    this.verts.push({ y, z, ny, nz, p: this.len });
    this.brk.push(breakAfter);
  }

  /** Start a new loop (tube / box inner wall): no length jump between loops. */
  newLoop(): void {
    if (this.brk.length) this.brk[this.brk.length - 1] = true;
    this.last = null;
  }

  finish(cap: Outline['cap']): Outline {
    const perimeter = Math.max(this.len, 1e-6);
    for (const v of this.verts) v.p /= perimeter;
    if (this.brk.length) this.brk[this.brk.length - 1] = true;
    return { verts: this.verts, brk: this.brk, perimeter, cap };
  }
}

export function profileOutline(p: BeamProfile, rootRadius: number, maxSeg = 0.03): Outline {
  const b = new OutlineBuilder(maxSeg);
  const v2 = (y: number, z: number) => new THREE.Vector2(z, y);
  switch (p.type) {
    case 'I': {
      const { h, b: w, tw, tf } = p;
      const r = Math.min(rootRadius, 0.45 * (w / 2 - tw / 2), 0.45 * (h / 2 - tf));
      const H = h / 2, B = w / 2, T = tw / 2, F = H - tf;
      const nf = 5;
      // Counter-clockwise seen along +x (z right, y up): top face, then down the left side.
      b.face(H, B, H, -B, 1, 0);
      b.face(H, -B, F, -B, 0, -1);
      b.face(F, -B, F, -T - r, -1, 0);
      b.arc(F - r, -T - r, r, Math.PI / 2, 0, nf, true);
      b.face(F - r, -T, -F + r, -T, 0, -1);
      b.arc(-F + r, -T - r, r, 0, -Math.PI / 2, nf, true);
      b.face(-F, -T - r, -F, -B, 1, 0);
      b.face(-F, -B, -H, -B, 0, -1);
      b.face(-H, -B, -H, B, -1, 0);
      b.face(-H, B, -F, B, 0, 1);
      b.face(-F, B, -F, T + r, 1, 0);
      b.arc(-F + r, T + r, r, (3 * Math.PI) / 2, Math.PI, nf, true);
      b.face(-F + r, T, F - r, T, 0, 1);
      b.arc(F - r, T + r, r, Math.PI, Math.PI / 2, nf, true);
      b.face(F, T + r, F, B, -1, 0);
      b.face(F, B, H, B, 0, 1);
      const outer: THREE.Vector2[] = [];
      for (const v of b.verts) {
        const q = v2(v.y, v.z);
        const lastQ = outer[outer.length - 1];
        if (!lastQ || lastQ.distanceTo(q) > 1e-7) outer.push(q);
      }
      if (outer.length > 1 && outer[0]!.distanceTo(outer[outer.length - 1]!) < 1e-7) outer.pop();
      return b.finish({ outer });
    }
    case 'cruciform': {
      const { arm: A, t } = p;
      const T = t / 2;
      b.face(A, T, A, -T, 1, 0);
      b.face(A, -T, T, -T, 0, -1);
      b.face(T, -T, T, -A, 1, 0);
      b.face(T, -A, -T, -A, 0, -1);
      b.face(-T, -A, -T, -T, -1, 0);
      b.face(-T, -T, -A, -T, 0, -1);
      b.face(-A, -T, -A, T, -1, 0);
      b.face(-A, T, -T, T, 0, 1);
      b.face(-T, T, -T, A, -1, 0);
      b.face(-T, A, T, A, 0, 1);
      b.face(T, A, T, T, 1, 0);
      b.face(T, T, A, T, 0, 1);
      const pts: [number, number][] = [[A, T], [A, -T], [T, -T], [T, -A], [-T, -A], [-T, -T], [-A, -T], [-A, T], [-T, T], [-T, A], [T, A], [T, T]];
      return b.finish({ outer: pts.map(([y, z]) => v2(y, z)) });
    }
    case 'tube': {
      const R = p.d / 2, r = R - p.t, n = 28;
      b.arc(0, 0, R, 0, 2 * Math.PI, n, false);
      b.newLoop();
      b.arc(0, 0, r, 2 * Math.PI, 0, n, true);
      const outer: THREE.Vector2[] = [], hole: THREE.Vector2[] = [];
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n;
        outer.push(v2(R * Math.sin(a), R * Math.cos(a)));
        hole.push(v2(r * Math.sin(a), r * Math.cos(a)));
      }
      return b.finish({ outer, hole });
    }
    case 'box': {
      const H = p.h / 2, B = p.b / 2, hi = H - p.t, bi = B - p.t;
      b.face(H, B, H, -B, 1, 0);
      b.face(H, -B, -H, -B, 0, -1);
      b.face(-H, -B, -H, B, -1, 0);
      b.face(-H, B, H, B, 0, 1);
      b.newLoop();
      b.face(hi, -bi, hi, bi, -1, 0);
      b.face(hi, bi, -hi, bi, 0, -1);
      b.face(-hi, bi, -hi, -bi, 1, 0);
      b.face(-hi, -bi, hi, -bi, 0, 1);
      return b.finish({
        outer: [v2(H, B), v2(H, -B), v2(-H, -B), v2(-H, B)],
        hole: [v2(hi, bi), v2(hi, -bi), v2(-hi, -bi), v2(-hi, bi)],
      });
    }
  }
}

/**
 * Offset the outline by d along its normals (fireproofing coat over the steel). A sharp corner is
 * two coincident vertices with different normals; both go to the mitred corner p + d (n₁ + n₂)/(1 + n₁·n₂)
 * so the coat stays closed there instead of opening a slit along every flange edge.
 */
export function offsetOutline(o: Outline, d: number): Outline {
  const vs = o.verts;
  const verts = vs.map((v, i) => {
    let mx = v.ny, mz = v.nz;
    for (const j of [i - 1, i + 1]) {
      const w = vs[j];
      if (!w || Math.hypot(w.y - v.y, w.z - v.z) > 1e-7) continue;
      const c = v.ny * w.ny + v.nz * w.nz;
      if (c > 0.999 || c < -0.5) continue;
      mx = (v.ny + w.ny) / (1 + c);
      mz = (v.nz + w.nz) / (1 + c);
    }
    return { ...v, y: v.y + d * mx, z: v.z + d * mz };
  });
  return {
    ...o,
    verts,
    cap: {
      outer: o.cap.outer.map((q) => q.clone().multiplyScalar(1 + d / Math.max(0.01, q.length()))),
      hole: o.cap.hole?.map((q) => q.clone()),
    },
  };
}

/** A local dent: displacement of the surface near (s, y, z) along (dy, dz), Gaussian of radius R. */
export interface Dent {
  s: number;
  y: number;
  z: number;
  dy: number;
  dz: number;
  R: number;
  depth: number;
}

export interface SweepFrameSource {
  /** Number of nodes and node spacing along the undeformed axis */
  n: number;
  ds: number;
  x: Float64Array;
  u: Float64Array;
  s0: Float64Array;
  temp: Float32Array;
  /** Plastic hinge rotation per node (for surface crazing) */
  plast: Float64Array;
}

/**
 * Swept member mesh: rings along the Catmull-Rom smoothed centreline with node frames interpolated
 * between nodes, plus end caps. Positions are written in world space (the mesh sits at the origin
 * of the world group) or, for a rigid body, relative to a given frame.
 */
export class SweptMesh {
  readonly geometry = new THREE.BufferGeometry();
  readonly outline: Outline;
  readonly rings: number;
  private pos: Float32Array;
  private nrm: Float32Array;
  private duv: Float32Array;
  private heat: Float32Array;
  private strain: Float32Array;
  private rim: Float32Array;
  private readonly capBase: number;
  private readonly capTris: number[][];
  private readonly length: number;
  private readonly s0: number;

  constructor(outline: Outline, length: number, s0: number, ringSpacing: number) {
    this.outline = outline;
    this.length = length;
    this.s0 = s0;
    this.rings = Math.max(2, Math.ceil(length / ringSpacing) + 1);
    const m = outline.verts.length;
    const capContour = outline.cap.outer.concat(outline.cap.hole ?? []);
    this.capTris = THREE.ShapeUtils.triangulateShape(outline.cap.outer, outline.cap.hole ? [outline.cap.hole] : []);
    this.capBase = this.rings * m;
    const nv = this.capBase + 2 * capContour.length;
    this.pos = new Float32Array(3 * nv);
    this.nrm = new Float32Array(3 * nv);
    this.duv = new Float32Array(2 * nv);
    this.heat = new Float32Array(nv).fill(20);
    this.strain = new Float32Array(nv);
    this.rim = new Float32Array(nv);
    const idx: number[] = [];
    let quads = 0;
    for (let i = 0; i < m - 1; i++) if (!outline.brk[i]) quads++;
    this.bandIndices = 6 * quads;
    for (let k = 0; k < this.rings - 1; k++) {
      for (let i = 0; i < m - 1; i++) {
        if (outline.brk[i]) continue;
        const a = k * m + i, b = a + 1, c = a + m + 1, d = a + m;
        idx.push(a, d, c, a, c, b);
      }
    }
    // End caps (both ends), reversed winding at the start.
    const nc = capContour.length;
    for (const [end, base] of [[0, this.capBase], [1, this.capBase + nc]] as const) {
      for (const t of this.capTris) {
        if (end === 0) idx.push(base + t[0]!, base + t[2]!, base + t[1]!);
        else idx.push(base + t[0]!, base + t[1]!, base + t[2]!);
      }
    }
    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aDUv', new THREE.BufferAttribute(this.duv, 2));
    g.setAttribute('aHeat', new THREE.BufferAttribute(this.heat, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aStrain', new THREE.BufferAttribute(this.strain, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aRim', new THREE.BufferAttribute(this.rim, 1));
    g.setIndex(idx);
    // Texture coordinates never change: u = perimeter, v = arc length.
    for (let k = 0; k < this.rings; k++) {
      const v = (k / (this.rings - 1)) * (length / Math.max(length, 1e-6));
      for (let i = 0; i < m; i++) {
        this.duv[2 * (k * m + i)] = outline.verts[i]!.p;
        this.duv[2 * (k * m + i) + 1] = v;
      }
    }
    for (let q = 0; q < 2 * nc; q++) {
      this.duv[2 * (this.capBase + q)] = 0.5;
      this.duv[2 * (this.capBase + q) + 1] = q < nc ? 0.001 : 0.999;
      this.rim[this.capBase + q] = 1;
    }
    this.capContour = capContour;
  }
  private readonly capContour: THREE.Vector2[];

  /**
   * Rebuild positions/normals from the member state. `toLocal` maps world → the mesh's frame (null:
   * identity). Dents displace the surface (rest coordinates), heat/strain are interpolated from nodes.
   */
  update(src: SweepFrameSource, dents: readonly Dent[], toLocal: THREE.Matrix4 | null): void {
    const m = this.outline.verts.length;
    const R = this.rings;
    const { n, ds, x, u } = src;
    const P = new THREE.Vector3(), T = new THREE.Vector3(), U = new THREE.Vector3(), V = new THREE.Vector3();
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), p3 = new THREE.Vector3();
    const ua = new THREE.Vector3(), ub = new THREE.Vector3();
    const node = (i: number, out: THREE.Vector3) => {
      const j = Math.max(0, Math.min(n - 1, i));
      out.set(x[3 * j]!, x[3 * j + 1]!, x[3 * j + 2]!);
      if (i < 0) {
        // Extrapolate beyond the ends so the spline keeps the end tangent.
        const b = new THREE.Vector3(x[3]!, x[4]!, x[5]!);
        out.multiplyScalar(2).sub(b);
      } else if (i > n - 1) {
        const b = new THREE.Vector3(x[3 * (n - 2)]!, x[3 * (n - 2) + 1]!, x[3 * (n - 2) + 2]!);
        out.multiplyScalar(2).sub(b);
      }
      return out;
    };
    const L = ds * (n - 1);
    const nm = new THREE.Matrix3();
    if (toLocal) nm.getNormalMatrix(toLocal);
    const first = new THREE.Vector3(), last = new THREE.Vector3(), firstT = new THREE.Vector3(), lastT = new THREE.Vector3(), firstU = new THREE.Vector3(), lastU = new THREE.Vector3();
    // Dents reach 3 R along the member: each ring only tests the few within reach of it.
    const near = this.nearDents;
    let dk0 = R, dk1 = -1;
    for (let k = 0; k < R; k++) {
      const s = (k / (R - 1)) * L;
      const f = Math.min(n - 1 - 1e-9, s / ds);
      const i = Math.floor(f), t = f - i;
      node(i - 1, p0);
      node(i, p1);
      node(i + 1, p2);
      node(i + 2, p3);
      // Centripetal-free uniform Catmull-Rom position and derivative.
      const t2 = t * t, t3 = t2 * t;
      P.set(0, 0, 0)
        .addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t)
        .addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1)
        .addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t)
        .addScaledVector(p3, 0.5 * t3 - 0.5 * t2);
      T.set(0, 0, 0)
        .addScaledVector(p0, -1.5 * t2 + 2 * t - 0.5)
        .addScaledVector(p1, 4.5 * t2 - 5 * t)
        .addScaledVector(p2, -4.5 * t2 + 4 * t + 0.5)
        .addScaledVector(p3, 1.5 * t2 - t)
        .normalize();
      const j = Math.min(n - 1, i + 1);
      ua.set(u[3 * i]!, u[3 * i + 1]!, u[3 * i + 2]!);
      ub.set(u[3 * j]!, u[3 * j + 1]!, u[3 * j + 2]!);
      U.copy(ua).lerp(ub, t);
      U.addScaledVector(T, -U.dot(T)).normalize();
      V.crossVectors(T, U);
      const heat = src.temp[i]! * (1 - t) + src.temp[j]! * t;
      const strain = Math.max(src.plast[i]!, src.plast[j]!) * 0.5;
      const sRest = this.s0 + s;
      near.length = 0;
      for (const d of dents) if (Math.abs(sRest - d.s) < 3 * d.R) near.push(d);
      for (let q = 0; q < m; q++) {
        const ov = this.outline.verts[q]!;
        let y = ov.y, z = ov.z;
        for (const d of near) {
          const ddist2 = (sRest - d.s) ** 2 + (y - d.y) ** 2 + (z - d.z) ** 2;
          if (ddist2 > 9 * d.R * d.R) continue;
          const w = d.depth * Math.exp(-ddist2 / (d.R * d.R));
          y += w * d.dy;
          z += w * d.dz;
          if (w > 2e-4) {
            if (k < dk0) dk0 = k;
            if (k > dk1) dk1 = k;
          }
        }
        const vi = k * m + q;
        let px = P.x + U.x * y + V.x * z, py = P.y + U.y * y + V.y * z, pz = P.z + U.z * y + V.z * z;
        let nx = U.x * ov.ny + V.x * ov.nz, ny = U.y * ov.ny + V.y * ov.nz, nz = U.z * ov.ny + V.z * ov.nz;
        if (toLocal) {
          const e = toLocal.elements;
          const qx = e[0]! * px + e[4]! * py + e[8]! * pz + e[12]!;
          const qy = e[1]! * px + e[5]! * py + e[9]! * pz + e[13]!;
          const qz = e[2]! * px + e[6]! * py + e[10]! * pz + e[14]!;
          px = qx;
          py = qy;
          pz = qz;
          const ne = nm.elements;
          const rx = ne[0]! * nx + ne[3]! * ny + ne[6]! * nz, ry = ne[1]! * nx + ne[4]! * ny + ne[7]! * nz, rz = ne[2]! * nx + ne[5]! * ny + ne[8]! * nz;
          nx = rx;
          ny = ry;
          nz = rz;
        }
        this.pos[3 * vi] = px;
        this.pos[3 * vi + 1] = py;
        this.pos[3 * vi + 2] = pz;
        this.nrm[3 * vi] = nx;
        this.nrm[3 * vi + 1] = ny;
        this.nrm[3 * vi + 2] = nz;
        this.heat[vi] = heat;
        this.strain[vi] = strain;
      }
      if (k === 0) {
        first.copy(P);
        firstT.copy(T);
        firstU.copy(U);
      }
      if (k === R - 1) {
        last.copy(P);
        lastT.copy(T);
        lastU.copy(U);
      }
    }
    // Caps.
    const nc = this.capContour.length;
    for (const [end, P0, T0, U0] of [[0, first, firstT, firstU], [1, last, lastT, lastU]] as const) {
      const V0 = new THREE.Vector3().crossVectors(T0, U0);
      const sign = end === 0 ? -1 : 1;
      for (let q = 0; q < nc; q++) {
        const c = this.capContour[q]!;
        const vi = this.capBase + end * nc + q;
        const pw = new THREE.Vector3().copy(P0).addScaledVector(U0, c.y).addScaledVector(V0, c.x);
        const nw = T0.clone().multiplyScalar(sign);
        if (toLocal) {
          pw.applyMatrix4(toLocal);
          nw.applyMatrix3(nm).normalize();
        }
        this.pos[3 * vi] = pw.x;
        this.pos[3 * vi + 1] = pw.y;
        this.pos[3 * vi + 2] = pw.z;
        this.nrm[3 * vi] = nw.x;
        this.nrm[3 * vi + 1] = nw.y;
        this.nrm[3 * vi + 2] = nw.z;
        this.heat[vi] = end === 0 ? src.temp[0]! : src.temp[n - 1]!;
      }
    }
    const g = this.geometry;
    if (!this.windingChecked) this.fixWinding();
    // A dished face is no longer flat: shade it from the deformed surface. Sharp corners are
    // separate vertices, so they stay sharp; the caps keep their own normals.
    if (dk1 >= dk0) this.recomputeRingNormals(dk0 - 1, dk1 + 1);
    for (const name of ['position', 'normal', 'aHeat', 'aStrain']) (g.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    g.computeBoundingSphere();
    g.computeBoundingBox();
  }

  private windingChecked = false;
  private readonly nearDents: Dent[] = [];
  /** Index entries per ring band (6 per quad of the outline) */
  private readonly bandIndices: number;

  /** Refresh only the temperature attribute (a cooling member whose shape has not changed). */
  updateHeat(temp: Float32Array, n: number, ds: number): void {
    const m = this.outline.verts.length, R = this.rings, L = ds * (n - 1);
    for (let k = 0; k < R; k++) {
      const f = Math.min(n - 1 - 1e-9, ((k / (R - 1)) * L) / ds);
      const i = Math.floor(f), t = f - i, j = Math.min(n - 1, i + 1);
      const heat = temp[i]! * (1 - t) + temp[j]! * t;
      this.heat.fill(heat, k * m, (k + 1) * m);
    }
    const nc = this.capContour.length;
    this.heat.fill(temp[0]!, this.capBase, this.capBase + nc);
    this.heat.fill(temp[n - 1]!, this.capBase + nc, this.capBase + 2 * nc);
    (this.geometry.getAttribute('aHeat') as THREE.BufferAttribute).needsUpdate = true;
  }

  /**
   * Area-weighted vertex normals of the swept surface between rings k0 and k1 (the dented stretch;
   * the rest keeps its analytic normals, the caps their own). Ring-major index layout: band b (rings
   * b, b+1) owns indices [b·q, (b+1)·q).
   */
  private recomputeRingNormals(k0: number, k1: number): void {
    const idx = this.geometry.getIndex()!.array as Uint16Array | Uint32Array;
    const p = this.pos, n = this.nrm, m = this.outline.verts.length, q = this.bandIndices;
    k0 = Math.max(0, k0);
    k1 = Math.min(this.rings - 1, k1);
    if (k1 <= k0) return;
    n.fill(0, 3 * k0 * m, 3 * (k1 + 1) * m);
    for (let t = k0 * q; t < k1 * q; t += 3) {
      const i = idx[t]!, j = idx[t + 1]!, k = idx[t + 2]!;
      const ax = p[3 * j]! - p[3 * i]!, ay = p[3 * j + 1]! - p[3 * i + 1]!, az = p[3 * j + 2]! - p[3 * i + 2]!;
      const bx = p[3 * k]! - p[3 * i]!, by = p[3 * k + 1]! - p[3 * i + 1]!, bz = p[3 * k + 2]! - p[3 * i + 2]!;
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      n[3 * i] = n[3 * i]! + cx;
      n[3 * i + 1] = n[3 * i + 1]! + cy;
      n[3 * i + 2] = n[3 * i + 2]! + cz;
      n[3 * j] = n[3 * j]! + cx;
      n[3 * j + 1] = n[3 * j + 1]! + cy;
      n[3 * j + 2] = n[3 * j + 2]! + cz;
      n[3 * k] = n[3 * k]! + cx;
      n[3 * k + 1] = n[3 * k + 1]! + cy;
      n[3 * k + 2] = n[3 * k + 2]! + cz;
    }
    for (let v = k0 * m; v < (k1 + 1) * m; v++) {
      const l = Math.hypot(n[3 * v]!, n[3 * v + 1]!, n[3 * v + 2]!);
      if (l > 0) {
        n[3 * v] = n[3 * v]! / l;
        n[3 * v + 1] = n[3 * v + 1]! / l;
        n[3 * v + 2] = n[3 * v + 2]! / l;
      }
    }
  }

  /** Make every triangle's winding agree with its vertex normals (outline / cap orientation). */
  private fixWinding(): void {
    this.windingChecked = true;
    const idx = this.geometry.getIndex()!;
    const a = idx.array as Uint16Array | Uint32Array;
    const p = this.pos, n = this.nrm;
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < a.length; t += 3) {
      const i = a[t]!, j = a[t + 1]!, k = a[t + 2]!;
      e1.set(p[3 * j]! - p[3 * i]!, p[3 * j + 1]! - p[3 * i + 1]!, p[3 * j + 2]! - p[3 * i + 2]!);
      e2.set(p[3 * k]! - p[3 * i]!, p[3 * k + 1]! - p[3 * i + 1]!, p[3 * k + 2]! - p[3 * i + 2]!);
      c.crossVectors(e1, e2);
      const d = c.x * (n[3 * i]! + n[3 * j]! + n[3 * k]!) + c.y * (n[3 * i + 1]! + n[3 * j + 1]! + n[3 * k + 1]!) + c.z * (n[3 * i + 2]! + n[3 * j + 2]! + n[3 * k + 2]!);
      if (d < 0) {
        a[t + 1] = k;
        a[t + 2] = j;
      }
    }
    idx.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
