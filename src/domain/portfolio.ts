import type { Ccy, Decimal } from './money.ts';
import type { IsoDate } from './dates.ts';
import { apply } from './holdings.ts';
import type { Holdings } from './holdings.ts';
import { sortLedger } from './ledger.ts';
import type { Transaction, TxType } from './types.ts';
import { valueHoldings } from './valuation.ts';
import type { Book, Valuation } from './valuation.ts';

/**
 * What is being measured, and therefore which flows are external to it:
 * - `bucket`: an asset class across accounts. Buys/capital calls are money in; sales, write-offs and
 *   dividends are money out (they land in the account's cash, outside the bucket). Cash is excluded.
 * - `accounts`: whole accounts including their cash. Deposits, withdrawals and transfers are the flows.
 * - `total`: every account. Only deposits and withdrawals count; transfers between accounts are internal.
 */
export type Scope =
  | { kind: 'bucket'; bucket: string }
  | { kind: 'accounts'; accounts: readonly string[] }
  | { kind: 'total' };

export interface Flow {
  date: IsoDate;
  /** Money into the portfolio (+) or out of it (−), in the series currency. */
  amount: Decimal;
}

export interface Series {
  ccy: Ccy;
  values: { date: IsoDate; value: Decimal; valuation: Valuation }[];
  flows: Flow[];
}

export const BUCKET_FLOWS: ReadonlySet<TxType> = new Set(['BUY', 'SELL', 'WRITE_OFF', 'DIVIDEND', 'CAPITAL_CALL']);
const ACCOUNT_FLOWS: ReadonlySet<TxType> = new Set(['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT']);
export const TOTAL_FLOWS: ReadonlySet<TxType> = new Set(['DEPOSIT', 'WITHDRAWAL']);

function flowOf(book: Book, scope: Scope, tx: Transaction): Decimal | undefined {
  switch (scope.kind) {
    case 'bucket':
      if (!BUCKET_FLOWS.has(tx.type) || !tx.asset) return undefined;
      return book.assets.get(tx.asset)?.bucket === scope.bucket ? tx.amount.neg() : undefined;
    case 'accounts':
      return ACCOUNT_FLOWS.has(tx.type) && scope.accounts.includes(tx.account) ? tx.amount : undefined;
    case 'total':
      return TOTAL_FLOWS.has(tx.type) ? tx.amount : undefined;
  }
}

function value(book: Book, scope: Scope, h: Holdings, ccy: Ccy): Valuation {
  switch (scope.kind) {
    case 'bucket':
      return valueHoldings(book, h, ccy, (_acc, asset) => asset?.bucket === scope.bucket, false);
    case 'accounts':
      return valueHoldings(book, h, ccy, (acc) => scope.accounts.includes(acc));
    case 'total':
      return valueHoldings(book, h, ccy);
  }
}

/** Values the scope at each date (ascending) and collects its external flows up to the last date. */
export function portfolioSeries(
  book: Book,
  txs: readonly Transaction[],
  scope: Scope,
  ccy: Ccy,
  dates: readonly IsoDate[],
): Series {
  const sorted = sortLedger(txs);
  const last = dates[dates.length - 1];
  const h: Holdings = { asOf: dates[0] ?? '', positions: new Map(), cash: new Map() };
  const flows: Flow[] = [];
  const values: Series['values'] = [];
  let i = 0;
  for (const d of dates) {
    for (; i < sorted.length && sorted[i]!.date <= d; i++) {
      const tx = sorted[i]!;
      apply(h, tx);
      const f = flowOf(book, scope, tx);
      if (f && !f.isZero()) {
        const acc = book.accounts.get(tx.account);
        if (!acc) throw new Error(`Cuenta desconocida: ${tx.account}`);
        flows.push({ date: tx.date, amount: book.fx.convert(f, acc.ccy, ccy, tx.date) });
      }
    }
    h.asOf = d;
    const v = value(book, scope, h, ccy);
    values.push({ date: d, value: v.total, valuation: v });
  }
  return { ccy, values, flows: flows.filter((f) => last === undefined || f.date <= last) };
}

