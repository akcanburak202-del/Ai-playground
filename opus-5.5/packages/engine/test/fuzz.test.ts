import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFuzz } from './fuzz/fuzz.ts';

// A quick differential run for CI; `npm run fuzz` runs the large campaign.
test('differential fuzzing against SQLite finds no mismatches', () => {
  let agreed = 0;
  for (let seed = 1000; seed < 1008; seed++) {
    const stats = runFuzz({ seed, queries: 150, dml: 15 });
    for (const m of stats.mismatches) {
      assert.fail(`seed ${seed}\n${m.sql}\n  opus  : ${m.opus}\n  sqlite: ${m.sqlite}`);
    }
    agreed += stats.agreed;
  }
  assert.ok(agreed > 1000, `only ${agreed} queries compared`);
});
