import { dec } from '../domain/money.ts';
import { FxTable } from '../domain/fx.ts';
import type { RatePoint } from '../domain/fx.ts';
import { SeriesPriceSource } from '../domain/prices.ts';
import type { PricePoint } from '../domain/prices.ts';
import type { Account, Asset } from '../domain/types.ts';
import { CsvError, parseCsv } from './csv.ts';
import type { Benchmark, StoredPrice, StoredRate } from './json.ts';

function table(text: string, required: string[]): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const cols = header.map((h) => h.trim().toLowerCase());
  for (const c of required) if (!cols.includes(c)) throw new CsvError(`Falta la columna "${c}"`);
  return rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? '').trim()])));
}

export interface BookFile {
  accounts: Account[];
  assets: Asset[];
  benchmarks?: Benchmark[];
}

export function parseBook(json: string): { accounts: Map<string, Account>; assets: Map<string, Asset>; benchmarks: Benchmark[] } {
  const b = JSON.parse(json) as BookFile;
  return { accounts: new Map(b.accounts.map((a) => [a.id, a])), assets: new Map(b.assets.map((a) => [a.id, a])), benchmarks: b.benchmarks ?? [] };
}

/** Columns: symbol, date, close, ccy, source. */
export function readPriceRows(text: string): StoredPrice[] {
  return table(text, ['symbol', 'date', 'close', 'ccy']).map((r) => {
    dec(r.close!);
    return { symbol: r.symbol!, date: r.date!, close: r.close!, ccy: r.ccy!, source: r.source || 'desconocida' };
  });
}

/**
 * Columns: ccy, date, per_usd, source. `ccy` is either a currency (value = units per USD, e.g. COP TRM)
 * or a pair quoted against USD like `EUR/USD` (value = USD per unit, market convention; inverted on load).
 */
export function readFxRows(text: string): StoredRate[] {
  return table(text, ['ccy', 'date', 'per_usd']).map((r) => {
    const pair = r.ccy!.endsWith('/USD');
    const v = dec(r.per_usd!);
    if (!v.gt(0)) throw new CsvError(`${r.ccy} ${r.date}: la tasa debe ser positiva (${r.per_usd})`);
    return { ccy: pair ? r.ccy!.slice(0, -4) : r.ccy!, date: r.date!, perUsd: (pair ? dec(1).div(v) : v).toString(), source: r.source || 'desconocida' };
  });
}

export function priceSource(rows: readonly StoredPrice[], maxStaleDays?: number): SeriesPriceSource {
  const by = new Map<string, PricePoint[]>();
  for (const r of rows) {
    const pts = by.get(r.symbol) ?? [];
    pts.push({ date: r.date, close: dec(r.close), ccy: r.ccy, source: r.source });
    by.set(r.symbol, pts);
  }
  const src = new SeriesPriceSource(maxStaleDays);
  for (const [s, pts] of by) src.set(s, pts);
  return src;
}

export function fxTable(rows: readonly StoredRate[], maxStaleDays?: number): FxTable {
  const by = new Map<string, RatePoint[]>();
  for (const r of rows) {
    const pts = by.get(r.ccy) ?? [];
    pts.push({ date: r.date, perUsd: dec(r.perUsd), source: r.source });
    by.set(r.ccy, pts);
  }
  const fx = new FxTable(maxStaleDays);
  for (const [c, pts] of by) fx.set(c, pts);
  return fx;
}

export const parsePrices = (text: string, maxStaleDays?: number) => priceSource(readPriceRows(text), maxStaleDays);
export const parseFx = (text: string, maxStaleDays?: number) => fxTable(readFxRows(text), maxStaleDays);
