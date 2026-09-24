import * as THREE from 'three';

/**
 * Procedural textures for the ground, generated once at startup (no image assets):
 * a tileable 4-channel noise used at several world scales by the ground shader, and an atlas of
 * impact pocks (chipped stone, disturbed soil) for small-arms and cannon hits.
 */

/** Periodic 2D gradient noise (Perlin 2002 quintic fade) with lattice period `p`; ≈ [-1, 1]. */
export function periodicNoise(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const g = (ix: number, iy: number, dx: number, dy: number) => {
    const h = hash2(((ix % p) + p) % p, ((iy % p) + p) % p, seed);
    const a = h * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = g(xi, yi, xf, yf);
  const n10 = g(xi + 1, yi, xf - 1, yf);
  const n01 = g(xi, yi + 1, xf, yf - 1);
  const n11 = g(xi + 1, yi + 1, xf - 1, yf - 1);
  return 1.4 * (n00 + u * (n10 - n00) + v * (n01 - n00) + u * v * (n00 - n10 - n01 + n11));
}

export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Tileable fBm in [0, 1] over a `size`² texture starting at lattice period `base`. */
function tileFbm(x: number, y: number, size: number, base: number, octaves: number, seed: number): number {
  let sum = 0, amp = 1, norm = 0, per = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * periodicNoise((x / size) * per, (y / size) * per, per, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    per *= 2;
  }
  return 0.5 + 0.5 * (sum / norm);
}

/**
 * RGBA noise, tileable, linear data (not colour):
 * R: broad fBm (4 → 64 cycles), G: independent broad fBm, B: fine fBm (16 → 128), A: ridged
 * "crack" noise (1 − |n|)^6 for stone veins / dry-soil cracks.
 */
export function createGroundNoise(size = 256): THREE.DataTexture {
  const t = new THREE.DataTexture(groundNoiseData(size), size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Texel data is generated once per page (≈ 0.3 s) and shared; each terrain owns its GPU texture. */
const dataCache = new Map<string, Uint8Array>();

function groundNoiseData(size: number): Uint8Array {
  const key = `ground-${size}`;
  const hit = dataCache.get(key);
  if (hit) return hit;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = to8(tileFbm(x, y, size, 4, 5, 11));
      data[i + 1] = to8(tileFbm(x, y, size, 4, 5, 97));
      data[i + 2] = to8(tileFbm(x, y, size, 16, 4, 211));
      const n = periodicNoise((x / size) * 8, (y / size) * 8, 8, 401) + 0.5 * periodicNoise((x / size) * 16, (y / size) * 16, 16, 402);
      data[i + 3] = to8(Math.pow(Math.max(0, 1 - Math.abs(n)), 6));
    }
  }
  dataCache.set(key, data);
  return data;
}

function to8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * Impact pock atlas, 2 × 2 variants of 128², RGBA:
 * R = darkness of the cavity (shadowed hole), G = fresh-fracture brightness (the chipped ring of a
 * hit on stone is lighter than the weathered surface), B = crumbs / spatter, A = coverage.
 * All data, linear.
 */
export function createPockAtlas(): THREE.DataTexture {
  const n = 256;
  const t = new THREE.DataTexture(pockData(), n, n, THREE.RGBAFormat);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function pockData(): Uint8Array {
  const hit = dataCache.get('pocks');
  if (hit) return hit;
  const cell = 128, n = cell * 2;
  const data = new Uint8Array(n * n * 4);
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * cell, oy = Math.floor(v / 2) * cell;
    const seed = 1000 + v * 37;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const px = (x + 0.5) / cell * 2 - 1, py = (y + 0.5) / cell * 2 - 1;
        const r = Math.hypot(px, py);
        const a = Math.atan2(py, px);
        // Irregular rim from angular noise; radial crack rays.
        const wob = 0.18 * periodicNoise(a * 1.3 + 7, v * 3.1, 64, seed) + 0.1 * periodicNoise(a * 4 + 1, 2, 64, seed + 1);
        const rim = 0.6 * (1 + wob);
        const hole = smooth(rim * 0.55, rim * 0.25, r);
        const chip = smooth(rim * 1.25, rim * 0.8, r) * (1 - hole * 0.6);
        const rays = Math.pow(Math.max(0, periodicNoise(a * 9, 0.5, 64, seed + 2)), 3) * smooth(0.98, rim, r);
        const crumbs = hash2(x, y, seed) > 0.93 ? smooth(1, 0.5, r) : 0;
        const cover = Math.min(1, Math.max(hole, chip, rays * 0.8, crumbs));
        const i = ((oy + y) * n + ox + x) * 4;
        data[i] = to8(hole);
        data[i + 1] = to8(chip * 0.9 + rays * 0.5);
        data[i + 2] = to8(crumbs + rays * 0.3);
        data[i + 3] = to8(cover);
      }
    }
  }
  dataCache.set('pocks', data);
  return data;
}

/** 1 at `inner`, 0 at `outer`, smooth in between (either order of edges). */
function smooth(outer: number, inner: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - outer) / (inner - outer)));
  return t * t * (3 - 2 * t);
}
