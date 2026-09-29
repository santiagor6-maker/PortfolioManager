import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const shots = process.env.SHOTS_DIR;

async function loadDemo(page: Page) {
  await page.goto('');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('investment-tracker'); q.onsuccess = q.onerror = q.onblocked = r; }));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await expect(page.locator('.hero .kicker')).toHaveText('Valor del portafolio');
}

const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, headers: cors, body: JSON.stringify(body) });

test('Actualizar precios: downloads the missing days from each source, keeps a failure apart, and the key stays in the browser', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const keys: string[] = [];
  // Fake APIs in their real reply formats (the demo's tickers are fictional).
  await page.route('https://api.twelvedata.com/**', (route) => {
    const u = new URL(route.request().url());
    keys.push(u.searchParams.get('apikey') ?? '');
    if (u.searchParams.get('symbol') === 'ACME') return route.abort('internetdisconnected');
    return json(route, {
      meta: { symbol: 'SMPL', interval: '1day', currency: 'USD' },
      values: [
        { datetime: '2025-07-09', open: '1', high: '1', low: '1', close: '110.10000', volume: '1' },
        { datetime: '2025-07-10', open: '1', high: '1', low: '1', close: '110.85000', volume: '1' },
      ],
      status: 'ok',
    });
  });
  await page.route('https://www.datos.gov.co/**', (route) =>
    json(route, [{ valor: '4350.1', unidad: 'COP', vigenciadesde: '2025-07-09T00:00:00.000', vigenciahasta: '2025-07-09T00:00:00.000' }]),
  );

  await loadDemo(page);
  await page.getByRole('link', { name: 'Datos' }).click();
  const card = page.locator('.refresh-card');
  await expect(card.getByRole('heading', { name: 'Actualizar precios' })).toBeVisible();
  // Without the key only the TRM can go; the US stocks wait for it, the Colombian one has no free source.
  await expect(card).toContainText('Por actualizar: 1 de datos.gov.co');
  await card.locator('summary').click();
  await expect(card.getByText(/Sample Corp \(SMPL\): Falta la clave/)).toBeVisible();
  await expect(card.getByText(/Andes Energía SA \(ANDES\): Bolsa fuera de EE. UU./)).toBeVisible();

  await card.getByLabel('Clave de Twelve Data').fill('demo-key');
  await card.getByRole('button', { name: 'Guardar clave' }).click();
  await expect(card).toContainText('Por actualizar: 2 de Twelve Data, 1 de datos.gov.co');
  await card.getByRole('button', { name: 'Actualizar precios' }).click();

  await expect(card.getByRole('status').filter({ hasText: 'Se agregaron' })).toHaveText(/Se agregaron 2 precios y 1 tasa\. 1 serie falló/, { timeout: 10_000 });
  await expect(card.getByRole('row').filter({ hasText: 'Acme Industries' })).toContainText('No se pudo conectar con Twelve Data');
  await expect(card.getByRole('row').filter({ hasText: 'Sample Corp' })).toContainText('10 jul 2025');
  await expect(card.getByRole('row').filter({ hasText: 'TRM (COP)' })).toContainText('9 jul 2025');
  expect(new Set(keys)).toEqual(new Set(['demo-key']));
  // The status table and the header now reflect the new data.
  await expect(page.getByRole('row').filter({ hasText: 'Sample Corp' }).last()).toContainText('10 jul 2025');
  await expect(page.getByText(/TRM hasta 9 jul 2025/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/actualizar-precios-${info.project.name}.png`, fullPage: true });

  // The key is kept by this browser (not in the backup).
  await page.reload();
  await expect(page.locator('.refresh-card')).toContainText('Clave de Twelve Data guardada en este navegador');
  const backup = await page.evaluate(() => new Promise<string>((r) => {
    const q = indexedDB.open('investment-tracker');
    q.onsuccess = () => {
      const g = q.result.transaction('kv').objectStore('kv').get('dataset');
      g.onsuccess = () => r(JSON.stringify(g.result));
    };
  }));
  expect(backup).not.toContain('demo-key');
  expect(backup).toContain('"source":"twelvedata"');
  expect(errors).toEqual([]);
});
