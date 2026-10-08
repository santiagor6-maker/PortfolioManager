import { dec } from '../domain/money.ts';
import type { Decimal } from '../domain/money.ts';
import type { IsoDate } from '../domain/dates.ts';
import type { FxTable } from '../domain/fx.ts';
import type { Transaction } from '../domain/types.ts';

/**
 * A typed number: "1.234.567,89" (es-CO), "1234567.89", "1,234,567.89". In a peso account a single dot before three
 * digits ("2.345", "234.500") is a thousands separator, as a peso price or amount is written; elsewhere it stays a
 * decimal point (a dollar price of 2.345). Undefined when it is not a number.
 */
export function parseNum(s: string, ccy?: string): Decimal | undefined {
  const t = s.trim().replace(/\s/g, '');
  if (!t) return undefined;
  const norm =
    ccy === 'COP' && /^-?[1-9]\d{0,2}(\.\d{3})+$/.test(t)
      ? t.replace(/\./g, '')
      : /,\d*$/.test(t)
        ? t.replace(/\./g, '').replace(',', '.')
        : t.replace(/,/g, '');
  try {
    return dec(norm);
  } catch {
    return undefined;
  }
}

/** A stored number written back into a form field: plain digits (no exponent) and a decimal comma, so `parseNum` reads it back exactly in any currency. */
export const field = (x: Decimal): string => x.toFixed().replace('.', ',');

/**
 * What leaves the account on a buy (units × price + fee) or reaches it on a sale (units × price − fee), to the cent
 * (half up). With `rate`, the price is in the asset's quote currency and is converted at the broker's rate: by
 * default `rate` is account currency per 1 of the quote currency (a Nagarro sale in euros on a dollar account: units ×
 * EUR price × USD per EUR); `inverted` when it is typed the other way round, quote currency per 1 of the account's
 * (pesos per dollar), and the gross is divided by it. The fee is in the account's currency.
 */
export function tradeTotal(kind: string, qty: Decimal, price: Decimal, fee: Decimal | undefined, rate?: Decimal, inverted = false): Decimal {
  const raw = qty.times(price);
  const gross = rate ? (inverted ? raw.div(rate) : raw.times(rate)) : raw;
  const f = fee ?? dec(0);
  return (kind === 'SELL' ? gross.minus(f) : gross.plus(f)).toDecimalPlaces(2);
}

/** The price per unit (6 decimals) a buy's or sale's total implies: (|total| − fee) / units for a buy, (|total| + fee) / units for a sale. */
export function impliedPrice(kind: string, amount: Decimal, qty: Decimal, fee: Decimal | undefined): Decimal {
  const f = fee ?? dec(0);
  const gross = kind === 'SELL' ? amount.abs().plus(f) : amount.abs().minus(f);
  return gross.div(qty).toDecimalPlaces(6);
}

/**
 * The price per unit to edit a stored buy or sale with, only when units × that price ± fee gives back its stored total
 * to the cent; otherwise undefined and the form keeps the stored total (editing must never change an amount by itself).
 */
export function editablePrice(tx: Pick<Transaction, 'type' | 'amount' | 'qty' | 'fee'>): Decimal | undefined {
  if ((tx.type !== 'BUY' && tx.type !== 'SELL') || !tx.qty || tx.qty.isZero()) return undefined;
  const price = impliedPrice(tx.type, tx.amount, tx.qty, tx.fee);
  return price.gt(0) && tradeTotal(tx.type, tx.qty, price, tx.fee).eq(tx.amount.abs()) ? price : undefined;
}

/**
 * The stored rate of `to` per unit of `from` on `date` (both against USD, as the app keeps them), with the date of the
 * older of the two quotes; undefined when either is missing or stale. A check on the rate the user types, never a fill-in.
 */
export function storedRate(fx: FxTable, from: string, to: string, date: IsoDate): { rate: Decimal; date: IsoDate } | undefined {
  try {
    const a = fx.perUsd(from, date);
    const b = fx.perUsd(to, date);
    return { rate: b.perUsd.div(a.perUsd), date: a.date < b.date ? a.date : b.date };
  } catch {
    return undefined;
  }
}

/** How a typed rate compares with the stored one: `ok` within 5 %, `inverted` when it is the stored one upside down, else `far`. */
export function rateCheck(typed: Decimal, stored: Decimal): 'ok' | 'inverted' | 'far' {
  const near = (x: Decimal) => x.div(stored).minus(1).abs().lte(0.05);
  if (near(typed)) return 'ok';
  return typed.gt(0) && near(dec(1).div(typed)) ? 'inverted' : 'far';
}

/** Currencies quoted as dollars per unit (EUR/USD 1,08); every other one is quoted as units per dollar (USD/CAD 1,37). */
const ABOVE_USD = ['EUR', 'GBP', 'AUD', 'NZD'];
const rank = (c: string) => (ABOVE_USD.includes(c) ? ABOVE_USD.indexOf(c) : c === 'USD' ? ABOVE_USD.length : 99);

/**
 * Which way the user types the rate between an asset's quote currency and the account's: by market convention, as
 * brokers show it, so it does not depend on what rates happen to be stored — 1,08 USD per EUR, but 1,37 CAD and
 * 4.100 COP per USD. Between two currencies of the same rank (CAD and COP) it is the stored rate, kept above 1, and
 * without one the peso goes per the other.
 */
export function rateQuote(quoteCcy: string, accountCcy: string, stored?: Decimal): { base: string; per: string; inverted: boolean } {
  const rq = rank(quoteCcy);
  const ra = rank(accountCcy);
  const inverted = rq !== ra ? ra < rq : stored ? stored.lt(1) : quoteCcy === 'COP';
  return inverted ? { base: accountCcy, per: quoteCcy, inverted } : { base: quoteCcy, per: accountCcy, inverted };
}
