import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';

/**
 * Cloud sync end to end against an in-memory fake of the Supabase endpoints the app uses (auth OTP, two RPCs,
 * one select). Two "devices" are two origins, so each has its own IndexedDB and session.
 */

const shots = process.env.SHOTS_DIR;
const CODE = '123456';
const PASS = 'una frase de prueba larga';

interface Row { user: string; blob: string; salt: string; kdf: unknown; version: number; device: string; updated_at: string }

class FakeSupabase {
  rows = new Map<string, Row>();
  uploads: string[] = [];
  /** When set, downloads of the cloud copy wait for it (to edit while a pull is in flight). */
  gate?: Promise<void>;
  /** Simulates a network failure for every request. */
  down = false;
  /** Seconds an access token lasts (short: every use needs a refresh first). */
  tokenLife = 3600;
  refreshes = 0;
  /** Where the last emailed sign-in link would send the user back to. */
  redirect?: string | null;

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

    if (url.pathname === '/auth/v1/otp') {
      this.redirect = url.searchParams.get('redirect_to');
      return json(200, {});
    }
    if (url.pathname === '/auth/v1/verify') {
      if (body.token !== CODE) return json(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      return json(200, this.session(body.email));
    }
    if (url.pathname === '/auth/v1/token') {
      this.refreshes++;
      return json(200, this.session(String(body.refresh_token).replace(/^refresh:/, '')));
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === '/auth/v1/user') return json(200, { id: user, email: user, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} });
    if (!user) return json(401, { message: 'no session' });

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

async function signIn(page: Page, email: string) {
  const card = page.locator('.sync-card');
  await card.getByLabel('Correo').fill(email);
  await card.getByRole('button', { name: 'Enviarme el enlace' }).click();
  await card.getByLabel(/Código \(si el correo/).fill(CODE);
  await card.getByRole('button', { name: 'Entrar' }).click();
}

async function addAccount(page: Page, id: string, name: string) {
  const form = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Cuentas' }) });
  await form.getByLabel('Código').fill(id);
  await form.getByLabel('Nombre').fill(name);
  await form.getByRole('button', { name: 'Agregar cuenta' }).click();
  await expect(form.getByRole('cell', { name, exact: true })).toBeVisible();
}

test('sync: encrypted upload, second device with the passphrase, changes, and a conflict resolved by hand', async ({ browser }) => {
  const fake = new FakeSupabase();
  const a = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[0]!);
  const b = await device(await browser.newContext({ acceptDownloads: true }), fake, ports[1]!);
  const cardA = a.locator('.sync-card');
  const cardB = b.locator('.sync-card');

  // Device A: demo data, sign in, create the passphrase. A backup is handed over before the first upload.
  await a.getByRole('button', { name: 'Cargar demostración' }).first().click();
  await a.goto(`http://127.0.0.1:${ports[0]}/#/datos`);
  await expect(a.locator('.sync-badge')).toContainText('Sin sincronizar');
  await signIn(a, 'yo@example.test');
  await expect(cardA.getByText('Todavía no hay una copia en la nube')).toBeVisible();
  await cardA.getByLabel('Frase', { exact: true }).fill(PASS);
  await cardA.getByLabel('Repite la frase').fill(PASS);
  const activate = cardA.getByRole('button', { name: 'Descargar respaldo y activar' });
  await expect(activate).toBeDisabled();
  await cardA.getByRole('checkbox').check();
  if (shots) await cardA.screenshot({ path: `${shots}/sync-passphrase.png` });
  const backup = a.waitForEvent('download');
  await activate.click();
  expect((await backup).suggestedFilename()).toMatch(/^inversiones-respaldo-.*\.json$/);
  await expect(cardA.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(fake.rows.get('yo@example.test')?.version).toBe(1);
  // Only ciphertext reaches the server.
  const stored = atob(fake.rows.get('yo@example.test')!.blob);
  expect(stored).not.toContain('Broker');
  expect(stored).not.toContain('"ledger"');

  // Device B: empty, signs in, a wrong passphrase changes nothing, the right one brings the data.
  await signIn(b, 'yo@example.test');
  await cardB.getByLabel('Tu frase').fill('frase equivocada');
  await cardB.getByRole('button', { name: 'Abrir mis datos' }).click();
  await expect(cardB.getByRole('alert')).toContainText('Esa frase no abre tus datos');
  await cardB.getByLabel('Tu frase').fill(PASS);
  await cardB.getByRole('button', { name: 'Abrir mis datos' }).click();
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

test('sync: the emailed link signs in on the page it came back to, and an expired one says so', async ({ browser }) => {
  const fake = new FakeSupabase();
  const ctx = await browser.newContext();
  const a = await device(ctx, fake, ports[0]!);
  const card = a.locator('.sync-card');
  await card.getByLabel('Correo').fill('link@example.test');
  await card.getByRole('button', { name: 'Enviarme el enlace' }).click();
  await expect(card.getByText('en este mismo navegador')).toBeVisible();
  expect(fake.redirect).toBe(`http://127.0.0.1:${ports[0]}/`);

  // What Supabase does when the link is opened: back to redirect_to with the session in the hash.
  const s = fake.session('link@example.test');
  const hash = new URLSearchParams({ access_token: s.access_token, refresh_token: s.refresh_token, expires_in: String(s.expires_in), expires_at: String(s.expires_at), token_type: 'bearer', type: 'magiclink' });
  const b = await ctx.newPage();
  const errors: string[] = [];
  b.on('pageerror', (e) => errors.push(e.message));
  await b.goto(`${fake.redirect}#${hash}`);
  await expect(b.locator('.sync-card').getByLabel('Frase', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(b).toHaveURL(/#\/datos$/);
  // The tab that asked for the link follows.
  await expect(card.getByLabel('Frase', { exact: true })).toBeVisible({ timeout: 15_000 });

  const ctx2 = await browser.newContext();
  await ctx2.route('https://sync.test/**', (r) => fake.handle(r));
  const c = await ctx2.newPage();
  await c.goto(`http://127.0.0.1:${ports[1]}/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
  await expect(c.locator('.sync-card').getByRole('alert')).toContainText('El enlace no es válido o ya venció');
  await expect(c.locator('.sync-card').getByLabel('Correo')).toBeVisible();
  await expect(c).toHaveURL(/#\/datos$/);
  expect([...(a as Page & { errors: string[] }).errors, ...errors]).toEqual([]);
});

test('sync: a device that reopens the app keeps its key and syncs without asking again', async ({ browser }) => {
  const fake = new FakeSupabase();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const a = await device(ctx, fake, ports[0]!);
  await signIn(a, 'otro@example.test');
  const card = a.locator('.sync-card');
  await card.getByLabel('Frase', { exact: true }).fill(PASS);
  await card.getByLabel('Repite la frase').fill(PASS);
  await card.getByRole('checkbox').check();
  await card.getByRole('button', { name: 'Activar la sincronización' }).click();
  await expect(card.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
  await a.reload();
  await expect(a.locator('.sync-badge')).toContainText('Sincronizado', { timeout: 15_000 });
  await expect(card.getByLabel('Tu frase')).toHaveCount(0);
});

test('without sync configured the app shows nothing of it', async ({ page }) => {
  await page.goto(`file://${process.cwd()}/dist/index.html#/datos`);
  await expect(page.getByRole('heading', { name: 'Respaldo' })).toBeVisible();
  await expect(page.locator('.sync-card')).toHaveCount(0);
  await expect(page.locator('.sync-badge')).toHaveCount(0);
});

async function link(page: Page, email: string) {
  await signIn(page, email);
  const card = page.locator('.sync-card');
  await card.getByLabel('Frase', { exact: true }).fill(PASS);
  await card.getByLabel('Repite la frase').fill(PASS);
  await card.getByRole('checkbox').check();
  await card.getByRole('button', { name: /activar/ }).click();
  await expect(card.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 15_000 });
}

async function open(page: Page, email: string) {
  await signIn(page, email);
  const card = page.locator('.sync-card');
  await card.getByLabel('Tu frase').fill(PASS);
  await card.getByRole('button', { name: 'Abrir mis datos' }).click();
}

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
  await expect(card.getByLabel('Tu frase')).toHaveCount(0);
  await expect(card.getByLabel('Correo')).toHaveCount(0);
  fake.down = false;
  // No click: the app recovers on its own once the auth client lets the refresh through.
  await expect(card.getByText('Sincronizado', { exact: true })).toBeVisible({ timeout: 100_000 });
  await expect(card.getByLabel('Tu frase')).toHaveCount(0);
  expect(fake.refreshes).toBeGreaterThan(0);
  expect(fake.rows.get('yo@example.test')?.version).toBe(2);
});
