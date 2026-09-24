import { test } from 'node:test';
import assert from 'node:assert/strict';
import { damagedSection, sectionProps } from '../src/destructibles/steel/section.ts';

const cm2 = (v: number) => v * 1e-4;
const cm3 = (v: number) => v * 1e-6;
const cm4 = (v: number) => v * 1e-8;

function near(actual: number, expected: number, rel: number, what: string) {
  const err = Math.abs(actual - expected) / expected;
  assert.ok(err <= rel, `${what}: ${actual.toExponential(4)} vs ${expected.toExponential(4)} (${(err * 100).toFixed(2)} % > ${rel * 100} %)`);
}

test('HEB 300 matches EN 10365 table values', () => {
  const s = sectionProps({ type: 'I', h: 0.3, b: 0.3, tw: 0.011, tf: 0.019 });
  assert.equal(s.rootRadius, 0.027);
  near(s.A, cm2(149.1), 0.005, 'A');
  near(s.Iy, cm4(25170), 0.005, 'Iy (strong)');
  near(s.Zy, cm3(1869), 0.005, 'Wpl,y');
  near(s.Sy, cm3(1678), 0.005, 'Wel,y');
  near(s.Iz, cm4(8563), 0.005, 'Iz (weak)');
  near(s.Zz, cm3(870.1), 0.005, 'Wpl,z');
});

test('IPE 300 matches EN 10365 table values', () => {
  const s = sectionProps({ type: 'I', h: 0.3, b: 0.15, tw: 0.0071, tf: 0.0107 });
  assert.equal(s.rootRadius, 0.015);
  near(s.A, cm2(53.81), 0.005, 'A');
  near(s.Iy, cm4(8356), 0.005, 'Iy');
  near(s.Zy, cm3(628.4), 0.005, 'Wpl,y');
  near(s.Iz, cm4(603.8), 0.01, 'Iz');
  near(s.Zz, cm3(125.2), 0.01, 'Wpl,z');
});

test('CHS 219.1 × 10 matches EN 10210', () => {
  const s = sectionProps({ type: 'tube', d: 0.2191, t: 0.01 });
  near(s.A, cm2(65.7), 0.01, 'A');
  near(s.Iy, cm4(3598), 0.01, 'I');
  near(s.Iz, cm4(3598), 0.01, 'I (other axis)');
  near(s.Sy, cm3(328), 0.01, 'Wel');
  near(s.Zy, cm3(436), 0.01, 'Wpl');
});

test('SHS 200 × 10 (sharp corners) matches the closed form, and the rounded-corner table within 8 %', () => {
  const s = sectionProps({ type: 'box', h: 0.2, b: 0.2, t: 0.01 });
  near(s.A, 0.2 * 0.2 - 0.18 * 0.18, 1e-9, 'A');
  near(s.Iy, (0.2 ** 4 - 0.18 ** 4) / 12, 1e-9, 'I');
  near(s.Zy, (0.2 ** 3 - 0.18 ** 3) / 4, 1e-9, 'Wpl');
  near(s.Iy, cm4(4251), 0.08, 'I vs EN 10219 table (r = 1.5 t corners)');
});

test('cruciform: closed-form second moment and plastic modulus', () => {
  const arm = 0.1, t = 0.02;
  const s = sectionProps({ type: 'cruciform', arm, t });
  near(s.A, 4 * arm * t - t * t, 1e-9, 'A');
  near(s.Iy, (2 * arm * t ** 3 + t * (2 * arm) ** 3 - t ** 4) / 12, 1e-9, 'Iy');
  near(s.Iz, s.Iy, 1e-9, 'symmetric');
  near(s.Zy, (arm * t * t) / 2 + t * arm * arm - (t ** 3) / 4, 1e-9, 'Zy');
});

test('damage fractions scale the right plates', () => {
  const s = sectionProps({ type: 'I', h: 0.3, b: 0.3, tw: 0.011, tf: 0.019 });
  const intact = damagedSection(s, [1, 1, 1]);
  near(intact.A, s.A, 1e-12, 'intact A');
  // Lose the top flange completely: A drops by b·tf, strong-axis Z by the flange's lever arm share.
  const d = damagedSection(s, [0, 1, 1]);
  near(s.A - d.A, 0.3 * 0.019, 1e-9, 'A loss');
  near(s.Zy - d.Zy, 0.3 * 0.019 * (0.15 - 0.0095), 1e-9, 'Zy loss');
  assert.ok(d.Iy < 0.62 * s.Iy, 'strong-axis stiffness mostly gone');
});
