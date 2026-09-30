import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useState } from 'preact/hooks';
import { deriveKey, KDF_ITERATIONS, loginSecret, newSalt, seal, unseal, validKdf, WrongPassphrase } from '../data/crypto.ts';
import type { Dataset } from '../data/json.ts';
import { download } from './download.ts';
import { today } from './format.ts';
import { DIRTY, getDataset, getGeneration, kvGet, kvSet, kvSetMany, onLocalChange, ready, replaceDataset } from './store.ts';
import { decideSync } from './syncPlan.ts';

/**
 * Optional cloud sync through Supabase. Local first: IndexedDB stays the working copy and the app works
 * offline. One password per user: the account signs in with a secret derived from it (`loginSecret`) and the
 * dataset is sealed with another key derived from it before it is uploaded, so the server only stores
 * ciphertext and never sees the password. Saves are optimistic on a version number and are never merged: when both
 * sides changed (or the cloud copy went back), the user picks one, and the other is kept on this device and
 * handed over as a file first.
 *
 * Built only when VITE_SUPABASE_URL and VITE_SUPABASE_KEY are set (the published site); without them the app
 * stays local and shows nothing of this.
 */
const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY_ = import.meta.env.VITE_SUPABASE_KEY as string | undefined;
export const syncConfigured = Boolean(URL_ && KEY_);

export type SyncStatus =
  | 'off'
  | 'starting'
  | 'signed-out'
  /** Signed in, but this device does not hold the key: the password opens the data again. */
  | 'needs-password'
  | 'synced'
  | 'pending'
  | 'syncing'
  | 'offline'
  | 'conflict'
  | 'error';

export interface SyncState {
  status: SyncStatus;
  email?: string;
  lastSync?: string;
  /** The last problem, in words for the user. */
  message?: string;
  /** In a conflict: the cloud copy (version 0: there is none any more), when and from which device it was saved. */
  remote?: { version: number; updatedAt?: string; device?: string };
  /** When a copy was last replaced by a sync choice; that copy stays on this device. */
  replacedAt?: string;
}

interface Meta {
  baseVersion: number;
  salt?: string;
  iterations?: number;
  lastSync?: string;
}

interface Replaced {
  at: string;
  data: Dataset;
}

const META = 'sync:meta';
const KEY = 'sync:key';
const REPLACED = 'sync:replaced';
const PUSH_DELAY = 3000;
const SESSION_RETRY = 30_000;
/** States in which this device is linked and may talk to the cloud on its own. */
const LINKED: SyncStatus[] = ['synced', 'pending', 'syncing', 'offline', 'error'];

let state: SyncState = { status: syncConfigured ? 'starting' : 'off' };
const subs = new Set<() => void>();
function update(p: Partial<SyncState>) {
  state = { ...state, ...p };
  subs.forEach((s) => s());
}

export function getSyncState(): SyncState {
  return state;
}

export function useSync(): SyncState {
  const [, force] = useState(0);
  useEffect(() => {
    const s = () => force((n) => n + 1);
    subs.add(s);
    s();
    return () => {
      subs.delete(s);
    };
  }, []);
  return state;
}

let client: SupabaseClient | undefined;
let meta: Meta = { baseVersion: 0 };
let key: CryptoKey | undefined;
/** Local changes not yet in the cloud (mirrors the DIRTY flag the store writes with every change). */
let dirty = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let busy: Promise<void> = Promise.resolve();
/** The cloud copy held while the user resolves a conflict (no data: the cloud copy is gone). */
let pending: { data?: Dataset; version: number } | undefined;
/** The session could not be checked at start (no network): retry before anything else. */
let sessionUnknown = false;
let retry: ReturnType<typeof setTimeout> | undefined;

export function isEmptyDataset(d: Dataset): boolean {
  return [d.accounts, d.assets, d.benchmarks, d.ledger, d.prices, d.fx, d.closes].every((a) => a.length === 0);
}

function device(): string {
  const ua = navigator.userAgent;
  if (/iPhone|Android.+Mobile/.test(ua)) return 'celular';
  if (/iPad|Android/.test(ua)) return 'tableta';
  return 'computador';
}

function describe(e: unknown): Partial<SyncState> {
  const err = e as { code?: string; message?: string };
  if (err?.code === '42501') return { status: 'error', message: 'Este correo no está autorizado para sincronizar.' };
  if (!navigator.onLine) return { status: 'offline', message: undefined };
  // supabase-js reports a failed request as an error whose message is the fetch error's ("TypeError: Failed to fetch").
  if (e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(err?.message ?? '')) return { status: 'offline', message: 'No se pudo conectar con la nube.' };
  return { status: 'error', message: err?.message ?? String(e) };
}

/** Runs sync steps one at a time; a failure becomes the state shown to the user. */
function serial(step: () => Promise<void>): Promise<void> {
  busy = busy.then(step).catch((e) => update(describe(e)));
  return busy;
}

async function remoteVersion(): Promise<number> {
  const { data, error } = await client!.rpc('dataset_version');
  if (error) throw error;
  return Number(data);
}

interface Row {
  blob: string;
  salt: string;
  kdf?: { iter?: number };
  version: number;
  updated_at?: string;
  device?: string;
}

async function remoteRow(): Promise<Row> {
  const { data, error } = await client!.from('datasets').select('blob,salt,kdf,version,updated_at,device').single();
  if (error) throw error;
  return data as unknown as Row;
}

/** Decrypts and checks a cloud copy. Another passphrase (the copy was recreated elsewhere) asks for it again. */
async function openRow(row: Row, k: CryptoKey): Promise<Dataset> {
  const data = await unseal<Partial<Dataset>>(row.blob, k);
  if (data?.format !== 'investment-tracker' || data.version !== 1) throw new Error('La copia en la nube no tiene un formato válido.');
  return data as Dataset;
}

async function forgetKey(message?: string): Promise<void> {
  key = undefined;
  meta = { baseVersion: 0 };
  await kvSetMany([[KEY, undefined], [META, undefined]]);
  update({ status: 'needs-password', message });
}

async function persist(clean: boolean): Promise<void> {
  if (clean) dirty = false;
  await kvSetMany(clean ? [[META, meta], [DIRTY, false]] : [[META, meta]]);
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => void serial(check), PUSH_DELAY);
}

/** Compares this device with the cloud and does what `decideSync` says. */
async function check(): Promise<void> {
  if (!client || !key || !LINKED.includes(state.status)) return;
  update({ status: 'syncing' });
  const gen = getGeneration();
  const remote = await remoteVersion();
  const action = decideSync({ baseVersion: meta.baseVersion, dirty }, remote);
  if (action === 'idle') return update({ status: 'synced', message: undefined });
  if (action === 'push' || action === 'first-push') return push(action === 'first-push' ? 0 : meta.baseVersion);
  if (action === 'conflict') return toConflict(remote);
  const row = await remoteRow();
  let data: Dataset;
  try {
    data = await openRow(row, key);
  } catch (e) {
    if (e instanceof WrongPassphrase) return forgetKey(OTHER_PASSWORD);
    throw e;
  }
  await apply(data, row.version, gen, row);
}

async function push(expected: number): Promise<void> {
  const gen = getGeneration();
  const blob = await seal(getDataset(), key!);
  const { data, error } = await client!.rpc('save_dataset', {
    expected,
    p_blob: blob,
    p_salt: meta.salt!,
    p_kdf: { alg: 'PBKDF2-SHA-256', iter: meta.iterations ?? KDF_ITERATIONS },
    p_device: device(),
  });
  if (error) throw error;
  const v = Number(data);
  if (v === -1) return toConflict(await remoteVersion());
  meta = { ...meta, baseVersion: v, lastSync: new Date().toISOString() };
  // Changes made during the upload stay pending and go in the next one.
  await persist(getGeneration() === gen);
  update({ status: dirty ? 'pending' : 'synced', lastSync: meta.lastSync, message: undefined });
  if (dirty) schedule();
}

/** Takes a cloud copy, unless this device changed since `gen` was read: then it is a conflict, not a pull. */
async function apply(data: Dataset, version: number, gen: number, row?: Row): Promise<void> {
  if (getGeneration() !== gen) {
    pending = { data, version };
    return update({ status: 'conflict', remote: { version, updatedAt: row?.updated_at, device: row?.device } });
  }
  const done = replaceDataset(data);
  meta = { ...meta, baseVersion: version, lastSync: new Date().toISOString() };
  await done;
  // An edit made while the copy was being saved stays pending and goes up next.
  await persist(getGeneration() === gen);
  update({ status: dirty ? 'pending' : 'synced', lastSync: meta.lastSync, message: undefined, remote: undefined });
  if (dirty) schedule();
}

async function toConflict(remote: number): Promise<void> {
  if (remote === 0) {
    pending = { version: 0 };
    return update({ status: 'conflict', remote: { version: 0 } });
  }
  const row = await remoteRow();
  let data: Dataset;
  try {
    data = await openRow(row, key!);
  } catch (e) {
    if (e instanceof WrongPassphrase) return forgetKey(OTHER_PASSWORD);
    throw e;
  }
  pending = { data, version: row.version };
  update({ status: 'conflict', remote: { version: row.version, updatedAt: row.updated_at, device: row.device } });
}

/** Keeps the copy a sync choice is about to replace: on this device and as a file. */
async function keepReplaced(data: Dataset, name: string): Promise<void> {
  const at = new Date().toISOString();
  await kvSet(REPLACED, { at, data } satisfies Replaced);
  download(`${name}-${today()}.json`, JSON.stringify(data), 'application/json');
  update({ replacedAt: at });
}

/** Forgets this device's link to the cloud (key, versions). The local data stays. */
async function forget(): Promise<void> {
  clearTimeout(timer);
  key = undefined;
  pending = undefined;
  meta = { baseVersion: 0 };
  dirty = false;
  await kvSetMany([[KEY, undefined], [META, undefined], [DIRTY, undefined]]);
}

const OTHER_PASSWORD =
  'Tu contraseña no abre la copia que hay en la nube (se guardó con otra). Si no la recuerdas, borra esa copia en Supabase (tabla datasets) y vuelve a entrar desde el dispositivo que tiene tus datos.';

/** Starts sync on app load: restores the session and the saved key, and checks the cloud. */
export async function initSync(): Promise<void> {
  if (!syncConfigured || client) return;
  client = createClient(URL_!, KEY_!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  // Registered before anything is awaited: the store also persists the flag, for changes made before this.
  onLocalChange(() => {
    dirty = true;
    if (!key || !LINKED.includes(state.status)) return;
    update({ status: 'pending' });
    schedule();
  });
  await ready;
  try {
    meta = (await kvGet<Meta>(META)) ?? meta;
    key = await kvGet<CryptoKey>(KEY);
    dirty = dirty || Boolean(await kvGet<boolean>(DIRTY));
    const replaced = await kvGet<Replaced>(REPLACED);
    update({ lastSync: meta.lastSync, replacedAt: replaced?.at });
  } catch {
    /* storage blocked: sync stays signed out */
  }
  client.auth.onAuthStateChange((event) => {
    if (event === 'TOKEN_REFRESHED' && sessionUnknown) void serial(resume);
    if (event === 'SIGNED_OUT') void serial(async () => {
      await forget();
      update({ status: 'signed-out', email: undefined, lastSync: undefined, remote: undefined });
    });
  });
  addEventListener('online', () => void serial(resume));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void serial(resume);
  });
  await serial(startSession);
}

/** Restores the session. Only a confirmed absence of session forgets the key; a failure to check it does not. */
async function startSession(): Promise<void> {
  const { data, error } = await client!.auth.getSession();
  if (error) {
    // e.g. offline with an expired token: the session is still stored and refreshes when the network is back.
    // The auth client holds a failed refresh for a minute, so keep retrying until it goes through.
    sessionUnknown = true;
    clearTimeout(retry);
    retry = setTimeout(() => void serial(resume), SESSION_RETRY);
    return update(describe(error));
  }
  sessionUnknown = false;
  clearTimeout(retry);
  if (!data.session) {
    // A lost session forgets the key too, so nothing is uploaded under another account.
    if (key) await forget();
    return update({ status: 'signed-out' });
  }
  update({ email: data.session.user.email });
  if (!key) return update({ status: 'needs-password' });
  update({ status: 'syncing' });
  return check();
}

/** Back online or back to the tab: finish restoring the session if that failed, else check the cloud. */
function resume(): Promise<void> {
  return sessionUnknown ? startSession() : check();
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Correo o contraseña incorrectos. Si es la primera vez, usa «Crear cuenta».',
  user_already_exists: 'Ya hay una cuenta con este correo: usa «Entrar».',
  email_exists: 'Ya hay una cuenta con este correo: usa «Entrar».',
  email_not_confirmed: 'Supabase pide confirmar el correo: en Supabase → Authentication → Sign In / Providers → Email, desactiva «Confirm email» y vuelve a intentarlo.',
  signup_disabled: 'Crear cuentas está desactivado en Supabase.',
  weak_password: 'Supabase rechazó la contraseña por débil: revisa su política en Authentication → Sign In / Providers.',
  over_request_rate_limit: 'Demasiados intentos seguidos. Espera unos minutos.',
};

/** An auth failure in words, on the form the user is on. */
function authFailed(error: { code?: string; message: string; status?: number }, status: SyncStatus): void {
  const message = !error.status ? 'No se pudo conectar con la nube. Revisa la conexión e inténtalo de nuevo.' : ((error.code && MESSAGES[error.code]) ?? error.message);
  update({ status, message });
}

/**
 * Signs in with email and password (or first creates the account) and opens the data with the same password.
 * Supabase must not ask to confirm the email, or a new account comes back without a session.
 */
export function signIn(email: string, password: string, create = false): Promise<void> {
  return serial(async () => {
    const from = state.status === 'needs-password' ? 'needs-password' : 'signed-out';
    const address = email.trim().toLowerCase();
    const secret = await loginSecret(password, address);
    if (create) {
      const { data, error } = await client!.auth.signUp({ email: address, password: secret });
      if (error) return authFailed(error, from);
      // An existing confirmed address answers like a new one but without a session.
      if (!data.session) return update({ status: from, message: data.user?.identities?.length === 0 ? MESSAGES.user_already_exists : MESSAGES.email_not_confirmed });
    } else {
      const { error } = await client!.auth.signInWithPassword({ email: address, password: secret });
      if (error) return authFailed(error, from);
    }
    update({ email: address, message: undefined });
    try {
      await openWith(password);
    } catch (e) {
      // Signed in but the data could not be opened (e.g. the network dropped): the password is asked again.
      if (key) throw e;
      update({ ...describe(e), status: 'needs-password' });
      if (!state.message) update({ message: 'No se pudo conectar con la nube. Revisa la conexión e inténtalo de nuevo.' });
    }
  });
}

/** Signed in: creates the cloud copy from this device, or opens the one there. A wrong password changes nothing. */
async function openWith(password: string): Promise<void> {
  const gen = getGeneration();
  if ((await remoteVersion()) === 0) {
    // An empty device never starts the cloud copy: the one with the data does (it would otherwise ask the
    // device with the data to choose between its data and an empty copy).
    if (isEmptyDataset(getDataset())) {
      await client!.auth.signOut({ scope: 'local' });
      return update({ status: 'signed-out', message: 'Todavía no hay datos en la nube. Entra primero desde el dispositivo que tiene tus datos.' });
    }
    download(`inversiones-respaldo-${today()}.json`, JSON.stringify(getDataset()), 'application/json');
    const salt = newSalt();
    key = await deriveKey(password, salt);
    meta = { baseVersion: 0, salt, iterations: KDF_ITERATIONS };
    dirty = true;
    await kvSetMany([[KEY, key], [META, meta], [DIRTY, true]]);
    update({ status: 'syncing' });
    return check();
  }
  const row = await remoteRow();
  const iterations = row.kdf?.iter ?? KDF_ITERATIONS;
  if (!validKdf(row.salt, iterations)) throw new Error('La copia en la nube no tiene un formato válido: no se abrió.');
  const k = await deriveKey(password, row.salt, iterations);
  let data: Dataset;
  try {
    data = await openRow(row, k);
  } catch (e) {
    if (e instanceof WrongPassphrase) return update({ status: 'needs-password', message: OTHER_PASSWORD });
    throw e;
  }
  key = k;
  // This device was linked to this same copy (only its key was lost): it syncs as usual from where it was.
  if (meta.salt === row.salt && meta.baseVersion > 0) {
    await kvSet(KEY, key);
    update({ status: 'syncing' });
    return check();
  }
  meta = { baseVersion: 0, salt: row.salt, iterations };
  if (isEmptyDataset(getDataset())) {
    await kvSetMany([[KEY, key], [META, meta]]);
    return apply(data, row.version, gen, row);
  }
  // This device already had data of its own: the user decides which copy stays. Marked in the same write
  // as the key, so a reload in between can never take the cloud copy over it.
  dirty = true;
  await kvSetMany([[KEY, key], [META, meta], [DIRTY, true]]);
  pending = { data, version: row.version };
  update({ status: 'conflict', message: undefined, remote: { version: row.version, updatedAt: row.updated_at, device: row.device } });
}

/** Conflict: keep this device's data and upload it. The cloud copy is kept here and handed over first. */
export function keepThisDevice(): Promise<void> {
  return serial(async () => {
    if (!pending) return;
    if (pending.data) await keepReplaced(pending.data, 'inversiones-nube');
    const { version } = pending;
    pending = undefined;
    meta = { ...meta, baseVersion: version };
    dirty = true;
    await persist(false);
    update({ status: 'syncing', remote: undefined });
    await push(version);
  });
}

/** Conflict: use the cloud copy. This device's data is kept here and handed over first. */
export function useCloudCopy(): Promise<void> {
  return serial(async () => {
    if (!pending?.data) return;
    const gen = getGeneration();
    await keepReplaced(getDataset(), 'inversiones-este-dispositivo');
    const { data, version } = pending;
    pending = undefined;
    // An edit made while the backup was being written makes this a conflict again instead of losing it.
    await apply(data, version, gen);
  });
}

/** The copy last replaced by a sync choice, as a file. */
export async function downloadReplaced(): Promise<void> {
  const r = await kvGet<Replaced>(REPLACED);
  if (r) download(`inversiones-reemplazada-${r.at.slice(0, 10)}.json`, JSON.stringify(r.data), 'application/json');
}

export function syncNow(): Promise<void> {
  clearTimeout(timer);
  return serial(resume);
}

/** Signs out and forgets the key on this device. The local data stays. */
export function signOut(): Promise<void> {
  return serial(async () => {
    await forget();
    await client!.auth.signOut({ scope: 'local' });
    update({ status: 'signed-out', email: undefined, lastSync: undefined, message: undefined, remote: undefined });
  });
}
