import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const shots = process.env.SHOTS_DIR;

async function loadDemo(page: Page) {
  // file:// pages share one storage origin across browser contexts: start every test from an empty database.
  await page.goto('');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('investment-tracker'); q.onsuccess = q.onerror = q.onblocked = r; }));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Empezar' })).toBeVisible();
  await page.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await expect(page.locator('.hero .kicker')).toHaveText('Valor del portafolio');
}

test('demo portfolio: summary, positions, comparison, persistence', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loadDemo(page);

  await page.getByRole('link', { name: 'Resumen' }).click();
  await expect(page.getByText('Tu rentabilidad (XIRR, anual)')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Acciones USD' })).toBeVisible();
  await expect(page.locator('.class-card').filter({ hasText: 'Acciones USD' }).getByText('Índice demo (retorno total)').first()).toBeVisible();
  await expect(page.locator('.notice.err')).toHaveCount(0);
  const value = await page.locator('.hero .figure').textContent();
  expect(value).toMatch(/\$\s\d/);
  if (shots) await page.screenshot({ path: `${shots}/resumen-${info.project.name}.png`, fullPage: true });

  await page.getByRole('button', { name: 'USD', exact: true }).click();
  await expect(page.locator('.hero .figure')).toContainText('US$');

  await page.getByRole('link', { name: 'Activos' }).click();
  await expect(page.getByRole('cell', { name: /Copy portfolio Tech \(demo\)/ })).toBeVisible();
  await expect(page.getByText(/precio de lista .* anual sin apalancamiento/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/activos-${info.project.name}.png`, fullPage: true });

  await page.getByRole('link', { name: 'Comparación' }).click();
  await expect(page.locator('.card').filter({ hasText: 'Crecimiento de 100' }).locator('.chart svg path.series')).toHaveCount(2);
  if (shots) await page.screenshot({ path: `${shots}/comparacion-${info.project.name}.png`, fullPage: true });

  await page.reload();
  await page.getByRole('link', { name: 'Movimientos' }).click();
  await expect(page.getByText(/\d+ movimientos/)).toContainText('43 movimientos');
  expect(errors).toEqual([]);
});

test('record a buy, reject an oversell, record a sale', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('link', { name: 'Movimientos' }).click();

  await page.getByRole('button', { name: '+ Registrar movimiento' }).click();
  const form = page.getByRole('form', { name: 'Nuevo movimiento' });
  await form.getByLabel('Fecha').fill('2025-06-10');
  await form.getByRole('combobox', { name: /^Cuenta/ }).selectOption('broker-usd');
  await form.getByRole('combobox', { name: /^Activo/ }).selectOption('SMPL');
  await form.getByLabel('Cantidad (unidades)').fill('2');
  await form.getByLabel(/Total pagado/).fill('250,50');
  await form.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText('44 movimientos')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'US$ -250,50' })).toBeVisible();

  await page.getByRole('button', { name: '+ Registrar movimiento' }).click();
  await form.getByRole('combobox', { name: /^Tipo/ }).selectOption('SELL');
  await form.getByLabel('Fecha').fill('2025-06-11');
  await form.getByRole('combobox', { name: /^Cuenta/ }).selectOption('broker-usd');
  await form.getByRole('combobox', { name: /^Activo/ }).selectOption('SMPL');
  await expect(form.getByText('Tienes 30 a esa fecha')).toBeVisible();
  await form.getByLabel('Cantidad (unidades)').fill('31');
  await form.getByLabel(/Total recibido/).fill('4000');
  await form.getByRole('button', { name: 'Guardar' }).click();
  await expect(form.getByRole('alert')).toContainText('excede la posición');
  await expect(page.getByText('44 movimientos')).toBeVisible();

  await form.getByLabel('Cantidad (unidades)').fill('10');
  await form.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText('45 movimientos')).toBeVisible();
});

test('buy a new asset created inline', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('link', { name: 'Movimientos' }).click();
  await page.getByRole('button', { name: '+ Registrar movimiento' }).click();
  const form = page.getByRole('form', { name: 'Nuevo movimiento' });
  await form.getByLabel('Fecha').fill('2025-06-12');
  await form.getByRole('combobox', { name: /^Cuenta/ }).selectOption('broker-usd');
  await form.getByRole('combobox', { name: /^Activo/ }).selectOption('__new__');
  await form.getByLabel('Código').fill('NEWCO');
  await form.getByLabel('Nombre').fill('New Co');
  await form.getByLabel('Cantidad (unidades)').fill('1');
  await form.getByLabel(/Total pagado/).fill('10');
  await form.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('cell', { name: 'New Co' })).toBeVisible();
  await page.getByRole('link', { name: 'Activos' }).click();
  await expect(page.getByText('al costo · falta dato')).toBeVisible();
});

test('month-end close: enter a value, see the month result, close the month', async ({ page }, info) => {
  await loadDemo(page);
  await expect(page.getByRole('link', { name: 'Hacer el cierre' })).toBeVisible();
  await page.getByRole('link', { name: 'Cierre del mes', exact: true }).click();

  // July: the value can be saved, but the month cannot be closed without July's exchange rate.
  await page.getByRole('combobox', { name: /^Mes/ }).selectOption('2025-07-31');
  const input = page.getByLabel('Valor de Copy portfolio Tech (demo) al 2025-07-31');
  await input.fill('1.702,35');
  await page.getByRole('button', { name: /Guardar valores/ }).click();
  await expect(page.getByRole('status')).toContainText('Guardado 1 valor');
  await expect(page.getByText('Ya registrado: US$ 1.702,35')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cerrar jul 2025' })).toBeDisabled();

  // June: only the apartment's list price is missing; once entered, the result is final and the month closes.
  await page.getByRole('combobox', { name: /^Mes/ }).selectOption('2025-06-30');
  await expect(page.getByRole('button', { name: 'Cerrar jun 2025' })).toBeDisabled();
  await page.getByLabel('Valor de Apartamento 60 m² (demo) al 2025-06-30').fill('395000000');
  await page.getByRole('button', { name: /Guardar valores/ }).click();
  await expect(page.getByText('Listo para cerrar')).toBeVisible();
  await expect(page.locator('table.result tr.k-total')).toContainText('TOTAL');
  await expect(page.locator('table.result tr.k-subtotal')).toContainText('Subtotal sin inmobiliario');
  // The month's gain split: the investments themselves and the exchange rate (the US holdings move with the TRM in pesos).
  await expect(page.locator('.result-hero .fx-split')).toContainText(/De la inversión .+ · efecto cambiario .+/);
  await expect(page.locator('table.result thead')).toContainText('De la inversión');
  await expect(page.locator('table.result thead')).toContainText('Efecto cambiario');
  await expect(page.locator('table.result tr.k-class').filter({ hasText: 'Acciones USD' }).locator('td').nth(4)).not.toHaveText('');
  if (shots) await page.screenshot({ path: `${shots}/cierre-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Cerrar jun 2025' }).click();
  await expect(page.getByText(/Cerrado el/).first()).toBeVisible();

  // A later change to a closed month is flagged.
  await page.getByLabel('Valor de Apartamento 60 m² (demo) al 2025-06-30').fill('396000000');
  await page.getByRole('button', { name: /Guardar valores/ }).click();
  await expect(page.getByText(/Las cifras cambiaron desde que cerraste/)).toBeVisible();

  await page.getByRole('link', { name: 'Movimientos', exact: true }).click();
  await page.getByLabel('Buscar activo o nota').fill('copy');
  await expect(page.getByRole('cell', { name: 'US$ 1.702,35' })).toBeVisible();
});

test('month-by-month tracking with total and subtotal without real estate', async ({ page }, info) => {
  await loadDemo(page);
  await page.getByRole('link', { name: 'Seguimiento' }).click();
  const grid = page.locator('table.track');
  await expect(grid.getByRole('rowheader', { name: 'TOTAL', exact: true })).toBeVisible();
  await expect(grid.getByRole('rowheader', { name: 'Subtotal sin inmobiliario' })).toBeVisible();
  await expect(grid.getByRole('rowheader', { name: /Copy portfolio Tech/ })).toBeVisible();
  await expect(page.locator('.notice.warn')).toContainText('El seguimiento llega hasta jun 2025');
  if (shots) await page.screenshot({ path: `${shots}/seguimiento-${info.project.name}.png`, fullPage: true });

  await page.getByRole('button', { name: 'Rend. del mes' }).first().click();
  await expect(grid.locator('tr.k-total td').last()).toHaveText(/%$/);
  await grid.getByRole('button', { name: 'Acciones USD' }).click();
  await expect(grid.getByRole('rowheader', { name: /Copy portfolio Tech/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Sin inmobiliario' }).click();
  await expect(page.getByText('todo menos el inmobiliario')).toBeVisible();
  await grid.locator('thead').getByRole('link', { name: /jun/ }).click();
  await expect(page.locator('.close-title')).toHaveText('jun 2025');
});

test('price tracking: set a target and see the progress; theme switch', async ({ page }, info) => {
  await loadDemo(page);
  await page.getByRole('link', { name: 'Precios' }).click();
  const table = page.locator('table.prices');
  const row = table.locator('tr.stock').filter({ hasText: 'Sample Corp' });
  await expect(row).toContainText('sin objetivo');
  await row.getByRole('button', { name: /Sample Corp/ }).click();
  const form = page.getByRole('form', { name: 'Objetivo de Sample Corp' });
  await form.getByLabel(/Precio objetivo/).fill('1000');
  await form.getByLabel('Estrategia').fill('Crecimiento');
  await form.getByRole('button', { name: 'Guardar' }).click();
  await expect(row).toContainText('Crecimiento');
  await expect(row.locator('.progress')).toContainText('%');
  await expect(page.locator('.tile').filter({ hasText: 'Acierto en ventas' })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/precios-${info.project.name}.png`, fullPage: true });

  const sw = page.getByRole('switch', { name: 'Modo oscuro' });
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('switch', { name: 'Modo oscuro' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

const amount = (s: string | null) => Number((s ?? '').match(/\$\s([\d.]+)/)![1]!.replace(/\./g, ''));

test('summary analysis blocks: gain bridge, monthly heatmap and risk; hide and reorder blocks', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loadDemo(page);
  await expect(page.getByRole('heading', { name: '¿De dónde viene tu ganancia?' })).toBeVisible();
  await expect(page.getByRole('list', { name: /Puente del valor inicial al final/ }).getByRole('listitem')).not.toHaveCount(0);
  const heat = page.getByRole('table', { name: /Rentabilidad mensual por año/ });
  await expect(heat.getByRole('rowheader', { name: '2025' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Riesgo y caídas' })).toBeVisible();
  await expect(page.getByText('Máxima caída', { exact: true })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/resumen-analisis-${info.project.name}.png`, fullPage: true });

  await page.getByText('Personalizar el resumen').click();
  await page.getByRole('checkbox', { name: 'Rentabilidad mes a mes' }).uncheck();
  await expect(heat).toHaveCount(0);
  // Two places up: past the hidden heatmap and the gain bridge.
  await page.getByRole('button', { name: 'Subir Riesgo y caídas' }).click();
  await page.getByRole('button', { name: 'Subir Riesgo y caídas' }).click();
  const order = async () => {
    const h = await page.locator('main h2').allInnerTexts();
    return h.indexOf('Riesgo y caídas') < h.indexOf('¿De dónde viene tu ganancia?');
  };
  expect(await order()).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Riesgo y caídas' })).toBeVisible();
  await expect(heat).toHaveCount(0);
  expect(await order()).toBe(true);

  await page.getByRole('link', { name: 'Comparación' }).click();
  const risk = page.locator('.card').filter({ has: page.getByRole('heading', { name: /Riesgo: cuánto se mueve/ }) });
  await expect(risk.getByRole('row')).toHaveCount(3);
  await expect(risk.locator('.chart svg path.series')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('summary is modular: click a class, Ctrl-click to leave one out, the choice is remembered', async ({ page }, info) => {
  await loadDemo(page);
  const card = (name: string) => page.locator('.class-card').filter({ has: page.getByRole('link', { name, exact: true }) });
  const heroExact = page.locator('.hero .exact').first();
  const total = amount(await heroExact.textContent());

  await card('Fondos').locator('.big').click();
  await expect(page.locator('.hero .kicker')).toHaveText('Valor de la selección');
  expect(amount(await heroExact.textContent())).toBe(amount(await card('Fondos').locator('.big').textContent()));

  await page.getByRole('button', { name: 'Todo', exact: true }).click();
  await expect(page.locator('.hero .kicker')).toHaveText('Valor del portafolio');

  await card('Inmobiliario').locator('.big').click({ modifiers: ['Control'] });
  const picker = page.getByRole('group', { name: 'Portafolios que se suman' });
  await expect(picker.getByRole('button', { name: 'Inmobiliario' })).toHaveAttribute('aria-pressed', 'false');
  await expect(picker.getByRole('button', { name: 'Fondos' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.hero .exact').nth(1)).not.toContainText('Inmobiliario');
  const withoutRealEstate = amount(await heroExact.textContent());
  expect(withoutRealEstate + amount(await card('Inmobiliario').locator('.big').textContent())).toBe(total);
  await expect(page.locator('.notice.err')).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/resumen-seleccion-${info.project.name}.png`, fullPage: true });

  await page.reload();
  await expect(page.locator('.hero .kicker')).toHaveText('Valor de la selección');
  expect(amount(await page.locator('.hero .exact').first().textContent())).toBe(withoutRealEstate);
});

test('indicators: composition filters the table; edit the thesis and fundamentals', async ({ page }, info) => {
  await loadDemo(page);
  await page.getByRole('link', { name: 'Indicadores' }).click();
  const rows = page.locator('table.ind tr.stock');
  await expect(rows).toHaveCount(4);
  await page.locator('.wpanel').filter({ hasText: 'Mercado' }).getByRole('button', { name: /Colombia/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Andes Energía SA');
  await page.getByRole('button', { name: 'Quitar filtro' }).click();
  await expect(rows).toHaveCount(4);

  const row = rows.filter({ hasText: 'Sample Corp' });
  await row.getByRole('button', { name: /Sample Corp/ }).click();
  const form = page.getByRole('form', { name: 'Tesis de Sample Corp' });
  await form.getByLabel(/Precio objetivo/).fill('1000');
  await form.getByLabel(/Precio optimista/).fill('1.200,5');
  await form.getByLabel('ROE (%)').fill('31,5');
  await form.getByLabel('Comentarios').fill('Líder del mercado (demo)');
  // A moat rating needs its date: the provider's rating is shown with it, never the user's own call.
  await form.getByLabel('GuruFocus Moat Score (0–10)').fill('9');
  await form.getByRole('button', { name: 'Guardar' }).click();
  await expect(form.getByRole('alert')).toContainText('fecha');
  await form.getByLabel('Fecha (GuruFocus)').fill('2025-06-30');
  await form.getByRole('button', { name: 'Guardar' }).click();
  await expect(row).toContainText('US$ 1.000+');
  await expect(row).toContainText('US$ 1.201+') // 1.200,5 read with a decimal comma;
  await expect(row).toContainText('Líder del mercado (demo)');
  await expect(row).toContainText('Proveedor demo Amplio');
  await expect(row).toContainText('GuruFocus 9/10');
  await expect(page.locator('.tile').filter({ hasText: 'Potencial ponderado' }).locator('.value')).toContainText('%');

  await page.getByRole('button', { name: 'Fundamentales' }).click();
  await expect(row).toContainText('31,5 %');
  await expect(row).toContainText('24,5x');
  if (shots) await page.screenshot({ path: `${shots}/indicadores-${info.project.name}.png`, fullPage: true });

  // Precios links straight to the stock's thesis.
  await page.getByRole('link', { name: 'Precios' }).click();
  await page.locator('table.prices tr.stock').filter({ hasText: 'Acme Industries' }).getByRole('button', { name: /Acme/ }).click();
  await page.getByRole('link', { name: /Tesis, precio optimista y fundamentales de Acme/ }).click();
  const acme = page.getByRole('form', { name: 'Tesis de Acme Industries' });
  await expect(acme).toBeVisible();

  // With two stocks that have a target, each one's weight is plotted against its potential.
  await acme.getByLabel(/Precio objetivo/).fill('50');
  await acme.getByRole('button', { name: 'Guardar' }).click();
  const scatter = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Peso frente a potencial' }) });
  await expect(scatter.getByRole('img', { name: 'Peso de cada acción frente a su potencial al objetivo' })).toBeVisible();
  await expect(scatter.locator('g.pt')).toHaveCount(2);
  await expect(scatter.locator('details td', { hasText: 'SMPL' })).toBeAttached();
});

test('dividends: received by month and year, who pays, and the next 12 months as a projection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loadDemo(page);
  await page.getByRole('link', { name: 'Dividendos' }).click();
  await expect(page.locator('.tile').filter({ hasText: 'Desde el inicio' })).toContainText('2 pagos');
  await expect(page.getByRole('img', { name: /Dividendos por mes de 2025/ })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Dividendos de los últimos 12 meses por activo' }).getByRole('listitem')).toHaveCount(2);

  const cal = page.getByRole('list', { name: 'Calendario de dividendos proyectados' });
  const filled = cal.getByRole('listitem').filter({ has: page.locator('li') });
  await expect(filled).toHaveCount(2);
  await expect(filled.first()).toContainText('mar 2026');
  await expect(filled.first()).toContainText('Sample Corp');
  await expect(filled.last()).toContainText('Andes Energía SA');

  const payments = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Pagos recibidos' }) });
  await expect(payments.locator('tbody tr')).toHaveCount(2);
  await expect(payments.locator('tbody tr').last()).toContainText('US$ 11,20');
  await page.getByRole('button', { name: 'USD' }).click();
  await expect(payments.locator('thead')).toContainText('En USD');
  expect(errors).toEqual([]);
});
