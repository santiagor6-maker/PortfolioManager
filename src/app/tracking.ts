import { Decimal, ZERO } from '../domain/money.ts';
import type { Ccy } from '../domain/money.ts';
import { addDays, daysBetween, monthEnd, monthEnds } from '../domain/dates.ts';
import type { IsoDate } from '../domain/dates.ts';
import { MissingDataError } from '../domain/fx.ts';
import { apply } from '../domain/holdings.ts';
import type { Holdings } from '../domain/holdings.ts';
import { sortLedger } from '../domain/ledger.ts';
import { BUCKET_FLOWS, TOTAL_FLOWS } from '../domain/portfolio.ts';
import type { Flow } from '../domain/portfolio.ts';
import { xirr } from '../domain/returns.ts';
import { valuePosition } from '../domain/valuation.ts';
import type { Context } from './analysis.ts';
import { bucketLabel } from './analysis.ts';

export const REAL_ESTATE = 'inmobiliario';

const ONE = new Decimal(1);

/**
 * How a month-end value was obtained. `cost`: no price and no manual value (missing data, valued at cost);
 * `stale`: a market close more than 5 days old or a manual value from an earlier month (carried forward);
 * `estimated`: a manual value flagged as an estimate (e.g. a property list price).
 */
export type CellFlag = 'cost' | 'stale' | 'estimated';

export interface Cell {
  /** Month-end value in the report currency (translated at the month-end rate). */
  value: Decimal;
  /** Net money put in during the month (+ buys, capital calls, deposits; − sales, dividends, withdrawals), each at its own date's rate. */
  flow: Decimal;
  /** The same flows weighted by the share of the month they were invested (Modified Dietz). */
  wflow: Decimal;
  /** value − previous month-end value − flow: the month's result, including dividends and currency effect. */
  gain: Decimal;
  /**
   * The part of `gain` due to exchange rates: the change of the rate from the currency the holding is valued in
   * (a market price's, or the account's for a manual value, a cost and cash) to the report currency, over the
   * opening value and over each flow since its date. For a position, `gain − fx` is its result in that currency
   * translated at the month-end rate; for cash, the interest, fees and conversion spreads at their own dates'
   * rates. Undefined when a rate it needs is missing (the gain itself is still known).
   */
  fx?: Decimal;
  /** Modified Dietz return for the month; null when the capital base is not positive. */
  r: number | null;
  /**
   * The month's flows are large next to its capital (the weighted base is under half the larger of the start and
   * end values, e.g. a sale early in the month or a big deposit into a small account): Modified Dietz can then be
   * far from the real result, so risk statistics leave the month out.
   */
  approx?: true;
  flag?: CellFlag;
}

export type RowKind = 'asset' | 'class' | 'cash' | 'subtotal' | 'total';

export interface TrackRow {
  id: string;
  kind: RowKind;
  label: string;
  /** Account name for an asset row. */
  sub?: string;
  bucket?: string;
  cells: Cell[];
  /** Dated external flows (money in +), for XIRR to date. Empty for the cash row. */
  flows: Flow[];
}

/** Month-by-month tracking, like the per-portfolio sheets of a spreadsheet: one cell per row and month-end. */
export interface Tracking {
  ccy: Ccy;
  /** Month-ends, ascending. */
  months: IsoDate[];
  assets: TrackRow[];
  classes: TrackRow[];
  /** Broker cash plus whatever is not an asset (interest, fees, currency effect on cash). */
  cash: TrackRow;
  /** Everything except real estate. */
  exRealEstate: TrackRow;
  total: TrackRow;
  /** Why the series stops before `to` (e.g. a missing exchange rate). */
  error?: string;
}

interface Acc {
  value: Decimal[];
  flow: Decimal[];
  wflow: Decimal[];
  fx: (Decimal | undefined)[];
  /** Currency each month-end value was taken in (see ValuedPosition.valuedIn). */
  inCcy: (Ccy | undefined)[];
  /** This month's flows, in the report currency at their date, waiting for the month-end to measure their currency effect. */
  pending: { amount: Decimal; date: IsoDate }[];
  flags: (CellFlag | undefined)[];
  flows: Flow[];
}

const newAcc = (n: number): Acc => ({
  value: Array(n).fill(ZERO),
  flow: Array(n).fill(ZERO),
  wflow: Array(n).fill(ZERO),
  fx: Array(n).fill(ZERO),
  inCcy: Array(n).fill(undefined),
  pending: [],
  flags: Array(n).fill(undefined),
  flows: [],
});

function cells(a: Acc, n: number): Cell[] {
  const out: Cell[] = [];
  for (let m = 0; m < n; m++) {
    const v0 = m > 0 ? a.value[m - 1]! : ZERO;
    const v1 = a.value[m]!;
    const f = a.flow[m]!;
    const gain = v1.minus(v0).minus(f);
    // Same convention as the engine's TWR: when the row starts inside the month, flows get full weight.
    const base = v0.plus(v0.isZero() ? f : a.wflow[m]!);
    const approx = v0.gt(0) && base.gt(0) && base.lt(Decimal.max(v0, v1).div(2));
    out.push({ value: v1, flow: f, wflow: a.wflow[m]!, gain, ...(a.fx[m] ? { fx: a.fx[m] } : {}), r: base.gt(0) ? gain.div(base).toNumber() : null, ...(approx ? { approx: true as const } : {}), ...(a.flags[m] ? { flag: a.flags[m] } : {}) });
  }
  return out;
}

function combine(n: number, parts: Acc[], signs: number[] = parts.map(() => 1)): Acc {
  const a = newAcc(n);
  parts.forEach((p, i) => {
    const s = signs[i]!;
    for (let m = 0; m < n; m++) {
      a.value[m] = a.value[m]!.plus(p.value[m]!.times(s));
      a.flow[m] = a.flow[m]!.plus(p.flow[m]!.times(s));
      a.wflow[m] = a.wflow[m]!.plus(p.wflow[m]!.times(s));
      const x = a.fx[m];
      const y = p.fx[m];
      a.fx[m] = x && y ? x.plus(y.times(s)) : undefined;
    }
    a.flows.push(...p.flows.map((f) => ({ date: f.date, amount: f.amount.times(s) })));
  });
  a.flows.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return a;
}

const RANK: Record<CellFlag, number> = { estimated: 1, stale: 2, cost: 3 };

/**
 * Replays the ledger once and values every position at each month-end from the first transaction to `to`.
 * Rows are additive: classes = Σ assets; total = Σ classes + cash; exRealEstate = total − real-estate class.
 */
export function tracking(ctx: Context, ccy: Ccy, to: IsoDate): Tracking {
  const sorted = sortLedger(ctx.ledger);
  const blank = (id: string, kind: RowKind, label: string): TrackRow => ({ id, kind, label, cells: [], flows: [] });
  if (!sorted.length || sorted[0]!.date > to) {
    return { ccy, months: [], assets: [], classes: [], cash: blank('cash', 'cash', 'Efectivo en cuentas'), exRealEstate: blank('ex', 'subtotal', 'Subtotal sin inmobiliario'), total: blank('total', 'total', 'TOTAL') };
  }
  const all = monthEnds(monthEnd(sorted[0]!.date), to);
  const N = all.length;
  const pos = new Map<string, Acc>();
  const total = newAcc(N);
  const h: Holdings = { asOf: '', positions: new Map(), cash: new Map() };
  const accCcy = (id: string) => {
    const a = ctx.book.accounts.get(id);
    if (!a) throw new Error(`Cuenta desconocida: ${id}`);
    return a.ccy;
  };
  // What one unit of a currency is worth in the report currency on a date: the currency effect is how it moved.
  const rateCache = new Map<string, Decimal>();
  const rate = (c: Ccy, date: IsoDate) => {
    const key = `${c}|${date}`;
    let r = rateCache.get(key);
    if (!r) rateCache.set(key, (r = c === ccy ? ONE : ctx.book.fx.convert(ONE, c, ccy, date)));
    return r;
  };
  /** Currency effect, over to month-end `d`, of an amount in the report currency held in `c` since `from`. */
  const moved = (amount: Decimal, c: Ccy, from: IsoDate, d: IsoDate) => (c === ccy || amount.isZero() ? ZERO : amount.times(rate(c, d).div(rate(c, from)).minus(1)));
  /** A currency effect that needs a rate the data lacks is unknown; it never stops the series. */
  const effect = (f: () => Decimal): Decimal | undefined => {
    try {
      return f();
    } catch (e) {
      if (e instanceof MissingDataError) return undefined;
      throw e;
    }
  };

  let prev = addDays(`${all[0]!.slice(0, 8)}01`, -1);
  let i = 0;
  let done = 0;
  let error: string | undefined;
  for (let m = 0; m < N; m++) {
    const d = all[m]!;
    const days = daysBetween(prev, d);
    try {
      const openingCash = m > 0 ? new Map(h.cash) : new Map<string, Decimal>();
      const cashMoves: { account: string; delta: Decimal; date: IsoDate }[] = [];
      for (const a of pos.values()) a.pending = [];
      for (; i < sorted.length && sorted[i]!.date <= d; i++) {
        const tx = sorted[i]!;
        const before = new Map(h.cash);
        apply(h, tx);
        for (const account of new Set([...before.keys(), ...h.cash.keys()])) {
          const delta = (h.cash.get(account) ?? ZERO).minus(before.get(account) ?? ZERO);
          if (!delta.isZero()) cashMoves.push({ account, delta, date: tx.date });
        }
        const w = new Decimal(daysBetween(tx.date, d)).div(days);
        const add = (a: Acc, amount: Decimal) => {
          const f = ctx.book.fx.convert(amount, accCcy(tx.account), ccy, tx.date);
          a.flow[m] = a.flow[m]!.plus(f);
          a.wflow[m] = a.wflow[m]!.plus(f.times(w));
          a.flows.push({ date: tx.date, amount: f });
        };
        if (tx.asset && BUCKET_FLOWS.has(tx.type)) {
          const k = `${tx.account}|${tx.asset}`;
          if (!pos.has(k)) pos.set(k, newAcc(N));
          const a = pos.get(k)!;
          const was = a.flow[m]!;
          add(a, tx.amount.neg());
          a.pending.push({ amount: a.flow[m]!.minus(was), date: tx.date });
        }
        if (TOTAL_FLOWS.has(tx.type)) add(total, tx.amount);
      }
      h.asOf = d;
      let sum = ZERO;
      for (const p of h.positions.values()) {
        if (!p.open) continue;
        const k = `${p.account}|${p.asset}`;
        if (!pos.has(k)) pos.set(k, newAcc(N));
        const a = pos.get(k)!;
        const v = valuePosition(ctx.book, p, d, ccy);
        a.value[m] = v.value;
        a.inCcy[m] = v.valuedIn;
        a.flags[m] =
          v.method === 'cost' ? 'cost'
          : v.method === 'market' ? ((v.priceAgeDays ?? 0) > 5 ? 'stale' : undefined)
          : v.priceDate! < `${d.slice(0, 8)}01` ? 'stale'
          : v.estimated ? 'estimated' : undefined;
        sum = sum.plus(v.value);
      }
      for (const [account, c] of h.cash) sum = sum.plus(ctx.book.fx.convert(c, accCcy(account), ccy, d));
      total.value[m] = sum;

      // Currency effects: each opening value in the currency it was taken in, from the previous month-end; each
      // flow from its date, in the currency the position is valued in now (or was, if it closed this month).
      let fxAll = effect(() => {
        let x = ZERO;
        for (const [account, c] of openingCash) x = x.plus(moved(ctx.book.fx.convert(c, accCcy(account), ccy, prev), accCcy(account), prev, d));
        for (const c of cashMoves) x = x.plus(moved(ctx.book.fx.convert(c.delta, accCcy(c.account), ccy, c.date), accCcy(c.account), c.date, d));
        return x;
      });
      for (const [k, a] of pos) {
        const opening = m > 0 ? a.inCcy[m - 1] : undefined;
        // Opened and closed within the month (never valued): a quoted asset moves with its price's currency.
        const def = ctx.book.assets.get(k.split('|')[1]!);
        const now = a.inCcy[m] ?? opening ?? (def?.pricing === 'market' && def.symbol ? def.ccy : accCcy(k.split('|')[0]!));
        a.fx[m] = effect(() =>
          a.pending.reduce((x, f) => x.plus(moved(f.amount, now, f.date, d)), opening ? moved(a.value[m - 1]!, opening, prev, d) : ZERO),
        );
        fxAll = fxAll && a.fx[m] ? fxAll.plus(a.fx[m]!) : undefined;
      }
      total.fx[m] = fxAll;
    } catch (e) {
      error = e instanceof MissingDataError ? `Falta un dato de mercado: ${e.message}` : e instanceof Error ? e.message : String(e);
      break;
    }
    done = m + 1;
    prev = d;
  }

  const n = done;
  const months = all.slice(0, n);
  const assets: TrackRow[] = [];
  const byBucket = new Map<string, Acc[]>();
  for (const [k, a] of pos) {
    const [account, asset] = k.split('|') as [string, string];
    const def = ctx.book.assets.get(asset);
    const bucket = def?.bucket ?? '';
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), a]);
    const row: TrackRow = { id: k, kind: 'asset', label: def?.name ?? asset, sub: ctx.book.accounts.get(account)?.name, bucket, cells: cells(a, n), flows: a.flows };
    if (row.cells.some((c) => !c.value.isZero() || !c.flow.isZero())) assets.push(row);
  }
  const classAccs = new Map([...byBucket].map(([b, parts]) => {
    const acc = combine(n, parts);
    for (let m = 0; m < n; m++) {
      const worst = parts.map((p) => p.flags[m]).filter((f): f is CellFlag => !!f).sort((x, y) => RANK[y] - RANK[x])[0];
      acc.flags[m] = worst;
    }
    return [b, acc] as const;
  }));
  const classes = [...classAccs].map(([b, a]): TrackRow => ({ id: `class:${b}`, kind: 'class', label: bucketLabel(b), bucket: b, cells: cells(a, n), flows: a.flows }));
  const cashAcc = combine(n, [total, ...pos.values()], [1, ...[...pos.values()].map(() => -1)]);
  const re = classAccs.get(REAL_ESTATE);
  const exAcc = re ? combine(n, [total, re], [1, -1]) : total;
  return {
    ccy,
    months,
    assets,
    classes,
    cash: { id: 'cash', kind: 'cash', label: 'Efectivo en cuentas', cells: cells(cashAcc, n), flows: [] },
    exRealEstate: { id: 'ex', kind: 'subtotal', label: 'Subtotal sin inmobiliario', cells: cells(exAcc, n), flows: exAcc.flows },
    total: { id: 'total', kind: 'total', label: 'TOTAL', cells: cells(total, n), flows: total.flows },
    ...(error ? { error } : {}),
  };
}

/**
 * One row that adds up several rows of the same tracking (e.g. the classes the user picked, with or without cash).
 * Values and flows are summed month by month and the returns recomputed, so the classes plus cash give back the total.
 */
export function combineRows(rows: readonly TrackRow[], id: string, label: string): TrackRow {
  const n = rows[0]?.cells.length ?? 0;
  const accs = rows.map((r): Acc => ({
    value: r.cells.map((c) => c.value),
    flow: r.cells.map((c) => c.flow),
    wflow: r.cells.map((c) => c.wflow),
    fx: r.cells.map((c) => c.fx),
    inCcy: [],
    pending: [],
    flags: r.cells.map((c) => c.flag),
    flows: r.flows,
  }));
  const acc = combine(n, accs);
  for (let m = 0; m < n; m++) acc.flags[m] = accs.map((a) => a.flags[m]).filter((f): f is CellFlag => !!f).sort((x, y) => RANK[y] - RANK[x])[0];
  return { id, kind: 'subtotal', label, cells: cells(acc, n), flows: acc.flows };
}

/** Money-weighted return (annual) from the row's first flow to month `m`, valuing the row at that month-end. */
export function xirrToDate(row: TrackRow, months: readonly IsoDate[], m: number): number | null {
  const d = months[m]!;
  return xirr([...row.flows.filter((f) => f.date <= d).map((f) => ({ date: f.date, amount: f.amount.neg() })), { date: d, amount: row.cells[m]!.value }]);
}

/** Time-weighted return of the calendar year to month `m`: the year's monthly returns chained. */
export function yearToDate(row: TrackRow, months: readonly IsoDate[], m: number): number | null {
  const y = months[m]!.slice(0, 4);
  let g = 1;
  let any = false;
  for (let k = m; k >= 0 && months[k]!.startsWith(y); k--) {
    const r = row.cells[k]!.r;
    if (r !== null) {
      g *= 1 + r;
      any = true;
    }
  }
  return any ? g - 1 : null;
}

/** Index total return between two month-ends in the report currency, or undefined when a level is missing. */
export function indexReturn(ctx: Context, symbol: string, ccy: Ccy, from: IsoDate, to: IsoDate): number | undefined {
  try {
    const level = (d: IsoDate) => {
      const px = ctx.book.prices.close(symbol, d);
      if (!px) throw new MissingDataError(symbol);
      return ctx.book.fx.convert(px.close, px.ccy, ccy, d);
    };
    return level(to).div(level(from)).minus(1).toNumber();
  } catch {
    return undefined;
  }
}
