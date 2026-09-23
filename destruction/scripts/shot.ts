/**
 * Headless screenshots of any page in this package, for visual checks and scripted scenarios.
 *
 *   node scripts/shot.ts <page> [--out .shots/name.png] [--scenario file.mjs] [--size 1280x720] [--timeout 180]
 *
 * <page> is a path relative to the package root, e.g. `index.html?scene=chapel` or
 * `sandbox/voxel.html`. The script starts its own Vite dev server, opens the page in headless
 * Chromium (SwiftShader WebGL), waits for `window.__ready`, switches the simulation to manual
 * stepping, then either renders once and saves a PNG, or runs a scenario module:
 *
 *   export default async ({ page, run, shot, log }) => {
 *     await run(`__sim.fire({ ammo: 'm855', from: [0, 1.5, 12], at: [0, 1.5, 0], count: 60 })`);
 *     await shot('after-60');                 // renders a frame and writes <out-dir>/after-60.png
 *     log(await run(`__sim.impacts(3)`));
 *   };
 *
 * Browser console errors are echoed to stderr so failures are visible.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const pagePath = args.find((a) => !a.startsWith('--') && !isFlagValue(a));
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function isFlagValue(a: string): boolean {
  const i = args.indexOf(a);
  return i > 0 && args[i - 1]!.startsWith('--');
}
if (!pagePath) {
  console.error('usage: node scripts/shot.ts <page> [--out file.png] [--scenario file.mjs] [--size WxH] [--timeout s]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, flag('out') ?? `.shots/${basename(pagePath.split('?')[0]!).replace(/\.html$/, '')}.png`);
const outDir = dirname(out);
mkdirSync(outDir, { recursive: true });
const [w, h] = (flag('size') ?? '1280x720').split('x').map(Number) as [number, number];
const timeout = Number(flag('timeout') ?? 180) * 1000;
const scenarioPath = flag('scenario');

// A private dep-optimizer cache per run, so several screenshot runs can work side by side.
const cacheDir = resolve(root, `node_modules/.vite-shot-${process.pid}`);
const server = await createServer({ root, cacheDir, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const addr = server.httpServer!.address();
const port = typeof addr === 'object' && addr ? addr.port : 5173;
const url = `http://127.0.0.1:${port}/${pagePath}${pagePath.includes('?') ? '&' : '?'}manual`;

// Prefer the pre-installed Chromium (CHROMIUM_PATH or /opt/pw-browsers/chromium) over a Playwright download.
const exe = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox'],
});
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.error(`[browser ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    failed = true;
    console.error(`[pageerror] ${e.message}\n${e.stack ?? ''}`);
  });
  page.setDefaultTimeout(timeout);
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout });
  await page.evaluate(() => (window as unknown as { __sim: { setManual(b: boolean): void } }).__sim.setManual(true));

  const run = async (code: string) => page.evaluate(code);
  const shot = async (name: string) => {
    await page.evaluate(() => (window as unknown as { __sim: { render(): void } }).__sim.render());
    const file = resolve(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`saved ${file}`);
    return file;
  };
  const log = (...a: unknown[]) => console.log(...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))));

  if (scenarioPath) {
    const mod = await import(pathToFileURL(resolve(process.cwd(), scenarioPath)).href);
    await mod.default({ page, run, shot, log });
  } else {
    await page.evaluate(() => (window as unknown as { __sim: { render(): void } }).__sim.render());
    await page.screenshot({ path: out });
    console.log(`saved ${out}`);
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  await server.close();
  rmSync(cacheDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
