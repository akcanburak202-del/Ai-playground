/**
 * CLI for the differential fuzzer.
 *
 *   node test/fuzz/run.ts [--seeds 50] [--queries 400] [--dml 40] [--start 1] [--verbose]
 */
import { runFuzz } from './fuzz.ts';
import type { Mismatch } from './fuzz.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const seeds = opt('seeds', 50);
const queries = opt('queries', 400);
const dml = opt('dml', 40);
const start = opt('start', 1);
const verbose = args.includes('--verbose');
const json = args.includes('--json');

let total = 0;
let agreed = 0;
let bothErrored = 0;
let rows = 0;
const mismatches: Mismatch[] = [];
const sqliteBugs: Mismatch[] = [];
const features: Record<string, number> = {};
const t0 = performance.now();
for (let s = start; s < start + seeds; s++) {
  const stats = runFuzz({ seed: s, queries, dml });
  total += stats.queries;
  agreed += stats.agreed;
  bothErrored += stats.bothErrored;
  rows += stats.rowsCompared;
  for (const [k, v] of Object.entries(stats.features)) features[k] = (features[k] ?? 0) + v;
  mismatches.push(...stats.mismatches);
  sqliteBugs.push(...stats.sqliteBugs);
  if (verbose) console.log(`seed ${s}: ${stats.agreed}/${stats.queries} agreed, ${stats.mismatches.length} mismatches`);
}
const ms = performance.now() - t0;
const compared = total - bothErrored;
const summary = {
  seeds,
  queries: total,
  compared,
  agreed,
  bothErrored,
  mismatches: mismatches.length,
  sqliteInconsistencies: sqliteBugs.length,
  agreement: compared ? agreed / compared : 1,
  rowsCompared: rows,
  seconds: Math.round(ms / 100) / 10,
  features,
};
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`\nDifferential fuzzing vs SQLite: ${agreed}/${compared} queries agreed (${(summary.agreement * 100).toFixed(2)}%)`);
  console.log(`  ${total} queries over ${seeds} random schemas, ${rows} result rows compared, ${bothErrored} rejected by both, ${summary.seconds}s`);
  if (sqliteBugs.length) console.log(`  ${sqliteBugs.length} queries where SQLite's answer changed with/without indexes; OpusDB matched the index-free answer`);
  console.log(`  features: ${Object.entries(features).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}
if (args.includes('--show-sqlite-bugs')) {
  for (const m of sqliteBugs.slice(0, 5)) {
    console.log('\n--- SQLITE INCONSISTENCY (seed ' + m.seed + ')');
    console.log(m.sql);
    console.log('  opus / sqlite without indexes:', m.opus);
    console.log('  sqlite with indexes          :', m.sqlite);
  }
}
for (const m of mismatches.slice(0, verbose ? 50 : 8)) {
  console.log('\n--- MISMATCH (seed ' + m.seed + ')');
  console.log(m.sql);
  console.log('  opus  :', m.opus);
  console.log('  sqlite:', m.sqlite);
}
process.exitCode = mismatches.length ? 1 : 0;
