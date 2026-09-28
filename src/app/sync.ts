import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useState } from 'preact/hooks';
import { deriveKey, KDF_ITERATIONS, newSalt, seal, unseal, WrongPassphrase } from '../data/crypto.ts';
import type { Dataset } from '../data/json.ts';
import { download } from './download.ts';
import { today } from './format.ts';
import { DIRTY, getDataset, getGeneration, kvGet, kvSet, kvSetMany, onLocalChange, ready, replaceDataset } from './store.ts';
import { decideSync } from './syncPlan.ts';

/**
 * Optional cloud sync through Supabase. Local first: IndexedDB stays the working copy and the app works
 * offline. The dataset is sealed with a key derived from the user's passphrase before it is uploaded, so the
 * server only stores ciphertext. Saves are optimistic on a version number and are never merged: when both
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
  | 'code-sent'
  | 'new-passphrase'
  | 'needs-passphrase'
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
  if (e instanceof TypeError || err?.message === 'Failed to fetch') return { status: 'offline', message: 'No se pudo conectar con la nube.' };
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
  update({ status: 'needs-passphrase', message });
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
    if (e instanceof WrongPassphrase) return forgetKey('La copia en la nube se cifró con otra frase. Escríbela para abrirla.');
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
    if (e instanceof WrongPassphrase) return forgetKey('La copia en la nube se cifró con otra frase. Escríbela para abrirla.');
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
  if (!key) return afterSignIn();
  update({ status: 'syncing' });
  return check();
}

/** Back online or back to the tab: finish restoring the session if that failed, else check the cloud. */
function resume(): Promise<void> {
  return sessionUnknown ? startSession() : check();
}

async function afterSignIn(): Promise<void> {
  const remote = await remoteVersion();
  update({ status: remote === 0 ? 'new-passphrase' : 'needs-passphrase', message: undefined });
}

export function sendCode(email: string): Promise<void> {
  return serial(async () => {
    const { error } = await client!.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
    if (error) throw error;
    update({ status: 'code-sent', email: email.trim(), message: undefined });
  });
}

export function verifyCode(code: string): Promise<void> {
  return serial(async () => {
    const { error } = await client!.auth.verifyOtp({ email: state.email!, token: code.trim(), type: 'email' });
    if (error) return update({ status: 'code-sent', message: 'El código no es válido o ya venció. Pide uno nuevo.' });
    await afterSignIn();
  });
}

export function restart(): void {
  update({ status: 'signed-out', message: undefined });
}

/** First device: creates the passphrase and uploads this device's data (after handing over a backup). */
export function createPassphrase(passphrase: string): Promise<void> {
  return serial(async () => {
    if (!isEmptyDataset(getDataset())) download(`inversiones-respaldo-${today()}.json`, JSON.stringify(getDataset()), 'application/json');
    const salt = newSalt();
    key = await deriveKey(passphrase, salt);
    meta = { baseVersion: 0, salt, iterations: KDF_ITERATIONS };
    dirty = true;
    await kvSetMany([[KEY, key], [META, meta], [DIRTY, true]]);
    update({ status: 'syncing', message: undefined });
    await check();
  });
}

/** Another device: opens the cloud copy with the passphrase. A wrong one changes nothing. */
export function unlock(passphrase: string): Promise<void> {
  return serial(async () => {
    const gen = getGeneration();
    const row = await remoteRow();
    const iterations = row.kdf?.iter ?? KDF_ITERATIONS;
    const k = await deriveKey(passphrase, row.salt, iterations);
    let data: Dataset;
    try {
      data = await openRow(row, k);
    } catch (e) {
      if (e instanceof WrongPassphrase) return update({ status: 'needs-passphrase', message: 'Esa frase no abre tus datos. Revísala e inténtalo de nuevo.' });
      throw e;
    }
    key = k;
    meta = { baseVersion: 0, salt: row.salt, iterations };
    await kvSetMany([[KEY, key], [META, meta]]);
    if (isEmptyDataset(getDataset())) return apply(data, row.version, gen, row);
    // This device already had data of its own: the user decides which copy stays.
    dirty = true;
    await kvSet(DIRTY, true);
    pending = { data, version: row.version };
    update({ status: 'conflict', message: undefined, remote: { version: row.version, updatedAt: row.updated_at, device: row.device } });
  });
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
