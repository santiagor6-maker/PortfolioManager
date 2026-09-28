import { Decimal, ZERO } from '../domain/money.ts';
import type { Ccy } from '../domain/money.ts';
import { addDays, monthEnd, monthEnds } from '../domain/dates.ts';
import type { IsoDate } from '../domain/dates.ts';
import { MissingDataError } from '../domain/fx.ts';
import { apply } from '../domain/holdings.ts';
import type { Holdings } from '../domain/holdings.ts';
import { positionKey, sortLedger } from '../domain/ledger.ts';
import { valuePosition } from '../domain/valuation.ts';
import type { Context } from './analysis.ts';

/** A dividend received (net of withholding, as the ledger records it). */
export interface DividendPayment {
  date: IsoDate;
  account: string;
  asset: string;
  name: string;
  bucket: string;
  /** Account currency. */
  native: Decimal;
  nativeCcy: Ccy;
  /** Report currency at the payment date's rate; missing when that rate is missing. */
  amount?: Decimal;
  /**
   * What the payment was earned on, as held at the start of its day (the ex-date comes before the payment,
   * so same-day trades do not count): the units, or for assets without units (funds) the cost basis.
   */
  held: { qty: Decimal; cost: Decimal };
  estimated: boolean;
}

/** A payment expected in the next 12 months: one received in the last 12, a year later, sized to what is held today. */
export interface ProjectedPayment {
  date: IsoDate;
  account: string;
  asset: string;
  name: string;
  bucket: string;
  /** The payment it repeats. */
  basis: IsoDate;
  native: Decimal;
  nativeCcy: Ccy;
  /** Report currency at the as-of rate; missing when that rate is missing. */
  amount?: Decimal;
  estimated: boolean;
}

export interface MonthTotal {
  /** Month end. */
  date: IsoDate;
  total: Decimal;
  /** Part of `total` that comes from estimated payments. */
  estimated: Decimal;
  count: number;
}

export interface YearTotal {
  year: number;
  total: Decimal;
  estimated: Decimal;
  /** The as-of year, before its 31 dec. */
  partial: boolean;
  /** Change on the previous calendar year, when both are whole and the ledger covers the previous one from its start. */
  growth?: number;
}

export interface AssetDividends {
  asset: string;
  name: string;
  bucket: string;
  last12: Decimal;
  total: Decimal;
  count: number;
  last: IsoDate;
  /** Still held on the as-of date. */
  held: boolean;
}

/** A total with the part of it that comes from estimated payments. */
export interface Part {
  total: Decimal;
  estimated: Decimal;
}

export interface Dividends {
  ccy: Ccy;
  asOf: IsoDate;
  payments: DividendPayment[];
  /** Received payments left out of the totals because their date's exchange rate is missing. */
  missingFx: DividendPayment[];
  months: MonthTotal[];
  years: YearTotal[];
  /** Received in (asOf − 1 year, asOf]. */
  last12: Part;
  /** Received in the 12 months before that; missing when the ledger does not reach back that far. */
  prev12?: Part;
  ytd: Part;
  all: Part;
  projected: ProjectedPayment[];
  /** Projected payments with no as-of rate for their currency. */
  projectedMissingFx: ProjectedPayment[];
  /** Month ends covering (asOf, asOf + 1 year], each with its projected total. */
  calendar: MonthTotal[];
  next12: Part;
  byAsset: AssetDividends[];
  /** Value and cost, on the as-of date, of the positions the projection counts on. `priced`: none valued at cost. */
  base?: { value: Decimal; cost: Decimal; priced: boolean };
  /** next12 / value of those positions (only when all are priced) and next12 / their cost. Net of withholding. */
  yieldOnValue?: number;
  yieldOnCost?: number;
}

/** Same day `n` years later (29 feb → 28 feb). */
export function addYears(d: IsoDate, n: number): IsoDate {
  const y = Number(d.slice(0, 4)) + n;
  const md = d.slice(5);
  return md === '02-29' && monthEnd(`${y}-02-01`).endsWith('28') ? `${y}-02-28` : `${y}-${md}`;
}

const empty = (): Part => ({ total: ZERO, estimated: ZERO });
const add = (p: Part, amount: Decimal, estimated: boolean): Part => ({ total: p.total.plus(amount), estimated: estimated ? p.estimated.plus(amount) : p.estimated });

function addMonthTotal(m: Map<IsoDate, MonthTotal>, date: IsoDate, amount: Decimal, estimated: boolean) {
  const k = monthEnd(date);
  const t = m.get(k) ?? { date: k, total: ZERO, estimated: ZERO, count: 0 };
  m.set(k, { date: k, ...add(t, amount, estimated), count: t.count + 1 });
}

/**
 * Dividends received up to `asOf` (the ledger's DIVIDEND rows, net of withholding) in the report currency at each
 * payment date's rate, grouped by month, year and asset; and a projection of the next 12 months that repeats each
 * payment of the last 12 a year later for the positions still held, scaled to the units held today (funds without
 * units: to the cost basis held today). The projection is a pattern, not an announced dividend. Cash interest is
 * not a dividend and is left out.
 */
export function dividends(ctx: Context, ccy: Ccy, asOf: IsoDate): Dividends {
  const h: Holdings = { asOf, positions: new Map(), cash: new Map() };
  const dayStart = new Map<string, { date: IsoDate; qty: Decimal; cost: Decimal }>();
  const payments: DividendPayment[] = [];
  const missingFx: DividendPayment[] = [];
  const ledger = sortLedger(ctx.ledger);
  for (const tx of ledger) {
    if (tx.date > asOf) break;
    const k = tx.asset ? positionKey(tx.account, tx.asset) : '';
    if (tx.asset && dayStart.get(k)?.date !== tx.date) {
      const p = h.positions.get(k);
      dayStart.set(k, { date: tx.date, qty: p?.open ? p.qty : ZERO, cost: p?.open ? p.cost : ZERO });
    }
    apply(h, tx);
    if (tx.type !== 'DIVIDEND' || !tx.asset) continue;
    const asset = ctx.book.assets.get(tx.asset);
    const acc = ctx.book.accounts.get(tx.account);
    if (!asset || !acc) continue;
    let amount: Decimal | undefined;
    try {
      amount = ctx.book.fx.convert(tx.amount, acc.ccy, ccy, tx.date);
    } catch (e) {
      if (!(e instanceof MissingDataError)) throw e;
    }
    const start = dayStart.get(k)!;
    const pay: DividendPayment = {
      date: tx.date,
      account: tx.account,
      asset: tx.asset,
      name: asset.name,
      bucket: asset.bucket,
      native: tx.amount,
      nativeCcy: acc.ccy,
      ...(amount ? { amount } : {}),
      held: { qty: start.qty, cost: start.cost },
      estimated: tx.estimated ?? false,
    };
    (amount ? payments : missingFx).push(pay);
  }

  const yearAgo = addYears(asOf, -1);
  const twoYearsAgo = addYears(asOf, -2);
  const year = asOf.slice(0, 4);
  const historyFrom = ledger[0]?.date;
  let last12 = empty();
  let prev12 = empty();
  let ytd = empty();
  let all = empty();
  const months = new Map<IsoDate, MonthTotal>();
  const years = new Map<number, Part>();
  const byAsset = new Map<string, AssetDividends>();
  for (const p of payments) {
    const a = p.amount!;
    all = add(all, a, p.estimated);
    if (p.date > yearAgo) last12 = add(last12, a, p.estimated);
    else if (p.date > twoYearsAgo) prev12 = add(prev12, a, p.estimated);
    if (p.date.startsWith(year)) ytd = add(ytd, a, p.estimated);
    addMonthTotal(months, p.date, a, p.estimated);
    const y = Number(p.date.slice(0, 4));
    years.set(y, add(years.get(y) ?? empty(), a, p.estimated));
    const s = byAsset.get(p.asset) ?? { asset: p.asset, name: p.name, bucket: p.bucket, last12: ZERO, total: ZERO, count: 0, last: p.date, held: false };
    byAsset.set(p.asset, { ...s, total: s.total.plus(a), last12: p.date > yearAgo ? s.last12.plus(a) : s.last12, count: s.count + 1, last: p.date });
  }

  // Every month and year from the first payment on, so gaps show as zero rather than disappear.
  const first = payments[0]?.date;
  const monthList = first ? monthEnds(`${first.slice(0, 7)}-01`, monthEnd(asOf)).map((d) => months.get(d) ?? { date: d, total: ZERO, estimated: ZERO, count: 0 }) : [];
  const yearList: YearTotal[] = [];
  if (first) {
    for (let y = Number(first.slice(0, 4)); y <= Number(year); y++) {
      const t = years.get(y) ?? empty();
      const partial = String(y) === year && asOf < `${year}-12-31`;
      const prev = yearList[yearList.length - 1];
      // The year before counts only when the ledger starts in its January: a first, partial year would inflate growth.
      const whole = prev && !prev.partial && !!historyFrom && historyFrom < `${prev.year}-02-01`;
      const growth = whole && !partial && prev.total.gt(0) ? t.total.div(prev.total).minus(1).toNumber() : undefined;
      yearList.push({ year: y, ...t, partial, ...(growth !== undefined ? { growth } : {}) });
    }
  }

  const projected: ProjectedPayment[] = [];
  const projectedMissingFx: ProjectedPayment[] = [];
  const base = new Set<string>();
  for (const p of [...payments, ...missingFx]) {
    if (p.date <= yearAgo) continue;
    const date = addYears(p.date, 1);
    if (date <= asOf) continue; // 29 feb repeated on 28 feb of an as-of date: already here, not ahead
    const pos = h.positions.get(positionKey(p.account, p.asset));
    if (!pos?.open) continue;
    let native: Decimal;
    if (p.held.qty.gt(0)) native = p.native.times(pos.qty).div(p.held.qty);
    else if (pos.qty.isZero() && p.held.cost.gt(0)) native = p.native.times(pos.cost).div(p.held.cost);
    else continue; // nothing held at the start of the payment day to scale from
    if (native.isZero()) continue;
    let amount: Decimal | undefined;
    try {
      amount = ctx.book.fx.convert(native, p.nativeCcy, ccy, asOf);
    } catch (e) {
      if (!(e instanceof MissingDataError)) throw e;
    }
    const pp: ProjectedPayment = { date, account: p.account, asset: p.asset, name: p.name, bucket: p.bucket, basis: p.date, native, nativeCcy: p.nativeCcy, ...(amount ? { amount } : {}), estimated: p.estimated };
    (amount ? projected : projectedMissingFx).push(pp);
    base.add(positionKey(p.account, p.asset));
  }
  projected.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));

  const cal = new Map<IsoDate, MonthTotal>();
  let next12 = empty();
  for (const p of projected) {
    next12 = add(next12, p.amount!, p.estimated);
    addMonthTotal(cal, p.date, p.amount!, p.estimated);
  }
  // 12 month ends when asOf is a month end; 13 (first and last partial) otherwise.
  const calendar = monthEnds(`${asOf.slice(0, 7)}-01`, monthEnd(addYears(asOf, 1)))
    .filter((d) => d > asOf)
    .map((d) => cal.get(d) ?? { date: d, total: ZERO, estimated: ZERO, count: 0 });

  const open = new Set([...h.positions.values()].filter((p) => p.open).map((p) => p.asset));
  for (const [k, s] of byAsset) byAsset.set(k, { ...s, held: open.has(k) });

  let baseValue: Dividends['base'];
  try {
    let value = ZERO;
    let cost = ZERO;
    let priced = true;
    for (const k of base) {
      const v = valuePosition(ctx.book, h.positions.get(k)!, asOf, ccy);
      value = value.plus(v.value);
      cost = cost.plus(v.cost);
      if (v.method === 'cost') priced = false;
    }
    if (base.size) baseValue = { value, cost, priced };
  } catch (e) {
    if (!(e instanceof MissingDataError)) throw e;
  }
  const complete = !!baseValue && !projectedMissingFx.length;

  return {
    ccy,
    asOf,
    payments,
    missingFx,
    months: monthList,
    years: yearList,
    last12,
    ...(historyFrom && historyFrom <= addDays(twoYearsAgo, 31) ? { prev12 } : {}),
    ytd,
    all,
    projected,
    projectedMissingFx,
    calendar,
    next12,
    byAsset: [...byAsset.values()].sort((a, b) => b.last12.cmp(a.last12) || b.total.cmp(a.total)),
    ...(baseValue ? { base: baseValue } : {}),
    ...(complete && baseValue!.priced && baseValue!.value.gt(0) ? { yieldOnValue: next12.total.div(baseValue!.value).toNumber() } : {}),
    ...(complete && baseValue!.cost.gt(0) ? { yieldOnCost: next12.total.div(baseValue!.cost).toNumber() } : {}),
  };
}
