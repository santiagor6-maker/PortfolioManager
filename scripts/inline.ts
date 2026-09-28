/** Folds <out>/assets/*.js|css into <out>/index.html so the app is a single file that opens from disk (file://). <out> defaults to dist. */
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

const out = process.argv[2] ?? 'dist';

let html = readFileSync(`${out}/index.html`, 'utf8');
html = html.replace(/<script type="module" crossorigin src="\.?\/?(assets\/[^"]+\.js)"><\/script>/g, (_m, f: string) => {
  const js = readFileSync(`${out}/${f}`, 'utf8').replaceAll('</script', '<\\/script');
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="\.?\/?(assets\/[^"]+\.css)">/g, (_m, f: string) => `<style>${readFileSync(`${out}/${f}`, 'utf8')}</style>`);
if (/src="\.?\/?assets\//.test(html) || /href="\.?\/?assets\//.test(html)) throw new Error(`Unresolved asset reference in ${out}/index.html`);
writeFileSync(`${out}/index.html`, html);

// Netlify headers: the inlined scripts are allowed by hash, nothing else runs. Fonts and the icon are data: URIs.
const hashes = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
// The published build may sync with Supabase (VITE_SUPABASE_URL): allow only that origin besides the site.
const supabase = process.env.VITE_SUPABASE_URL ? new URL(process.env.VITE_SUPABASE_URL).origin : '';
const csp = [
  "default-src 'none'",
  `script-src ${hashes.join(' ')}`,
  "style-src 'unsafe-inline'",
  'font-src data:',
  'img-src data: blob:',
  `connect-src 'self'${supabase ? ` ${supabase}` : ''}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
writeFileSync(`${out}/_headers`, `/*\n  Content-Security-Policy: ${csp}\n  X-Frame-Options: DENY\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n`);
rmSync(`${out}/assets`, { recursive: true, force: true });
console.log(`${out}/index.html: ${(html.length / 1024).toFixed(0)} KB, self-contained`);
