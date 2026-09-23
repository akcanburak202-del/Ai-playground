/**
 * Fold the single-chunk build (`vite build --mode single`) into one self-contained HTML file:
 * dist-single/index.html → dist-single/destruction.html with every script and stylesheet inlined.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const dir = resolve(import.meta.dirname, '../dist-single');
const indexPath = resolve(dir, 'index.html');
if (!existsSync(indexPath)) {
  console.error('dist-single/index.html not found — run `npx vite build --mode single` first');
  process.exit(1);
}
let html = readFileSync(indexPath, 'utf8');

html = html.replace(/<script\b([^>]*?)\ssrc="([^"]+)"([^>]*)><\/script>/g, (_m, pre: string, src: string, post: string) => {
  const code = readFileSync(resolve(dirname(indexPath), src), 'utf8').replace(/<\/script/gi, '<\\/script');
  const attrs = `${pre}${post}`.replace(/\scrossorigin(="[^"]*")?/g, '');
  return `<script${attrs}>${code}</script>`;
});
html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="(\.\/assets\/[^"]+)"[^>]*>/g, (_m, href: string) => {
  const css = readFileSync(resolve(dirname(indexPath), href), 'utf8');
  return `<style>${css}</style>`;
});
html = html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, '');

const out = resolve(dir, 'destruction.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB)`);
