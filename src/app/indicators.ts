import { Decimal, ZERO } from '../domain/money.ts';
import type { Ccy } from '../domain/money.ts';
import type { IsoDate } from '../domain/dates.ts';
import type { PricePoint } from '../domain/prices.ts';
import type { Fundamentals, MoatRating, SecData } from '../domain/types.ts';
import { secFundamentals } from '../data/sec.ts';
import type { SecField, SecResult } from '../data/sec.ts';
import type { ValuationMethod } from '../domain/valuation.ts';
import { positionRows } from './analysis.ts';
import type { Context } from './analysis.ts';

/** One open holding (all accounts together) with its weight in the chosen portfolio and the user's thesis. */
export interface IndicatorRow {
  asset: string;
  name: string;
  symbol?: string;
  /** Quote currency: prices and targets are in it. */
  ccy: Ccy;
  bucket: string;
  accounts: string[];
  /** Value in the report currency. */
  value: Decimal;
  /** Share of the rows' total value. */
  weight: number;
  method: ValuationMethod;
  price?: PricePoint;
  target?: Decimal;
  targetHigh?: Decimal;
  /** target / price − 1: what the price still has to rise (negative once passed). */
  upside?: number;
  upsideHigh?: number;
  strategy?: string;
  region?: string;
  ideaSource?: string;
  note?: string;
  /** What the user copied by hand, with the SEC's figures over it where the filings give them. */
  f: Fundamentals;
  /** The SEC's figures (see src/data/sec.ts) and the fields of `f` they fill. */
  sec?: SecResult & { data: SecData; fields: SecField[] };
  /** What the user copied by hand, as stored. */
  manual: Fundamentals;
  moats: MoatRating[];
  /** The moat category used for the composition: see `moatOf`. */
  moat?: MoatRating['rating'];
}

/** Morningstar's category when there is one (the reference for moat ratings), else the first provider that gives a category. */
export function moatOf(ratings: readonly MoatRating[]): MoatRating['rating'] {
  return (ratings.find((m) => m.source === 'Morningstar' && m.rating) ?? ratings.find((m) => m.rating))?.rating;
}

/**
 * The SEC's ratios take the place of the hand-copied ones for the fields the filings give (they are dated
 * and sourced); the rest (size, style, stars, and any ratio the filings lack) stays as copied.
 */
export function withSec(manual: Fundamentals, data: SecData | undefined, ccy: Ccy, price: PricePoint | undefined, asOf: IsoDate): Pick<IndicatorRow, 'f' | 'sec' | 'manual'> {
  if (!data || data.error) return { f: manual, manual };
  const r = secFundamentals(data, ccy, price?.close, asOf);
  const fields = Object.keys(r.f) as SecField[];
  return { f: { ...manual, ...r.f }, sec: { ...r, data, fields }, manual };
}

const upsideTo = (t: Decimal | undefined, p: PricePoint | undefined) => (t && p && !p.close.isZero() ? t.div(p.close).minus(1).toNumber() : undefined);

export function indicatorRows(ctx: Context, ccy: Ccy, asOf: IsoDate, buckets: readonly string[]): IndicatorRow[] {
  const byAsset = new Map<string, { value: Decimal; accounts: string[]; method: ValuationMethod }>();
  for (const p of positionRows(ctx, ccy, asOf)) {
    if (!p.open || !buckets.includes(p.bucket)) continue;
    const g = byAsset.get(p.asset) ?? { value: ZERO, accounts: [], method: p.method };
    g.value = g.value.plus(p.value);
    g.accounts.push(p.accountName);
    if (p.method === 'cost') g.method = 'cost';
    byAsset.set(p.asset, g);
  }
  const total = [...byAsset.values()].reduce((s, g) => s.plus(g.value), ZERO);
  const rows: IndicatorRow[] = [];
  for (const [id, g] of byAsset) {
    const a = ctx.book.assets.get(id)!;
    const price = a.pricing === 'market' && a.symbol ? ctx.book.prices.close(a.symbol, asOf) : undefined;
    const target = a.target ? new Decimal(a.target) : undefined;
    const targetHigh = a.targetHigh ? new Decimal(a.targetHigh) : undefined;
    rows.push({
      asset: id,
      name: a.name,
      symbol: a.symbol,
      ccy: a.ccy,
      bucket: a.bucket,
      accounts: g.accounts,
      value: g.value,
      weight: total.isZero() ? 0 : g.value.div(total).toNumber(),
      method: g.method,
      price,
      target,
      targetHigh,
      upside: upsideTo(target, price),
      upsideHigh: upsideTo(targetHigh, price),
      strategy: a.strategy,
      region: a.region,
      ideaSource: a.ideaSource,
      note: a.note,
      ...withSec(a.fundamentals ?? {}, a.sec, a.ccy, price, asOf),
      moats: a.moats ?? [],
      moat: moatOf(a.moats ?? []),
    });
  }
  return rows.sort((x, y) => y.weight - x.weight || x.name.localeCompare(y.name));
}

export interface Slice {
  /** '' groups the rows without a value for the dimension. */
  key: string;
  value: Decimal;
  weight: number;
  names: string[];
}

/** Weight per value of a dimension (market, strategy, idea source, style…), largest first, unassigned last. */
export function breakdown(rows: readonly IndicatorRow[], key: (r: IndicatorRow) => string | undefined): Slice[] {
  const m = new Map<string, Slice>();
  for (const r of rows) {
    const k = key(r) ?? '';
    const s = m.get(k) ?? { key: k, value: ZERO, weight: 0, names: [] };
    s.value = s.value.plus(r.value);
    s.weight += r.weight;
    s.names.push(r.name);
    m.set(k, s);
  }
  return [...m.values()].sort((a, b) => (a.key === '') !== (b.key === '') ? (a.key === '' ? 1 : -1) : b.weight - a.weight);
}

/**
 * Value-weighted potential to the targets: Σ weight·upside over the holdings that have a target and a price,
 * divided by their weight. `coverage` is that weight, the share of the portfolio the figure speaks for.
 */
export function weightedUpside(rows: readonly IndicatorRow[], which: 'upside' | 'upsideHigh'): { upside?: number; coverage: number } {
  const known = rows.filter((r) => r[which] !== undefined);
  const w = known.reduce((s, r) => s + r.weight, 0);
  const all = rows.reduce((s, r) => s + r.weight, 0);
  return { upside: w > 0 ? known.reduce((s, r) => s + r.weight * r[which]!, 0) / w : undefined, coverage: all > 0 ? w / all : 0 };
}

/** Top weights and the effective number of holdings, 1 / Σ w² (equal weights: the count itself). */
export function concentration(rows: readonly IndicatorRow[]): { top5: number; effective?: number } {
  const w = rows.map((r) => r.weight).sort((a, b) => b - a);
  const hhi = w.reduce((s, x) => s + x * x, 0);
  return { top5: w.slice(0, 5).reduce((s, x) => s + x, 0), effective: hhi > 0 ? 1 / hhi : undefined };
}
