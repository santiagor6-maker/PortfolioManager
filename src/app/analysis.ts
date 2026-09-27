import { ZERO, sum } from '../domain/money.ts';
import type { Ccy, Decimal } from '../domain/money.ts';
import { addDays, daysBetween, monthEnd, monthEnds } from '../domain/dates.ts';
import type { IsoDate } from '../domain/dates.ts';
import { ksPme } from '../domain/benchmark.ts';
import { MissingDataError } from '../domain/fx.ts';
import { apply } from '../domain/holdings.ts';
import type { Holdings, Position } from '../domain/holdings.ts';
import { positionKey, sortLedger } from '../domain/ledger.ts';
import { portfolioSeries } from '../domain/portfolio.ts';
import type { Flow, Scope } from '../domain/portfolio.ts';
import { annualize, performance } from '../domain/returns.ts';
import type { Performance } from '../domain/returns.ts';
import type { Transaction } from '../domain/types.ts';
import { valuePosition } from '../domain/valuation.ts';
import type { Book, ValuedPosition } from '../domain/valuation.ts';
import type { Benchmark } from '../data/json.ts';

export type Window = 'all' | 'ytd' | '12m' | '36m' | '60m' | `from:${string}`;

export const WINDOWS: { id: Window; label: string }[] = [
  { id: 'all', label: 'Desde el inicio' },
  { id: 'ytd', label: 'Año corrido' },
  { id: '12m', label: '12 meses' },
  { id: '36m', label: '3 años' },
  { id: '60m', label: '5 años' },
];

/** A custom window starts on the given date: `from:YYYY-MM-DD`. */
export const customWindow = (d: IsoDate): Window => `from:${d}`;

export const BUCKET_LABELS: Record<string, string> = {
  acciones_cop: 'Acciones COP',
  acciones_usd: 'Acciones USD',
  cripto: 'Cripto',
  fondos: 'Fondos',
  inmobiliario: 'Inmobiliario',
  renta_fija: 'Renta fija',
};
export const bucketLabel = (b: string) => BUCKET_LABELS[b] ?? b;

export interface Context {
  book: Book;
  ledger: readonly Transaction[];
  benchmarks: readonly Benchmark[];
}

export interface BenchResult {
  symbol: string;
  name: string;
  /** Index total return over the same period as the portfolio's TWR, annualized. */
  annual?: number;
  /** Kaplan–Schoar PME with the portfolio's flows. > 1: the portfolio beat the index. */
  ksPme?: number;
  missing?: string;
}

export interface GrowthPoint {
  date: IsoDate;
  /** Growth of 100 at the portfolio's TWR. */
  portfolio: number;
  benches: Record<string, number>;
}

/** Value of the scope and the money put in so far (start value + net flows), per valuation date. */
export interface HistoryPoint {
  date: IsoDate;
  value: number;
  invested: number;
}

export interface ScopeResult {
  value: Decimal;
  perf?: Performance;
  benches: BenchResult[];
  growth: GrowthPoint[];
  history: HistoryPoint[];
  error?: string;
}

function windowStart(w: Window, asOf: IsoDate): IsoDate | undefined {
  const [y, m] = asOf.split('-').map(Number) as [number, number];
  if (w.startsWith('from:')) return w.slice(5);
  const back = (months: number) => {
    const t = y * 12 + (m - 1) - months;
    return monthEnd(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`);
  };
  switch (w) {
    case 'all':
      return undefined;
    case 'ytd':
      return `${y - 1}-12-31`;
    case '12m':
      return back(12);
    case '36m':
      return back(36);
    case '60m':
      return back(60);
  }
}

export function seriesDates(from: IsoDate, to: IsoDate): IsoDate[] {
  const ds = monthEnds(from, to);
  if (ds[0] !== from) ds.unshift(from);
  if (ds[ds.length - 1] !== to) ds.push(to);
  return ds;
}

function message(e: unknown): string {
  if (e instanceof MissingDataError) return `Falta un dato de mercado: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export function analyzeScope(ctx: Context, scope: Scope, ccy: Ccy, asOf: IsoDate, window: Window, benches: readonly Benchmark[]): ScopeResult {
  const empty: ScopeResult = { value: ZERO, benches: [], growth: [], history: [] };
  try {
    const probe = portfolioSeries(ctx.book, ctx.ledger, scope, ccy, [asOf]);
    const value = probe.values[0]!.value;
    const first = probe.flows[0];
    if (!first) return { ...empty, value };
    const inception = addDays(`${first.date.slice(0, 8)}01`, -1);
    const ws = windowStart(window, asOf);
    const from = ws && ws > inception ? ws : inception;
    if (from >= asOf) return { ...empty, value };
    const s = portfolioSeries(ctx.book, ctx.ledger, scope, ccy, seriesDates(from, asOf));
    const perf = performance(s, from, asOf);

    // Growth of 100 at the portfolio's TWR and at each index, both anchored at `since`.
    const growth: GrowthPoint[] = [{ date: perf.since, portfolio: 100, benches: {} }];
    let g = 100;
    for (const p of perf.periods) {
      if (p.r !== null) g *= 1 + p.r;
      if (p.end > perf.since) growth.push({ date: p.end, portfolio: g, benches: {} });
    }

    const flows: Flow[] = [
      ...(perf.startValue.isZero() ? [] : [{ date: from, amount: perf.startValue }]),
      ...s.flows.filter((f) => f.date > from && f.date <= asOf),
    ];
    const history: HistoryPoint[] = [];
    let invested = ZERO;
    let k = 0;
    for (const v of s.values) {
      for (; k < flows.length && flows[k]!.date <= v.date; k++) invested = invested.plus(flows[k]!.amount);
      if (v.date >= perf.since) history.push({ date: v.date, value: v.value.toNumber(), invested: invested.toNumber() });
    }
    const results: BenchResult[] = benches.map((b) => {
      try {
        const level = (d: IsoDate) => {
          const px = ctx.book.prices.close(b.symbol, d);
          if (!px) throw new MissingDataError(`${b.name} sin nivel el ${d}`);
          return ctx.book.fx.convert(px.close, px.ccy, ccy, d);
        };
        const base = level(perf.since);
        for (const pt of growth) {
          pt.benches[b.symbol] = level(pt.date).div(base).times(100).toNumber();
        }
        const cum = level(asOf).div(base).minus(1).toNumber();
        return { symbol: b.symbol, name: b.name, annual: annualize(cum, perf.since, asOf), ksPme: ksPme(flows, perf.endValue, asOf, level) };
      } catch (e) {
        return { symbol: b.symbol, name: b.name, missing: message(e) };
      }
    });
    return { value: perf.endValue, perf, benches: results, growth, history };
  } catch (e) {
    return { ...empty, error: message(e) };
  }
}

/** A subtotal of the classes the user picked, with or without cash. One class alone keeps its benchmarks. */
export function analyzeMix(ctx: Context, buckets: readonly string[], cash: boolean, ccy: Ccy, asOf: IsoDate, window: Window): ScopeResult {
  const benches = buckets.length === 1 && !cash ? ctx.benchmarks.filter((b) => b.buckets.includes(buckets[0]!)) : [];
  return analyzeScope(ctx, { kind: 'mix', buckets, cash }, ccy, asOf, window, benches);
}

export interface PositionRow extends ValuedPosition {
  name: string;
  accountName: string;
  /** Market value − remaining cost, computed in the account currency and translated at the as-of rate. */
  unrealized: Decimal;
  /** Cumulative realized gain and income to date, each translated at the rate of its own transaction date. */
  realized: Decimal;
  income: Decimal;
  open: boolean;
}

/**
 * Positions (open and closed) valued at `asOf` in `ccy`. Realized gains and income are converted
 * transaction by transaction, so each uses the exchange rate of its own date.
 */
export function positionRows(ctx: Context, ccy: Ccy, asOf: IsoDate): PositionRow[] {
  const h: Holdings = { asOf, positions: new Map(), cash: new Map() };
  const realized = new Map<string, Decimal>();
  const income = new Map<string, Decimal>();
  for (const tx of sortLedger(ctx.ledger)) {
    if (tx.date > asOf) break;
    const k = tx.asset ? positionKey(tx.account, tx.asset) : undefined;
    const before = k ? h.positions.get(k) : undefined;
    const r0 = before?.realized ?? ZERO;
    const i0 = before?.income ?? ZERO;
    apply(h, tx);
    if (!k) continue;
    const p = h.positions.get(k)!;
    const acc = ctx.book.accounts.get(tx.account)!.ccy;
    const dr = p.realized.minus(r0);
    const di = p.income.minus(i0);
    if (!dr.isZero()) realized.set(k, (realized.get(k) ?? ZERO).plus(ctx.book.fx.convert(dr, acc, ccy, tx.date)));
    if (!di.isZero()) income.set(k, (income.get(k) ?? ZERO).plus(ctx.book.fx.convert(di, acc, ccy, tx.date)));
  }
  const rows: PositionRow[] = [];
  for (const [k, p] of h.positions) {
    const r = realized.get(k) ?? ZERO;
    const inc = income.get(k) ?? ZERO;
    if (!p.open && r.isZero() && inc.isZero()) continue;
    rows.push(row(ctx, p, ccy, asOf, r, inc));
  }
  return rows;
}

function row(ctx: Context, p: Position, ccy: Ccy, asOf: IsoDate, realized: Decimal, income: Decimal): PositionRow {
  const asset = ctx.book.assets.get(p.asset);
  const account = ctx.book.accounts.get(p.account)!;
  const base = { name: asset?.name ?? p.asset, accountName: account.name, realized, income, open: p.open };
  if (!p.open) {
    return { ...base, account: p.account, asset: p.asset, bucket: asset?.bucket ?? '', qty: p.qty, value: ZERO, cost: ZERO, method: 'market', estimated: false, unrealized: ZERO };
  }
  const v = valuePosition(ctx.book, p, asOf, ccy);
  const local = valuePosition(ctx.book, p, asOf, account.ccy);
  // For committed assets `value` is equity (value − still owed), compared with what was paid so far.
  return { ...v, ...base, unrealized: ctx.book.fx.convert(local.value.minus(p.cost), account.ccy, ccy, asOf) };
}

export interface Report {
  asOf: IsoDate;
  ccy: Ccy;
  total: ScopeResult;
  cash: Decimal;
  buckets: (ScopeResult & { bucket: string; label: string; weight: number;
    /** Holds an asset bought on a payment plan (commitment): TWR on a small leveraged base is not comparable. */
    leveraged: boolean; unrealized: Decimal; realized: Decimal; income: Decimal; atCost: string[]; manual: { name: string; date?: IsoDate }[] })[];
  positions: PositionRow[];
  error?: string;
}

export function analyze(ctx: Context, ccy: Ccy, asOf: IsoDate, window: Window): Report {
  let positions: PositionRow[] = [];
  let error: string | undefined;
  try {
    positions = positionRows(ctx, ccy, asOf);
  } catch (e) {
    error = message(e);
  }
  const total = analyzeScope(ctx, { kind: 'total' }, ccy, asOf, window, []);
  const bucketIds = [...new Set([...ctx.book.assets.values()].map((a) => a.bucket))].filter((b) => positions.some((p) => p.bucket === b));
  const invested = sum(positions.filter((p) => p.open).map((p) => p.value));
  const buckets = bucketIds.map((bucket) => {
    const rows = positions.filter((p) => p.bucket === bucket);
    const r = analyzeScope(ctx, { kind: 'bucket', bucket }, ccy, asOf, window, ctx.benchmarks.filter((b) => b.buckets.includes(bucket)));
    const open = rows.filter((p) => p.open);
    return {
      ...r,
      bucket,
      label: bucketLabel(bucket),
      weight: total.value.isZero() ? 0 : r.value.div(total.value).toNumber(),
      leveraged: ctx.ledger.some((t) => t.type === 'COMMITMENT' && t.asset !== undefined && ctx.book.assets.get(t.asset)?.bucket === bucket),
      unrealized: sum(open.map((p) => p.unrealized)),
      realized: sum(rows.map((p) => p.realized)),
      income: sum(rows.map((p) => p.income)),
      atCost: open.filter((p) => p.method === 'cost').map((p) => p.name),
      manual: open.filter((p) => p.method === 'manual').map((p) => ({ name: p.name, date: p.priceDate })),
    };
  });
  buckets.sort((a, b) => b.value.comparedTo(a.value));
  return { asOf, ccy, total, cash: total.value.minus(invested), buckets, positions, error };
}

/** Days between the latest data point and the as-of date, to flag stale inputs. */
export function staleness(date: IsoDate | undefined, asOf: IsoDate): number | undefined {
  return date ? daysBetween(date, asOf) : undefined;
}
