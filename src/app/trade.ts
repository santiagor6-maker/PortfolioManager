import { dec } from '../domain/money.ts';
import type { Decimal } from '../domain/money.ts';
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

/** What leaves the account on a buy (units × price + fee) or reaches it on a sale (units × price − fee), to the cent (half up). */
export function tradeTotal(kind: string, qty: Decimal, price: Decimal, fee: Decimal | undefined): Decimal {
  const gross = qty.times(price);
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
