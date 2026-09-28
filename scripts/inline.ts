/** Folds dist/assets/*.js|css into dist/index.html so the app is a single file that opens from disk (file://). */
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

let html = readFileSync('dist/index.html', 'utf8');
html = html.replace(/<script type="module" crossorigin src="\.?\/?(assets\/[^"]+\.js)"><\/script>/g, (_m, f: string) => {
  const js = readFileSync(`dist/${f}`, 'utf8').replaceAll('</script', '<\\/script');
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="\.?\/?(assets\/[^"]+\.css)">/g, (_m, f: string) => `<style>${readFileSync(`dist/${f}`, 'utf8')}</style>`);
if (/src="\.?\/?assets\//.test(html) || /href="\.?\/?assets\//.test(html)) throw new Error('Unresolved asset reference in dist/index.html');
writeFileSync('dist/index.html', html);

// Netlify headers: the inlined scripts are allowed by hash, nothing else runs. Fonts and the icon are data: URIs.
const hashes = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
const csp = [
  "default-src 'none'",
  `script-src ${hashes.join(' ')}`,
  "style-src 'unsafe-inline'",
  'font-src data:',
  'img-src data: blob:',
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
writeFileSync('dist/_headers', `/*\n  Content-Security-Policy: ${csp}\n  X-Frame-Options: DENY\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n`);
rmSync('dist/assets', { recursive: true, force: true });
console.log(`dist/index.html: ${(html.length / 1024).toFixed(0)} KB, self-contained`);
