import { expect, test } from '@playwright/test';

const shots = process.env.SHOTS_DIR;

test('Orientación: asks for a profile, then measures the mix against it and every class against its index', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('investment-tracker'); q.onsuccess = q.onerror = q.onblocked = r; }));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await expect(page.locator('.hero .kicker')).toHaveText('Valor del portafolio');

  await page.getByRole('link', { name: 'Mi plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tu plan de acción' })).toBeVisible();
  const plan = page.locator('.actions-list');
  // Without a profile the first point asks for one.
  await expect(plan.locator('.action').first()).toContainText('Define tu perfil de inversión');
  // Each class with an index gets its holding-by-holding comparison.
  const usd = page.getByRole('region', { name: 'Acciones USD contra el índice' });
  await expect(usd).toContainText('Índice demo');
  await expect(usd.getByRole('cell', { name: 'Sample Corp' })).toBeVisible();
  await expect(page.locator('.notice.err')).toHaveCount(0);

  // A template, adjusted: the targets must add up to 100 % before it saves.
  await page.getByRole('button', { name: 'Crecimiento' }).click();
  const stocks = page.getByLabel('Acciones USD', { exact: true });
  await stocks.fill('70');
  await page.getByRole('button', { name: 'Guardar perfil' }).click();
  await expect(page.locator('.profile-form .notice.err')).toContainText('deben sumar 100 %');
  await stocks.fill('55');
  await page.getByLabel('Aporte mensual (COP)').fill('1.000.000');
  await page.getByRole('button', { name: 'Guardar perfil' }).click();
  await expect(page.locator('.profile-summary')).toContainText('Horizonte 10 años');
  await expect(page.locator('.profile-summary')).toContainText('aporte mensual $ 1.000.000');
  await expect(plan.locator('.action').filter({ hasText: 'Define tu perfil' })).toHaveCount(0);

  // The mix now has targets, bands and a contribution plan.
  const mix = page.getByRole('region', { name: 'Tu mezcla líquida' });
  await expect(mix.getByRole('row').filter({ hasText: 'Renta fija' })).toContainText('20 %');
  await expect(mix.locator('.plan')).toContainText('Este mes');
  if (shots) await page.screenshot({ path: `${shots}/orientacion-${info.project.name}.png`, fullPage: true });

  // The profile is part of the data: it survives a reload.
  await page.reload();
  await expect(page.locator('.profile-summary')).toContainText('Horizonte 10 años');
  expect(errors).toEqual([]);
});
