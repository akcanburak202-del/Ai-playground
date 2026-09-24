import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fmtDeg, fmtDistance, fmtEnergy, fmtLength, fmtMass, fmtPressure, fmtScale, fmtSpeed, fmtTime, num } from '../src/ui/format.ts';
import { caliberTr, upperTr, NAME_TR, ROLE_TR } from '../src/ui/i18n.ts';
import { blastRow, describeImpact, impactRow, weaponSpecs } from '../src/ui/telemetry.ts';
import { buildSlots, stepWeapon, weaponForKey, slotOf } from '../src/player/slots.ts';
import { artKindFor } from '../src/ui/sceneArt.ts';
import { reticleFor, scopeFor } from '../src/ui/crosshair.ts';
import { WEAPONS } from '../src/weapons/arsenal.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';
import { MATERIALS } from '../src/physics/materials.ts';
import type { ImpactEvent } from '../src/physics/ballistics/types.ts';

const NNBSP = ' ';

test('Turkish number formatting: decimal comma, grouped thousands, units', () => {
  assert.equal(num(0.1, 2), '0,10');
  assert.equal(num(1555, 0), '1555');
  assert.equal(num(12345.6, 1), `12${NNBSP}345,6`);
  assert.equal(num(-3.25, 1), '−3,3'.replace('3,3', (3.25).toFixed(1).replace('.', ',')));
  assert.equal(num(NaN), '—');
  assert.equal(fmtSpeed(905.4), '905 m/s');
  assert.equal(fmtEnergy(1620), '1,62 kJ');
  assert.equal(fmtEnergy(6.9e6), '6,90 MJ');
  assert.equal(fmtEnergy(850), '850 J');
  assert.equal(fmtLength(0.0042), '4,2 mm');
  assert.equal(fmtLength(0.142), '142 mm');
  assert.equal(fmtLength(1.25), '1,25 m');
  assert.equal(fmtMass(0.00402), '4,02 g');
  assert.equal(fmtMass(5.7), '5,70 kg');
  assert.equal(fmtMass(874), '874 kg');
  assert.equal(fmtPressure(34_500), '34,5 kPa');
  assert.equal(fmtPressure(650), '650 Pa');
  assert.equal(fmtPressure(1.2e6), '1,20 MPa');
  assert.equal(fmtTime(0.058), '58 ms');
  assert.equal(fmtTime(1.24), '1,24 s');
  assert.equal(fmtDeg(Math.PI / 4), '45°');
  assert.equal(fmtScale(0.1), '×0,10');
  assert.equal(fmtDistance(7.73), '7,7 m');
  assert.equal(fmtDistance(1240), '1,24 km');
});

test('Turkish capitals and calibre typography', () => {
  assert.equal(upperTr('Mühimmat · isabet'), 'MÜHİMMAT · İSABET');
  assert.equal(caliberTr('7.62×51 mm NATO'), '7,62×51 mm NATO');
  assert.equal(caliberTr('12.7×99 mm (.50 BMG)'), '12,7×99 mm (.50 BMG)');
  assert.equal(caliberTr('demolition charge'), 'yıkım şarjı');
  for (const w of WEAPONS) assert.ok(ROLE_TR[w.id], `Turkish role for ${w.id}`);
  assert.ok(Object.keys(NAME_TR).every((id) => WEAPONS.some((w) => w.id === id)));
});

function impact(o: Partial<ImpactEvent>): ImpactEvent {
  const ammo = getAmmo('m855');
  return {
    time: 0, ammo, agent: 'projectile', point: new THREE.Vector3(), direction: new THREE.Vector3(0, 0, -1), normal: new THREE.Vector3(0, 0, 1),
    obliquity: 0.2, speed: 880, mass: ammo.mass, kineticEnergy: 1557, outcome: 'embed', depth: 0.031, residualSpeed: 0,
    craterRadius: 0.028, craterDepth: 0.022, tunnelRadius: 0.003, spallRadius: 0, spallDepth: 0, damageRadius: 0.1,
    energyAbsorbed: 1557, momentum: new THREE.Vector3(), material: MATERIALS.concrete, targetKind: 'voxel', summary: 'model line',
    ...o,
  };
}

test('impact rows carry the resolver numbers in Turkish', () => {
  const r = impactRow(impact({}));
  assert.equal(r.material, 'Beton C40/50');
  assert.equal(r.outcomeTr, 'Delmedi');
  assert.equal(r.speed, '880 m/s');
  assert.equal(r.obliquity, '11°');
  assert.equal(r.depth, '31 mm');
  assert.equal(r.energy, '1,56 kJ');
  assert.equal(r.model, 'model line');
  assert.match(r.description, /^Krater Ø56 mm × 22 mm/);
  const p = impactRow(impact({ outcome: 'perforate', material: MATERIALS.steel_s355, residualSpeed: 610, tunnelRadius: 0.0029 }));
  assert.equal(p.outcomeTr, 'Deldi');
  assert.match(p.description, /Levhayı deldi · delik Ø5,8 mm · kalıntı hız 610 m\/s/);
  assert.match(describeImpact(impact({ outcome: 'ricochet', residualSpeed: 500 })), /^Sekti/);
  assert.match(describeImpact(impact({ outcome: 'shatter', material: MATERIALS.rha })), /parçalandı/);
  assert.match(describeImpact(impact({ agent: 'jet', outcome: 'perforate' })), /Oyuk dolgu jeti/);
});

test('blast readout uses Kingery–Bulmash at the viewer', () => {
  // 1 kg TNT surface burst, 5 m: incident ≈ 43 kPa (UFC 3-340-02 fig. 2-15; the 70 kPa in
  // DESIGN.md is the reflected value), arrival ≈ 8–9 ms.
  const row = blastRow({ center: new THREE.Vector3(0, 0, 0), tntKg: 1, kind: 'he', normal: new THREE.Vector3(0, 1, 0) }, new THREE.Vector3(5, 0, 0));
  assert.ok(row.ps > 43e3 * 0.8 && row.ps < 43e3 * 1.2, `ps ${row.ps}`);
  assert.ok(row.ta > 6e-3 && row.ta < 11e-3, `ta ${row.ta}`);
  assert.ok(row.warn, 'above the eardrum threshold');
  const far = blastRow({ center: new THREE.Vector3(0, 0, 0), tntKg: 1, kind: 'he', normal: new THREE.Vector3(0, 1, 0) }, new THREE.Vector3(200, 0, 0));
  assert.ok(!far.warn && far.ps < 1000);
  assert.equal(row.tnt, '1,00 kg');
});

test('weapon specifications: muzzle energy ½mv², HEAT RHA, TNT equivalent', () => {
  const m4 = WEAPONS.find((w) => w.id === 'm4a1')!;
  const s = weaponSpecs(m4, getAmmo('m855'));
  const E = 0.5 * getAmmo('m855').mass * getAmmo('m855').muzzleVelocity ** 2;
  assert.equal(s.find((x) => x.label === 'Namlu enerjisi')!.value, fmtEnergy(E));
  const rpg = WEAPONS.find((w) => w.id === 'rpg7')!;
  const r = weaponSpecs(rpg, getAmmo('pg7vl'));
  assert.equal(r.find((x) => x.label === 'Delme (RHA)')!.value, '500 mm');
  assert.equal(r.find((x) => x.label === 'TNT eşdeğeri')!.value, '1,20 kg');
  const arty = WEAPONS.find((w) => w.id === 'm777')!;
  assert.ok(weaponSpecs(arty, getAmmo('m795')).some((x) => x.label === 'Çarpma hızı'));
  for (const w of WEAPONS) for (const a of w.ammo) for (const x of weaponSpecs(w, getAmmo(a))) assert.ok(!x.value.includes('NaN') && x.value !== '—', `${w.id}/${a} ${x.label}`);
});

test('weapon slots: grouped by category, keys cycle within a group', () => {
  const slots = buildSlots(WEAPONS);
  assert.deepEqual(slots.map((s) => s.category), ['rifle', 'mg', 'sniper', 'launcher', 'cannon', 'artillery', 'airstrike', 'demolition']);
  assert.equal(slots.reduce((n, s) => n + s.weapons.length, 0), WEAPONS.length);
  assert.equal(weaponForKey(slots, 2, 'm4a1'), 'm249');
  assert.equal(weaponForKey(slots, 2, 'm249'), 'm240b');
  const mgs = slots[1]!.weapons;
  assert.equal(weaponForKey(slots, 2, mgs[mgs.length - 1]!.id), 'm249');
  assert.equal(weaponForKey(slots, 9, 'm4a1'), null);
  assert.equal(stepWeapon(slots, 'm4a1', -1), 'demo');
  assert.equal(stepWeapon(slots, 'demo', 1), 'm4a1');
  assert.equal(slotOf(slots, 'javelin')!.key, 4);
});

test('reticles, scopes and scene drawings are chosen sensibly', () => {
  const get = (id: string) => WEAPONS.find((w) => w.id === id)!;
  assert.equal(reticleFor(get('m4a1')), 'cross');
  assert.equal(reticleFor(get('m107')), 'mildot');
  assert.equal(reticleFor(get('tankgun')), 'chevron');
  assert.equal(reticleFor(get('gau8')), 'pipper');
  assert.equal(reticleFor(get('m777')), 'box');
  assert.equal(reticleFor(get('demo')), 'charge');
  assert.equal(scopeFor(get('m107')), 'rifle');
  assert.equal(scopeFor(get('javelin')), 'clu');
  assert.equal(scopeFor(get('m4a1')), null);
  assert.equal(artKindFor('chapel'), 'chapel');
  assert.equal(artKindFor('x', 'Barcelona pavilion'), 'pavilion');
  assert.equal(artKindFor('doric-temple'), 'temple');
  assert.equal(artKindFor('glass-tower'), 'tower');
  assert.equal(artKindFor('proving-ground'), 'proving');
  assert.equal(artKindFor('something'), 'generic');
});
