import * as THREE from 'three';
import type { ChargeEvent, SimContext, System } from '../app/contracts.ts';

/** Block size (length, width, thickness), m — a demolition block's rough outline, for visuals only */
const BLOCK: [number, number, number] = [0.28, 0.05, 0.05];
/** Olive drab */
const OLIVE = 0x4b5320;
/** LED blink period and on-fraction */
const BLINK_S = 1.0;
const BLINK_ON = 0.18;

interface Marker {
  id: number;
  group: THREE.Group;
  led: THREE.Mesh;
  phase: number;
}

const _n = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Placed charges made visible: a small olive block with a detonator and a blinking red LED at
 * each `chargePlaced` position, lying flat on the surface (its back against it, long side level
 * where the surface allows), removed on `chargeRemoved` and cleared when the scene resets.
 * Geometry and materials are shared by all markers and freed in `dispose`.
 */
export class ChargeMarkers implements System {
  readonly name = 'chargeMarkers';
  private readonly ctx: SimContext;
  private readonly root = new THREE.Group();
  private readonly markers = new Map<number, Marker>();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly blockGeo: THREE.BoxGeometry;
  private readonly capGeo: THREE.CylinderGeometry;
  private readonly boxGeo: THREE.BoxGeometry;
  private readonly ledGeo: THREE.SphereGeometry;
  private readonly blockMat: THREE.MeshStandardMaterial;
  private readonly capMat: THREE.MeshStandardMaterial;
  private readonly boxMat: THREE.MeshStandardMaterial;
  private readonly ledOn: THREE.MeshBasicMaterial;
  private readonly ledOff: THREE.MeshStandardMaterial;
  private readonly off: (() => void)[] = [];
  private clock = 0;

  constructor(ctx: SimContext) {
    this.ctx = ctx;
    this.root.name = 'charge markers';
    const [L, W, T] = BLOCK;
    this.blockGeo = this.geo(new THREE.BoxGeometry(L, W, T));
    this.capGeo = this.geo(new THREE.CylinderGeometry(0.0035, 0.0035, 0.05, 8));
    this.boxGeo = this.geo(new THREE.BoxGeometry(0.035, 0.03, 0.02));
    this.ledGeo = this.geo(new THREE.SphereGeometry(0.004, 8, 6));
    this.blockMat = this.mat(new THREE.MeshStandardMaterial({ color: OLIVE, roughness: 0.85, metalness: 0 }));
    this.capMat = this.mat(new THREE.MeshStandardMaterial({ color: 0xb8b8b0, roughness: 0.35, metalness: 0.9 }));
    this.boxMat = this.mat(new THREE.MeshStandardMaterial({ color: 0x1c1c1a, roughness: 0.6, metalness: 0.1 }));
    this.ledOn = this.mat(new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    this.ledOff = this.mat(new THREE.MeshStandardMaterial({ color: 0x3a0806, roughness: 0.4, metalness: 0 }));
    ctx.scene.add(this.root);
    this.off.push(
      ctx.events.on('chargePlaced', (e) => this.add(e)),
      ctx.events.on('chargeRemoved', (e) => this.remove(e.id)),
    );
  }

  /** Number of markers shown (tests) */
  get count(): number {
    return this.markers.size;
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  private add(e: ChargeEvent): void {
    this.remove(e.id);
    const [L, , T] = BLOCK;
    // Frame: z = surface normal, x = long side (level: normal × up, else any in-plane axis).
    _n.copy(e.normal).normalize();
    _x.crossVectors(UP, _n);
    if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0).addScaledVector(_n, -_n.x);
    _x.normalize();
    _y.crossVectors(_n, _x);
    const group = new THREE.Group();
    group.name = `charge ${e.id}`;
    group.quaternion.setFromRotationMatrix(_m.makeBasis(_x, _y, _n));
    // The event point sits a few cm off the surface; put the block's back face on the surface.
    group.position.copy(e.position).addScaledVector(_n, T / 2 - 0.03);

    const block = new THREE.Mesh(this.blockGeo, this.blockMat);
    block.castShadow = true;
    block.receiveShadow = true;
    // Detonator: a thin metal cap pushed into one end, its wire box taped on the front face.
    const cap = new THREE.Mesh(this.capGeo, this.capMat);
    cap.rotation.z = Math.PI / 2;
    cap.position.set(L / 2 + 0.015, 0, 0);
    const box = new THREE.Mesh(this.boxGeo, this.boxMat);
    box.position.set(L / 2 - 0.03, 0, T / 2 + 0.01);
    box.castShadow = true;
    const led = new THREE.Mesh(this.ledGeo, this.ledOff);
    led.position.set(L / 2 - 0.03, 0.006, T / 2 + 0.021);
    group.add(block, cap, box, led);
    this.root.add(group);
    this.markers.set(e.id, { id: e.id, group, led, phase: (e.id * 0.37) % 1 });
  }

  private remove(id: number): void {
    const m = this.markers.get(id);
    if (!m) return;
    m.group.removeFromParent();
    this.markers.delete(id);
  }

  frameUpdate(_simDt: number, realDt: number): void {
    if (!this.markers.size) return;
    this.clock = (this.clock + realDt) % 3600;
    for (const m of this.markers.values()) {
      const on = ((this.clock / BLINK_S + m.phase) % 1) < BLINK_ON;
      m.led.material = on ? this.ledOn : this.ledOff;
    }
  }

  reset(): void {
    for (const id of [...this.markers.keys()]) this.remove(id);
  }

  dispose(): void {
    this.reset();
    for (const off of this.off) off();
    this.off.length = 0;
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
