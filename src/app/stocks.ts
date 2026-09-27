import { Decimal, ZERO } from '../domain/money.ts';
import type { Ccy } from '../domain/money.ts';
import { addDays, daysBetween } from '../domain/dates.ts';
import type { IsoDate } from '../domain/dates.ts';
import { apply } from '../domain/holdings.ts';
import type { Holdings } from '../domain/holdings.ts';
import { positionKey, sortLedger } from '../domain/ledger.ts';
import type { PricePoint } from '../domain/prices.ts';
import type { Context } from './analysis.ts';

/** A buy of the current holding period, at its price in the asset's quote currency (commission excluded). */
export interface Lot {
  date: IsoDate;
  qty: Decimal;
  price: Decimal;
  /** Price change since this buy. */
  ret?: number;
}

/** One open market-priced position, as a price-tracking row (the spreadsheet "bitácora" view). */
export interface StockRow {
  key: string;
  account: string;
  asset: string;
  name: string;
  symbol: string;
  /** Quote currency: every price in the row is in it. */
  ccy: Ccy;
  bucket: string;
  strategy?: string;
  qty: Decimal;
  /** Average entry price of the units held (average cost, commissions excluded). Sales do not change it. */
  avgPrice: Decimal;
  /** Quantity-weighted entry date of the units held; `days` counts from it. */
  since: IsoDate;
  days: number;
  price?: PricePoint;
  /** Latest close more than 5 days before the as-of date. */
  stale: boolean;
  change1d?: number;
  change1m?: number;
  changeYtd?: number;
  low52?: number;
  high52?: number;
  target?: Decimal;
  /** Share of the way from the entry price to the target: (price − entry) / (target − entry). */
  progress?: number;
  /** What is left to the target: target / price − 1. */
  toTarget?: number;
  /** Price return on the average entry price. */
  ret?: number;
  /** `ret` annualized over `days` (only from 90 days on: shorter periods annualize into noise). */
  annual?: number;
  lots: Lot[];
  /** Closes of the last year, for a sparkline. */
  spark: { date: IsoDate; close: number }[];
}

/** A sale (or write-off) with its result on the average entry price, like a closed row of the bitácora. */
export interface ClosedTrade {
  date: IsoDate;
  account: string;
  asset: string;
  name: string;
  ccy: Ccy;
  qty: Decimal;
  entry: Decimal;
  exit: Decimal;
  days: number;
  ret: number;
  annual?: number;
  /** Realized gain on average cost, in the report currency at the sale date's rate. */
  realized: Decimal;
}

interface State {
  qty: Decimal;
  avg: Decimal;
  /** Quantity-weighted entry date, as days since 1970-01-01. */
  day: number;
  lots: Lot[];
}

const EPOCH = '1970-01-01';
const MIN_ANNUAL_DAYS = 90;
const annualized = (ret: number, days: number) => (days >= MIN_ANNUAL_DAYS ? (1 + ret) ** (365 / days) - 1 : undefined);

function at(pts: readonly PricePoint[], d: IsoDate): PricePoint | undefined {
  let lo = 0;
  let hi = pts.length - 1;
  let found: PricePoint | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.date <= d) {
      found = pts[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Price change from the close on or before `from` (if it is within 10 days of it) to `price`. */
function change(pts: readonly PricePoint[], from: IsoDate, price: PricePoint): number | undefined {
  const p = at(pts, from);
  return p && daysBetween(p.date, from) <= 10 && !p.close.isZero() ? price.close.div(p.close).minus(1).toNumber() : undefined;
}

/**
 * Replays the ledger to `asOf`, following each market-priced position in its quote currency:
 * open rows with price, target and range data, and every sale as a closed trade.
 */
export function stockBook(ctx: Context, ccy: Ccy, asOf: IsoDate): { rows: StockRow[]; trades: ClosedTrade[] } {
  const h: Holdings = { asOf, positions: new Map(), cash: new Map() };
  const state = new Map<string, State>();
  const trades: ClosedTrade[] = [];
  const quote = (amount: Decimal, account: string, asset: string, date: IsoDate) => {
    const acc = ctx.book.accounts.get(account)!.ccy;
    return ctx.book.fx.convert(amount, acc, ctx.book.assets.get(asset)!.ccy, date);
  };
  for (const tx of sortLedger(ctx.ledger)) {
    if (tx.date > asOf) break;
    const asset = tx.asset ? ctx.book.assets.get(tx.asset) : undefined;
    const tracked = asset?.pricing === 'market' && !!asset.symbol && tx.qty !== undefined && !tx.qty.isZero();
    const k = tx.asset ? positionKey(tx.account, tx.asset) : '';
    const realized0 = h.positions.get(k)?.realized ?? ZERO;
    apply(h, tx);
    if (!tracked || !asset) continue;
    const qty = tx.qty!;
    const fee = tx.fee ?? ZERO;
    const day = daysBetween(EPOCH, tx.date);
    const s = state.get(k) ?? { qty: ZERO, avg: ZERO, day, lots: [] };
    if (tx.type === 'BUY') {
      const price = quote(tx.amount.neg().minus(fee), tx.account, asset.id, tx.date).div(qty);
      const q = s.qty.plus(qty);
      s.avg = s.avg.times(s.qty).plus(price.times(qty)).div(q);
      s.day = s.qty.isZero() ? day : (s.day * s.qty.toNumber() + day * qty.toNumber()) / q.toNumber();
      s.qty = q;
      s.lots.push({ date: tx.date, qty, price });
      state.set(k, s);
    } else if ((tx.type === 'SELL' || tx.type === 'WRITE_OFF') && !s.qty.isZero()) {
      const exit = tx.type === 'SELL' ? quote(tx.amount.plus(fee), tx.account, asset.id, tx.date).div(qty) : ZERO;
      const ret = s.avg.isZero() ? 0 : exit.div(s.avg).minus(1).toNumber();
      const days = Math.max(0, day - Math.round(s.day));
      const dr = h.positions.get(k)!.realized.minus(realized0);
      trades.push({
        date: tx.date,
        account: tx.account,
        asset: asset.id,
        name: asset.name,
        ccy: asset.ccy,
        qty,
        entry: s.avg,
        exit,
        days,
        ret,
        annual: annualized(ret, days),
        realized: ctx.book.fx.convert(dr, ctx.book.accounts.get(tx.account)!.ccy, ccy, tx.date),
      });
      if (h.positions.get(k)!.open) s.qty = s.qty.minus(qty);
      else state.delete(k);
    }
  }

  const rows: StockRow[] = [];
  for (const [k, s] of state) {
    const p = h.positions.get(k);
    if (!p?.open || s.qty.isZero()) continue;
    const asset = ctx.book.assets.get(p.asset)!;
    const symbol = asset.symbol!;
    const pts = (ctx.book.prices.history?.(symbol) ?? []).filter((x) => x.date <= asOf);
    const price = ctx.book.prices.close(symbol, asOf);
    const since = addDays(EPOCH, Math.round(s.day));
    const days = daysBetween(since, asOf);
    const year = pts.filter((x) => x.date > addDays(asOf, -365));
    const closes = year.map((x) => x.close.toNumber());
    const target = asset.target ? new Decimal(asset.target) : undefined;
    const ret = price && !s.avg.isZero() ? price.close.div(s.avg).minus(1).toNumber() : undefined;
    const step = Math.max(1, Math.ceil(year.length / 120));
    rows.push({
      key: k,
      account: p.account,
      asset: asset.id,
      name: asset.name,
      symbol,
      ccy: asset.ccy,
      bucket: asset.bucket,
      ...(asset.strategy ? { strategy: asset.strategy } : {}),
      qty: s.qty,
      avgPrice: s.avg,
      since,
      days,
      price,
      stale: !!price && daysBetween(price.date, asOf) > 5,
      change1d: price && pts.length >= 2 ? change(pts, addDays(price.date, -1), price) : undefined,
      change1m: price && change(pts, addDays(asOf, -30), price),
      changeYtd: price && change(pts, `${Number(asOf.slice(0, 4)) - 1}-12-31`, price),
      low52: closes.length ? Math.min(...closes) : undefined,
      high52: closes.length ? Math.max(...closes) : undefined,
      target,
      progress: target && price && target.gt(s.avg) ? price.close.minus(s.avg).div(target.minus(s.avg)).toNumber() : undefined,
      toTarget: target && price && !price.close.isZero() ? target.div(price.close).minus(1).toNumber() : undefined,
      ret,
      annual: ret === undefined ? undefined : annualized(ret, days),
      lots: s.lots.map((l) => ({ ...l, ret: price && !l.price.isZero() ? price.close.div(l.price).minus(1).toNumber() : undefined })),
      spark: year.filter((_, i) => i % step === 0 || i === year.length - 1).map((x) => ({ date: x.date, close: x.close.toNumber() })),
    });
  }
  return { rows, trades: trades.reverse() };
}

/** Share of sales that closed with a gain, the spreadsheet's "average batting". */
export function battingAverage(trades: readonly ClosedTrade[]): number | undefined {
  return trades.length ? trades.filter((t) => t.ret > 0).length / trades.length : undefined;
}
