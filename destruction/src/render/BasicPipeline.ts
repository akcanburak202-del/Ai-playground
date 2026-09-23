import * as THREE from 'three';
import type { RenderPipelineApi, SceneDef, SimContext } from '../app/contracts.ts';

/**
 * Bare-bones pipeline used until the full one (sky, post-processing, terrain) is wired in, and by
 * module sandboxes. Sun + hemisphere light, a flat plaza and plain forward rendering.
 */
export class BasicPipeline implements RenderPipelineApi {
  private ctx!: SimContext;
  private sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  private hemi = new THREE.HemisphereLight(0xcfdcf0, 0x6f675c, 1.1);
  private ground: THREE.Mesh;

  constructor() {
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x8d877c, roughness: 0.95 }),
    );
    this.ground.receiveShadow = true;
    this.ground.name = 'basic-ground';
    const s = this.sun.shadow;
    s.mapSize.set(2048, 2048);
    s.camera.left = -40; s.camera.right = 40; s.camera.top = 40; s.camera.bottom = -40;
    s.camera.near = 1; s.camera.far = 300;
    s.bias = -0.0004; s.normalBias = 0.02;
    this.sun.castShadow = true;
  }

  setup(ctx: SimContext, scene: SceneDef | null): void {
    this.ctx = ctx;
    const r = ctx.renderer;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    ctx.scene.background = new THREE.Color(0xbfd0e0);
    ctx.scene.fog = new THREE.Fog(0xbfd0e0, 120, 420);
    const elev = THREE.MathUtils.degToRad(scene?.sun?.elevation ?? 35);
    const az = THREE.MathUtils.degToRad(scene?.sun?.azimuth ?? 210);
    this.sun.position.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az)).multiplyScalar(120);
    for (const o of [this.sun, this.sun.target, this.hemi, this.ground]) if (!o.parent) ctx.scene.add(o);
  }

  render(): void {
    this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
  }

  resize(width: number, height: number): void {
    this.ctx.renderer.setSize(width, height, false);
    this.ctx.camera.aspect = width / height;
    this.ctx.camera.updateProjectionMatrix();
  }

  setQuality(): void {}
}
