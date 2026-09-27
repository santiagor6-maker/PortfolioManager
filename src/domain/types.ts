import type { Ccy, Decimal } from './money.ts';
import type { IsoDate } from './dates.ts';

/**
 * Sign convention: `amount` is the cash effect on the account, in the account currency.
 * BUY/CAPITAL_CALL/FEE/TAX/WITHDRAWAL/TRANSFER_OUT are negative; SELL/DIVIDEND/INTEREST/DEPOSIT/TRANSFER_IN positive.
 * VALUATION carries the market value of the whole position (positive) and does not move cash.
 * COMMITMENT carries the contract price as a negative amount (e.g. an off-plan property) and does not move cash.
 */
export type TxType =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'BUY'
  | 'SELL'
  | 'WRITE_OFF'
  | 'DIVIDEND'
  | 'INTEREST'
  | 'FEE'
  | 'TAX'
  | 'VALUATION'
  | 'COMMITMENT'
  | 'CAPITAL_CALL';

export const TX_TYPES: readonly TxType[] = [
  'DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'BUY', 'SELL', 'WRITE_OFF',
  'DIVIDEND', 'INTEREST', 'FEE', 'TAX', 'VALUATION', 'COMMITMENT', 'CAPITAL_CALL',
];

/** Types that need an asset. */
export const ASSET_TX: ReadonlySet<TxType> = new Set([
  'BUY', 'SELL', 'WRITE_OFF', 'DIVIDEND', 'VALUATION', 'COMMITMENT', 'CAPITAL_CALL',
]);

/** Money crossing the account boundary (external flows at account level). */
export const EXTERNAL_TX: ReadonlySet<TxType> = new Set(['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT']);

export interface Transaction {
  id?: string;
  date: IsoDate;
  account: string;
  type: TxType;
  asset?: string;
  /** Units bought, sold or written off. Optional for assets without units (funds valued by statement, property). */
  qty?: Decimal;
  amount: Decimal;
  /** Always the account currency. */
  ccy: Ccy;
  /** Commission included in `amount`, for display only. */
  fee?: Decimal;
  /** True for reconstructed or estimated data (estimated dividends, list-price valuations). */
  estimated?: boolean;
  /** Links the two legs of a transfer between accounts. */
  transferId?: string;
  note?: string;
}

/** `market`: priced from a public quote (`symbol`). `manual`: priced by VALUATION transactions entered by the user. */
export type Pricing = 'market' | 'manual';

export interface Asset {
  id: string;
  name: string;
  /** Quote currency of `symbol`. */
  ccy: Ccy;
  /** Asset class bucket used for grouping and benchmarks (e.g. acciones_cop, acciones_usd, cripto, fondos, inmobiliario). */
  bucket: string;
  pricing: Pricing;
  symbol?: string;
  /** The user's target price, in `ccy` (a decimal string). */
  target?: string;
  /** The user's thesis for holding it (e.g. Valor, Crecimiento, Cíclica). */
  strategy?: string;
}

export interface Account {
  id: string;
  name: string;
  ccy: Ccy;
}
