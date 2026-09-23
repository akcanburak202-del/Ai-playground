/**
 * Collects facts about the repository for the Studio's Benchmarks and About
 * views: lines of code per package, test counts, and the latest benchmark and
 * fuzzing results from docs/. Output: src/generated/stats.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = (p: string) => join(root, 'packages', p);

function walk(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'generated') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

function lines(files: string[]): number {
  let n = 0;
  for (const f of files) for (const l of readFileSync(f, 'utf8').split('\n')) if (l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)) n++;
  return n;
}

function countTests(files: string[]): number {
  let n = 0;
  for (const f of files) n += (readFileSync(f, 'utf8').match(/^\s*test\(/gm) ?? []).length;
  return n;
}

const readJson = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

const engineSrc = walk(pkg('engine/src'), ['.ts']);
const engineTests = walk(pkg('engine/test'), ['.ts']);
const serverSrc = walk(pkg('server/src'), ['.ts']);
const serverTests = walk(pkg('server/test'), ['.ts']);
const studioSrc = walk(pkg('studio/src'), ['.ts', '.tsx', '.css']);

const has = (f: string, ...parts: string[]) => parts.some((p) => f.includes(p));
const bySubsystem: Record<string, string[]> = {
  sql: engineSrc.filter((f) => has(f, '/sql/')),
  binder: engineSrc.filter((f) => has(f, '/plan/binder', '/plan/bound', '/plan/show')),
  planner: engineSrc.filter((f) => has(f, '/plan/planner')),
  exec: engineSrc.filter((f) => has(f, '/exec/')),
  btree: engineSrc.filter((f) => has(f, '/storage/btree', '/storage/page', '/storage/codec')),
  pager: engineSrc.filter((f) => has(f, '/storage/pager')),
  file: engineSrc.filter((f) => has(f, '/storage/file', 'src/node.ts')),
  api: engineSrc.filter((f) => !/\/(sql|plan|exec|storage)\//.test(f) && !f.endsWith('src/node.ts')),
};

const stats = {
  generatedAt: new Date().toISOString(),
  loc: {
    engine: lines(engineSrc),
    engineTests: lines(engineTests),
    server: lines(serverSrc),
    serverTests: lines(serverTests),
    studio: lines(studioSrc),
    subsystems: Object.entries(bySubsystem).map(([name, files]) => ({ name, lines: lines(files), files: files.length })),
  },
  tests: {
    engine: countTests(engineTests),
    server: countTests(serverTests),
  },
  runtimeDependencies: { engine: 0, server: 0 },
  benchMemory: readJson(join(root, 'docs/bench-memory.json')),
  benchFile: readJson(join(root, 'docs/bench-file.json')),
  fuzz: readJson(join(root, 'docs/fuzz.json')),
};

const out = join(root, 'packages/studio/src/generated/stats.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(stats, null, 2));
console.log(`stats: engine ${stats.loc.engine} lines, ${stats.tests.engine + stats.tests.server} tests -> ${out}`);
