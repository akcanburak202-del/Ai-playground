import * as THREE from 'three';

const _q = new THREE.Quaternion();
const _spin = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n: number[] = [0, 1, 0];
const _nv = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Small impact marks on the ground, far below the height field's resolution: a shadowed cavity,
 * a ring of freshly fractured (lighter) stone with radial cracks for hits on paving, or a dark
 * blotch of turned-over soil with crumbs for hits on earth. Instanced decals in a ring buffer,
 * lit like the ground (standard material), drawn with polygon offset.
 */
export class PockDecals {
  readonly mesh: THREE.InstancedMesh;
  private variant: THREE.InstancedBufferAttribute;
  private next = 0;
  private capacity: number;
  private material: THREE.MeshStandardMaterial;
  private geometry: THREE.BufferGeometry;
  /** Per mark: x, z, radius (0 = removed), spin — so later craters can move or remove it */
  private marks: Float32Array;

  constructor(atlas: THREE.Texture, capacity: number) {
    this.capacity = capacity;
    this.marks = new Float32Array(capacity * 4);
    this.geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.variant = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.variant.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aPock', this.variant);
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.95, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    m.name = 'ground-pocks';
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uAtlas = { value: atlas };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aPock;\nvarying vec2 vPockUv;\nvarying float vKind;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPockUv = (uv + vec2(mod(aPock.x, 2.0), floor(aPock.x / 2.0))) * 0.5;\nvKind = aPock.y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uAtlas;\nvarying vec2 vPockUv;\nvarying float vKind;')
        .replace(
          '#include <map_fragment>',
          `vec4 pk = texture2D(uAtlas, vPockUv);
          vec3 stoneChip = vec3(0.72, 0.7, 0.66);
          vec3 soilCol = vec3(0.075, 0.056, 0.04);
          vec3 cavity = vec3(0.035, 0.032, 0.03);
          vec3 c = vKind < 0.5 ? mix(stoneChip, cavity, pk.r) : mix(soilCol * (1.0 + 0.8 * pk.b), cavity, pk.r * 0.7);
          float a = vKind < 0.5 ? max(pk.r, pk.g * 0.9) : max(pk.r, max(pk.g * 0.6, pk.b * 0.9));
          diffuseColor = vec4(c, a * pk.a);`,
        );
    };
    m.customProgramCacheKey = () => 'ground-pocks-v1';
    this.material = m;
    this.mesh = new THREE.InstancedMesh(this.geometry, m, capacity);
    this.mesh.name = 'ground-pocks';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  /** Add a mark of radius r at p on a surface with normal n. kind 0 = stone / paving, 1 = soil. */
  add(p: THREE.Vector3, n: THREE.Vector3, r: number, kind: 0 | 1, rand: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.place(i, p, n, r, rand);
    this.variant.setXY(i, Math.floor(rand * 97) % 4, kind);
    this.variant.addUpdateRange(i * 2, 2);
    this.variant.needsUpdate = true;
    this.mesh.count = Math.min(this.capacity, Math.max(this.mesh.count, i + 1));
  }

  private place(i: number, p: THREE.Vector3, n: THREE.Vector3, r: number, rand: number): void {
    _q.setFromUnitVectors(UP, n);
    _spin.setFromAxisAngle(UP, rand * Math.PI * 2);
    _q.multiply(_spin);
    const d = 2 * r;
    _m.compose(_p.copy(p).addScaledVector(n, 0.002), _q, r > 0 ? _s.set(d, 1, d) : _s.set(0, 0, 0));
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.addUpdateRange(i * 16, 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    const k = i * 4;
    this.marks[k] = p.x;
    this.marks[k + 1] = p.z;
    this.marks[k + 2] = r;
    this.marks[k + 3] = rand;
  }

  /**
   * The ground under (cx, cz) was re-shaped out to `reach`: marks inside `removeRadius` were blown
   * away with the surface they sat on; the rest are re-seated on the new surface.
   */
  conform(cx: number, cz: number, reach: number, removeRadius: number, heightAt: (x: number, z: number) => number, normalAt: (x: number, z: number, out: number[]) => number[]): void {
    const m = this.marks;
    for (let i = 0; i < this.mesh.count; i++) {
      const k = i * 4;
      const r = m[k + 2]!;
      if (!(r > 0)) continue;
      const x = m[k]!, z = m[k + 1]!;
      const d = Math.hypot(x - cx, z - cz);
      if (d > reach + r) continue;
      normalAt(x, z, _n);
      _nv.set(_n[0]!, _n[1]!, _n[2]!);
      _p.set(x, heightAt(x, z), z);
      this.place(i, _p, _nv, d < removeRadius ? 0 : r, m[k + 3]!);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
