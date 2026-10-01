import { ZERO, sum } from './money.ts';
import type { Ccy, Decimal } from './money.ts';
import { daysBetween } from './dates.ts';
import type { IsoDate } from './dates.ts';
import type { FxTable } from './fx.ts';
import type { Holdings, Position } from './holdings.ts';
import type { PriceSource } from './prices.ts';
import type { Account, Asset } from './types.ts';

/**
 * How a position was valued:
 * - `market`: units × public close.
 * - `manual`: the user's latest VALUATION (copy portfolios, funds, property), shown with its date;
 *   `estimated` only when the valuation itself is an estimate (e.g. a property list price, not a broker statement).
 * - `cost`: no price and no valuation; remaining cost basis stands in and the UI must flag it as missing data.
 */
export type ValuationMethod = 'market' | 'manual' | 'cost';

export interface ValuedPosition {
  account: string;
  asset: string;
  bucket: string;
  qty: Decimal;
  /** Value in the requested currency. For committed assets, equity: gross value − amount still owed. */
  value: Decimal;
  /** Remaining cost basis in the requested currency (converted at the valuation date). */
  cost: Decimal;
  method: ValuationMethod;
  /** Currency the value was taken in before converting: the price's for a market close, the account's for a manual value or cost. */
  valuedIn: Ccy;
  /** Date of the price or valuation used. */
  priceDate?: IsoDate;
  priceAgeDays?: number;
  estimated: boolean;
}

export interface Book {
  assets: ReadonlyMap<string, Asset>;
  accounts: ReadonlyMap<string, Account>;
  prices: PriceSource;
  fx: FxTable;
}

export interface Valuation {
  date: IsoDate;
  ccy: Ccy;
  positions: ValuedPosition[];
  cash: { account: string; value: Decimal }[];
  total: Decimal;
}

function lookup<T>(m: ReadonlyMap<string, T>, id: string, what: string): T {
  const v = m.get(id);
  if (!v) throw new Error(`${what} desconocido: ${id}`);
  return v;
}

export function valuePosition(book: Book, p: Position, date: IsoDate, ccy: Ccy): ValuedPosition {
  const asset = lookup(book.assets, p.asset, 'Activo');
  const accCcy = lookup(book.accounts, p.account, 'Cuenta').ccy;
  const owed = p.commitment ? p.commitment.minus(p.cost) : ZERO;
  const base = { account: p.account, asset: p.asset, bucket: asset.bucket, qty: p.qty };
  const cost = book.fx.convert(p.cost, accCcy, ccy, date);

  if (asset.pricing === 'market' && asset.symbol) {
    const px = book.prices.close(asset.symbol, date);
    if (px) {
      return {
        ...base,
        value: book.fx.convert(p.qty.times(px.close), px.ccy, ccy, date),
        cost,
        method: 'market',
        valuedIn: px.ccy,
        priceDate: px.date,
        priceAgeDays: daysBetween(px.date, date),
        estimated: false,
      };
    }
  }
  if (p.valuation) {
    return {
      ...base,
      value: book.fx.convert(p.valuation.value.minus(owed), accCcy, ccy, date),
      cost,
      method: 'manual',
      valuedIn: accCcy,
      priceDate: p.valuation.date,
      priceAgeDays: daysBetween(p.valuation.date, date),
      estimated: p.valuation.estimated,
    };
  }
  return { ...base, value: cost, cost, method: 'cost', valuedIn: accCcy, estimated: true };
}

export function valueHoldings(
  book: Book,
  h: Holdings,
  ccy: Ccy,
  include: (account: string, asset?: Asset) => boolean = () => true,
  withCash = true,
): Valuation {
  const positions: ValuedPosition[] = [];
  for (const p of h.positions.values()) {
    if (!p.open || !include(p.account, book.assets.get(p.asset))) continue;
    positions.push(valuePosition(book, p, h.asOf, ccy));
  }
  const cash: Valuation['cash'] = [];
  if (withCash) {
    for (const [account, c] of h.cash) {
      if (!include(account)) continue;
      const acc = lookup(book.accounts, account, 'Cuenta');
      cash.push({ account, value: book.fx.convert(c, acc.ccy, ccy, h.asOf) });
    }
  }
  const total = sum(positions.map((p) => p.value)).plus(sum(cash.map((c) => c.value)));
  return { date: h.asOf, ccy, positions, cash, total };
}

