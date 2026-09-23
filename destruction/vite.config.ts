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

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), ...sandboxes } },
  },
});
