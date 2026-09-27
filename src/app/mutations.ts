import { parseLedgerCsv } from '../data/csv.ts';
import { emptyDataset, toStored } from '../data/json.ts';
import type { Dataset, MonthClose, StoredPrice, StoredRate } from '../data/json.ts';
import { readFxRows, readPriceRows } from '../data/load.ts';
import type { BookFile } from '../data/load.ts';
import type { Account, Asset, Transaction } from '../domain/types.ts';
import sampleBook from '../../samples/book.json?raw';
import sampleLedger from '../../samples/ledger.csv?raw';
import samplePrices from '../../samples/prices.csv?raw';
import sampleFx from '../../samples/fx.csv?raw';

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

const withIds = (txs: Transaction[]) => txs.map((t) => (t.id ? t : { ...t, id: newId() }));

export function addTransactions(d: Dataset, txs: Transaction[]): Dataset {
  return { ...d, ledger: [...d.ledger, ...withIds(txs).map(toStored)] };
}

/** Replaces the transaction `id` (and, for a transfer, keeps the pair together by replacing every leg given). */
export function replaceTransactions(d: Dataset, ids: string[], txs: Transaction[]): Dataset {
  const keep = d.ledger.filter((t) => !t.id || !ids.includes(t.id));
  return { ...d, ledger: [...keep, ...withIds(txs).map(toStored)] };
}

export function deleteTransactions(d: Dataset, ids: string[]): Dataset {
  return { ...d, ledger: d.ledger.filter((t) => !t.id || !ids.includes(t.id)) };
}

/** Records (or re-records) the close of a month. */
export function closeMonth(d: Dataset, c: MonthClose): Dataset {
  return { ...d, closes: [...(d.closes ?? []).filter((x) => x.month !== c.month), c] };
}

export function reopenMonth(d: Dataset, month: string): Dataset {
  return { ...d, closes: (d.closes ?? []).filter((x) => x.month !== month) };
}

export function upsertAsset(d: Dataset, a: Asset): Dataset {
  return { ...d, assets: [...d.assets.filter((x) => x.id !== a.id), a] };
}

export function upsertAccount(d: Dataset, a: Account): Dataset {
  return { ...d, accounts: [...d.accounts.filter((x) => x.id !== a.id), a] };
}

export function importLedger(d: Dataset, csv: string, mode: 'replace' | 'append'): Dataset {
  const txs = withIds(parseLedgerCsv(csv)).map(toStored);
  return { ...d, ledger: mode === 'replace' ? txs : [...d.ledger, ...txs] };
}

export function importBook(d: Dataset, json: string): Dataset {
  const b = JSON.parse(json) as BookFile;
  if (!Array.isArray(b.accounts) || !Array.isArray(b.assets)) throw new Error('El archivo debe tener "accounts" y "assets"');
  const merge = <T extends { id?: string; symbol?: string }>(old: T[], add: T[], key: (x: T) => string) => {
    const keys = new Set(add.map(key));
    return [...old.filter((x) => !keys.has(key(x))), ...add];
  };
  return {
    ...d,
    accounts: merge(d.accounts, b.accounts, (x) => x.id),
    assets: merge(d.assets, b.assets, (x) => x.id),
    benchmarks: b.benchmarks ? merge(d.benchmarks, b.benchmarks, (x) => x.symbol) : d.benchmarks,
  };
}

/** Merges quotes: a new row for the same symbol and date replaces the old one. */
export function importPrices(d: Dataset, csv: string): Dataset {
  return { ...d, prices: mergeRows(d.prices, readPriceRows(csv), (r) => `${r.symbol}|${r.date}`) };
}

export function importFx(d: Dataset, csv: string): Dataset {
  return { ...d, fx: mergeRows(d.fx, readFxRows(csv), (r) => `${r.ccy}|${r.date}`) };
}

function mergeRows<T extends StoredPrice | StoredRate>(old: T[], add: T[], key: (r: T) => string): T[] {
  const m = new Map(old.map((r) => [key(r), r]));
  for (const r of add) m.set(key(r), r);
  return [...m.values()];
}

export function demoDataset(): Dataset {
  let d = importBook(emptyDataset(), sampleBook);
  d = importLedger(d, sampleLedger, 'replace');
  d = importPrices(d, samplePrices);
  return importFx(d, sampleFx);
}
