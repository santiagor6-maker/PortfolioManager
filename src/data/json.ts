import { dec } from '../domain/money.ts';
import type { Account, Asset, Transaction } from '../domain/types.ts';

/** JSON-safe transaction: decimals as strings so nothing passes through a binary float. */
export type StoredTx = Omit<Transaction, 'qty' | 'amount' | 'fee'> & { qty?: string; amount: string; fee?: string };

export interface StoredPrice {
  symbol: string;
  date: string;
  close: string;
  ccy: string;
  source: string;
}

export interface StoredRate {
  /** Currency, quoted as units per 1 USD. */
  ccy: string;
  date: string;
  perUsd: string;
  source: string;
}

/** A total-return index used to compare the asset classes listed in `buckets`. */
export interface Benchmark {
  symbol: string;
  name: string;
  buckets: string[];
}

/**
 * A month the user closed, with the figures as they stood (in COP), so a later change to that month
 * (a late dividend, a corrected price) can be flagged instead of silently rewriting a closed month.
 */
export interface MonthClose {
  /** Month-end date. */
  month: string;
  closedAt: string;
  total: string;
  exRealEstate: string;
  gain: string;
}

/** Everything the app stores. Exported as a single JSON backup. */
export interface Dataset {
  format: 'investment-tracker';
  version: 1;
  accounts: Account[];
  assets: Asset[];
  benchmarks: Benchmark[];
  ledger: StoredTx[];
  prices: StoredPrice[];
  fx: StoredRate[];
  closes: MonthClose[];
}

export function emptyDataset(): Dataset {
  return { format: 'investment-tracker', version: 1, accounts: [], assets: [], benchmarks: [], ledger: [], prices: [], fx: [], closes: [] };
}

export function toStored(t: Transaction): StoredTx {
  const { qty, amount, fee, ...rest } = t;
  return { ...rest, amount: amount.toString(), ...(qty ? { qty: qty.toString() } : {}), ...(fee ? { fee: fee.toString() } : {}) };
}

export function fromStored(t: StoredTx): Transaction {
  const { qty, amount, fee, ...rest } = t;
  return { ...rest, amount: dec(amount), ...(qty ? { qty: dec(qty) } : {}), ...(fee ? { fee: dec(fee) } : {}) };
}

export function parseDataset(json: string): Dataset {
  const d = JSON.parse(json) as Partial<Dataset>;
  if (d.format !== 'investment-tracker' || d.version !== 1) throw new Error('No es un respaldo de este tracker (formato o versión desconocidos)');
  return { ...emptyDataset(), ...d } as Dataset;
}
