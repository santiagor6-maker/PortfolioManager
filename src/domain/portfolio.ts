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
 * - `assets`: some holdings across accounts, measured like a bucket (their trades are the flows, no cash).
 * - `bucket`: an asset class across accounts. Buys/capital calls are money in; sales, write-offs and
 *   dividends are money out (they land in the account's cash, outside the bucket). Cash is excluded.
 * - `accounts`: whole accounts including their cash. Deposits, withdrawals and transfers are the flows.
 * - `total`: every account. Only deposits and withdrawals count; transfers between accounts are internal.
 * - `mix`: any set of asset classes, with or without the accounts' cash. Without cash it adds up the
 *   buckets (their trades are the flows). With cash it is the total minus the classes left out: deposits
 *   and withdrawals, plus money moving between the cash and a class left out (a buy of it is money out).
 *   Either way the scopes add up: mix(S, cash) + each class left out = total.
 */
export type Scope =
  | { kind: 'bucket'; bucket: string }
  | { kind: 'assets'; assets: readonly string[] }
  | { kind: 'accounts'; accounts: readonly string[] }
  | { kind: 'total' }
  | { kind: 'mix'; buckets: readonly string[]; cash: boolean };

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
    case 'assets':
      return BUCKET_FLOWS.has(tx.type) && tx.asset && scope.assets.includes(tx.asset) ? tx.amount.neg() : undefined;
    case 'accounts':
      return ACCOUNT_FLOWS.has(tx.type) && scope.accounts.includes(tx.account) ? tx.amount : undefined;
    case 'total':
      return TOTAL_FLOWS.has(tx.type) ? tx.amount : undefined;
    case 'mix': {
      const bucket = tx.asset && BUCKET_FLOWS.has(tx.type) ? book.assets.get(tx.asset)?.bucket : undefined;
      if (!scope.cash) return bucket !== undefined && scope.buckets.includes(bucket) ? tx.amount.neg() : undefined;
      if (TOTAL_FLOWS.has(tx.type)) return tx.amount;
      return bucket !== undefined && !scope.buckets.includes(bucket) ? tx.amount : undefined;
    }
  }
}

function value(book: Book, scope: Scope, h: Holdings, ccy: Ccy): Valuation {
  switch (scope.kind) {
    case 'bucket':
      return valueHoldings(book, h, ccy, (_acc, asset) => asset?.bucket === scope.bucket, false);
    case 'assets':
      return valueHoldings(book, h, ccy, (_acc, asset) => asset !== undefined && scope.assets.includes(asset.id), false);
    case 'accounts':
      return valueHoldings(book, h, ccy, (acc) => scope.accounts.includes(acc));
    case 'total':
      return valueHoldings(book, h, ccy);
    case 'mix':
      return valueHoldings(book, h, ccy, (_acc, asset) => (asset ? scope.buckets.includes(asset.bucket) : true), scope.cash);
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

