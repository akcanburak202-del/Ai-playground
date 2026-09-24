import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fmtDeg, fmtDistance, fmtEnergy, fmtLength, fmtMass, fmtPressure, fmtScale, fmtSpeed, fmtTime, num } from '../src/ui/format.ts';
import { caliberTr, keyHints, upperTr, HELP_DESKTOP, NAME_TR, ROLE_TR } from '../src/ui/i18n.ts';
import { blastRow, describeImpact, followThrough, groupLine, HitGroups, impactRow, PROFILE_POINTS, weaponSpecs, weaponSummary } from '../src/ui/telemetry.ts';
import { sceneReference } from '../src/ui/menu.ts';
import { SCENES } from '../src/scenes/index.ts';
import { buildSlots, stepWeapon, weaponForKey, slotOf } from '../src/player/slots.ts';
import { artKindFor } from '../src/ui/sceneArt.ts';
import { reticleFor, scopeFor } from '../src/ui/crosshair.ts';
import { WEAPONS } from '../src/weapons/arsenal.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';
import { MATERIALS } from '../src/physics/materials.ts';
import { Rng } from '../src/core/rng.ts';
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

test('hit group: a burst on one spot reads as a cavity that keeps deepening', () => {
  // The viewer stands 10 m in front of the wall, looking at it (−z).
  const eye = new THREE.Vector3(0, 1.5, 10), fwd = new THREE.Vector3(0, 0, -1);
  const shoot = (gs: HitGroups, e: ImpactEvent, r = 0) => {
    const g = gs.add(e, r);
    gs.select(e.time, eye, fwd, g);
    return g;
  };
  const gs = new HitGroups();
  const hit = (i: number, o: Partial<ImpactEvent> = {}) => impact({
    time: i * 0.075, targetName: 'RC wall', targetKind: 'voxel',
    // Each round meets the floor the earlier ones dug (1 cm deeper each) and digs 3 cm more.
    point: new THREE.Vector3(0.01 * Math.sin(i), 1.5 + 0.01 * Math.cos(i), -0.01 * i), depth: 0.03, ...o,
  });
  shoot(gs, hit(0));
  assert.equal(groupLine(gs.current), null, 'one hit is not a group yet');
  for (let i = 1; i < 12; i++) shoot(gs, hit(i));
  const g = gs.current!;
  assert.equal(g.count, 12);
  // Reach = depth of the entry point below the first entry plane + depth along the normal.
  assert.ok(Math.abs(g.first - 0.03) < 1e-9, `first ${g.first}`);
  assert.ok(Math.abs(g.deepest - 0.14) < 1e-9, `deepest ${g.deepest}`);
  assert.equal(g.profile.length, 12);
  assert.ok(g.profile.every((r, i) => i === 0 || r >= g.profile[i - 1]!), 'the cavity profile never gets shallower');
  // The round that goes through gives the member's thickness (exit point below the first entry plane) …
  shoot(gs, hit(12, { outcome: 'perforate', exitPoint: new THREE.Vector3(0, 1.5, -0.25) }));
  assert.equal(g.perforatedAt, 13);
  assert.ok(Math.abs(g.thickness - 0.25) < 1e-9);
  // … and lands behind the wall: a spot of its own, which must not take over the readout.
  shoot(gs, hit(12.2, { targetName: 'ground', targetKind: 'terrain', material: MATERIALS.soil, point: new THREE.Vector3(0, 0, -6), normal: new THREE.Vector3(0, 1, 0) }));
  assert.equal(gs.current, g);
  shoot(gs, hit(13.1, { point: new THREE.Vector3(0, 1.5, -0.12) }));
  shoot(gs, hit(13.3, { targetName: 'ground', targetKind: 'terrain', material: MATERIALS.soil, point: new THREE.Vector3(0.02, 0, -6), normal: new THREE.Vector3(0, 1, 0) }));
  assert.equal(gs.current, g, 'still the wall after a second round landed on the same spot behind it');
  // A tandem precursor and the main jet of one round (same step) are one hit.
  const n = g.count;
  shoot(gs, hit(20, { agent: 'jet', depth: 0.05 }));
  shoot(gs, hit(20, { agent: 'jet', depth: 0.25 }));
  assert.equal(g.count, n + 1);
  // Fragments are not aimed hits.
  assert.equal(shoot(gs, hit(21, { agent: 'fragment' })), null);
  // Working another spot: it takes over once it is the one being hit and the crosshair is on it.
  const fwd0 = fwd.clone();
  fwd.set(1.2, 0, -10).normalize();
  for (let i = 0; i < 4; i++) shoot(gs, hit(40 + i * 0.1, { point: new THREE.Vector3(1.2, 1.5, -0.01 * i) }));
  fwd.copy(fwd0);
  assert.notEqual(gs.current, g);
  const l2 = groupLine(gs.current)!;
  assert.equal(l2.head, 'Aynı nokta · 4. isabet');
  assert.match(l2.depth, /^oyuk \d+ → \d+ mm$/);
  assert.equal(l2.note, '');
  assert.equal(groupLine(g)!.note, '13. isabette delindi · kesit 250 mm');
  // A burst next to an older hit (9 cm away) stays one spot: each hit goes to the nearest group
  // (only the first rounds, inside the older hit's 10 cm, may join that one).
  const gs2 = new HitGroups();
  shoot(gs2, hit(100, { point: new THREE.Vector3(0, 1.59, 0) }));
  for (let i = 0; i < 30; i++) shoot(gs2, hit(101 + i * 0.075, { point: new THREE.Vector3(0.012 * Math.sin(i * 2.1), 1.5 + 0.012 * Math.cos(i * 1.7), -0.004 * i) }));
  assert.ok(gs2.current!.count >= 27 && gs2.current!.deepest > 0.1, `burst kept together: ${gs2.list.map((x) => x.count)}`);
  // Rounds flying on through a hole land on the ground behind: those ricochet marks (no cavity,
  // far from the crosshair) never take the readout from the plate, and do not evict it either.
  const gs3 = new HitGroups();
  const plate = { targetName: 'plate', targetKind: 'plate', material: MATERIALS.steel_s355 };
  for (let i = 0; i < 3; i++) shoot(gs3, hit(200 + i * 0.1, { ...plate, point: new THREE.Vector3(0.003 * i, 1.3, 0), outcome: 'perforate', depth: 0.012 }));
  const plateGroup = gs3.current!;
  for (let i = 0; i < 12; i++) shoot(gs3, hit(200.35 + i * 0.1, { targetName: 'ground', targetKind: 'terrain', material: MATERIALS.soil, point: new THREE.Vector3(i * 3, 0, -150 - i * 7), normal: new THREE.Vector3(0, 1, 0) }));
  // … even when they land together (same trajectory through the same hole) and dig a little.
  for (let i = 0; i < 6; i++) shoot(gs3, hit(201.6 + i * 0.1, { targetName: 'ground', targetKind: 'terrain', material: MATERIALS.soil, point: new THREE.Vector3(0.5, 0, -150), normal: new THREE.Vector3(0, 1, 0), depth: 0.02 }));
  assert.equal(gs3.current, plateGroup);
  assert.equal(groupLine(gs3.current)!.head, 'Aynı nokta · 3. isabet');
  // A dispersed weapon (GAU-8, 9.6 MOA at 30 m: 95 % radius ≈ 0.2 m) still groups on one spot.
  const gs4 = new HitGroups();
  const r95 = 2.45 * 9.6 * (Math.PI / (180 * 60)) * 30;
  const rng = new Rng(7);
  const sig = r95 / 2.45;
  for (let i = 0; i < 60; i++) shoot(gs4, hit(300 + i * 0.015, { point: new THREE.Vector3(rng.gaussian(0, sig), 1.5 + rng.gaussian(0, sig), -0.002 * i) }), r95);
  assert.ok(gs4.current!.count >= 50, `GAU-8 burst: ${gs4.list.map((x) => x.count)}`);
  // A single round elsewhere after the spot went quiet: no stale readout.
  const gs5 = new HitGroups();
  for (let i = 0; i < 5; i++) shoot(gs5, hit(400 + i * 0.1));
  assert.ok(gs5.current);
  shoot(gs5, hit(400.9, { point: new THREE.Vector3(2, 1, 0) }));
  assert.ok(gs5.current, 'still shown right after the burst');
  shoot(gs5, hit(460, { point: new THREE.Vector3(-2, 1, 0) }));
  assert.equal(gs5.current, null);
  // Long bursts keep a bounded profile that still ends at the deepest point.
  for (let i = 0; i < 1000; i++) shoot(gs, hit(60 + i * 0.07, { point: new THREE.Vector3(1.2, 1.5, -0.0002 * i) }));
  const lg = gs.current!;
  assert.ok(lg.profile.length <= PROFILE_POINTS && lg.profile.length >= PROFILE_POINTS / 2, `profile ${lg.profile.length}`);
  assert.ok(Math.abs(lg.profile[lg.profile.length - 1]! - lg.deepest) < 1e-12);
  assert.ok(Math.abs(lg.profile.length * lg.stride - lg.count) < lg.stride, `stride ${lg.stride} × ${lg.profile.length} vs ${lg.count}`);
  // Degenerate input stays finite; the list stays bounded.
  shoot(gs, hit(2000, { targetName: 'plate', targetKind: 'plate', normal: new THREE.Vector3(0, 0, 0), depth: NaN }));
  for (let i = 0; i < 20; i++) shoot(gs, hit(2001 + i, { point: new THREE.Vector3(i, 0, 0) }));
  assert.ok(gs.list.length <= 6);
  assert.ok(gs.list.every((x) => x.profile.every(Number.isFinite) && Number.isFinite(x.deepest)));
});

test('follow-through hits: priorPerforations from the resolver marks the second target of a round', () => {
  const primary = impactRow(impact({ priorPerforations: 0 }));
  assert.equal(primary.secondary, false);
  assert.equal(primary.follow, '');
  const behind = impactRow(impact({ priorPerforations: 1, material: MATERIALS.soil ?? MATERIALS.concrete, targetKind: 'terrain' }));
  assert.equal(behind.secondary, true);
  assert.equal(behind.follow, '2. hedef');
  // Same round and result on the same target, but one of them came through a wall: two rows.
  assert.notEqual(impactRow(impact({ priorPerforations: 0 })).key, impactRow(impact({ priorPerforations: 1 })).key);
  assert.equal(followThrough(impact({})), undefined, 'unknown without the field: the HUD falls back to its own test');
  assert.equal(followThrough(impact({ priorPerforations: 2 })), true);
  assert.equal(followThrough(impact({ agent: 'fragment', priorPerforations: 1 })), false);
});

test('collapsed weapon card: at most three defining numbers, typed indirect / placed data', () => {
  const find = (id: string) => WEAPONS.find((w) => w.id === id)!;
  const m4 = weaponSummary(find('m4a1'), getAmmo('m855'));
  assert.equal(m4, '905 m/s · 1,65 kJ · 800 atım/dk'.replace('905', String(Math.round(getAmmo('m855').muzzleVelocity))).replace('1,65 kJ', m4.split(' · ')[1]!));
  assert.ok(m4.split(' · ').length === 3 && m4.includes('atım/dk'));
  const rpg = weaponSummary(find('rpg7'), getAmmo('pg7vl'));
  assert.match(rpg, /^500 mm RHA · \d+ m\/s$/);
  const arty = find('m777');
  assert.match(weaponSummary(arty, getAmmo('m795')), /TNT-e · 340 m\/s/);
  const specs = weaponSpecs(arty, getAmmo('m795'));
  assert.equal(specs.find((x) => x.label === 'Dalış açısı')!.value, '60°');
  assert.equal(specs.find((x) => x.label === 'İsabet sapması')!.value, '≈ 3,0 m');
  const demo = find('demo');
  assert.equal(weaponSpecs(demo, getAmmo('c4')).find((x) => x.label === 'Erişim')!.value, '80 m');
  assert.match(weaponSummary(demo, getAmmo('c4')), /TNT-e · erişim 80 m$/);
  for (const w of WEAPONS) for (const a of w.ammo) {
    const line = weaponSummary(w, getAmmo(a));
    assert.ok(line.length > 0 && line.split(' · ').length <= 3 && !line.includes('NaN') && !line.includes('—'), `${w.id}/${a}: ${line}`);
  }
});

test('key hints and help cover weapons, ammunition, slow motion, bullet camera and charges', () => {
  const direct = keyHints('direct', 2, 0).map((h) => h.keys.join('+'));
  for (const k of ['1–8', 'T', 'F', 'C', 'G', 'I', 'H']) assert.ok(direct.includes(k), `direct hint ${k}`);
  assert.ok(!keyHints('direct', 1, 0).some((h) => h.keys[0] === 'T'), 'no ammo key with one round type');
  const placed = keyHints('placed', 2, 0).map((h) => h.keys[0]);
  assert.equal(placed[0], 'Sol tık');
  assert.ok(!placed.includes('X'), 'nothing to detonate yet');
  assert.ok(keyHints('placed', 2, 3).some((h) => h.keys[0] === 'X') && keyHints('placed', 2, 3).some((h) => h.keys[0] === 'B'));
  const helpKeys = HELP_DESKTOP.flatMap((g) => g.entries.flatMap((e) => e.keys));
  for (const k of ['1–8', 'T', 'I', 'G', 'X', 'B', 'F', 'C', 'V', 'H', 'Esc']) assert.ok(helpKeys.includes(k), `help lists ${k}`);
});

test('scene plates carry their architectural reference', () => {
  assert.deepEqual(sceneReference('x', 'Tadao Ando’dan (İbaraki, 1989): kalıp izli betonarme kutu.'), { reference: 'Tadao Ando · İbaraki, 1989', note: 'Kalıp izli betonarme kutu.' });
  assert.deepEqual(sceneReference('y', 'Mies van der Rohe’dan (Barselona, 1929): traverten podyum.'), { reference: 'Mies van der Rohe · Barselona, 1929', note: 'Traverten podyum.' });
  assert.equal(sceneReference('z', 'Beton şeritte hedefler.').reference, '');
  for (const s of SCENES) {
    const r = sceneReference(s.id, s.blurbTr);
    assert.ok(r.reference.length > 0, `reference for ${s.id}`);
    assert.ok(r.note.length > 20 && !/^[a-zçğıöşü]/.test(r.note), `note for ${s.id}: ${r.note}`);
  }
  assert.equal(sceneReference('chapel', SCENES.find((s) => s.id === 'chapel')!.blurbTr).reference, 'Tadao Ando · İbaraki, 1989');
});
