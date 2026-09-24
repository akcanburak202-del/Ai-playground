import type * as THREE from 'three';
import { MATERIALS, type MaterialProps } from '../physics/materials.ts';

/**
 * What the effects need to know about the ground under a point: its height (debris lands there,
 * dust skirts hug it) and the colour of the dust it raises. The terrain registers itself as the
 * provider of its scene; without terrain the ground is the flat plane y = 0.
 */
export interface GroundProvider {
  heightAt(x: number, z: number): number;
  dustColorAt(x: number, z: number): number;
  materialAt(x: number, z: number): MaterialProps;
}

const FLAT: GroundProvider = {
  heightAt: () => 0,
  dustColorAt: () => 0x9a8a72,
  materialAt: () => MATERIALS.soil,
};

const providers = new WeakMap<THREE.Scene, GroundProvider>();

export function setGroundProvider(scene: THREE.Scene, p: GroundProvider | null): void {
  if (p) providers.set(scene, p);
  else providers.delete(scene);
}

export function groundOf(scene: THREE.Scene): GroundProvider {
  return providers.get(scene) ?? FLAT;
}
