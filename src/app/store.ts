import { useEffect, useState } from 'preact/hooks';
import { emptyDataset } from '../data/json.ts';
import type { Dataset } from '../data/json.ts';

/**
 * The whole dataset lives in the browser's IndexedDB (one record). It leaves the device only through the
 * optional cloud sync (`sync.ts`), encrypted with the user's passphrase first.
 * Every change replaces the dataset object: identity changes drive recomputation.
 */
const DB = 'investment-tracker';
const STORE = 'kv';
const KEY = 'dataset';

let db: Promise<IDBDatabase> | undefined;
/** One connection for the page, so transactions are created (and commit) in the order they are requested. */
function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

/** Raw access to the same key-value store, also used by cloud sync for its own state (key, versions). */
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const conn = await open();
  return new Promise((resolve, reject) => {
    const req = conn.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** Writes several keys in one transaction (`undefined` deletes): all or nothing. */
export async function kvSetMany(entries: [string, unknown][]): Promise<void> {
  const conn = await open();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE, 'readwrite');
    for (const [key, value] of entries) {
      if (value === undefined) tx.objectStore(STORE).delete(key);
      else tx.objectStore(STORE).put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kvSet = (key: string, value: unknown) => kvSetMany([[key, value]]);

/**
 * Set with every local change, in the same transaction as the dataset, so an edit that has not reached the
 * cloud is known even after a reload. Cloud sync clears it once its upload matches this device.
 */
export const DIRTY = 'sync:dirty';

let current: Dataset = emptyDataset();
let loaded = false;
let storageError: string | undefined;
/** Bumped synchronously on every local change: sync compares it before and after a network round trip. */
let generation = 0;
export const getGeneration = () => generation;
const listeners = new Set<() => void>();
/** Called after each change made on this device (not after a copy pulled from the cloud). */
const localChanges = new Set<() => void>();
export function onLocalChange(l: () => void): void {
  localChanges.add(l);
}
const notify = () => listeners.forEach((l) => l());

export const ready: Promise<void> = kvGet<Dataset>(KEY)
  .then((d) => {
    if (d) current = { ...emptyDataset(), ...d };
  })
  .catch((e) => {
    storageError = `No se pudo abrir el almacenamiento del navegador: ${e}. Los cambios no se guardarán.`;
  })
  .finally(() => {
    loaded = true;
    notify();
  });

export function getDataset(): Dataset {
  return current;
}

async function store(next: Dataset, local: boolean): Promise<void> {
  current = next;
  notify();
  try {
    await kvSetMany(local ? [[KEY, next], [DIRTY, true]] : [[KEY, next]]);
    storageError = undefined;
  } catch (e) {
    storageError = `No se pudo guardar en el navegador: ${e}`;
  }
  notify();
}

export async function setDataset(next: Dataset): Promise<void> {
  generation++;
  localChanges.forEach((l) => l());
  await store(next, true);
}

/** Replaces the dataset with a copy from the cloud: saved and shown, but not a local change. */
export async function replaceDataset(next: Dataset): Promise<void> {
  await store({ ...emptyDataset(), ...next }, false);
}

export function useDataset(): { data: Dataset; loaded: boolean; storageError?: string } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    l(); // catch up on any change (e.g. the initial load) that happened before subscribing
    return () => listeners.delete(l);
  }, []);
  return { data: current, loaded, storageError };
}

/** Per-viewer UI preferences (currency, window…). Best effort: private windows may block storage. */
export function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(`pref:${key}`) as T | null) ?? initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(`pref:${key}`, nv);
      } catch {
        /* ignore */
      }
    },
  ];
}
