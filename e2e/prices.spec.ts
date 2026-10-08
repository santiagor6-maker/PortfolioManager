import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';

const shots = process.env.SHOTS_DIR;

// The published site: dist/index.html over http with its CSP, so /api/quotes is same-origin as on Netlify.
let server: Server;
let origin = '';
test.beforeAll(async () => {
  const headers = Object.fromEntries(
    readFileSync('dist/_headers', 'utf8').split('\n').slice(1).filter(Boolean).map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  const html = readFileSync('dist/index.html');
  server = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      res.writeHead(502).end(); // replaced per test by page.route
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', ...headers });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(() => server.close());

async function loadDemo(page: Page, url: string) {
  await page.goto(url);
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('investment-tracker'); q.onsuccess = q.onerror = q.onblocked = r; }));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await expect(page.locator('.hero .kicker')).toHaveText('Valor del portafolio');
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
const day = (d: string) => Date.parse(`${d}T13:30:00Z`) / 1000;

test('Traer precios del cierre: the missing closes come in from Yahoo and the TRM, a failure stays apart', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (/Content Security Policy/.test(m.text())) errors.push(m.text());
  });
  const asked: string[] = [];
  // The site's function, as it relays Yahoo (the demo's tickers are fictional).
  await page.route(`${origin}/api/quotes**`, (route) => {
    const s = new URL(route.request().url()).searchParams.getAll('s');
    asked.push(...s);
    const out: Record<string, unknown> = {};
    for (const x of s) {
      const sym = x.split('@')[0]!;
      out[sym] =
        sym === 'ACME'
          ? { error: 'Yahoo Finance no tiene datos de ACME (404).' }
          : { currency: sym === 'ANDES' ? 'COP' : 'USD', timestamps: [day('2025-07-09'), day('2025-07-10')], close: sym === 'ANDES' ? [13600, 13650] : [110.1, 110.85] };
    }
    return json(route, out);
  });
  await page.route('https://www.datos.gov.co/**', (route) =>
    json(route, [{ valor: '4350.1', unidad: 'COP', vigenciadesde: '2025-07-09T00:00:00.000', vigenciahasta: '2025-07-09T00:00:00.000' }]),
  );

  await loadDemo(page, `${origin}/`);
  await page.getByRole('link', { name: 'Datos' }).click();
  const card = page.locator('.refresh-card');
  await expect(card.getByRole('heading', { name: 'Precios del cierre' })).toBeVisible();
  await expect(card).toContainText('Faltan por actualizar 4 series.');
  // The demo's index has no known source: listed with why, never guessed.
  await card.locator('summary', { hasText: 'no se puede traer sola' }).click();
  await expect(card.getByText(/Índice demo \(retorno total\) \(BENCH:DEMO-TR\): La app no sabe de dónde sale este índice/)).toBeVisible();

  await card.getByRole('button', { name: 'Traer precios del cierre' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Se agregaron' })).toHaveText(
    'Se agregaron 4 precios hasta el 10 jul 2025 y 1 tasa hasta el 9 jul 2025. 1 serie falló y queda como estaba: Acme Industries (ACME).',
    { timeout: 10_000 },
  );  expect(asked.sort()).toEqual(['ACME@2025-07-08', 'ANDES@2025-07-08', 'SMPL@2025-07-08']);
  await card.locator('summary', { hasText: 'Ver el detalle' }).click();
  await expect(card.getByRole('row').filter({ hasText: 'Acme Industries' })).toContainText('no tiene datos de ACME');
  await expect(card.getByRole('row').filter({ hasText: 'TRM (COP)' })).toContainText('9 jul 2025');
  // The status table reflects the new data.
  await expect(page.getByRole('row').filter({ hasText: 'Andes Energía SA' }).last()).toContainText('10 jul 2025');
  await expect(page.getByText(/TRM hasta 9 jul 2025/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/precios-cierre-${info.project.name}.png`, fullPage: true });

  // The month close offers the same button while a month lacks prices.
  await page.getByRole('link', { name: 'Cierre del mes' }).click();
  await expect(page.locator('.refresh-card.compact').getByRole('button', { name: 'Traer precios del cierre' })).toBeVisible();

  const stored = await page.evaluate(() => new Promise<string>((r) => {
    const q = indexedDB.open('investment-tracker');
    q.onsuccess = () => {
      const g = q.result.transaction('kv').objectStore('kv').get('dataset');
      g.onsuccess = () => r(JSON.stringify(g.result));
    };
  }));
  expect(stored).toContain('{"symbol":"ANDES","date":"2025-07-10","close":"13650","ccy":"COP","source":"yahoo"}');
  expect(errors).toEqual([]);
});

test('opened from disk, the button says it works on the published site', async ({ page }) => {
  await loadDemo(page, '');
  await page.getByRole('link', { name: 'Datos' }).click();
  await expect(page.locator('.refresh-card')).toContainText('funciona en la versión publicada');
  await expect(page.locator('.refresh-card').getByRole('button', { name: 'Traer precios del cierre' })).toHaveCount(0);
});

test('Fundamentales de la SEC: read on opening the published app, shown with their source, and a stock the SEC does not list says so', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (/Content Security Policy/.test(m.text())) errors.push(m.text());
  });
  const M = 1e6;
  const f = (start: string | undefined, end: string, val: number, form = '10-Q') => ({ ...(start ? { start } : {}), end, val, form, filed: form === '10-K' ? '2026-02-10' : '2026-07-30', accn: '0000000001-26-000002' });
  const flow = (fy: number, h1: number, h0: number) => [f('2025-01-01', '2025-12-31', fy, '10-K'), f('2026-01-01', '2026-06-30', h1), f('2025-01-01', '2025-06-30', h0)];
  const asked: string[] = [];
  // The site's function, as it relays the SEC (the demo's companies are fictional).
  await page.route(`${origin}/api/fundamentals**`, (route) => {
    const t = new URL(route.request().url()).searchParams.getAll('t');
    asked.push(...t);
    const out: Record<string, unknown> = {};
    for (const x of t) {
      out[x] =
        x === 'SMPL'
          ? {
              cik: 1,
              entity: 'Sample Corp',
              facts: {
                'us-gaap': {
                  Revenues: { USD: [...flow(1000 * M, 600 * M, 500 * M), f('2020-01-01', '2020-12-31', 500 * M, '10-K')] },
                  OperatingIncomeLoss: { USD: flow(200 * M, 130 * M, 100 * M) },
                  DepreciationDepletionAndAmortization: { USD: flow(50 * M, 30 * M, 25 * M) },
                  NetIncomeLoss: { USD: flow(150 * M, 90 * M, 80 * M) },
                  EarningsPerShareDiluted: { 'USD/shares': flow(1.5, 0.9, 0.8) },
                },
              },
            }
          : { error: `La SEC no tiene una empresa con el símbolo ${x} (los ETF y las acciones que no cotizan en EE. UU. no están).` };
    }
    return json(route, out);
  });
  await page.route(`${origin}/api/quotes**`, (route) => json(route, {}));

  await loadDemo(page, `${origin}/`);
  await page.getByRole('link', { name: 'Tesis', exact: true }).click();
  await page.getByRole('button', { name: 'Fundamentales' }).click();
  const card = page.locator('.sec-card');
  await expect(card.getByRole('status').filter({ hasText: 'Fundamentales actualizados' })).toContainText('Fundamentales actualizados: 2 acciones, sin cambios en las cifras.', { timeout: 10_000 });
  expect(asked.sort()).toEqual(['ACME', 'SMPL']);
  await expect(card).toContainText('2 de 2 acciones, leídos el');

  // Net margin 160 / 1100, with its source on hover; what the filings lack stays missing, with why.
  const row = page.getByRole('row').filter({ hasText: 'Sample Corp' });
  await expect(row.locator('td[title^="SEC · 10-Q 12 meses al 30 jun 2026"]').first()).toBeVisible();
  await expect(row).toContainText('14,5');
  await expect(row).toContainText('SEC · 30 jun 2026');
  await expect(row.locator('td[title*="SEC: no reporta su deuda"]').first()).toBeVisible();
  await card.locator('summary', { hasText: 'De dónde sale cada cifra' }).click();
  await expect(card.getByRole('row').filter({ hasText: 'Acme Industries' })).toContainText('no tiene una empresa con el símbolo ACME');
  await expect(card.getByRole('link', { name: /10-Q presentado el 30 jul 2026/ })).toHaveAttribute('href', 'https://www.sec.gov/Archives/edgar/data/1/000000000126000002/');
  if (shots) await page.screenshot({ path: `${shots}/sec-${info.project.name}.png`, fullPage: true });

  // Read again this month: only on request, and it lists nothing new.
  await card.getByRole('button', { name: 'Actualizar ahora' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Fundamentales actualizados' })).toContainText('sin cambios en las cifras');
  expect(asked).toHaveLength(4);
  expect(errors).toEqual([]);
});
