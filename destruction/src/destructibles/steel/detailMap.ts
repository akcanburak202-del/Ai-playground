import * as THREE from 'three';
import { Noise3 } from '../../core/noise.ts';

const NOISE = new Noise3(7717);

/**
 * Stamp edges and streaks vary with the angle around the stamp centre only, so the noise is
 * tabulated once per stamp on a ring (LUT_N samples) and every texel just interpolates: a 1 m soot
 * stamp touches ~2·10⁵ texels, and three gradient-noise evaluations per texel cost > 100 ms.
 */
const LUT_N = 256;
const RINGS = [0, 1, 2, 3].map(() => new Float32Array(LUT_N + 1));

function ring(slot: number, seed: number, freq: number): Float32Array {
  const out = RINGS[slot]!;
  for (let k = 0; k <= LUT_N; k++) {
    const a = (2 * Math.PI * k) / LUT_N;
    out[k] = NOISE.noise3(Math.cos(a) * freq, Math.sin(a) * freq, seed);
  }
  return out;
}

function around(t: Float32Array, ang: number): number {
  let f = (ang / (2 * Math.PI) + 1) * LUT_N;
  f -= Math.floor(f / LUT_N) * LUT_N;
  const i = Math.min(LUT_N - 1, Math.floor(f));
  const r = f - i;
  return t[i]! + (t[i + 1]! - t[i]!) * r;
}

/** Integer hash → [0, 1) (texel grain) and a smooth 2-D value noise in [0, 1] (mottling). */
function hash2(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise2(x: number, y: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Dirty rectangle of one texture (texels, inclusive). */
interface Dirty {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type TexelFn = (i: number, rr: number, ang: number, du: number, dv: number) => void;

/**
 * CPU-painted surface detail for a steel element (see look.ts for what the channels mean) plus a
 * float heat map. Stamps work in texture space (u, v ∈ [0, 1]) with radii given per axis, so a
 * texture that covers a non-square area still gets round marks. Shared by the pieces of a torn plate
 * (they keep the parent's texture coordinates), hence the reference count. Only the rows a stamp
 * touched are re-uploaded (a plate's detail map is ~2 MB; machine-gun fire stamps it every frame).
 */
export class DetailMap {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
  readonly tex: THREE.DataTexture;
  readonly hw: number;
  readonly hh: number;
  readonly heat: Float32Array;
  readonly heatTex: THREE.DataTexture;
  refs = 1;
  private readonly dirtyDetail: Dirty = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
  private readonly dirtyHeat: Dirty = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
  /**
   * Upload state per texture: partial row updates are only valid once the GPU holds a full copy and
   * no whole-texture upload is still waiting (it would otherwise be cut down to the new rows).
   */
  private readonly texState = { resident: false, fullPending: true };
  private readonly heatState = { resident: false, fullPending: true };

  constructor(w: number, h: number, hw: number, hh: number, floatLinear: boolean) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(4 * w * h);
    for (let i = 0; i < w * h; i++) this.data[4 * i] = 255;
    this.tex = new THREE.DataTexture(this.data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.generateMipmaps = true;
    this.tex.colorSpace = THREE.NoColorSpace;
    this.tex.onUpdate = () => {
      this.texState.resident = true;
      this.texState.fullPending = false;
    };
    this.tex.needsUpdate = true;
    this.hw = hw;
    this.hh = hh;
    this.heat = new Float32Array(4 * hw * hh);
    for (let i = 0; i < hw * hh; i++) {
      this.heat[4 * i + 1] = -1e4;
      this.heat[4 * i + 2] = 0.01;
      this.heat[4 * i + 3] = 20;
    }
    this.heatTex = new THREE.DataTexture(this.heat, hw, hh, THREE.RGBAFormat, THREE.FloatType);
    this.heatTex.magFilter = this.heatTex.minFilter = floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
    this.heatTex.wrapS = this.heatTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heatTex.onUpdate = () => {
      this.heatState.resident = true;
      this.heatState.fullPending = false;
    };
    this.heatTex.needsUpdate = true;
  }

  /**
   * Visit texels within an ellipse around (cu, cv) with radii (ru, rv); f gets the texel index, r/R,
   * the angle and the normalised offsets. `heat` selects the heat map's resolution.
   */
  private each(cu: number, cv: number, ru: number, rv: number, heat: boolean, f: TexelFn): void {
    const w = heat ? this.hw : this.w, h = heat ? this.hh : this.h;
    if (!(ru > 0 && rv > 0)) return;
    const x0 = Math.max(0, Math.floor((cu - ru) * w)), x1 = Math.min(w - 1, Math.ceil((cu + ru) * w));
    const y0 = Math.max(0, Math.floor((cv - rv) * h)), y1 = Math.min(h - 1, Math.ceil((cv + rv) * h));
    if (x1 < x0 || y1 < y0) return;
    const d = heat ? this.dirtyHeat : this.dirtyDetail;
    d.x0 = Math.min(d.x0, x0);
    d.x1 = Math.max(d.x1, x1);
    d.y0 = Math.min(d.y0, y0);
    d.y1 = Math.max(d.y1, y1);
    for (let y = y0; y <= y1; y++) {
      const dv = ((y + 0.5) / h - cv) / rv;
      for (let x = x0; x <= x1; x++) {
        const du = ((x + 0.5) / w - cu) / ru;
        const rr = Math.sqrt(du * du + dv * dv);
        if (rr > 1) continue;
        f(y * w + x, rr, Math.atan2(dv, du), du, dv);
      }
    }
  }

  /**
   * Punch a hole: material gone inside a radius that wanders by `jag` (torn edges are ragged,
   * drilled-like AP holes are round), with a one-texel soft edge and a darker torn lip around it.
   */
  hole(cu: number, cv: number, ru: number, rv: number, jag: number, seed: number): void {
    const pad = 1.25 + jag;
    const tu = 1 / this.w, tv = 1 / this.h;
    const A = ring(0, seed, 2.2), B = ring(1, seed + 3, 7);
    const Ru = ru * pad + 2 * tu, Rv = rv * pad + 2 * tv;
    this.each(cu, cv, Ru, Rv, false, (i, rr, ang) => {
      const wobble = 1 + jag * (0.55 * around(A, ang) + 0.35 * around(B, ang));
      const edge = wobble / pad; // hole radius in units of the stamp radius
      // Distance to the edge in texels.
      const d = (rr - edge) * Ru * this.w;
      // R: 0 inside, ramps 0 → 0.5 across the edge texel, then the lip band 0.5 → 1 over ~1.5 texels.
      const r = d < -0.5 ? 0 : d < 0.5 ? (d + 0.5) * 0.5 : Math.min(1, 0.5 + (d - 0.5) / 3);
      const k = 4 * i;
      this.data[k] = Math.min(this.data[k]!, Math.round(r * 255));
    });
  }

  /**
   * Scar (bare metal / chipped coating): strength 0..1, full in the middle, with a ragged edge
   * (fine angular wander plus per-texel grain, so it reads as scraped metal, not a cut-out).
   */
  scar(cu: number, cv: number, ru: number, rv: number, strength: number, seed: number): void {
    const A = ring(0, seed, 4), B = ring(1, seed + 5, 13);
    const s0 = Math.floor(seed * 7919);
    this.each(cu, cv, ru, rv, false, (i, rr, ang, du, dv) => {
      const edge = 0.8 + 0.14 * around(A, ang) + 0.08 * around(B, ang);
      const grain = hash2(Math.round(du * 997), Math.round(dv * 991), s0) - 0.5;
      const v = strength * clamp01((1 - rr / edge) * 3 + 0.4 * grain);
      const k = 4 * i + 1;
      this.data[k] = Math.max(this.data[k]!, Math.round(v * 255));
    });
  }

  /**
   * Spall scab / gouged crater: a sharp, ragged-edged patch of fracture surface (bare metal) with a
   * flat bottom `depth` (0..1 of the dimple scale) and a steep wall, as a Hopkinson scab leaves it.
   */
  scab(cu: number, cv: number, ru: number, rv: number, depth: number, seed: number): void {
    const jag = 0.3, pad = 1.35;
    const A = ring(0, seed, 2.5), B = ring(1, seed + 5, 9);
    const s0 = Math.floor(seed * 7919);
    const texels = Math.max(1, ru * this.w * 0.08);
    this.each(cu, cv, ru * pad, rv * pad, false, (i, rr, ang, du, dv) => {
      const wobble = 1 + jag * (0.6 * around(A, ang) + 0.4 * around(B, ang));
      const x = (rr * pad) / wobble; // 1 on the ragged edge
      const k = 4 * i;
      const edge = Math.min(1, Math.max(0, (1 - x) * texels * 4));
      const g = Math.round(255 * Math.max(edge, x < 1.25 ? 0.25 * (1.25 - x) * 4 * 0.5 : 0));
      this.data[k + 1] = Math.max(this.data[k + 1]!, Math.min(255, g));
      const d = depth * edge * (0.8 + 0.2 * vnoise2(du * 4 + 5, dv * 4 + 9, s0));
      this.data[k + 3] = Math.max(this.data[k + 3]!, Math.round(Math.min(1, d) * 255));
    });
  }

  /**
   * Detonation soot. The products leave a dense, mottled deposit that is darkest under the charge
   * and thins outward; radial streaks appear only where the outflow has organised (away from the
   * centre), and the edge is ragged. Successive films darken asymptotically: B ← 1 − (1 − B)(1 − v).
   */
  soot(cu: number, cv: number, ru: number, rv: number, amount: number, seed: number): void {
    const E1 = ring(0, seed + 11, 1.8), E2 = ring(1, seed + 17, 6), S1 = ring(2, seed, 12), S2 = ring(3, seed + 3, 31);
    const s0 = Math.floor(seed * 7919);
    this.each(cu, cv, ru, rv, false, (i, rr, ang, du, dv) => {
      const edge = 0.78 + 0.16 * around(E1, ang) + 0.06 * around(E2, ang);
      const x = rr / edge;
      if (x >= 1) return;
      const org = clamp01((x - 0.25) / 0.5);
      const streak = 1 + org * org * (3 - 2 * org) * (0.45 * around(S1, ang) + 0.25 * around(S2, ang));
      const mottle = 0.75 + 0.5 * vnoise2(du * 3.5 + 11, dv * 3.5 + 5, s0);
      const p = 1 - x * x;
      const v = clamp01(amount * p * Math.sqrt(p) * streak * mottle);
      const k = 4 * i + 2;
      const b = this.data[k]! / 255;
      this.data[k] = Math.round(255 * (1 - (1 - b) * (1 - v)));
    });
  }

  /** Crater depth in [0, 1] (× the material's dimple scale): a smooth bowl with a raised lip. */
  dimple(cu: number, cv: number, ru: number, rv: number, depth: number): void {
    this.each(cu, cv, ru * 1.3, rv * 1.3, false, (i, rr) => {
      const x = rr * 1.3;
      const bowl = x < 1 ? 1 - x * x : 0;
      const lip = x >= 0.85 ? -0.25 * Math.exp(-((x - 1.05) ** 2) / 0.01) : 0;
      const v = depth * (bowl + lip);
      const k = 4 * i + 3;
      this.data[k] = Math.max(0, Math.min(255, Math.max(this.data[k]!, Math.round(v * 255))));
    });
  }

  /**
   * Hot spot: temperature rise dT (K) over a radius (m), added to whatever is left of earlier spots
   * (their conduction decay evaluated now), stamped with the current time. `temper: false` for a
   * surface flash too thin to leave an oxide film worth seeing (it is under soot anyway).
   */
  heatSpot(cu: number, cv: number, ru: number, rv: number, dT: number, time: number, radius: number, alpha: number, temper = true): void {
    const H = this.heat;
    this.each(cu, cv, ru, rv, true, (i, rr) => {
      const k = 4 * i;
      const left = spotNow(H, k, time, alpha);
      const add = dT * Math.exp(-3 * rr * rr);
      const peak = Math.min(1480, left + add);
      H[k] = peak;
      H[k + 1] = time;
      H[k + 2] = radius;
      if (temper) H[k + 3] = Math.max(H[k + 3]!, 20 + peak);
    });
  }

  /**
   * Heated wall layer of a bore or cut (thickness `layer`, m): flat inside the stamp, cooling by 1-D
   * conduction into the wall, ΔT(t) = ΔT₀·min(1, δ/√(π α t)) — the far-field of an instantaneous
   * plane source, Carslaw & Jaeger, Conduction of Heat in Solids (1959) §2.2. Stored with a negative
   * radius so the shader picks that law.
   */
  boreHeat(cu: number, cv: number, ru: number, rv: number, dT: number, time: number, layer: number, alpha: number): void {
    const H = this.heat;
    this.each(cu, cv, ru, rv, true, (i, rr) => {
      const k = 4 * i;
      const left = spotNow(H, k, time, alpha);
      const add = dT * (rr < 0.75 ? 1 : Math.max(0, 1 - (rr - 0.75) / 0.25));
      if (add <= left) return;
      const peak = Math.min(1480, add);
      H[k] = peak;
      H[k + 1] = time;
      H[k + 2] = -layer;
      H[k + 3] = Math.max(H[k + 3]!, 20 + peak);
    });
  }

  /** Material present at (u, v)? */
  solid(u: number, v: number): boolean {
    const x = Math.min(this.w - 1, Math.max(0, Math.floor(u * this.w)));
    const y = Math.min(this.h - 1, Math.max(0, Math.floor(v * this.h)));
    return this.data[4 * (y * this.w + x)]! >= 128;
  }

  /** Crater depth channel at (u, v), 0..1. */
  dimpleAt(u: number, v: number): number {
    const x = Math.min(this.w - 1, Math.max(0, Math.floor(u * this.w)));
    const y = Math.min(this.h - 1, Math.max(0, Math.floor(v * this.h)));
    return this.data[4 * (y * this.w + x) + 3]! / 255;
  }

  /** Push changes to the GPU (call at most once per frame): only the touched rows once it is resident. */
  upload(): void {
    if (flush(this.tex, this.dirtyDetail, this.w, this.h, this.texState)) this.tex.needsUpdate = true;
    if (flush(this.heatTex, this.dirtyHeat, this.hw, this.hh, this.heatState)) this.heatTex.needsUpdate = true;
  }

  release(): void {
    if (--this.refs > 0) return;
    this.tex.dispose();
    this.heatTex.dispose();
  }
}

/**
 * Queue the dirty rectangle as per-row update ranges (three.js uploads one row span per range);
 * a large rectangle, or a texture the GPU has never received, goes up whole. Returns true if dirty.
 */
function flush(tex: THREE.DataTexture, d: Dirty, w: number, h: number, st: { resident: boolean; fullPending: boolean }): boolean {
  if (d.x1 < d.x0) return false;
  const rows = d.y1 - d.y0 + 1, cols = d.x1 - d.x0 + 1;
  if (st.resident && !st.fullPending && rows * cols < 0.35 * w * h && rows < 256) {
    for (let y = d.y0; y <= d.y1; y++) tex.addUpdateRange(4 * (y * w + d.x0), 4 * cols);
  } else {
    tex.clearUpdateRanges();
    st.fullPending = true;
  }
  d.x0 = d.y0 = Infinity;
  d.x1 = d.y1 = -1;
  return true;
}

/** Temperature rise left at texel k now: 2-D spot (radius > 0) or 1-D wall layer (radius < 0). */
function spotNow(H: Float32Array, k: number, time: number, alpha: number): number {
  const age = Math.max(0, time - H[k + 1]!);
  const r0 = H[k + 2]!;
  if (r0 < 0) return H[k]! * Math.min(1, -r0 / Math.sqrt(Math.PI * alpha * Math.max(age, 1e-9)));
  const r = Math.max(r0, 1e-4);
  return H[k]! / (1 + (4 * alpha * age) / (r * r));
}
