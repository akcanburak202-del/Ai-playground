import { defineConfig } from 'vite';
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Every sandbox/*.html page is a separate entry so module sandboxes build too.
const sandboxDir = resolve(import.meta.dirname, 'sandbox');
const sandboxes = existsSync(sandboxDir)
  ? Object.fromEntries(
      readdirSync(sandboxDir)
        .filter((f) => f.endsWith('.html'))
        .map((f) => [`sandbox/${f.replace(/\.html$/, '')}`, resolve(sandboxDir, f)]),
    )
  : {};

export default defineConfig(({ mode }) => {
  // `vite build --mode single`: only the app, as one JS chunk, so scripts/inline.ts can fold it into
  // a single self-contained HTML file (Rapier's WASM is already embedded in its JS as base64).
  const single = mode === 'single';
  return {
    base: './',
    server: { host: '127.0.0.1', port: 5173 },
    build: {
      target: 'es2022',
      outDir: single ? 'dist-single' : 'dist',
      chunkSizeWarningLimit: 6000,
      assetsInlineLimit: single ? 100_000_000 : 4096,
      rollupOptions: single
        ? { input: resolve(import.meta.dirname, 'index.html'), output: { inlineDynamicImports: true } }
        : { input: { main: resolve(import.meta.dirname, 'index.html'), ...sandboxes } },
    },
  };
});
