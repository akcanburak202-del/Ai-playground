import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Terrain } from '../src/destructibles/terrain/Terrain.ts';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.ts';
import { DestructibleRegistry } from '../src/destructibles/Registry.ts';
import { EventBus } from '../src/core/events.ts';
import { Rng } from '../src/core/rng.ts';
import { createBlastLoad } from '../src/physics/ballistics/blast.ts';
import type { SimContext, SimEvents } from '../src/app/contracts.ts';
import type { Destructible } from '../src/destructibles/Destructible.ts';

async function makeCtx(): Promise<SimContext> {
  const physics = await PhysicsWorld.create();
  physics.defaultGround = physics.createFixed(new THREE.Vector3(0, -1, 0), undefined, [physics.R.ColliderDesc.cuboid(500, 1, 500)]);
  const registry = new DestructibleRegistry();
  const world = new THREE.Group();
  const nop = () => {};
  return {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(60, 1, 0.05, 2000), renderer: null as unknown as THREE.WebGLRenderer,
    physics, registry, events: new EventBus<SimEvents>(), rng: new Rng(3), time: { now: 0, scale: 1, fixedDt: 1 / 60 }, world,
    projectiles: { spawn: () => { throw new Error('none'); }, active: [] }, blasts: { detonate: nop },
    fx: { chips: nop, dust: nop, sparks: nop, smoke: nop, flash: nop, shake: nop }, audio: { unlock: nop, setMuted: nop, muted: true },
    structure: { link: () => 'a', touch: nop, remove: nop, update: nop },
    addDestructible(d: Destructible) { registry.add(d); world.add(d.root); },
    ammo: () => { throw new Error('none'); },
  };
}

// three.js uploads only the listed rows even on a DataTexture's first upload (texStorage2D, then
// texSubImage2D per range), so row updates queued before the terrain was ever drawn left the rest
// of the splat image zero — relief −2 m — and a crater dug right after a scene load showed a
// rectangle of wrong shading around it (seen in scripted runs that load and blast before a frame).
test('terrain splat: a crater before the first draw sends the whole image, later ones only their rows', async () => {
  const ctx = await makeCtx();
  const t = new Terrain(ctx, { size: 200, detail: 64, plaza: { halfX: 10, halfZ: 8, finish: 'pavers' } });
  ctx.addDestructible(t);
  const splat = (t as unknown as { splat: THREE.DataTexture }).splat;
  const up = new THREE.Vector3(0, 1, 0);
  const blast = (x: number, z: number) =>
    t.applyBlast(createBlastLoad({ center: new THREE.Vector3(x, 0.02, z), tntKg: 8, kind: 'he', normal: up, contactTargetId: t.id }, 0));

  blast(4, 3);
  const v0 = splat.version;
  t.frameUpdate();
  assert.ok(splat.version > v0, 'upload queued');
  assert.equal(splat.updateRanges.length, 0, 'not resident yet: the whole image goes up');

  // The renderer uploads it (three calls onUpdate); from then on a crater sends only its rows.
  splat.onUpdate?.(splat);
  blast(-4, -3);
  t.frameUpdate();
  assert.ok(splat.updateRanges.length > 0, 'row updates once resident');
  const texelsPerMetre = splat.image.width / 64;
  assert.ok(splat.updateRanges.length < 12 * texelsPerMetre, `${splat.updateRanges.length} rows for one crater`);
  t.dispose();
});
