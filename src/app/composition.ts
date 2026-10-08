import { ZERO } from '../domain/money.ts';
import type { Decimal } from '../domain/money.ts';
import type { IsoDate } from '../domain/dates.ts';
import type { CellFlag, TrackRow, Tracking } from './tracking.ts';
import { REAL_ESTATE } from './tracking.ts';

export const CASH_ID = 'efectivo';

export interface Slice {
  id: string;
  label: string;
  /** Asset class; `efectivo` for broker cash. */
  bucket: string;
  /** Account name, for a holding. */
  sub?: string;
  value: Decimal;
  /** Share of the positive total (0–1). */
  share: number;
  flag?: CellFlag;
}

export interface Composition {
  month: IsoDate;
  /** Sum of the positive parts: what the shares are of. */
  total: Decimal;
  /** Classes plus broker cash, largest first. */
  classes: Slice[];
  /** Every holding with a positive value, largest first; share of the same total. */
  holdings: Slice[];
  /** Broker cash below zero (owed to the broker): left out of the shares, never netted against a class. */
  negativeCash?: Decimal;
  /** Holdings worth less than zero at that month-end (e.g. a property net of what is still owed): listed apart, no share. */
  negativeHoldings: Omit<Slice, 'share'>[];
}

const slice = (r: TrackRow, k: number, bucket: string): Omit<Slice, 'share'> => {
  const c = r.cells[k]!;
  return { id: r.id, label: r.label, bucket, ...(r.sub ? { sub: r.sub } : {}), value: c.value, ...(c.flag ? { flag: c.flag } : {}) };
};

/**
 * What the portfolio is made of at month-end `k` of a tracking: each class and each holding as a share of the
 * positive total, with or without real estate. Uses the tracking's own month-end values (same rates and flags).
 */
export function composition(t: Tracking, k: number, withRealEstate: boolean): Composition {
  const keep = (b: string) => withRealEstate || b !== REAL_ESTATE;
  const classes = t.classes.filter((r) => keep(r.bucket!)).map((r) => slice(r, k, r.bucket!));
  const cash = t.cash.cells[k]!.value;
  if (cash.gt(0)) classes.push({ id: CASH_ID, label: 'Efectivo', bucket: CASH_ID, value: cash });
  const parts = classes.filter((c) => c.value.gt(0));
  const holdings = t.assets.filter((r) => keep(r.bucket!) && r.cells[k]!.value.gt(0)).map((r) => slice(r, k, r.bucket!));
  const negativeHoldings = t.assets.filter((r) => keep(r.bucket!) && r.cells[k]!.value.lt(0)).map((r) => slice(r, k, r.bucket!));
  const total = parts.reduce((s, p) => s.plus(p.value), ZERO);
  const share = (v: Decimal) => (total.gt(0) ? v.div(total).toNumber() : 0);
  const desc = (a: { value: Decimal }, b: { value: Decimal }) => b.value.comparedTo(a.value);
  return {
    month: t.months[k]!,
    total,
    classes: parts.sort(desc).map((p) => ({ ...p, share: share(p.value) })),
    holdings: holdings.sort(desc).map((h) => ({ ...h, share: share(h.value) })),
    ...(cash.lt(0) ? { negativeCash: cash.neg() } : {}),
    negativeHoldings,
  };
}

/** What a class's positive holdings add up to: the base of each holding's share of its class (never above 100 %). */
export const classBase = (c: Composition, bucket: string): Decimal => c.holdings.filter((h) => h.bucket === bucket).reduce((s, h) => s.plus(h.value), ZERO);

/** Share of `part` in `whole` (0 when the whole is not positive). */
export const shareOf = (part: Decimal, whole: Decimal): number => (whole.gt(0) ? part.div(whole).toNumber() : 0);
