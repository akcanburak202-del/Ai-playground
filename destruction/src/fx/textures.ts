import * as THREE from 'three';
import { Noise3 } from '../core/noise.ts';

/**
 * Billboard atlases generated at startup from 3D gradient noise (no image assets):
 *
 * Smoke: 4 × 4 cells; 0–7 cauliflower puffs (unions of spherical lobes: smoke, fireball soot),
 * 8–15 ragged diffuse clouds (fine dust). RG = the surface normal in billboard space (x, y),
 * B = thickness, A = density — so smoke can be lit by the sun per pixel (wrap diffuse +
 * forward scattering) instead of looking like flat grey sprites.
 *
 * Fire: 4 × 4 turbulent flame blobs, the last row four muzzle-flash stars. R = heat (drives the
 * black-body colour), A = density.
 */

export const ATLAS_CELLS = 4;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function createSmokeAtlas(cell = 128): THREE.DataTexture {
  const n = cell * ATLAS_CELLS;
  const data = new Uint8Array(n * n * 4);
  const noise = new Noise3(5150);
  const H = new Float32Array(cell * cell);
  const D = new Float32Array(cell * cell);
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let v = 0; v < ATLAS_CELLS * ATLAS_CELLS; v++) {
    // A puff is a union of overlapping spherical lobes (the cauliflower structure of turbulent
    // smoke), a few big ones in the middle and smaller ones towards the rim, with mild noise.
    const lobes: number[] = [];
    const count = 7 + Math.floor(rnd() * 5);
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const d = i === 0 ? 0 : 0.2 + 0.4 * Math.sqrt(rnd());
      const r = i === 0 ? 0.55 : 0.22 + 0.28 * rnd() * (1.1 - d);
      lobes.push(Math.cos(a) * d, Math.sin(a) * d, r, (rnd() - 0.5) * 0.15);
    }
    const ox = v * 17.3, oy = v * 7.1;
    const diffuse = v >= 8;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const px = ((x + 0.5) / cell) * 2 - 1, py = ((y + 0.5) / cell) * 2 - 1;
        if (diffuse) {
          // Fine dust: a soft, ragged cloud with little structure (no billows), domain-warped fBm.
          const r = Math.hypot(px, py);
          const wx = noise.fbm(px * 1.5 + ox, py * 1.5, 3.3 + v, 3);
          const f = noise.fbm(px * 2.4 + wx + ox, py * 2.4 + oy, v * 0.53, 5);
          const k = y * cell + x;
          const dome = Math.sqrt(Math.max(0, 1 - r * r));
          H[k] = dome * 0.6 + 0.04 * f;
          D[k] = smoothstep(0.0, 0.75, (1 - r) * (0.85 + 0.9 * f) - 0.05) * smoothstep(1.0, 0.8, r);
          continue;
        }
        let h = -1;
        for (let i = 0; i < lobes.length; i += 4) {
          const dx = px - lobes[i]!, dy = py - lobes[i + 1]!, r = lobes[i + 2]!;
          const q = r * r - dx * dx - dy * dy;
          if (q > 0) h = Math.max(h, Math.sqrt(q) + lobes[i + 3]!);
        }
        const nz = noise.fbm(px * 3.1 + ox, py * 3.1 + oy, v * 0.71, 4);
        const k = y * cell + x;
        H[k] = Math.max(0, h) + 0.09 * nz;
        // Dense inside the lobes, a wispy low-density fringe just outside them.
        const core = smoothstep(-0.04, 0.3, h + 0.12 * nz);
        const fringe = 0.4 * smoothstep(-0.22, 0.0, h + 0.18 * nz) * (0.5 + 0.5 * nz);
        D[k] = Math.max(core, fringe) * smoothstep(1.0, 0.85, Math.hypot(px, py));
      }
    }
    const cx0 = (v % ATLAS_CELLS) * cell, cy0 = Math.floor(v / ATLAS_CELLS) * cell;
    for (let y = 0; y < cell; y++) {
      const y0 = Math.max(0, y - 1), y1 = Math.min(cell - 1, y + 1);
      for (let x = 0; x < cell; x++) {
        const x0 = Math.max(0, x - 1), x1 = Math.min(cell - 1, x + 1);
        const dx = (H[y * cell + x1]! - H[y * cell + x0]!) * (cell / 4);
        const dy = (H[y1 * cell + x]! - H[y0 * cell + x]!) * (cell / 4);
        const l = Math.hypot(dx, dy, 1);
        const i = ((cy0 + y) * n + cx0 + x) * 4;
        data[i] = Math.round((0.5 - 0.5 * (dx / l)) * 255);
        data[i + 1] = Math.round((0.5 - 0.5 * (dy / l)) * 255);
        data[i + 2] = Math.round(Math.max(0, Math.min(1, H[y * cell + x]! * 1.8)) * 255);
        data[i + 3] = Math.round(D[y * cell + x]! * 255);
      }
    }
  }
  return atlasTexture(data, n);
}

export function createFireAtlas(cell = 128): THREE.DataTexture {
  const n = cell * ATLAS_CELLS;
  const data = new Uint8Array(n * n * 4);
  const noise = new Noise3(9001);
  for (let v = 0; v < ATLAS_CELLS * ATLAS_CELLS; v++) {
    const cx0 = (v % ATLAS_CELLS) * cell, cy0 = Math.floor(v / ATLAS_CELLS) * cell;
    const star = v >= 12;
    const petals = 4 + (v % 3);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const px = ((x + 0.5) / cell) * 2 - 1, py = ((y + 0.5) / cell) * 2 - 1;
        const r = Math.hypot(px, py);
        let heat: number, dens: number;
        if (!star) {
          // Turbulent flame blob: domain-warped fBm inside a soft disc, hottest in the core.
          const wx = noise.fbm(px * 1.7 + v * 3.1, py * 1.7, 0.7, 3) * 0.35;
          const wy = noise.fbm(px * 1.7, py * 1.7 + v * 5.3, 2.1, 3) * 0.35;
          const f = noise.fbm(px * 2.6 + wx * 2 + v, py * 2.6 + wy * 2, v * 0.37, 5);
          const core = 1 - Math.hypot(px + wx * 0.6, py + wy * 0.6);
          dens = smoothstep(0.0, 0.45, core + 0.55 * f);
          heat = Math.max(0, Math.min(1, smoothstep(0.1, 0.95, core + 0.4 * f)));
        } else {
          // Muzzle-flash star: a white-hot core and ragged petals (gas jets through the brake).
          const a = Math.atan2(py, px);
          const ray = Math.pow(Math.max(0, Math.cos(a * petals * 0.5 + v)), 6);
          const rag = 0.75 + 0.5 * noise.noise3(Math.cos(a) * 3 + v, Math.sin(a) * 3, r * 4);
          const reach = 0.25 + 0.7 * ray * rag;
          dens = smoothstep(reach, reach * 0.35, r);
          heat = smoothstep(0.55, 0.0, r / Math.max(reach, 1e-3)) * 0.6 + smoothstep(0.25, 0.0, r) * 0.4;
        }
        const i = ((cy0 + y) * n + cx0 + x) * 4;
        data[i] = Math.round(heat * 255);
        data[i + 1] = Math.round(dens * 255);
        data[i + 2] = 0;
        data[i + 3] = Math.round(dens * 255);
      }
    }
  }
  return atlasTexture(data, n);
}

function atlasTexture(data: Uint8Array, n: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
