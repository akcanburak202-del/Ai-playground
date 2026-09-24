import type { BrittleFinish } from '../../app/contracts.ts';

/**
 * Procedural, tileable surface textures for the brittle finishes, generated once per finish on
 * typed arrays (no DOM). Each finish yields two RGBA8 maps covering `tile` metres:
 *   albedoRough: sRGB albedo + roughness in A
 *   normalHeight: tangent-space normal (from the height field by a Sobel filter) + height in A
 * Features that must line up with the element (form-tie holes, panel seams, brick coursing, marble
 * veins, travertine bedding) are generated in the shader in object space instead; these maps carry
 * the fine skin: timber grain imprint, mottling, pores, crystal speckle, clay grain.
 */
export interface FinishMaps {
  size: number;
  /** Metres covered by one texture repeat */
  tile: number;
  albedoRough: Uint8Array;
  normalHeight: Uint8Array;
}

class TileRng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    // xorshift32
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }
}

/** Periodic value noise with `px`×`py` lattice cells over the tile, quintic interpolation, in [-1, 1]. */
function valueTile(size: number, px: number, py: number, seed: number, out: Float32Array, amp: number): void {
  const rng = new TileRng(seed);
  const lat = new Float32Array(px * py);
  for (let i = 0; i < lat.length; i++) lat[i] = rng.next() * 2 - 1;
  const sx = px / size, sy = py / size;
  const fx = new Float32Array(size), ix = new Int32Array(size);
  for (let x = 0; x < size; x++) {
    const u = x * sx;
    const i = Math.floor(u);
    const f = u - i;
    ix[x] = i % px;
    fx[x] = f * f * f * (f * (f * 6 - 15) + 10);
  }
  for (let y = 0; y < size; y++) {
    const v = y * sy;
    const j = Math.floor(v);
    let g = v - j;
    g = g * g * g * (g * (g * 6 - 15) + 10);
    const r0 = (j % py) * px, r1 = ((j + 1) % py) * px;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const i0 = ix[x]!, i1 = (i0 + 1) % px, f = fx[x]!;
      const a = lat[r0 + i0]! + (lat[r0 + i1]! - lat[r0 + i0]!) * f;
      const b = lat[r1 + i0]! + (lat[r1 + i1]! - lat[r1 + i0]!) * f;
      out[row + x]! += amp * (a + (b - a) * g);
    }
  }
}

/** Tileable fBm: octaves of value noise, base lattice (px, py), doubling each octave. */
function fbm(size: number, px: number, py: number, octaves: number, gain: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const cx = Math.min(size, px << o), cy = Math.min(size, py << o);
    valueTile(size, cx, cy, seed * 7919 + o * 104729, out, amp);
    norm += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

/**
 * Tileable cellular noise: jittered feature points on an n×n grid; returns F1 (distance to the
 * nearest point, in cell units) and the id of that cell.
 */
function worley(size: number, n: number, seed: number, stretchY = 1): { f1: Float32Array; f2: Float32Array; id: Uint32Array } {
  const rng = new TileRng(seed);
  const ptx = new Float32Array(n * n), pty = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    ptx[i] = rng.next();
    pty[i] = rng.next();
  }
  const f1 = new Float32Array(size * size), f2 = new Float32Array(size * size), id = new Uint32Array(size * size);
  const s = n / size;
  const wrap = new Int32Array(n + 2);
  for (let c = -1; c <= n; c++) wrap[c + 1] = ((c % n) + n) % n;
  for (let y = 0; y < size; y++) {
    const v = y * s;
    const cy = Math.floor(v);
    for (let x = 0; x < size; x++) {
      const u = x * s;
      const cx = Math.floor(u);
      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const gy = cy + dy;
        const row = wrap[gy + 1]! * n;
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx;
          const k = wrap[gx + 1]! + row;
          const ox = gx + ptx[k]! - u, oy = (gy + pty[k]! - v) * stretchY;
          const d = ox * ox + oy * oy;
          if (d < d1) { d2 = d1; d1 = d; best = k; } else if (d < d2) d2 = d;
        }
      }
      const p = x + y * size;
      f1[p] = Math.sqrt(d1);
      f2[p] = Math.sqrt(d2);
      id[p] = best;
    }
  }
  return { f1, f2, id };
}

function hash01(n: number): number {
  let x = (n * 0x9e3779b1) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

interface Layers {
  size: number;
  tile: number;
  /** Linear-ish albedo 0..1 per channel */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  rough: Float32Array;
  /** Height in metres (relative) */
  height: Float32Array;
}

function layers(size: number, tile: number, base: [number, number, number], rough: number): Layers {
  const n = size * size;
  const L: Layers = { size, tile, r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n), rough: new Float32Array(n), height: new Float32Array(n) };
  L.r.fill(base[0]);
  L.g.fill(base[1]);
  L.b.fill(base[2]);
  L.rough.fill(rough);
  return L;
}

const ENC = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) ENC[i] = Math.round(Math.pow((i / 4096) * 1.25, 1 / 2.2) * 255 > 255 ? 255 : Math.pow((i / 4096) * 1.25, 1 / 2.2) * 255);
/** Linear 0..1.25 → sRGB byte through a lookup table (Math.pow per texel is the bottleneck otherwise). */
function enc(v: number): number {
  const i = (v * (4096 / 1.25)) | 0;
  return ENC[i < 0 ? 0 : i > 4096 ? 4096 : i]!;
}

/** Pack layers into the two RGBA8 maps (normal from height via a Sobel filter, wrap-around). */
function pack(L: Layers, bumpScale: number): FinishMaps {
  const { size } = L;
  const n = size * size;
  const ar = new Uint8Array(n * 4), nh = new Uint8Array(n * 4);
  const texel = L.tile / size;
  const hgt = L.height;
  let hmin = Infinity, hmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const h = hgt[i]!;
    if (h < hmin) hmin = h;
    if (h > hmax) hmax = h;
  }
  const hr = hmax - hmin || 1;
  const k = bumpScale / (8 * texel);
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size, y0 = y * size, yp = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const i = x + y0;
      ar[i * 4] = enc(L.r[i]!);
      ar[i * 4 + 1] = enc(L.g[i]!);
      ar[i * 4 + 2] = enc(L.b[i]!);
      const r = L.rough[i]!;
      ar[i * 4 + 3] = r <= 0 ? 0 : r >= 1 ? 255 : Math.round(r * 255);
      // Sobel gradient of the height field (m per m).
      const gx = hgt[xp + ym]! + 2 * hgt[xp + y0]! + hgt[xp + yp]! - hgt[xm + ym]! - 2 * hgt[xm + y0]! - hgt[xm + yp]!;
      const gy = hgt[xm + yp]! + 2 * hgt[x + yp]! + hgt[xp + yp]! - hgt[xm + ym]! - 2 * hgt[x + ym]! - hgt[xp + ym]!;
      const nx = -gx * k, ny = -gy * k;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nh[i * 4] = ((nx * l * 0.5 + 0.5) * 255 + 0.5) | 0;
      nh[i * 4 + 1] = ((ny * l * 0.5 + 0.5) * 255 + 0.5) | 0;
      nh[i * 4 + 2] = ((l * 0.5 + 0.5) * 255 + 0.5) | 0;
      nh[i * 4 + 3] = (((hgt[i]! - hmin) / hr) * 255 + 0.5) | 0;
    }
  }
  return { size, tile: L.tile, albedoRough: ar, normalHeight: nh };
}

const srgb = (c: number) => Math.pow(c / 255, 2.2);

/** Concrete skin shared by the concrete finishes: mottling, bugholes, laitance. */
function concreteSkin(L: Layers, seed: number, mottle: number, holes: number): void {
  const { size } = L;
  const m = fbm(size, 2, 2, 6, 0.6, seed);
  const fine = fbm(size, 48, 48, 3, 0.5, seed + 5);
  const bug = worley(size, 26, seed + 9);
  for (let i = 0; i < size * size; i++) {
    const k = 1 + mottle * m[i]! + 0.035 * fine[i]!;
    L.r[i]! *= k;
    L.g[i]! *= k;
    L.b[i]! *= k * (1 - 0.01 * m[i]!);
    L.height[i]! += 0.0002 * fine[i]!;
    L.rough[i]! += 0.05 * fine[i]!;
    // Bugholes: sparse small air voids trapped against the formwork.
    const sel = hash01(bug.id[i]! + seed * 31);
    if (sel < holes) {
      const rr = 0.1 + 0.18 * hash01(bug.id[i]! * 7 + 3);
      const f = bug.f1[i]!;
      if (f < rr) {
        const t = 1 - f / rr;
        L.height[i]! -= 0.0025 * Math.sqrt(t);
        const dk = 1 - 0.45 * t;
        L.r[i]! *= dk; L.g[i]! *= dk; L.b[i]! *= dk;
        L.rough[i] = Math.min(1, L.rough[i]! + 0.1);
      }
    }
  }
}

function boardFormed(size: number): FinishMaps {
  const tile = 0.6;
  const L = layers(size, tile, [srgb(152), srgb(151), srgb(147)], 0.8);
  // Timber grain imprint: growth rings as iso-lines of a strongly warped, stretched noise field
  // (flat-sawn boards show cathedral figures and wandering lines, not a regular sine), plus
  // fibre streaks; printed 0.2–0.5 mm deep into the skin, with only a faint tonal trace.
  const streak = fbm(size, 2, 70, 4, 0.55, 11);
  const warpA = fbm(size, 2, 6, 4, 0.55, 12);
  const warpB = fbm(size, 4, 16, 3, 0.5, 14);
  const knot = worley(size, 4, 13);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = x + y * size;
      const v = (y / size) * tile;
      let k = 0;
      const kd = knot.f1[i]!;
      if (hash01(knot.id[i]!) < 0.3 && kd < 0.2) k = (0.2 - kd) * 2.2;
      const phase = v * 170 + warpA[i]! * 22 + warpB[i]! * 5 + k * 10;
      const ring = Math.pow(0.5 + 0.5 * Math.cos(phase), 5);
      const g = 0.6 * streak[i]! + 0.4 * ring;
      L.height[i]! += 0.00035 * g;
      const t = 1 - 0.012 * ring + 0.01 * streak[i]!;
      L.r[i]! *= t;
      L.g[i]! *= t;
      L.b[i]! *= t;
    }
  concreteSkin(L, 21, 0.09, 0.03);
  return pack(L, 1.0);
}

function smoothConcrete(size: number): FinishMaps {
  const L = layers(size, 1.0, [srgb(160), srgb(159), srgb(156)], 0.62);
  concreteSkin(L, 31, 0.05, 0.05);
  return pack(L, 0.8);
}

function exposedAggregate(size: number): FinishMaps {
  const tile = 0.6;
  const L = layers(size, tile, [srgb(142), srgb(140), srgb(135)], 0.88);
  concreteSkin(L, 41, 0.04, 0.0);
  // Washed exposed aggregate: rounded river gravel (6–14 mm) standing out of grey cement paste.
  const w = worley(size, 48, 43);
  const palette = [
    [150, 146, 138], [184, 176, 162], [120, 116, 112], [168, 150, 128], [206, 200, 190], [98, 94, 92], [140, 128, 116],
  ].map((c) => c.map(srgb));
  for (let i = 0; i < size * size; i++) {
    const id = w.id[i]!;
    const r0 = 0.3 + 0.18 * hash01(id * 3 + 1);
    const f = w.f1[i]!;
    if (f >= r0) {
      L.height[i]! -= 0.0008;
      continue;
    }
    const c = palette[Math.floor(hash01(id) * palette.length)]!;
    const t = Math.min(1, (r0 - f) * 30);
    const dome = Math.sqrt(Math.max(0, 1 - (f / r0) * (f / r0)));
    const shade = 0.9 + 0.2 * hash01(id * 5 + 2);
    L.r[i] = L.r[i]! * (1 - t) + c[0]! * shade * t;
    L.g[i] = L.g[i]! * (1 - t) + c[1]! * shade * t;
    L.b[i] = L.b[i]! * (1 - t) + c[2]! * shade * t;
    L.height[i]! += 0.003 * dome;
    L.rough[i] = L.rough[i]! * (1 - t) + 0.5 * t;
  }
  return pack(L, 1.2);
}

function marble(size: number): FinishMaps {
  const L = layers(size, 0.8, [srgb(234), srgb(234), srgb(231)], 0.16);
  // Crystal fabric: faint calcite grain and cloudy grey drifts; veins are 3D (shader).
  const cloud = fbm(size, 4, 4, 6, 0.6, 51);
  const grain = worley(size, 220, 52);
  for (let i = 0; i < size * size; i++) {
    const c = 1 - 0.05 * Math.max(0, cloud[i]!) + 0.012 * (hash01(grain.id[i]!) - 0.5);
    L.r[i]! *= c;
    L.g[i]! *= c;
    L.b[i]! *= c * 1.005;
    L.rough[i]! += 0.04 * hash01(grain.id[i]! * 3);
    L.height[i]! += 0.00002 * (grain.f2[i]! - grain.f1[i]!);
  }
  return pack(L, 0.3);
}

function travertine(size: number): FinishMaps {
  const L = layers(size, 0.8, [srgb(222), srgb(212), srgb(192)], 0.5);
  const fine = fbm(size, 64, 64, 3, 0.5, 61);
  const cloud = fbm(size, 3, 6, 5, 0.55, 62);
  for (let i = 0; i < size * size; i++) {
    const k = 1 + 0.05 * cloud[i]! + 0.03 * fine[i]!;
    L.r[i]! *= k;
    L.g[i]! *= k * 0.995;
    L.b[i]! *= k * 0.985;
    L.height[i]! += 0.00015 * fine[i]!;
    L.rough[i]! += 0.06 * fine[i]!;
  }
  return pack(L, 0.8);
}

const GRANITE = [[28, 28, 30], [214, 208, 198], [128, 128, 132], [196, 170, 160], [22, 22, 24]].map((c) => c.map(srgb));

function granite(size: number): FinishMaps {
  const L = layers(size, 0.4, [srgb(150), srgb(146), srgb(142)], 0.3);
  // Salt-and-pepper: feldspar (white/cream), quartz (translucent grey), biotite/hornblende (black).
  const w = worley(size, 150, 71);
  const w2 = worley(size, 330, 72);
  for (let i = 0; i < size * size; i++) {
    const h = hash01(w.id[i]!);
    let c: number[];
    if (h < 0.22) c = GRANITE[0]!;
    else if (h < 0.55) c = GRANITE[1]!;
    else if (h < 0.88) c = GRANITE[2]!;
    else c = GRANITE[3]!;
    const h2 = hash01(w2.id[i]! + 17);
    if (h2 < 0.12) c = GRANITE[4]!;
    const v = 0.9 + 0.2 * hash01(w.id[i]! * 13);
    L.r[i] = c[0]! * v;
    L.g[i] = c[1]! * v;
    L.b[i] = c[2]! * v;
    L.rough[i] = h < 0.22 ? 0.22 : 0.32;
    L.height[i] = 0.00003 * (w.f2[i]! - w.f1[i]!);
  }
  return pack(L, 0.3);
}

function onyx(size: number): FinishMaps {
  const L = layers(size, 0.8, [srgb(220), srgb(180), srgb(118)], 0.1);
  const fib = fbm(size, 6, 40, 5, 0.6, 81);
  for (let i = 0; i < size * size; i++) {
    const k = 1 + 0.06 * fib[i]!;
    L.r[i]! *= k;
    L.g[i]! *= k;
    L.b[i]! *= k;
    L.height[i] = 0.00001 * fib[i]!;
  }
  return pack(L, 0.2);
}

function brick(size: number): FinishMaps {
  const L = layers(size, 0.5, [srgb(138), srgb(74), srgb(56)], 0.86);
  // Sand-faced clay: fine grain, dark iron specks, fire flashing (clouds).
  const fine = fbm(size, 90, 90, 3, 0.55, 91);
  const cloud = fbm(size, 5, 5, 5, 0.55, 92);
  const speck = worley(size, 240, 93);
  for (let i = 0; i < size * size; i++) {
    const k = 1 + 0.08 * fine[i]! + 0.1 * cloud[i]!;
    L.r[i]! *= k;
    L.g[i]! *= k * (1 - 0.05 * cloud[i]!);
    L.b[i]! *= k;
    if (hash01(speck.id[i]!) < 0.06 && speck.f1[i]! < 0.35) {
      L.r[i]! *= 0.45; L.g[i]! *= 0.45; L.b[i]! *= 0.5;
    }
    L.height[i]! += 0.0004 * fine[i]!;
    L.rough[i]! += 0.05 * fine[i]!;
  }
  return pack(L, 1.0);
}

const cache = new Map<string, FinishMaps>();

/** Maps for a finish (generated on first use, then cached for the page lifetime). */
export function finishMaps(finish: BrittleFinish, size = 512): FinishMaps {
  const key = `${finish}@${size}`;
  let m = cache.get(key);
  if (m) return m;
  switch (finish) {
    case 'board-formed-concrete': m = boardFormed(size); break;
    case 'smooth-concrete': m = smoothConcrete(size); break;
    case 'exposed-aggregate': m = exposedAggregate(size); break;
    case 'marble': m = marble(size); break;
    case 'travertine': m = travertine(size); break;
    case 'granite': m = granite(size); break;
    case 'onyx': m = onyx(size); break;
    case 'brick': m = brick(size); break;
  }
  cache.set(key, m);
  return m;
}
