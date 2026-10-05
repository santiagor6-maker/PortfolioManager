import { dec } from '../domain/money.ts';
import type { Account, Asset, Transaction } from '../domain/types.ts';

/** JSON-safe transaction: decimals as strings so nothing passes through a binary float. */
export type StoredTx = Omit<Transaction, 'qty' | 'amount' | 'fee'> & { qty?: string; amount: string; fee?: string };

export interface StoredPrice {
  symbol: string;
  date: string;
  close: string;
  ccy: string;
  source: string;
}

export interface StoredRate {
  /** Currency, quoted as units per 1 USD. */
  ccy: string;
  date: string;
  perUsd: string;
  source: string;
}

/** A total-return index used to compare the asset classes listed in `buckets`. */
export interface Benchmark {
  symbol: string;
  name: string;
  buckets: string[];
}

/**
 * A month the user closed, with the figures as they stood (in COP), so a later change to that month
 * (a late dividend, a corrected price) can be flagged instead of silently rewriting a closed month.
 */
export interface MonthClose {
  /** Month-end date. */
  month: string;
  closedAt: string;
  total: string;
  exRealEstate: string;
  gain: string;
}

/**
 * The investor's own policy, set in Orientación: what the advice is measured against. Weights are fractions
 * (0.3 = 30 %). Nothing here is market data; every value is the user's choice (the view offers templates).
 */
export interface InvestorProfile {
  /** Years until most of the money is needed. */
  horizonYears: number;
  /** Deepest fall of the liquid portfolio the user would sit through without selling, as a positive fraction. */
  maxDrawdown: number;
  /** Target weight of each class in the liquid portfolio (everything but real estate; cash is `efectivo`); they add up to 1. */
  targets: Record<string, number>;
  /** Amount the user expects to invest each month (decimal string, in `monthlyCcy`). */
  monthly?: string;
  monthlyCcy?: string;
  /** Largest weight of one company's stock in the liquid portfolio. */
  maxPosition: number;
  /** Largest share of net worth in real estate (equity). */
  maxRealEstate: number;
  /** When the balance still owed on a property bought on a payment plan falls due (YYYY-MM-DD). */
  commitmentDue?: string;
  /** Part of that balance paid with money from outside the portfolio: a mortgage, an assignment, savings elsewhere (decimal string, COP). */
  commitmentFunding?: string;
  /** What the property is for: it changes whether it counts as an investment. */
  propertyPlan?: 'vivir' | 'arrendar' | 'vender';
  /** Months of expenses kept outside the portfolio as an emergency fund. */
  emergencyMonths?: number;
  /** Household income and expenses per month, after taxes (decimal strings, COP): what the plan can afford. */
  income?: string;
  expenses?: string;
  /** The mortgage for the balance: effective annual rate (0.12 = 12 % E.A.) and term in years. */
  mortgageRate?: number;
  mortgageYears?: number;
  /** For a property to rent: expected monthly rent and monthly costs (administration, property tax, upkeep), COP. */
  rent?: string;
  rentCosts?: string;
  updatedAt: string;
}

/** Everything the app stores. Exported as a single JSON backup. */
export interface Dataset {
  format: 'investment-tracker';
  version: 1;
  accounts: Account[];
  assets: Asset[];
  benchmarks: Benchmark[];
  ledger: StoredTx[];
  prices: StoredPrice[];
  fx: StoredRate[];
  closes: MonthClose[];
  profile?: InvestorProfile;
}

export function emptyDataset(): Dataset {
  return { format: 'investment-tracker', version: 1, accounts: [], assets: [], benchmarks: [], ledger: [], prices: [], fx: [], closes: [] };
}

export function toStored(t: Transaction): StoredTx {
  const { qty, amount, fee, ...rest } = t;
  return { ...rest, amount: amount.toString(), ...(qty ? { qty: qty.toString() } : {}), ...(fee ? { fee: fee.toString() } : {}) };
}

export function fromStored(t: StoredTx): Transaction {
  const { qty, amount, fee, ...rest } = t;
  return { ...rest, amount: dec(amount), ...(qty ? { qty: dec(qty) } : {}), ...(fee ? { fee: dec(fee) } : {}) };
}

export function parseDataset(json: string): Dataset {
  const d = JSON.parse(json) as Partial<Dataset>;
  if (d.format !== 'investment-tracker' || d.version !== 1) throw new Error('No es un respaldo de este tracker (formato o versión desconocidos)');
  return { ...emptyDataset(), ...d } as Dataset;
}
