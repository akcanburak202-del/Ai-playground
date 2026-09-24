/**
 * Regular-grid height field for the detailed ground around a scene: bilinear sampling, the exact
 * two-triangle-per-cell surface the render mesh and the Rapier collider use, ray casting, and
 * crater stamping. Pure numerics (no three.js, no DOM) so it is unit-testable under Node.
 *
 * Grid vertex (i, j) sits at x = x0 + i·cell, z = z0 + j·cell; heights are stored row-major by z
 * (index = j·(n+1) + i). Each cell is split along the (i, j)–(i+1, j+1) diagonal.
 */
export class Heightfield {
  readonly n: number;
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly size: number;
  /** Current heights, m */
  readonly h: Float32Array;
  /** Undisturbed heights (for disturbance / depth-of-cut queries) */
  readonly base: Float32Array;
  /** Running bounds of the height values */
  minH = 0;
  maxH = 0;

  constructor(size: number, cell: number, heightAt: (x: number, z: number) => number = () => 0) {
    this.n = Math.max(2, Math.round(size / cell));
    this.cell = size / this.n;
    this.size = size;
    this.x0 = -size / 2;
    this.z0 = -size / 2;
    const m = this.n + 1;
    this.h = new Float32Array(m * m);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) this.h[j * m + i] = heightAt(this.x0 + i * this.cell, this.z0 + j * this.cell);
    }
    this.base = this.h.slice();
    this.recomputeBounds();
  }

  recomputeBounds(): void {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < this.h.length; k++) {
      const v = this.h[k]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    this.minH = lo;
    this.maxH = hi;
  }

  get stride(): number {
    return this.n + 1;
  }

  contains(x: number, z: number): boolean {
    return x >= this.x0 && z >= this.z0 && x <= this.x0 + this.size && z <= this.z0 + this.size;
  }

  vertex(i: number, j: number): number {
    return this.h[j * (this.n + 1) + i]!;
  }

  /** Height of the triangulated surface at (x, z); clamps to the grid edge outside. */
  heightAt(x: number, z: number): number {
    const fx = Math.min(Math.max((x - this.x0) / this.cell, 0), this.n - 1e-6);
    const fz = Math.min(Math.max((z - this.z0) / this.cell, 0), this.n - 1e-6);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const m = this.n + 1;
    const h00 = this.h[j * m + i]!, h10 = this.h[j * m + i + 1]!;
    const h01 = this.h[(j + 1) * m + i]!, h11 = this.h[(j + 1) * m + i + 1]!;
    // Triangle (00, 10, 11) when u ≥ v, else (00, 11, 01).
    return u >= v ? h00 + u * (h10 - h00) + v * (h11 - h10) : h00 + v * (h01 - h00) + u * (h11 - h01);
  }

  /** Surface normal of the triangle under (x, z), written to out as [x, y, z]. */
  normalAt(x: number, z: number, out: number[] = [0, 1, 0]): number[] {
    const fx = Math.min(Math.max((x - this.x0) / this.cell, 0), this.n - 1e-6);
    const fz = Math.min(Math.max((z - this.z0) / this.cell, 0), this.n - 1e-6);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const m = this.n + 1;
    const c = this.cell;
    const h00 = this.h[j * m + i]!, h10 = this.h[j * m + i + 1]!;
    const h01 = this.h[(j + 1) * m + i]!, h11 = this.h[(j + 1) * m + i + 1]!;
    let dx: number, dz: number;
    if (u >= v) {
      dx = (h10 - h00) / c;
      dz = (h11 - h10) / c;
    } else {
      dx = (h11 - h01) / c;
      dz = (h01 - h00) / c;
    }
    const l = Math.hypot(dx, 1, dz);
    out[0] = -dx / l;
    out[1] = 1 / l;
    out[2] = -dz / l;
    return out;
  }

  /**
   * First intersection of the ray o + t·d (d normalised) with the surface for t in [0, maxT];
   * returns t or -1. Walks the cells the ray's horizontal projection crosses (2D DDA), testing the
   * two triangles of each, after clipping the ray to the slab [minH, maxH] where it can hit.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    let t0 = 0, t1 = maxT;
    // Clip to the vertical slab that contains the surface.
    const lo = this.minH - 1e-4, hi = this.maxH + 1e-4;
    if (Math.abs(dy) < 1e-12) {
      if (oy < lo || oy > hi) return -1;
    } else {
      let ta = (lo - oy) / dy, tb = (hi - oy) / dy;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
    }
    // Clip to the grid's horizontal extent.
    const xa = this.x0, xb = this.x0 + this.size, za = this.z0, zb = this.z0 + this.size;
    for (const [o, d, a, b] of [[ox, dx, xa, xb], [oz, dz, za, zb]] as const) {
      if (Math.abs(d) < 1e-12) {
        if (o < a || o > b) return -1;
      } else {
        let ta = (a - o) / d, tb = (b - o) / d;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      }
    }
    if (t0 > t1) return -1;
    // DDA over cells from t0 to t1.
    const c = this.cell;
    const px = ox + dx * t0, pz = oz + dz * t0;
    let i = Math.min(this.n - 1, Math.max(0, Math.floor((px - this.x0) / c)));
    let j = Math.min(this.n - 1, Math.max(0, Math.floor((pz - this.z0) / c)));
    const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1;
    const tdx = Math.abs(dx) > 1e-12 ? c / Math.abs(dx) : Infinity;
    const tdz = Math.abs(dz) > 1e-12 ? c / Math.abs(dz) : Infinity;
    let tmx = Math.abs(dx) > 1e-12 ? (this.x0 + (i + (dx > 0 ? 1 : 0)) * c - ox) / dx : Infinity;
    let tmz = Math.abs(dz) > 1e-12 ? (this.z0 + (j + (dz > 0 ? 1 : 0)) * c - oz) / dz : Infinity;
    const guard = 4 * this.n + 8;
    for (let k = 0; k < guard; k++) {
      const hit = this.hitCell(i, j, ox, oy, oz, dx, dy, dz, t0 - 1e-6, t1 + 1e-6);
      if (hit >= 0) return hit;
      if (tmx < tmz) {
        if (tmx > t1) break;
        i += si;
        tmx += tdx;
      } else {
        if (tmz > t1) break;
        j += sj;
        tmz += tdz;
      }
      if (i < 0 || j < 0 || i >= this.n || j >= this.n) break;
    }
    return -1;
  }

  private hitCell(i: number, j: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmin: number, tmax: number): number {
    const m = this.n + 1, c = this.cell;
    const xA = this.x0 + i * c, zA = this.z0 + j * c;
    const h00 = this.h[j * m + i]!, h10 = this.h[j * m + i + 1]!;
    const h01 = this.h[(j + 1) * m + i]!, h11 = this.h[(j + 1) * m + i + 1]!;
    let best = -1;
    // Triangle 1: (0,0) (1,0) (1,1) ; Triangle 2: (0,0) (1,1) (0,1)
    const t1 = rayTri(ox, oy, oz, dx, dy, dz, xA, h00, zA, xA + c, h10, zA, xA + c, h11, zA + c);
    if (t1 >= tmin && t1 <= tmax) best = t1;
    const t2 = rayTri(ox, oy, oz, dx, dy, dz, xA, h00, zA, xA + c, h11, zA + c, xA, h01, zA + c);
    if (t2 >= tmin && t2 <= tmax && (best < 0 || t2 < best)) best = t2;
    return best;
  }

  /**
   * Blend a radial profile into the surface: h ← min(h, ref + cut(r)) + add(r), for every vertex
   * within `radius` of (cx, cz). Returns the touched vertex range (inclusive) or null.
   */
  stamp(cx: number, cz: number, radius: number, profile: (r: number, angle: number) => { cut: number; add: number }, ref: number): { i0: number; i1: number; j0: number; j1: number } | null {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((cx - radius - this.x0) / c));
    const i1 = Math.min(this.n, Math.ceil((cx + radius - this.x0) / c));
    const j0 = Math.max(0, Math.floor((cz - radius - this.z0) / c));
    const j1 = Math.min(this.n, Math.ceil((cz + radius - this.z0) / c));
    if (i0 > i1 || j0 > j1) return null;
    const m = this.n + 1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + i * c - cx, z = this.z0 + j * c - cz;
        const r = Math.hypot(x, z);
        if (r > radius) continue;
        const p = profile(r, Math.atan2(z, x));
        const k = j * m + i;
        let v = this.h[k]!;
        if (Number.isFinite(p.cut)) v = Math.min(v, ref + p.cut);
        v += p.add;
        this.h[k] = v;
        if (v < this.minH) this.minH = v;
        if (v > this.maxH) this.maxH = v;
      }
    }
    return { i0, i1, j0, j1 };
  }
}

/** Möller–Trumbore ray/triangle intersection (two-sided); returns t or -1. */
function rayTri(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-7 || u > 1 + 1e-7) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-7 || u + v > 1 + 1e-7) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}
