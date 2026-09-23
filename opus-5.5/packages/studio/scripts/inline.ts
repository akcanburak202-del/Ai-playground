/**
 * Post-build step: produces dist/opusdb-studio.html, a single self-contained
 * file (CSS and JS inlined, no <html>/<head>/<body> wrapper) suitable for
 * publishing as a claude.ai Artifact. dist/index.html stays as-is for the
 * OpusDB server to host.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '../dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');

const cssHref = /<link rel="stylesheet"[^>]*href="\.?\/?(assets\/[^"]+\.css)"[^>]*>/.exec(html)?.[1];
const jsSrc = /<script type="module"[^>]*src="\.?\/?(assets\/[^"]+\.js)"[^>]*><\/script>/.exec(html)?.[1];
if (!cssHref || !jsSrc) throw new Error('could not find the built CSS/JS in dist/index.html');

const css = readFileSync(join(dist, cssHref), 'utf8');
const js = readFileSync(join(dist, jsSrc), 'utf8').replace(/<\/script/gi, '<\\/script');
const fonts = [...html.matchAll(/<link rel="(?:preconnect|stylesheet)" href="https:\/\/fonts[^>]*>/g)].map((m) => m[0]).join('\n');

const page = `<title>OpusDB Studio</title>
${fonts}
<style>
${css}
</style>
<div id="root"></div>
<script type="module">
${js}
</script>
`;
writeFileSync(join(dist, 'opusdb-studio.html'), page);
console.log(`artifact page: dist/opusdb-studio.html (${Math.round(page.length / 1024)} KiB)`);
