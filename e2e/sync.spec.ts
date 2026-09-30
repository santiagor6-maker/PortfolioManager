import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';

/**
 * Cloud sync end to end against an in-memory fake of the Supabase endpoints the app uses (password sign-up
 * and sign-in, two RPCs, one select). Two "devices" are two origins, so each has its own IndexedDB and session.
 */

const shots = process.env.SHOTS_DIR;
const PASS = 'una contraseña de prueba larga';

interface Row { user: string; blob: string; salt: string; kdf: unknown; version: number; device: string; updated_at: string }

class FakeSupabase {
  rows = new Map<string, Row>();
  uploads: string[] = [];
  /** When set, downloads of the cloud copy wait for it (to edit while a pull is in flight). */
  gate?: Promise<void>;
  /** Simulates a network failure for every request. */
  down = false;
  /** Simulates a network failure for data requests only (sign-in still works). */
  dataDown = false;
  /** Seconds an access token lasts (short: every use needs a refresh first). */
  tokenLife = 3600;
  refreshes = 0;
  /** The password each account was created with, as the server receives it. */
  accounts = new Map<string, string>();

  session(email: string) {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: `tok:${email}`,
      token_type: 'bearer',
      expires_in: this.tokenLife,
      expires_at: now + this.tokenLife,
      refresh_token: `refresh:${email}`,
      user: { id: email, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
    };
  }

  async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    if (this.down) return route.abort('internetdisconnected');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (status: number, body: unknown) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const user = (req.headers()['authorization'] ?? '').replace(/^Bearer tok:/, '');
    const body = req.postData() ? JSON.parse(req.postData()!) : {};

    if (url.pathname === '/auth/v1/signup') {
      if (this.accounts.has(body.email)) return json(422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
      this.accounts.set(body.email, body.password);
      return json(200, this.session(body.email));
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      if (this.accounts.get(body.email) !== body.password) return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return json(200, this.session(body.email));
    }
    if (url.pathname === '/auth/v1/token') {
      this.refreshes++;
      return json(200, this.session(String(body.refresh_token).replace(/^refresh:/, '')));
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === '/auth/v1/user') return json(200, { id: user, email: user, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} });
    if (!user) return json(401, { message: 'no session' });
    if (this.dataDown) return route.abort('internetdisconnected');

    if (url.pathname === '/rest/v1/rpc/dataset_version') return json(200, this.rows.get(user)?.version ?? 0);
    if (url.pathname === '/rest/v1/rpc/save_dataset') {
      const row = this.rows.get(user);
      if ((row?.version ?? 0) !== body.expected) return json(200, -1);
      const version = body.expected + 1;
      this.uploads.push(body.p_blob);
      this.rows.set(user, { user, blob: body.p_blob, salt: body.p_salt, kdf: body.p_kdf, version, device: body.p_device, updated_at: new Date().toISOString() });
      return json(200, version);
    }
    if (url.pathname === '/rest/v1/datasets') {
      if (this.gate) await this.gate;
      const row = this.rows.get(user);
      if (!row) return json(406, { code: 'PGRST116', message: 'no rows' });
      return json(200, row);
    }
    return json(404, { message: `unexpected ${req.method()} ${url.pathname}` });
  }
}

let servers: Server[] = [];
let ports: number[] = [];

test.beforeAll(async () => {
  const html = readFileSync('dist-sync/index.html');
  const headers = Object.fromEntries(
    readFileSync('dist-sync/_headers', 'utf8').split('\n').slice(1).filter(Boolean).map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  for (const _ of [0, 1]) {
    const s = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', ...headers });
      res.end(html);
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    ports.push((s.address() as { port: number }).port);
  }
});

test.afterAll(() => {
  servers.forEach((s) => s.close());
  servers = [];
  ports = [];
});

async function device(context: BrowserContext, fake: FakeSupabase, port: number): Promise<Page> {
  await context.route('https://sync.test/**', (r) => fake.handle(r));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (/Content Security Policy/.test(m.text())) errors.push(m.text());
  });
  (page as Page & { errors: string[] }).errors = errors;
  await page.goto(`http://127.0.0.1:${port}/#/datos`);
  return page;
}

/** Signs in with an account that exists. */
async function open(page: Page, email: string, pass = PASS) {
  const card = page.locator('.sync-card');
  await card.getByLabel('Correo').fill(email);
  await card.getByLabel('Contraseña', { exact: true }).fill(pass);
  await card.getByRole('button', { name: 'Entrar' }).click();
}

/** Creates the account and fills the form up to the last click. */
async function fillNewAccount(page: Page, email: string, pass = PASS) {
  const card = page.locator('.sync-card');
  await expect(card.getByLabel('Correo')).toBeVisible({ timeout: 15_000 });
  if (await card.getByRole('button', { name: 'Crear cuenta (primera vez)' }).isVisible()) await card.getByRole('button', { name: 'Crear cuenta (primera vez)' }).click();
  await card.getByLabel('Correo').fill(email);
  await card.getByLabel('Contraseña', { exact: true }).fill(pass);
  await card.getByLabel('Repite la contraseña').fill(pass);
  await card.getByRole('checkbox').check();
}

/** First device: creates the account and uploads this device's data. */
async function link(page: Page, email: string, pass = PASS) {
  await fillNewAccount(page, email, pass);
  const card = page.locator('.sync-card');
  await card.getByRole('button', { name: 'Crear cuenta y sincronizar' }).click();
  await expect(card.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
}

async function addAccount(page: Page, id: string, name: string) {
  const form = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Cuentas' }) });
  await form.getByLabel('Código').fill(id);
  await form.getByLabel('Nombre').fill(name);
  await form.getByRole('button', { name: 'Agregar cuenta' }).click();
  await expect(form.getByRole('cell', { name, exact: true })).toBeVisible();
}

test('sync: encrypted upload, second device with the same password, changes, and a conflict resolved by hand', async ({ browser }) => {
  const fake = new FakeSupabase();
  const a = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[0]!);
  const b = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[1]!);
  const cardA = a.locator('.sync-card');
  const cardB = b.locator('.sync-card');

  // Device A: demo data, create the account. A backup is handed over before the first upload.
  await a.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await a.goto(`http://127.0.0.1:${ports[0]}/#/datos`);
  await expect(a.locator('.sync-badge')).toContainText('Sin sincronizar');
  await fillNewAccount(a, 'yo@example.test');
  const activate = cardA.getByRole('button', { name: 'Crear cuenta y sincronizar' });
  await cardA.getByRole('checkbox').uncheck();
  await expect(activate).toBeDisabled();
  await cardA.getByRole('checkbox').check();
  if (shots) await cardA.screenshot({ path: `${shots}/sync-new-account.png` });
  const backup = a.waitForEvent('download');
  await activate.click();
  expect((await backup).suggestedFilename()).toMatch(/^inversiones-respaldo-.*\.json$/);
  await expect(cardA.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(fake.rows.get('yo@example.test')?.version).toBe(1);
  // Only ciphertext reaches the server.
  const stored = atob(fake.rows.get('yo@example.test')!.blob);
  expect(stored).not.toContain('Broker');
  expect(stored).not.toContain('"ledger"');
  // Nor does the password: the account holds a secret derived from it.
  expect(fake.accounts.get('yo@example.test')).toHaveLength(44);
  expect(fake.accounts.get('yo@example.test')).not.toBe(PASS);

  // Device B: empty; a wrong password changes nothing, the right one brings the data.
  await open(b, 'yo@example.test', 'contraseña equivocada');
  await expect(cardB.getByRole('alert')).toContainText('Correo o contraseña incorrectos');
  await open(b, 'yo@example.test');
  await expect(cardB.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(b.getByRole('heading', { name: 'Estado de los datos' })).toBeVisible();
  const statA = await a.locator('.card').filter({ has: a.getByRole('heading', { name: 'Estado de los datos' }) }).locator('p').first().textContent();
  const statB = await b.locator('.card').filter({ has: b.getByRole('heading', { name: 'Estado de los datos' }) }).locator('p').first().textContent();
  expect(statB).toBe(statA);

  // A change on A reaches B.
  await addAccount(a, 'nueva', 'Cuenta nueva A');
  await expect(a.locator('.sync-badge')).toContainText(/Cambios por subir|Sincronizando|Sincronizado/);
  await expect(cardA.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(fake.rows.get('yo@example.test')?.version).toBe(2);
  if (shots) await a.screenshot({ path: `${shots}/sync-synced.png` });
  await cardB.getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(b.getByRole('cell', { name: 'Cuenta nueva A', exact: true })).toBeVisible();

  // Both change before syncing: B sees a conflict, keeps the cloud copy, and gets its own version as a file.
  await addAccount(a, 'otra', 'Solo en A');
  await cardA.getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(cardA.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  await addAccount(b, 'mia', 'Solo en B');
  await cardB.getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(cardB.getByText('Hay cambios distintos en este dispositivo y en la nube')).toBeVisible();
  if (shots) await cardB.screenshot({ path: `${shots}/sync-conflict.png` });
  const mine = b.waitForEvent('download');
  await cardB.getByRole('button', { name: 'Usar la copia de la nube' }).click();
  expect((await mine).suggestedFilename()).toMatch(/^inversiones-este-dispositivo-.*\.json$/);
  await expect(b.getByRole('cell', { name: 'Solo en A', exact: true })).toBeVisible();
  await expect(b.getByRole('cell', { name: 'Solo en B', exact: true })).toHaveCount(0);
  await expect(cardB.getByText('Sincronizado', { exact: true })).toBeVisible();

  // Signing out keeps the local data.
  await cardB.getByRole('button', { name: 'Cerrar sesión en este dispositivo' }).click();
  await expect(cardB.getByLabel('Correo')).toBeVisible();
  await expect(b.getByRole('cell', { name: 'Solo en A', exact: true })).toBeVisible();

  expect((a as Page & { errors: string[] }).errors).toEqual([]);
  expect((b as Page & { errors: string[] }).errors).toEqual([]);
});

test('sync: an empty device never starts the cloud copy, and an account is created once', async ({ browser }) => {
  const fake = new FakeSupabase();
  const a = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[0]!);
  const card = a.locator('.sync-card');
  await fillNewAccount(a, 'vacio@example.test');
  await card.getByRole('button', { name: 'Crear cuenta y sincronizar' }).click();
  await expect(card.getByRole('alert')).toContainText('Todavía no hay datos en la nube');
  await expect(card.getByLabel('Correo')).toBeVisible();
  expect(fake.rows.size).toBe(0);

  await a.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await a.goto(`http://127.0.0.1:${ports[0]}/#/datos`);
  await fillNewAccount(a, 'vacio@example.test');
  await card.getByRole('button', { name: 'Crear cuenta y sincronizar' }).click();
  await expect(card.getByRole('alert')).toContainText('Ya hay una cuenta con este correo');
  await card.getByRole('button', { name: 'Ya tengo cuenta' }).click();
  await open(a, 'vacio@example.test');
  await expect(card.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(fake.rows.get('vacio@example.test')?.version).toBe(1);
  expect((a as Page & { errors: string[] }).errors).toEqual([]);
});

test('sync: a device that reopens the app keeps its key and syncs without asking again', async ({ browser }) => {
  const fake = new FakeSupabase();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const a = await device(ctx, fake, ports[0]!);
  await a.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await a.goto(`http://127.0.0.1:${ports[0]}/#/datos`);
  await link(a, 'otro@example.test');
  const card = a.locator('.sync-card');
  await a.reload();
  await expect(a.locator('.sync-badge')).toContainText('Sincronizado', { timeout: 15_000 });
  await expect(card.getByLabel(/Contraseña/)).toHaveCount(0);

  // Without the key (site data partly cleared) but still signed in: only the password is asked.
  await a.evaluate(() => new Promise((r) => {
    const q = indexedDB.open('investment-tracker');
    q.onsuccess = () => {
      const t = q.result.transaction('kv', 'readwrite');
      t.objectStore('kv').delete('sync:key');
      t.oncomplete = r;
    };
  }));
  await a.reload();
  await expect(card.getByLabel('Contraseña de otro@example.test')).toBeVisible({ timeout: 15_000 });
  await card.getByLabel('Contraseña de otro@example.test').fill(PASS);
  await card.getByRole('button', { name: 'Abrir mis datos' }).click();
  await expect(card.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(fake.rows.get('otro@example.test')?.version).toBe(1);
});

test('without sync configured the app shows nothing of it', async ({ page }) => {
  await page.goto(`file://${process.cwd()}/dist/index.html#/datos`);
  await expect(page.getByRole('heading', { name: 'Respaldo' })).toBeVisible();
  await expect(page.locator('.sync-card')).toHaveCount(0);
  await expect(page.locator('.sync-badge')).toHaveCount(0);
});

test('sync: an edit made while a cloud copy is downloading is never overwritten', async ({ browser }) => {
  const fake = new FakeSupabase();
  const a = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[0]!);
  const b = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[1]!);
  await a.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await a.goto(`http://127.0.0.1:${ports[0]}/#/datos`);
  await link(a, 'yo@example.test');
  await open(b, 'yo@example.test');
  await expect(b.locator('.sync-card').getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });

  await addAccount(a, 'desde-a', 'Desde A');
  await expect(a.locator('.sync-card').getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });

  // B starts pulling A's change; while the download hangs, B records its own change.
  let release!: () => void;
  fake.gate = new Promise((r) => (release = r));
  await b.locator('.sync-card').getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(b.locator('.sync-badge')).toHaveAttribute('aria-label', /Sincronizando/);
  await addAccount(b, 'desde-b', 'Desde B');
  release();
  fake.gate = undefined;
  await expect(b.locator('.sync-card').getByText('Hay cambios distintos en este dispositivo y en la nube')).toBeVisible();
  await expect(b.getByRole('cell', { name: 'Desde B', exact: true })).toBeVisible();

  // Keeping this device uploads it; the cloud copy is handed over and kept here.
  const cloud = b.waitForEvent('download');
  await b.locator('.sync-card').getByRole('button', { name: 'Conservar este dispositivo' }).click();
  expect((await cloud).suggestedFilename()).toMatch(/^inversiones-nube-.*\.json$/);
  await expect(b.locator('.sync-card').getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(b.locator('.sync-card').getByText(/La última versión reemplazada/)).toBeVisible();
  expect(fake.rows.get('yo@example.test')?.version).toBe(3);
  await a.locator('.sync-card').getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(a.getByRole('cell', { name: 'Desde B', exact: true })).toBeVisible();
});

test('sync: opening the cloud copy on a device that has its own data asks which to keep', async ({ browser }) => {
  const fake = new FakeSupabase();
  const a = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[0]!);
  const b = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[1]!);
  await a.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await a.goto(`http://127.0.0.1:${ports[0]}/#/datos`);
  await link(a, 'yo@example.test');
  await addAccount(b, 'propia', 'Cuenta propia de B');
  await open(b, 'yo@example.test');
  await expect(b.locator('.sync-card').getByText('Hay cambios distintos en este dispositivo y en la nube')).toBeVisible();
  await expect(b.getByRole('cell', { name: 'Cuenta propia de B', exact: true })).toBeVisible();
  expect(fake.rows.get('yo@example.test')?.version).toBe(1);
});

test('sync: a cloud copy that disappeared is a conflict, not a silent re-upload', async ({ browser }) => {
  const fake = new FakeSupabase();
  const a = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[0]!);
  await a.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await a.goto(`http://127.0.0.1:${ports[0]}/#/datos`);
  await link(a, 'yo@example.test');
  fake.rows.clear();
  await a.locator('.sync-card').getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(a.locator('.sync-card').getByText('La copia en la nube ya no existe.')).toBeVisible();
  expect(fake.rows.size).toBe(0);
  await a.locator('.sync-card').getByRole('button', { name: 'Subir la de este dispositivo' }).click();
  await expect(a.locator('.sync-card').getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(fake.rows.get('yo@example.test')?.version).toBe(1);
});

test('sync: a change that could not be uploaded survives a reload and goes up later', async ({ browser }) => {
  const fake = new FakeSupabase();
  const a = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[0]!);
  await a.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await a.goto(`http://127.0.0.1:${ports[0]}/#/datos`);
  await link(a, 'yo@example.test');
  fake.down = true;
  await addAccount(a, 'sin-red', 'Sin red');
  await a.locator('.sync-card').getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(a.locator('.sync-card').getByText('Sincronizado', { exact: true })).toHaveCount(0);
  await a.reload();
  fake.down = false;
  await a.locator('.sync-card').getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(a.locator('.sync-card').getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(fake.rows.get('yo@example.test')?.version).toBe(2);
});

test('sync: opening the app offline with an expired session keeps the key and syncs when the network is back', async ({ browser }) => {
  // The auth client retries a failed token refresh for ~30 s, then holds the failure for a minute.
  test.setTimeout(180_000);
  const fake = new FakeSupabase();
  fake.tokenLife = 1;
  const a = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[0]!);
  await a.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await a.goto(`http://127.0.0.1:${ports[0]}/#/datos`);
  await link(a, 'yo@example.test');
  await addAccount(a, 'pendiente', 'Pendiente');
  fake.down = true;
  await a.reload();
  const card = a.locator('.sync-card');
  await expect(a.locator('.sync-badge')).toHaveAttribute('aria-label', /Conectando/);
  await expect(a.locator('.sync-badge')).toHaveAttribute('aria-label', /Sin conexión|Error/, { timeout: 45_000 });
  await expect(card.getByLabel(/Contraseña/)).toHaveCount(0);
  await expect(card.getByLabel('Correo')).toHaveCount(0);
  fake.down = false;
  // No click: the app recovers on its own once the auth client lets the refresh through.
  await expect(card.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 100_000 });
  await expect(card.getByLabel(/Contraseña/)).toHaveCount(0);
  expect(fake.refreshes).toBeGreaterThan(0);
  expect(fake.rows.get('yo@example.test')?.version).toBe(2);
});

test('sync: a cloud copy saved with another password is never opened nor replaced on its own', async ({ browser }) => {
  const fake = new FakeSupabase();
  const a = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[0]!);
  await a.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await a.goto(`http://127.0.0.1:${ports[0]}/#/datos`);
  await link(a, 'otra@example.test', 'otra contraseña distinta');
  const c = await device(await browser.newContext(), fake, ports[1]!);
  await fillNewAccount(c, 'yo@example.test');
  await c.locator('.sync-card').getByRole('button', { name: 'Crear cuenta y sincronizar' }).click();
  await expect(c.locator('.sync-card').getByRole('alert')).toContainText('Todavía no hay datos en la nube');
  // yo@'s account exists, and its cloud copy is one sealed under another password.
  fake.rows.set('yo@example.test', { ...fake.rows.get('otra@example.test')!, user: 'yo@example.test' });
  const b = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[1]!);
  await open(b, 'yo@example.test');
  const card = b.locator('.sync-card');
  await expect(card.getByRole('alert')).toContainText('Tu contraseña no abre la copia que hay en la nube');
  await expect(card.getByLabel('Contraseña de yo@example.test')).toBeVisible();
  expect(fake.rows.get('yo@example.test')?.version).toBe(1);
  expect(fake.uploads).toHaveLength(1);
});

test('sync: without network the sign-in says so, and a failure after signing in asks the password again', async ({ browser }) => {
  const fake = new FakeSupabase();
  const a = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[0]!);
  await a.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await a.goto(`http://127.0.0.1:${ports[0]}/#/datos`);
  const card = a.locator('.sync-card');
  fake.down = true;
  await fillNewAccount(a, 'yo@example.test');
  await card.getByRole('button', { name: 'Crear cuenta y sincronizar' }).click();
  await expect(card.getByRole('alert')).toContainText('No se pudo conectar con la nube');
  await expect(card.getByLabel('Correo')).toBeVisible();
  expect(fake.accounts.size).toBe(0);

  fake.down = false;
  fake.dataDown = true;
  await fillNewAccount(a, 'yo@example.test');
  await card.getByRole('button', { name: 'Crear cuenta y sincronizar' }).click();
  await expect(card.getByLabel('Contraseña de yo@example.test')).toBeVisible();
  await expect(card.getByRole('alert')).toContainText('No se pudo conectar');
  fake.dataDown = false;
  await card.getByLabel('Contraseña de yo@example.test').fill(PASS);
  await card.getByRole('button', { name: 'Abrir mis datos' }).click();
  await expect(card.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(fake.rows.get('yo@example.test')?.version).toBe(1);
});
