import * as THREE from 'three';
import { createSandbox } from './sandboxKit.ts';

// Smoke test for the kit: a few plain boxes, one of them a falling Rapier body.
await createSandbox({
  title: 'basic sandbox',
  build(ctx) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.8 });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.3), mat);
    wall.position.set(0, 1.5, 0);
    wall.castShadow = wall.receiveShadow = true;
    ctx.world.add(wall);
    const cube = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mat);
    cube.castShadow = true;
    ctx.world.add(cube);
    const p = ctx.physics;
    const body = p.createDynamic({ position: new THREE.Vector3(1, 4, 1.5), colliders: [p.R.ColliderDesc.cuboid(0.25, 0.25, 0.25)] });
    ctx.world.userData.sync = () => {
      const t = body.translation();
      const r = body.rotation();
      cube.position.set(t.x, t.y, t.z);
      cube.quaternion.set(r.x, r.y, r.z, r.w);
    };
  },
  install(sim) {
    sim.onFrame(() => (sim.ctx.world.userData.sync as (() => void) | undefined)?.());
  },
});
