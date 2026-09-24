import { polyBounds, type Poly } from './polygon.ts';

/**
 * The per-pane damage image, painted on the CPU into RGBA bytes and uploaded as a DataTexture:
 *   R  crack lines (hairline cracks: dark where they refract, bright where their faces catch light)
 *   G  frost (comminuted glass: crush halos, Hertzian cone flakes, PVB delamination whitening)
 *   B  hole (1 = no glass: bullet holes and released pieces)
 *   A  crack orientation (line angle mod π, 0..255), used to light the crack faces
 * Texel (i, j) covers pane-local x ∈ [−W/2 + i·sx, …], y ∈ [−H/2 + j·sy, …]; row 0 is the pane bottom
 * so the texture maps onto uv (0..1) with flipY off.
 */
export class CrackRaster {
  readonly width: number;
  readonly height: number;
  readonly w: number;
  readonly h: number;
  readonly sx: number;
  readonly sy: number;
  readonly data: Uint8Array;
  /** Pixel rectangle changed since the last `takeDirty` [x0, y0, x1, y1] (inclusive), or null */
  private dirty: [number, number, number, number] | null = null;

  constructor(widthM: number, heightM: number, maxPx = 1024) {
    this.width = widthM;
    this.height = heightM;
    const px = Math.max(widthM, heightM) / maxPx;
    this.w = Math.max(8, Math.ceil(widthM / px));
    this.h = Math.max(8, Math.ceil(heightM / px));
    this.sx = widthM / this.w;
    this.sy = heightM / this.h;
    this.data = new Uint8Array(this.w * this.h * 4);
  }

  /** Metres per pixel (mean of the two axes). */
  get pixel(): number {
    return 0.5 * (this.sx + this.sy);
  }

  private fx(x: number): number {
    return (x + this.width / 2) / this.sx - 0.5;
  }
  private fy(y: number): number {
    return (y + this.height / 2) / this.sy - 0.5;
  }

  private touch(x0: number, y0: number, x1: number, y1: number): void {
    const d = this.dirty;
    if (!d) this.dirty = [x0, y0, x1, y1];
    else {
      if (x0 < d[0]) d[0] = x0;
      if (y0 < d[1]) d[1] = y0;
      if (x1 > d[2]) d[2] = x1;
      if (y1 > d[3]) d[3] = y1;
    }
  }

  /** Changed pixel rectangle since the last call (inclusive), cleared. */
  takeDirty(): [number, number, number, number] | null {
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  /** Channel value 0..1 at pane-local (x, y) (nearest texel). */
  sample(x: number, y: number, channel: 0 | 1 | 2 | 3): number {
    const i = Math.round(this.fx(x)), j = Math.round(this.fy(y));
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 0;
    return this.data[4 * (j * this.w + i) + channel]! / 255;
  }

  /** Largest channel value within radius r (m) of (x, y). */
  maxAround(x: number, y: number, r: number, channel: 0 | 1 | 2 | 3): number {
    const ci = this.fx(x), cj = this.fy(y);
    const ri = r / this.sx, rj = r / this.sy;
    let m = 0;
    for (let j = Math.max(0, Math.floor(cj - rj)); j <= Math.min(this.h - 1, Math.ceil(cj + rj)); j++) {
      for (let i = Math.max(0, Math.floor(ci - ri)); i <= Math.min(this.w - 1, Math.ceil(ci + ri)); i++) {
        const v = this.data[4 * (j * this.w + i) + channel]!;
        if (v > m) m = v;
      }
    }
    return m / 255;
  }

  /**
   * Smallest channel value over the texels whose centres lie within radius r (m) of (x, y), inside
   * the image (1 when none does). Early out once a texel at or below `stop` is found.
   */
  minWithin(x: number, y: number, r: number, channel: 0 | 1 | 2 | 3, stop = 0): number {
    const ci = this.fx(x), cj = this.fy(y);
    const ri = r / this.sx, rj = r / this.sy;
    const s = Math.round(stop * 255);
    let m = 255;
    for (let j = Math.max(0, Math.ceil(cj - rj)); j <= Math.min(this.h - 1, Math.floor(cj + rj)); j++) {
      const dy = (j - cj) / rj;
      // Half-width of the disc on this row, in texels.
      const hw = ri * Math.sqrt(Math.max(0, 1 - dy * dy));
      for (let i = Math.max(0, Math.ceil(ci - hw)); i <= Math.min(this.w - 1, Math.floor(ci + hw)); i++) {
        const v = this.data[4 * (j * this.w + i) + channel]!;
        if (v < m) {
          m = v;
          if (m <= s) return m / 255;
        }
      }
    }
    return m / 255;
  }

  /**
   * Visit the texels within `r` px of the segment (x0,y0)→(x1,y1) (pixel coordinates), walking the
   * major axis so a long diagonal touches ~length × (2r + 1) texels, not its whole bounding box.
   * `fn(k, dist)` gets the texel index and its distance to the segment in pixels.
   */
  private capsule(x0: number, y0: number, x1: number, y1: number, r: number, fn: (k: number, dist: number) => void): void {
    const dx = x1 - x0, dy = y1 - y0;
    const l2 = dx * dx + dy * dy;
    const steep = Math.abs(dy) > Math.abs(dx);
    // Major axis a, minor axis b.
    const a0 = steep ? y0 : x0, a1 = steep ? y1 : x1, b0 = steep ? x0 : y0, b1 = steep ? x1 : y1;
    const na = steep ? this.h : this.w, nb = steep ? this.w : this.h;
    const lo = Math.max(0, Math.floor(Math.min(a0, a1) - r - 1)), hi = Math.min(na - 1, Math.ceil(Math.max(a0, a1) + r + 1));
    const slope = a1 !== a0 ? (b1 - b0) / (a1 - a0) : 0;
    // Half-extent along the minor axis of a capsule of radius r at slope s: r·√(1 + s²), plus 1.
    const span = r * Math.sqrt(1 + slope * slope) + 1;
    for (let A = lo; A <= hi; A++) {
      const t = a1 !== a0 ? Math.min(1, Math.max(0, (A - a0) / (a1 - a0))) : 0;
      const bc = b0 + t * (b1 - b0);
      const blo = Math.max(0, Math.floor(bc - span - r)), bhi = Math.min(nb - 1, Math.ceil(bc + span + r));
      for (let B = blo; B <= bhi; B++) {
        const i = steep ? B : A, j = steep ? A : B;
        let u = l2 > 0 ? ((i - x0) * dx + (j - y0) * dy) / l2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const ex = x0 + u * dx - i, ey = y0 + u * dy - j;
        const dist = Math.sqrt(ex * ex + ey * ey);
        if (dist <= r) fn(j * this.w + i, dist);
      }
    }
  }

  /**
   * Anti-aliased crack line from a to b, `widthM` wide (never thinner than one pixel; thinner cracks
   * are drawn one pixel wide at somewhat lower intensity — a hairline crack still catches light over
   * the full depth of the glass, so it reads wider than it is).
   */
  line(ax: number, ay: number, bx: number, by: number, widthM: number, intensity: number): void {
    const x0 = this.fx(ax), y0 = this.fy(ay), x1 = this.fx(bx), y1 = this.fy(by);
    const wPx = widthM / this.pixel;
    const hw = Math.max(0.5, 0.5 * wPx);
    const I = intensity * Math.min(1, Math.max(0.75, Math.sqrt(wPx)));
    let ang = Math.atan2(by - ay, bx - ax);
    if (ang < 0) ang += Math.PI;
    if (ang >= Math.PI) ang -= Math.PI;
    const aByte = Math.min(255, Math.round((ang / Math.PI) * 255));
    const d = this.data;
    // Same walk as capsule(), inlined: this is the hot path (thousands of crack segments per blast).
    const r = hw + 0.5;
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
    const steep = Math.abs(dy) > Math.abs(dx);
    const a0 = steep ? y0 : x0, a1 = steep ? y1 : x1, b0 = steep ? x0 : y0, b1 = steep ? x1 : y1;
    const na = steep ? this.h : this.w, nb = steep ? this.w : this.h;
    const lo = Math.max(0, Math.floor(Math.min(a0, a1) - r - 1)), hi = Math.min(na - 1, Math.ceil(Math.max(a0, a1) + r + 1));
    const slope = a1 !== a0 ? (b1 - b0) / (a1 - a0) : 0;
    const span = r * Math.sqrt(1 + slope * slope) + 1;
    const W = this.w;
    for (let A = lo; A <= hi; A++) {
      const t0 = a1 !== a0 ? Math.min(1, Math.max(0, (A - a0) / (a1 - a0))) : 0;
      const bc = b0 + t0 * (b1 - b0);
      const blo = Math.max(0, Math.floor(bc - span - r)), bhi = Math.min(nb - 1, Math.ceil(bc + span + r));
      for (let B = blo; B <= bhi; B++) {
        const i = steep ? B : A, j = steep ? A : B;
        let u = l2 > 0 ? ((i - x0) * dx + (j - y0) * dy) / l2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const ex = x0 + u * dx - i, ey = y0 + u * dy - j;
        const cov = r - Math.sqrt(ex * ex + ey * ey);
        if (cov <= 0) continue;
        const v = (255 * I * (cov > 1 ? 1 : cov) + 0.5) | 0;
        const q = 4 * (j * W + i);
        if (v > d[q]!) {
          d[q] = v > 255 ? 255 : v;
          d[q + 3] = aByte;
        }
      }
    }
    this.touch(Math.max(0, Math.floor(Math.min(x0, x1) - hw - 1)), Math.max(0, Math.floor(Math.min(y0, y1) - hw - 1)), Math.min(this.w - 1, Math.ceil(Math.max(x0, x1) + hw + 1)), Math.min(this.h - 1, Math.ceil(Math.max(y0, y1) + hw + 1)));
  }

  /**
   * Frost (channel G) or hole (B) disc: value `amount` inside radius r0, falling smoothly to zero at
   * r1, broken up by per-texel grain and a few angular lobes so halos do not look stamped.
   */
  halo(cx: number, cy: number, r0: number, r1: number, amount: number, seed: number, channel: 1 | 2 = 1, grain = 0.35): void {
    const ci = this.fx(cx), cj = this.fy(cy);
    const ri = r1 / this.sx, rj = r1 / this.sy;
    const i0 = Math.max(0, Math.floor(ci - ri - 1)), i1 = Math.min(this.w - 1, Math.ceil(ci + ri + 1));
    const j0 = Math.max(0, Math.floor(cj - rj - 1)), j1 = Math.min(this.h - 1, Math.ceil(cj + rj + 1));
    if (i0 > i1 || j0 > j1) return;
    const d = this.data;
    const ph = (seed % 97) * 0.37;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i - ci) * this.sx, y = (j - cj) * this.sy;
        const r = Math.sqrt(x * x + y * y);
        const a = Math.atan2(y, x);
        const lobe = 1 + 0.22 * Math.sin(3 * a + ph) + 0.12 * Math.sin(7 * a + 2.1 * ph);
        const rr = r / lobe;
        if (rr >= r1) continue;
        let f = rr <= r0 ? 1 : 1 - (rr - r0) / Math.max(r1 - r0, 1e-6);
        f = f * f * (3 - 2 * f);
        const n = hash2(i + seed * 131, j - seed * 71);
        f *= 1 - grain + grain * 2 * n;
        const v = Math.round(255 * Math.min(1, amount * f));
        const k = 4 * (j * this.w + i) + channel;
        if (v > d[k]!) d[k] = v;
      }
    }
    this.touch(i0, j0, i1, j1);
  }

  /** Frost band `widthM` wide along a segment (fracture edges), channel G, max-combined. */
  band(ax: number, ay: number, bx: number, by: number, widthM: number, amount: number): void {
    const x0 = this.fx(ax), y0 = this.fy(ay), x1 = this.fx(bx), y1 = this.fy(by);
    const hw = Math.max(0.75, (0.5 * widthM) / this.pixel);
    const d = this.data;
    this.capsule(x0, y0, x1, y1, hw, (k, dist) => {
      const f = 1 - dist / hw;
      if (f <= 0) return;
      const q = 4 * k + 1;
      const v = Math.round(255 * amount * Math.min(1, 1.5 * f) * (0.7 + 0.3 * hash2(k, 7)));
      if (v > d[q]!) d[q] = v;
    });
    this.touch(Math.max(0, Math.floor(Math.min(x0, x1) - hw - 1)), Math.max(0, Math.floor(Math.min(y0, y1) - hw - 1)), Math.min(this.w - 1, Math.ceil(Math.max(x0, x1) + hw + 1)), Math.min(this.h - 1, Math.ceil(Math.max(y0, y1) + hw + 1)));
  }

  /**
   * Fill a polygon (with holes, even–odd) into the hole channel B: texel centres inside are set,
   * the outline gets a half-pixel anti-aliased edge.
   */
  fillPoly(outer: Poly, holes: readonly Poly[] = [], channel: 1 | 2 = 2, antialias = true): void {
    const b = polyBounds(outer);
    const j0 = Math.max(0, Math.floor(this.fy(b[1]))), j1 = Math.min(this.h - 1, Math.ceil(this.fy(b[3])));
    const i0 = Math.max(0, Math.floor(this.fx(b[0]))), i1 = Math.min(this.w - 1, Math.ceil(this.fx(b[2])));
    if (i0 > i1 || j0 > j1) return;
    const d = this.data;
    const xs: number[] = [];
    const rings = [outer, ...holes];
    for (let j = j0; j <= j1; j++) {
      const y = -this.height / 2 + (j + 0.5) * this.sy;
      xs.length = 0;
      for (const p of rings) {
        const n = p.length >> 1;
        for (let a = 0, c = n - 1; a < n; c = a++) {
          const ya = p[2 * a + 1]!, yc = p[2 * c + 1]!;
          if (ya > y !== yc > y) xs.push(p[2 * a]! + ((y - ya) * (p[2 * c]! - p[2 * a]!)) / (yc - ya));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const s0 = Math.max(i0, Math.ceil(this.fx(xs[k]!))), s1 = Math.min(i1, Math.floor(this.fx(xs[k + 1]!)));
        for (let i = s0; i <= s1; i++) d[4 * (j * this.w + i) + channel] = 255;
      }
    }
    // Soft edge: half-pixel lines along the outline.
    if (antialias) for (const p of rings) {
      const n = p.length >> 1;
      for (let a = 0, c = n - 1; a < n; c = a++) this.edge(p[2 * c]!, p[2 * c + 1]!, p[2 * a]!, p[2 * a + 1]!, channel);
    }
    this.touch(i0, j0, i1, j1);
  }

  private edge(ax: number, ay: number, bx: number, by: number, channel: number): void {
    const d = this.data;
    this.capsule(this.fx(ax), this.fy(ay), this.fx(bx), this.fy(by), 1, (k, dist) => {
      const q = 4 * k + channel;
      const v = Math.round(255 * 0.5 * (1 - dist));
      if (v > d[q]!) d[q] = v;
    });
  }

  /** Fill the whole pane channel (a pane that has gone completely). */
  fillAll(channel: 1 | 2, value = 255): void {
    // One 32-bit write per texel (little-endian: byte `channel` = bits 8·channel…).
    // Int32 view and int32-only bit operations: no values ≥ 2³¹ that the engine would box.
    const d32 = new Int32Array(this.data.buffer, this.data.byteOffset, this.data.length >> 2);
    const shift = 8 * channel;
    const mask = ~(0xff << shift), bits = (value & 0xff) << shift;
    for (let k = 0; k < d32.length; k++) d32[k] = (d32[k]! & mask) | bits;
    this.touch(0, 0, this.w - 1, this.h - 1);
  }
}

/** Cheap deterministic per-texel hash in [0, 1). */
export function hash2(i: number, j: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
