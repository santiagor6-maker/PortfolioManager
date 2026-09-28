import { ZERO } from '../domain/money.ts';
import type { Decimal } from '../domain/money.ts';
import { addDays, monthEnd } from '../domain/dates.ts';
import type { IsoDate } from '../domain/dates.ts';
import { drawdowns, maxDrawdown, volatility } from '../domain/risk.ts';
import type { CellFlag, TrackRow } from './tracking.ts';

/**
 * Analysis views built on the month-by-month tracking: returns by year and month, risk (falls and
 * volatility) and where the gain of a period came from. All figures are at month-ends.
 */

const monthBefore = (d: IsoDate) => addDays(`${d.slice(0, 8)}01`, -1);

/** First month the row holds something or moves money; −1 when it never does. */
function firstActive(row: TrackRow): number {
  return row.cells.findIndex((c) => !c.value.isZero() || !c.flow.isZero());
}

/** Indexes of the months after `from` (all when undefined), from the row's first active month. */
export function periodMonths(row: TrackRow, months: readonly IsoDate[], from?: IsoDate): number[] {
  const first = firstActive(row);
  if (first < 0) return [];
  const out: number[] = [];
  for (let m = first; m < months.length; m++) if (!from || months[m]! > from) out.push(m);
  return out;
}

export interface MonthCell {
  date: IsoDate;
  r: number | null;
  /** Modified Dietz is unreliable this month (large flows next to the capital). */
  approx?: true;
  flag?: CellFlag;
}

export interface YearReturns {
  year: string;
  /** Twelve slots, January first; undefined outside the row's history. */
  months: (MonthCell | undefined)[];
  /** The year's monthly returns chained (time-weighted); null when no month has a return. */
  total: number | null;
  /** Some month of the year is approximate, so the year is too. */
  approx: boolean;
}

/** Monthly returns laid out by calendar year, most recent year first. */
export function returnsByYear(row: TrackRow, months: readonly IsoDate[]): YearReturns[] {
  const years = new Map<string, YearReturns>();
  for (const m of periodMonths(row, months)) {
    const d = months[m]!;
    const y = d.slice(0, 4);
    if (!years.has(y)) years.set(y, { year: y, months: Array(12).fill(undefined), total: null, approx: false });
    const c = row.cells[m]!;
    years.get(y)!.months[Number(d.slice(5, 7)) - 1] = { date: d, r: c.r, ...(c.approx ? { approx: true as const } : {}), ...(c.flag ? { flag: c.flag } : {}) };
    if (c.approx) years.get(y)!.approx = true;
  }
  for (const y of years.values()) {
    const rs = y.months.filter((c): c is MonthCell => c !== undefined && c.r !== null).map((c) => c.r!);
    y.total = rs.length ? rs.reduce((g, r) => g * (1 + r), 1) - 1 : null;
  }
  return [...years.values()].sort((a, b) => (a.year < b.year ? 1 : -1));
}

export interface Underwater {
  date: IsoDate;
  /** Fall from the previous high, e.g. −0.12. */
  drawdown: number;
}

export interface LevelRisk {
  /** Annualized volatility of the monthly returns. */
  volatility?: number;
  maxDrawdown?: { depth: number; peak: IsoDate; trough: IsoDate; recovered?: IsoDate };
  /** Fall from the previous high at the last date (0 at a new high). */
  current: number;
  underwater: Underwater[];
}

function levelRisk(dates: readonly IsoDate[], levels: readonly number[], returns: readonly number[]): LevelRisk {
  const dd = drawdowns(levels);
  const worst = maxDrawdown(levels);
  return {
    volatility: volatility(returns),
    ...(worst ? { maxDrawdown: { depth: worst.depth, peak: dates[worst.peak]!, trough: dates[worst.trough]!, ...(worst.recovered !== undefined ? { recovered: dates[worst.recovered]! } : {}) } } : {}),
    current: dd[dd.length - 1] ?? 0,
    underwater: dates.map((date, i) => ({ date, drawdown: dd[i]! })),
  };
}

export interface Risk extends LevelRisk {
  /** The month-end the level starts at (1) and the last month-end. */
  from?: IsoDate;
  to?: IsoDate;
  /** Months with a return in the period, used for the statistics. */
  months: number;
  /** Months left out because Modified Dietz is unreliable in them (large flows next to the capital). */
  approx: IsoDate[];
  /** Months valued with a price or manual value from an earlier date, at cost, or with an estimate. */
  flagged: Record<CellFlag, number>;
  best?: { date: IsoDate; r: number };
  worst?: { date: IsoDate; r: number };
  /** Share of those months with a gain. */
  positive?: number;
}

/**
 * Risk of a tracking row over the months after `from`: its monthly returns chained into a level that starts
 * at 1 the month-end before, the falls from each high, and the volatility of the monthly returns.
 * A month without a return (no capital at risk) or with an unreliable one (`approx`) keeps the level and is
 * left out of the statistics; the approximate months are listed so the view can say so.
 */
export function riskOf(row: TrackRow, months: readonly IsoDate[], from?: IsoDate): Risk {
  const idx = periodMonths(row, months, from);
  const flagged: Record<CellFlag, number> = { cost: 0, stale: 0, estimated: 0 };
  if (!idx.length) return { months: 0, approx: [], flagged, current: 0, underwater: [] };
  const dates = [monthBefore(months[idx[0]!]!)];
  const levels = [1];
  const rs: { date: IsoDate; r: number }[] = [];
  const approx: IsoDate[] = [];
  for (const m of idx) {
    const c = row.cells[m]!;
    const r = c.approx ? null : c.r;
    if (c.approx) approx.push(months[m]!);
    if (c.flag) flagged[c.flag]++;
    dates.push(months[m]!);
    levels.push(levels[levels.length - 1]! * (1 + (r ?? 0)));
    if (r !== null) rs.push({ date: months[m]!, r });
  }
  const byR = [...rs].sort((a, b) => a.r - b.r);
  return {
    ...levelRisk(dates, levels, rs.map((x) => x.r)),
    from: dates[0]!,
    to: dates[dates.length - 1]!,
    months: rs.length,
    approx,
    flagged,
    ...(rs.length ? { best: byR[byR.length - 1]!, worst: byR[0]!, positive: rs.filter((x) => x.r > 0).length / rs.length } : {}),
  };
}

/**
 * Risk of a level series (e.g. growth of 100 of the portfolio or of an index). Volatility uses only
 * whole months: returns between two consecutive month-end points. Missing levels are skipped.
 */
export function levelSeriesRisk(dates: readonly IsoDate[], levels: readonly (number | null)[]): LevelRisk {
  const pts = dates.map((date, i) => ({ date, v: levels[i] })).filter((p): p is { date: IsoDate; v: number } => p.v !== null && p.v !== undefined);
  const returns: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (a.date === monthEnd(a.date) && b.date === monthEnd(b.date) && monthBefore(b.date) === a.date) returns.push(b.v / a.v - 1);
  }
  return levelRisk(pts.map((p) => p.date), pts.map((p) => p.v), returns);
}

/** Gain of a row over the given months: value change minus the money put in, month by month. */
export function gainOver(row: TrackRow, idx: readonly number[]): Decimal {
  return idx.reduce((s, m) => s.plus(row.cells[m]!.gain), ZERO);
}

export interface BridgePart {
  id: string;
  label: string;
  bucket?: string;
  gain: Decimal;
}

/** Value at the start, net money put in, each row's gain and the value at the end: start + flows + Σ gains = end. */
export interface GainBridge {
  start: IsoDate;
  end: IsoDate;
  startValue: Decimal;
  flows: Decimal;
  parts: BridgePart[];
  endValue: Decimal;
}

/** Where the change in value of a set of rows (e.g. the classes and cash) came from over the months after `from`. */
export function gainBridge(rows: readonly TrackRow[], months: readonly IsoDate[], from?: IsoDate): GainBridge | undefined {
  const idx = months.map((_, m) => m).filter((m) => (!from || months[m]! > from) && rows.some((r) => m >= firstActive(r) && firstActive(r) >= 0));
  if (!idx.length) return undefined;
  const m0 = idx[0]!;
  const m1 = idx[idx.length - 1]!;
  const sum = (f: (r: TrackRow) => Decimal) => rows.reduce((s, r) => s.plus(f(r)), ZERO);
  return {
    start: m0 > 0 ? months[m0 - 1]! : monthBefore(months[m0]!),
    end: months[m1]!,
    startValue: m0 > 0 ? sum((r) => r.cells[m0 - 1]!.value) : ZERO,
    flows: sum((r) => idx.reduce((s, m) => s.plus(r.cells[m]!.flow), ZERO)),
    parts: rows.map((r) => ({ id: r.id, label: r.label, ...(r.bucket !== undefined ? { bucket: r.bucket } : {}), gain: gainOver(r, idx) })),
    endValue: sum((r) => r.cells[m1]!.value),
  };
}
