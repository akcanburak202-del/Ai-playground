import * as THREE from 'three';
import type { BrittleFinish } from '../../app/contracts.ts';
import { finishMaps } from './textures.ts';
import {
  FRAG_AO, FRAG_DISCARD, FRAG_EMISSIVE, FRAG_VARYINGS, FRAG_MAP, FRAG_NOISE, FRAG_NORMAL, FRAG_ROUGHNESS, FRAG_SURFACE,
  REBAR_FRAG_MAP, REBAR_FRAG_PARS, REBAR_VERT_MAIN, REBAR_VERT_PARS, VERT_MAIN, VERT_PARS,
} from './shader.ts';

/**
 * The brittle-material family: one MeshStandardMaterial per role, extended through
 * onBeforeCompile. Programs are shared across elements (customProgramCacheKey depends only on
 * finish and role); per-element values live in uniform objects owned by each material.
 */

const FINISH_DEFINE: Record<BrittleFinish, string> = {
  'board-formed-concrete': 'FINISH_BOARD',
  'smooth-concrete': 'FINISH_SMOOTH',
  'exposed-aggregate': 'FINISH_AGGREGATE',
  marble: 'FINISH_MARBLE',
  travertine: 'FINISH_TRAVERTINE',
  granite: 'FINISH_GRANITE',
  onyx: 'FINISH_ONYX',
  brick: 'FINISH_BRICK',
};

/** GPU textures per finish, reference counted so the last element to go disposes them. */
class FinishTextures {
  readonly ar: THREE.DataTexture;
  readonly nh: THREE.DataTexture;
  readonly tile: number;
  refs = 0;
  constructor(finish: BrittleFinish, anisotropy: number) {
    const m = finishMaps(finish);
    this.tile = m.tile;
    const mk = (data: Uint8Array, srgb: boolean) => {
      const t = new THREE.DataTexture(data, m.size, m.size, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = anisotropy;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.needsUpdate = true;
      return t;
    };
    this.ar = mk(m.albedoRough, true);
    this.nh = mk(m.normalHeight, false);
  }
  dispose(): void {
    this.ar.dispose();
    this.nh.dispose();
  }
}

const textures = new Map<BrittleFinish, FinishTextures>();

function acquireTextures(finish: BrittleFinish, anisotropy: number): FinishTextures {
  let t = textures.get(finish);
  if (!t) textures.set(finish, (t = new FinishTextures(finish, anisotropy)));
  t.refs++;
  return t;
}

function releaseTextures(finish: BrittleFinish): void {
  const t = textures.get(finish);
  if (!t) return;
  if (--t.refs <= 0) {
    t.dispose();
    textures.delete(finish);
  }
}

/** Per-finish surface parameters of the MeshStandardMaterial. */
function standardParams(finish: BrittleFinish): THREE.MeshStandardMaterialParameters {
  switch (finish) {
    case 'marble':
    case 'granite':
    case 'onyx':
      return { roughness: 1, metalness: 0, envMapIntensity: 1.0 };
    default:
      return { roughness: 1, metalness: 0, envMapIntensity: 0.8 };
  }
}

function tintColor(tint: number | undefined): THREE.Vector3 {
  if (tint === undefined) return new THREE.Vector3(1, 1, 1);
  if (tint <= 4) return new THREE.Vector3(tint, tint, tint);
  const c = new THREE.Color(tint);
  return new THREE.Vector3(c.r, c.g, c.b);
}

export interface DiscardUniforms {
  uChunkMask: { value: THREE.Data3DTexture };
  uGridOrigin: { value: THREE.Vector3 };
  uVoxel: { value: number };
  uChunkDims: { value: THREE.Vector3 };
}

/**
 * Materials of one element family (an element and the debris pieces cut from it). The chunk
 * material is shared by the family; base materials are per element because each has its own
 * chunk mask.
 */
export class VoxelLook {
  readonly finish: BrittleFinish;
  readonly chunkMaterial: THREE.MeshStandardMaterial;
  /** Same surface for loose debris pieces (more angular fracture shading) */
  readonly debrisMaterial: THREE.MeshStandardMaterial;
  readonly rebarMaterial: THREE.MeshStandardMaterial;
  private tex: FinishTextures;
  private shared: Record<string, THREE.IUniform>;
  private refs = 0;
  private flatPristine: boolean;

  constructor(finish: BrittleFinish, tint: number | undefined, half: [number, number, number], seed: number, flatPristine: boolean, anisotropy: number, shape?: { kind: 0 | 1 | 2; radius?: number; halfHeight?: number; taper?: number; flutes?: number; fluteDepth?: number }) {
    this.finish = finish;
    this.flatPristine = flatPristine;
    this.tex = acquireTextures(finish, anisotropy);
    this.shared = {
      uAR: { value: this.tex.ar },
      uNH: { value: this.tex.nh },
      uTexScale: { value: 1 / this.tex.tile },
      uTint: { value: tintColor(tint) },
      uHalf: { value: new THREE.Vector3(...half) },
      uSeed: { value: seed },
      uShape: { value: new THREE.Vector4(shape?.kind ?? 0, shape?.radius ?? 0, shape?.halfHeight ?? 0, shape?.taper ?? 0) },
      uShape2: { value: new THREE.Vector2(shape?.flutes ?? 0, shape?.fluteDepth ?? 0) },
    };
    this.chunkMaterial = this.makeSurface(true, null);
    this.debrisMaterial = this.makeSurface(true, null, true);
    this.rebarMaterial = makeRebarMaterial();
  }

  acquire(): this {
    this.refs++;
    return this;
  }

  release(): void {
    if (--this.refs > 0) return;
    this.chunkMaterial.dispose();
    this.debrisMaterial.dispose();
    this.rebarMaterial.dispose();
    releaseTextures(this.finish);
  }

  /** Material for the analytic base mesh: same surface, no damage attributes, chunk discard. */
  makeBaseMaterial(discard: DiscardUniforms): THREE.MeshStandardMaterial {
    return this.makeSurface(false, discard);
  }

  /** Shadow-pass materials matching the base mesh discard. */
  makeDepthMaterials(discard: DiscardUniforms): { depth: THREE.MeshDepthMaterial; distance: THREE.MeshDistanceMaterial } {
    const hook = (m: THREE.Material) => {
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, discard);
        shader.defines = { ...(shader.defines ?? {}), VOXEL_DISCARD: '' };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\nvarying vec3 vObjPos;`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>\nvObjPos = position;`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nvarying vec3 vObjPos;\n${FRAG_DISCARD}`)
          .replace('void main() {', 'void main() {\n  if (voxelDiscard(vObjPos)) discard;');
      };
      m.customProgramCacheKey = () => 'voxel-depth';
    };
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    const distance = new THREE.MeshDistanceMaterial();
    hook(depth);
    hook(distance);
    return { depth, distance };
  }

  private makeSurface(attrs: boolean, discard: DiscardUniforms | null, debris = false): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial(standardParams(this.finish));
    const defines: Record<string, string> = { [FINISH_DEFINE[this.finish]]: '' };
    if (attrs) defines.VOXEL_ATTRS = '';
    if (debris) defines.VOXEL_DEBRIS = '';
    if (attrs && this.flatPristine) defines.VOXEL_FLAT_PRISTINE = '';
    if (discard) defines.VOXEL_DISCARD = '';
    const shared = this.shared;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, shared);
      if (discard) Object.assign(shader.uniforms, discard);
      shader.defines = { ...(shader.defines ?? {}), ...defines };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_VARYINGS}\n${FRAG_DISCARD}\n${FRAG_NOISE}\n${FRAG_SURFACE}`)
        .replace('void main() {', discard ? 'void main() {\n  if (voxelDiscard(vObjPos)) discard;' : 'void main() {')
        .replace('#include <map_fragment>', FRAG_MAP)
        .replace('#include <roughnessmap_fragment>', FRAG_ROUGHNESS)
        .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${FRAG_AO}`);
    };
    const key = `voxel-${this.finish}-${attrs ? 'a' : ''}${discard ? 'd' : ''}${attrs && this.flatPristine ? 'f' : ''}${debris ? 'r' : ''}`;
    m.customProgramCacheKey = () => key;
    return m;
  }
}

function makeRebarMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 1 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${REBAR_VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${REBAR_VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${REBAR_FRAG_PARS}\n${FRAG_NOISE}`)
      .replace('#include <map_fragment>', REBAR_FRAG_MAP)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = barRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = barMetal;')
      .replace('#include <normal_fragment_maps>', 'normal = vxBump(normal, -vViewPosition, rib * 0.0007, 1.0);');
  };
  m.customProgramCacheKey = () => 'voxel-rebar';
  return m;
}
