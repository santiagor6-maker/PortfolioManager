import { Decimal, ZERO, sum } from '../domain/money.ts';
import type { Ccy } from '../domain/money.ts';
import { addDays, daysBetween, monthEnd, monthEnds } from '../domain/dates.ts';
import { maxDrawdown } from '../domain/risk.ts';
import type { IsoDate } from '../domain/dates.ts';
import { ksPme, pme } from '../domain/benchmark.ts';
import type { IndexLevel } from '../domain/benchmark.ts';
import { MissingDataError } from '../domain/fx.ts';
import { holdingsAt } from '../domain/holdings.ts';
import { portfolioSeries } from '../domain/portfolio.ts';
import type { Flow } from '../domain/portfolio.ts';
import { xirr } from '../domain/returns.ts';
import type { Benchmark, InvestorProfile } from '../data/json.ts';
import { bucketLabel } from './analysis.ts';
import { sortLedger } from '../domain/ledger.ts';
import type { Context } from './analysis.ts';
import { indicatorRows } from './indicators.ts';
import { riskOf } from './insights.ts';
import { REAL_ESTATE, tracking } from './tracking.ts';
import { date, money, pct, ratio } from './format.ts';

/**
 * Orientación: a diagnosis of the portfolio against evidence and against the investor's own policy
 * (`InvestorProfile`), turned into a ranked action plan. Pure and deterministic: every finding is computed
 * from the ledger, the stored prices and the profile, and carries the figures it rests on. It never names a
 * security to buy beyond the indexes the user already compares against and the index funds already held,
 * and it never forecasts returns: the evidence is what happened to the user's own money.
 */

/** The class the liquid portfolio's cash is targeted as. */
export const CASH = 'efectivo';
export const CLASS_LABEL = (c: string) => (c === CASH ? 'Efectivo' : bucketLabel(c));

/** What an asset tagged with this strategy is: a fund that holds an index (or a copied basket), not one company. */
export const INDEX_STRATEGY = 'Índice';

/** Policy used while the investor has not set a profile, and the fields a profile cannot leave out. */
export const DEFAULT_POLICY = { maxPosition: 0.05, maxRealEstate: 0.5, cash: 0.03 } as const;

/** Years of history a class needs before its record against the index is judged. */
export const MIN_YEARS = 3;
/** Kaplan–Schoar PME below which a class's selection is said to lag its index (5 % less wealth than the index). */
export const LAG_PME = 0.95;
/** …and above which it is said to beat it. */
export const LEAD_PME = 1.05;
/** Years of the liquid portfolio's own history its worst fall is taken from (its mix years ago was another portfolio). */
export const RISK_YEARS = 5;
/** A finding moving less than this share of net worth is not ranked high, whatever its percentage. */
export const MATERIAL = 0.01;

export type RiskLevel = 'conservador' | 'moderado' | 'crecimiento' | 'agresivo';

/**
 * Starting templates for the profile form, not advice for a given person. The equity / defensive split
 * follows the usual ladder by risk tolerance (about 30 / 50 / 75 / 95 % in stocks); the stock part goes mostly
 * to global stocks in USD because Colombia is far below 1 % of the world's stock market, and the defensive part
 * to fixed income in COP, the currency the investor spends. Each template's tolerable fall covers what its own mix
 * would lose in the crisis scenario (`CRISIS`). The user edits every figure.
 */
export const PRESETS: Record<RiskLevel, { label: string; horizonYears: number; maxDrawdown: number; targets: Record<string, number> }> = {
  conservador: { label: 'Conservador', horizonYears: 3, maxDrawdown: 0.15, targets: { acciones_usd: 0.2, acciones_cop: 0.05, fondos: 0.05, cripto: 0, renta_fija: 0.6, [CASH]: 0.1 } },
  moderado: { label: 'Moderado', horizonYears: 5, maxDrawdown: 0.25, targets: { acciones_usd: 0.35, acciones_cop: 0.07, fondos: 0.08, cripto: 0, renta_fija: 0.45, [CASH]: 0.05 } },
  crecimiento: { label: 'Crecimiento', horizonYears: 10, maxDrawdown: 0.4, targets: { acciones_usd: 0.55, acciones_cop: 0.1, fondos: 0.1, cripto: 0.02, renta_fija: 0.2, [CASH]: 0.03 } },
  agresivo: { label: 'Agresivo', horizonYears: 15, maxDrawdown: 0.5, targets: { acciones_usd: 0.7, acciones_cop: 0.1, fondos: 0.1, cripto: 0.05, renta_fija: 0.03, [CASH]: 0.02 } },
};

export function presetProfile(level: RiskLevel, today: IsoDate): InvestorProfile {
  const p = PRESETS[level];
  return {
    horizonYears: p.horizonYears,
    maxDrawdown: p.maxDrawdown,
    targets: { ...p.targets },
    maxPosition: DEFAULT_POLICY.maxPosition,
    maxRealEstate: DEFAULT_POLICY.maxRealEstate,
    updatedAt: today,
  };
}

/** A decimal string as a Decimal, or undefined when it is missing or not a number. */
export function decimalOr(s: string | undefined): Decimal | undefined {
  if (s === undefined) return undefined;
  try {
    const d = new Decimal(s);
    return d.isFinite() ? d : undefined;
  } catch {
    return undefined;
  }
}

/** Why a profile cannot be used as it stands, or undefined when it can. */
export function profileProblem(p: InvestorProfile): string | undefined {
  const w = Object.values(p.targets);
  if (w.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) return 'Cada peso objetivo debe estar entre 0 % y 100 %.';
  const total = w.reduce((s, x) => s + x, 0);
  if (Math.abs(total - 1) > 0.001) return `Los pesos objetivo suman ${pct(total)}; deben sumar 100 %.`;
  if (!(p.horizonYears > 0)) return 'El horizonte debe ser de al menos un año.';
  if (!(p.maxDrawdown > 0 && p.maxDrawdown < 1)) return 'La caída tolerable debe estar entre 1 % y 99 %.';
  if (!(p.maxPosition > 0 && p.maxPosition <= 1)) return 'El límite por acción debe estar entre 1 % y 100 %.';
  if (!(p.maxRealEstate >= 0 && p.maxRealEstate <= 1)) return 'El límite inmobiliario debe estar entre 0 % y 100 %.';
  const amounts: [keyof InvestorProfile, string][] = [
    ['monthly', 'El aporte mensual'], ['income', 'El ingreso'], ['expenses', 'Los gastos'], ['commitmentFunding', 'Lo que pagas por fuera'], ['rent', 'El arriendo'], ['rentCosts', 'Los costos del arriendo'],
  ];
  for (const [k, label] of amounts) {
    const v = p[k];
    if (v === undefined) continue;
    const d = decimalOr(String(v));
    if (!d) return `${label} no es un número.`;
    if (d.lt(0)) return `${label} no puede ser negativo.`;
  }
  if (p.emergencyMonths !== undefined && !(Number.isFinite(p.emergencyMonths) && p.emergencyMonths >= 0)) return 'Los meses del fondo de emergencia deben ser un número de 0 en adelante.';
  if (p.mortgageYears !== undefined && !(Number.isInteger(p.mortgageYears) && p.mortgageYears >= 1 && p.mortgageYears <= 40)) return 'El plazo del crédito debe estar entre 1 y 40 años.';
  if (p.mortgageRate !== undefined && !(Number.isFinite(p.mortgageRate) && p.mortgageRate >= 0 && p.mortgageRate < 1)) return 'La tasa del crédito debe estar entre 0 % y 100 % efectivo anual.';
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Holdings against the index: the same money, on the same dates, in the class's index.

export interface HoldingGap {
  asset: string;
  name: string;
  strategy: string;
  open: boolean;
  /** First money in. */
  since: IsoDate;
  /** Money put in (sum of buys), in the report currency at each date's rate. */
  invested: Decimal;
  /** Value today plus nothing else: what was taken out is in the flows. Undefined when it could not be valued. */
  value?: Decimal;
  /** What the same flows would be worth in the index today (can be negative after large withdrawals). */
  indexValue?: Decimal;
  /** value − indexValue: positive when the holding did better than the index with the same money. */
  gap?: Decimal;
  /** Annual money-weighted returns; null under a year of history (a return is not annualized over less than a year). */
  xirr: number | null;
  indexXirr: number | null;
  /** Held for less than a year: returns are not annualized. */
  young: boolean;
  /** Why the comparison could not be made (an index level missing on a flow date). */
  missing?: string;
}

export interface GroupGap {
  key: string;
  value: Decimal;
  indexValue: Decimal;
  gap: Decimal;
  count: number;
}

/**
 * A class over a period: its money-weighted return (XIRR), the same flows in the index (PME: its XIRR and
 * terminal value) and the Kaplan–Schoar PME. A period that starts after the first money in counts the class's
 * value on that date as money in.
 */
export interface ClassWindow {
  id: 'all' | '36m';
  since: IsoDate;
  years: number;
  value: Decimal;
  xirr: number | null;
  indexXirr: number | null;
  indexValue: Decimal;
  ksPme: number;
}

export interface ClassRecord {
  bucket: string;
  label: string;
  bench: Benchmark;
  /** Since the first money in and over the last three years (when the class is older): see `ClassWindow`. */
  windows: ClassWindow[];
  /** Every holding the class ever had, worst gap first; the gaps add up to the class's. */
  holdings: HoldingGap[];
  byStrategy: GroupGap[];
  value: Decimal;
  indexValue: Decimal;
  gap: Decimal;
  /** Holdings left out of the sums (missing index data). */
  missing: string[];
  /** Index funds the user already holds in the class (the natural core). */
  indexHeld: string[];
}

function levelOf(ctx: Context, symbol: string, ccy: Ccy): IndexLevel {
  return (d) => {
    const px = ctx.book.prices.close(symbol, d);
    if (!px) throw new MissingDataError(`${symbol} sin nivel el ${d}`);
    return ctx.book.fx.convert(px.close, px.ccy, ccy, d);
  };
}

/** One holding (all its accounts) against an index: its flows bought and sold in the index on the same dates. */
export function holdingGap(ctx: Context, asset: string, ccy: Ccy, asOf: IsoDate, level: IndexLevel): HoldingGap | undefined {
  const a = ctx.book.assets.get(asset);
  let s;
  try {
    s = portfolioSeries(ctx.book, ctx.ledger, { kind: 'assets', assets: [asset] }, ccy, [asOf]);
  } catch (e) {
    // A rate missing on a trade date: the holding cannot be compared, the rest still can.
    if (!(e instanceof MissingDataError)) throw e;
    const first = ctx.ledger.filter((t) => t.asset === asset).reduce<string | undefined>((m, t) => (!m || t.date < m ? t.date : m), undefined);
    if (!first) return undefined;
    return { asset, name: a?.name ?? asset, strategy: a?.strategy || 'Sin estrategia', open: true, since: first, invested: ZERO, young: daysBetween(first, asOf) < 365, xirr: null, indexXirr: null, missing: e.message };
  }
  const flows: Flow[] = s.flows;
  if (!flows.length) return undefined;
  const value = s.values[0]!.value;
  const base = {
    asset,
    name: a?.name ?? asset,
    strategy: a?.strategy || 'Sin estrategia',
    open: !value.isZero() || s.values[0]!.valuation.positions.length > 0,
    since: flows[0]!.date,
    invested: sum(flows.filter((f) => f.amount.gt(0)).map((f) => f.amount)),
    value,
    young: daysBetween(flows[0]!.date, asOf) < 365,
  };
  const annual = (x: number | null) => (base.young ? null : x);
  const own = annual(xirr([...flows.map((f) => ({ date: f.date, amount: f.amount.neg() })), { date: asOf, amount: value }]));
  try {
    const p = pme(flows, asOf, level);
    return { ...base, xirr: own, indexValue: p.endValue, gap: value.minus(p.endValue), indexXirr: annual(p.xirr) };
  } catch (e) {
    if (e instanceof MissingDataError) return { ...base, xirr: own, indexXirr: null, missing: e.message };
    throw e;
  }
}

const yearsBetween = (a: IsoDate, b: IsoDate) => daysBetween(a, b) / 365;
/** The month-end `n` years before the month of `d` (30 sep 2026 → 30 sep 2023). */
const yearsBack = (d: IsoDate, n: number) => monthEnd(`${Number(d.slice(0, 4)) - n}${d.slice(4, 8)}01`);

function classWindows(ctx: Context, bucket: string, ccy: Ccy, asOf: IsoDate, level: IndexLevel): ClassWindow[] {
  const out: ClassWindow[] = [];
  const back = yearsBack(asOf, 3);
  for (const id of ['all', '36m'] as const) {
    try {
      const all = portfolioSeries(ctx.book, ctx.ledger, { kind: 'bucket', bucket }, ccy, [asOf]);
      const first = all.flows[0]?.date;
      if (!first) return out;
      let flows: Flow[] = all.flows;
      let since = first;
      let value = all.values[0]!.value;
      if (id === '36m') {
        if (first > back) continue;
        const s = portfolioSeries(ctx.book, ctx.ledger, { kind: 'bucket', bucket }, ccy, [back, asOf]);
        const start = s.values[0]!.value;
        flows = [...(start.isZero() ? [] : [{ date: back, amount: start }]), ...s.flows.filter((f) => f.date > back)];
        since = back;
        value = s.values[1]!.value;
      }
      if (!flows.some((x) => x.amount.gt(0))) continue; // nothing held in the window
      const p = pme(flows, asOf, level);
      out.push({
        id,
        since,
        years: yearsBetween(since, asOf),
        value,
        xirr: xirr([...flows.map((f) => ({ date: f.date, amount: f.amount.neg() })), { date: asOf, amount: value }]),
        indexXirr: p.xirr,
        indexValue: p.endValue,
        ksPme: ksPme(flows, value, asOf, level),
      });
    } catch (e) {
      if (!(e instanceof MissingDataError)) throw e;
    }
  }
  return out;
}

/** Each market class with an index: how its holdings did against that index with the same money. */
export function classRecords(ctx: Context, ccy: Ccy, asOf: IsoDate): ClassRecord[] {
  const out: ClassRecord[] = [];
  const buckets = [...new Set([...ctx.book.assets.values()].map((a) => a.bucket))].filter((b) => b !== REAL_ESTATE);
  for (const bucket of buckets) {
    const bench = ctx.benchmarks.find((b) => b.buckets.includes(bucket));
    if (!bench) continue;
    const level = levelOf(ctx, bench.symbol, ccy);
    const holdings: HoldingGap[] = [];
    for (const a of ctx.book.assets.values()) {
      if (a.bucket !== bucket) continue;
      const g = holdingGap(ctx, a.id, ccy, asOf, level);
      if (g) holdings.push(g);
    }
    if (!holdings.length) continue;
    const known = holdings.filter((h) => h.gap !== undefined);
    const groups = new Map<string, GroupGap>();
    for (const h of known) {
      const g = groups.get(h.strategy) ?? { key: h.strategy, value: ZERO, indexValue: ZERO, gap: ZERO, count: 0 };
      g.value = g.value.plus(h.value!);
      g.indexValue = g.indexValue.plus(h.indexValue!);
      g.gap = g.gap.plus(h.gap!);
      g.count++;
      groups.set(h.strategy, g);
    }
    const windows = classWindows(ctx, bucket, ccy, asOf, level);
    const openIds = new Set(holdings.filter((h) => h.open).map((h) => h.asset));
    out.push({
      bucket,
      label: bucketLabel(bucket),
      bench,
      windows,
      holdings: holdings.sort((x, y) => (x.gap ?? ZERO).comparedTo(y.gap ?? ZERO)),
      byStrategy: [...groups.values()].sort((x, y) => x.gap.comparedTo(y.gap)),
      value: sum(known.map((h) => h.value!)),
      indexValue: sum(known.map((h) => h.indexValue!)),
      gap: sum(known.map((h) => h.gap!)),
      missing: holdings.filter((h) => h.missing).map((h) => h.name),
      indexHeld: [...ctx.book.assets.values()].filter((a) => a.bucket === bucket && a.strategy === INDEX_STRATEGY && a.pricing === 'market' && openIds.has(a.id)).map((a) => a.name),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Allocation: where the liquid portfolio stands against the targets, and how to close the gap with new money.

export interface MixRow {
  cls: string;
  value: Decimal;
  /** Share of the liquid portfolio. */
  weight: number;
  target?: number;
  /** weight − target. */
  drift?: number;
  /** Beyond the tolerance band (5 points, or a quarter of a target under 20 %). */
  outOfBand?: boolean;
}

/** The 5/25 rule: a class is out of balance when it is 5 points off a target of 20 % or more, or a quarter off a smaller one. */
export function band(target: number): number {
  return target >= 0.2 ? 0.05 : Math.max(target * 0.25, 0.01);
}

/**
 * New money goes to the classes furthest below their target value (after adding it), in proportion to the
 * shortfall (cash included, up to its target); any money left once every shortfall is covered follows the targets
 * of the other classes. Nothing is sold.
 */
export function splitContribution(values: ReadonlyMap<string, Decimal>, targets: Readonly<Record<string, number>>, amount: Decimal): { cls: string; amount: Decimal }[] {
  const classes = [...new Set([...Object.keys(targets), ...values.keys()])];
  const total = sum(classes.map((c) => values.get(c) ?? ZERO)).plus(amount);
  const takers = classes.filter((c) => c !== CASH);
  // Cash below its target is topped up from the shortfall; it never takes the money left over (that is invested).
  const short = new Map([...takers, ...(classes.includes(CASH) ? [CASH] : [])].map((c) => [c, Decimal.max(ZERO, total.times(targets[c] ?? 0).minus(values.get(c) ?? ZERO))]));
  const need = sum([...short.values()]);
  const out = new Map<string, Decimal>();
  if (need.gte(amount)) {
    if (need.gt(0)) for (const [c, s] of short) if (s.gt(0)) out.set(c, amount.times(s).div(need));
  } else {
    const rest = amount.minus(need);
    const w = takers.reduce((x, c) => x + (targets[c] ?? 0), 0);
    for (const c of takers) out.set(c, (short.get(c) ?? ZERO).plus(w > 0 ? rest.times(targets[c] ?? 0).div(w) : ZERO));
  }
  return [...out.entries()].filter(([, a]) => a.gt(0)).map(([cls, a]) => ({ cls, amount: a })).sort((x, y) => y.amount.comparedTo(x.amount));
}

/** The cash this month above its target share of the portfolio (after adding the contribution). */
export function idleCashOf(values: ReadonlyMap<string, Decimal>, targets: Readonly<Record<string, number>>, monthly: Decimal): Decimal {
  const total = sum([...values.values()]).plus(monthly);
  return Decimal.max(ZERO, (values.get(CASH) ?? ZERO).minus(total.times(targets[CASH] ?? 0)));
}

export interface ContributionPlan {
  /** Cash above its target, put to work along with this month's contribution. */
  idleCash: Decimal;
  /** Of this month's money (contribution + idle cash), what goes to the reserve for a payment due. */
  toReserve: Decimal;
  /** The rest, to each class of the mix, largest first. */
  split: { cls: string; amount: Decimal }[];
  /** Months (this one included) until the reserve is complete; 0 when none is needed. */
  reserveMonths?: number;
  /** What the contributions cannot gather before the payment is due: it has to come from selling (only when the reserve is known and within reach). */
  sellNeeded: Decimal;
  /** Months (prices unchanged) until the reserve is complete and every class is inside its band; undefined beyond 10 years or when the reserve cannot be gathered in time. */
  months?: number;
  /** What this month's money and the contributions until the due date gather for the reserve. */
  gatheredByDue: Decimal;
  /** The reserve is complete by the due date. */
  onTime: boolean;
}

/**
 * A payment due comes first: this month's contribution and the idle cash fill the reserve for it, and only
 * what is left goes to the classes below their targets (`splitContribution`). Then the same contribution every
 * month, at today's prices, until the reserve is complete and the mix is back inside its bands. Nothing is sold;
 * what the contributions cannot gather before the due date is reported as `sellNeeded`.
 */
export function contributionPlan(
  current: ReadonlyMap<string, Decimal>,
  targets: Readonly<Record<string, number>>,
  monthly: Decimal,
  reserve?: { shortfall: Decimal; monthsLeft: number; sellable: boolean },
): ContributionPlan {
  const idleCash = idleCashOf(current, targets, monthly);
  const values = new Map(current);
  if (idleCash.gt(0)) values.set(CASH, (values.get(CASH) ?? ZERO).minus(idleCash));
  const now = monthly.plus(idleCash);
  let owed = reserve?.shortfall ?? ZERO;
  const toReserve = Decimal.min(owed, now);
  owed = owed.minus(toReserve);
  const split = splitContribution(values, targets, now.minus(toReserve));
  for (const s of split) values.set(s.cls, (values.get(s.cls) ?? ZERO).plus(s.amount));
  const left = reserve ? Math.max(0, reserve.monthsLeft - 1) : 0;
  const sellNeeded = reserve?.sellable ? Decimal.max(ZERO, owed.minus(monthly.times(left))) : ZERO;
  const inBand = (v: ReadonlyMap<string, Decimal>) => {
    const t = sum([...v.values()]);
    return t.isZero() || Object.entries(targets).every(([c, w]) => Math.abs((v.get(c) ?? ZERO).div(t).toNumber() - w) <= band(w));
  };
  let reserveMonths: number | undefined = reserve?.shortfall.gt(0) ? (owed.isZero() ? 1 : undefined) : 0;
  let months: number | undefined;
  for (let m = 1; m <= 120; m++) {
    if (owed.isZero() && inBand(values)) {
      months = m;
      break;
    }
    if (monthly.lte(0)) break;
    // At the due date what is still missing comes from the funding or a sale: the contributions go back to the mix.
    const due = !!reserve && m >= reserve.monthsLeft && owed.gt(0);
    if (due) owed = ZERO;
    const r = Decimal.min(owed, monthly);
    owed = owed.minus(r);
    if (!due && owed.isZero() && reserveMonths === undefined) reserveMonths = m + 1;
    for (const s of splitContribution(values, targets, monthly.minus(r))) values.set(s.cls, (values.get(s.cls) ?? ZERO).plus(s.amount));
  }
  const gatheredByDue = reserve ? Decimal.min(reserve.shortfall, now.plus(monthly.times(left))) : ZERO;
  const onTime = !reserve || gatheredByDue.gte(reserve.shortfall);
  return { idleCash, toReserve, split, ...(reserveMonths !== undefined ? { reserveMonths } : {}), sellNeeded, ...(months !== undefined && onTime ? { months } : {}), gatheredByDue, onTime };
}

// ---------------------------------------------------------------------------------------------------------
// Reference data that is not market data: what index some well-known funds hold, and the crisis scenario.

/** Index funds by ticker (without the exchange suffix): the index they hold. Only to name the core the user already has. */
const INDEX_FUNDS: Record<string, string> = {
  SPY: 'S&P 500', VOO: 'S&P 500', IVV: 'S&P 500', SPLG: 'S&P 500', CSPX: 'S&P 500', SXR8: 'S&P 500', VUAA: 'S&P 500', VUSA: 'S&P 500',
  QQQ: 'Nasdaq-100', QQQM: 'Nasdaq-100', CNDX: 'Nasdaq-100', EQQQ: 'Nasdaq-100',
  URTH: 'MSCI World', IWDA: 'MSCI World', SWDA: 'MSCI World',
  VT: 'FTSE All-World', VWRA: 'FTSE All-World', VWRL: 'FTSE All-World', ACWI: 'MSCI ACWI', SSAC: 'MSCI ACWI',
  ICOLCAP: 'MSCI COLCAP',
};
/** An index's name without the ticker of the fund it is read from: "MSCI World (URTH, TR)" → "MSCI World". */
const plainName = (name: string) => name.replace(/\s*\(.*\)\s*$/, '');
const indexOfFund = (symbol: string | undefined) => (symbol ? INDEX_FUNDS[symbol.split('.')[0]!.toUpperCase()] : undefined);
/** Listed in the US (no exchange suffix): for a Colombian resident its dividends carry the 30 % US withholding. */
const usListed = (symbol: string | undefined) => !!symbol && !symbol.includes('.') && indexOfFund(symbol) !== 'MSCI COLCAP';

/**
 * A crisis like 2008–2009, as fixed assumptions (not market data, not a forecast): stocks and funds −50 % (funds are
 * compared with a stock index, so they fall like one), crypto −75 %, fixed income and cash 0 %, property −15 % on its full value, so with a balance
 * still owed the fall in equity is larger. The one historical figure quoted is sourced in `note`; the crypto
 * reference is computed from the stored prices (`indexFall`).
 */
export const CRISIS: { label: string; shocks: Record<string, number>; equity: number; note: string } = {
  label: 'Crisis como la de 2008',
  shocks: { cripto: -0.75, renta_fija: 0, [CASH]: 0, [REAL_ESTATE]: -0.15 },
  equity: -0.5,
  note: 'Supuestos del escenario, no datos: acciones y fondos −50 % (los fondos cuentan como acciones porque los comparas con un índice de acciones), cripto −75 %, renta fija y efectivo 0 % y finca raíz −15 % sobre su valor total. Referencia para las acciones: el S&P 500 (sin dividendos) bajó 56,8 % del cierre de 1.565,15 el 9 oct 2007 al de 676,53 el 9 mar 2009 (cierres oficiales de S&P Dow Jones Indices, recopilados en en.wikipedia.org/wiki/Closing_milestones_of_the_S%26P_500, consultado el 3 oct 2026); con dividendos la caída fue algo menor. No incluye que en esas crisis el dólar suele subir frente al peso, lo que en pesos amortigua lo que tienes en dólares.',
};
const shockOf = (cls: string) => CRISIS.shocks[cls] ?? CRISIS.equity;

/** Worst fall of an index in the stored history, at month-ends, in `ccy`: a sourced reference beside the assumptions. */
function indexFall(ctx: Context, symbol: string, ccy: Ccy, from: IsoDate, to: IsoDate): { depth: number; peak: IsoDate; trough: IsoDate } | undefined {
  const level = levelOf(ctx, symbol, ccy);
  const dates: IsoDate[] = [];
  const levels: number[] = [];
  for (const d of monthEnds(from, to)) {
    try {
      levels.push(level(d).toNumber());
      dates.push(d);
    } catch (e) {
      if (!(e instanceof MissingDataError)) throw e;
    }
  }
  const w = maxDrawdown(levels);
  return w ? { depth: w.depth, peak: dates[w.peak]!, trough: dates[w.trough]! } : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// The diagnosis.

/** The currency the investor spends: decisions (risk, verdicts, reserves) are taken in it, whatever the view. */
export const HOME = 'COP';

/** The home currency when the data has its rate on the cut-off date; otherwise the view's (a portfolio kept only in dollars). */
function homeOf(ctx: Context, ccy: Ccy, asOf: IsoDate): Ccy {
  if (ccy === HOME) return HOME;
  try {
    ctx.book.fx.convert(new Decimal(1), HOME, ccy, asOf);
    return HOME;
  } catch (e) {
    if (e instanceof MissingDataError) return ccy;
    throw e;
  }
}

export type Priority = 'alta' | 'media' | 'baja';
export type Area = 'Venta' | 'Perfil' | 'Liquidez' | 'Concentración' | 'Selección' | 'Asignación' | 'Riesgo' | 'Efectivo' | 'Dividendos' | 'Tesis' | 'Divisas' | 'Impuestos' | 'Datos';

export interface Action {
  id: string;
  priority: Priority;
  area: Area;
  title: string;
  /** What the data shows. */
  finding: string;
  /** What to do about it. */
  action: string;
  /** Why it matters, with the source of any outside evidence. */
  why?: string;
  /** The money at stake (home currency), to rank actions of the same priority. */
  impact?: Decimal;
  evidence: { label: string; value: string }[];
  /** Limits of the finding. */
  caveat?: string;
  /** A positive finding: keep doing it. */
  good?: boolean;
  /** Has a date within a year: ranked first among its priority. */
  urgent?: boolean;
}

export interface RealEstate {
  /** Value net of what is still owed. */
  equity: Decimal;
  /** Latest valuation of the properties (gross). */
  gross: Decimal;
  owed: Decimal;
  /** Equity / net worth. */
  share: number;
  estimated: boolean;
  valuedOn?: IsoDate;
  /** Average monthly payment toward the contract over the last six months. */
  pace: Decimal;
  names: string[];
}

/** Money set apart, in pesos and at low risk, for the balance of a property bought on a payment plan. */
export interface Reserve {
  due: IsoDate;
  monthsLeft: number;
  /** Still owed when it falls due, at the current payment pace. */
  atDue: Decimal;
  /** Covered from outside the portfolio (mortgage, assignment…), as the user wrote it; undefined when not said yet. */
  funding?: Decimal;
  /** What the portfolio has to provide: atDue − funding (all of it while the funding is unknown). */
  need: Decimal;
  /** Already safe for it: cash in pesos and fixed income, up to the need. */
  held: Decimal;
  shortfall: Decimal;
}

export interface Advice {
  asOf: IsoDate;
  /** The view's currency; amounts below are in `home` (the currency decisions are taken in) and shown with `toView`. */
  ccy: Ccy;
  home: Ccy;
  toView: (x: Decimal) => Decimal;
  profile?: InvestorProfile;
  policy: { maxPosition: number; maxRealEstate: number; cashTarget: number };
  netWorth: Decimal;
  liquid: Decimal;
  cash: Decimal;
  /** The liquid portfolio without the reserve, by class: what the targets apply to. */
  mix: MixRow[];
  growth: Decimal;
  reserve?: Reserve;
  realEstate?: RealEstate;
  records: ClassRecord[];
  plan?: ContributionPlan;
  /** Per class of the plan, holdings not to add to (above the per-company limit or past the user's target). */
  avoid: Record<string, string[]>;
  /** Currency each part of net worth depends on (position valued in, or account currency of cash). */
  currencies: { ccy: Ccy; value: Decimal; share: number }[];
  risk: {
    /** Worst fall of the liquid portfolio (time-weighted, month-ends, in pesos) over the last `RISK_YEARS`. */
    historical?: { depth: number; peak: IsoDate; trough: IsoDate };
    /** The crisis scenario on today's liquid portfolio, and on net worth (property and its debt included). */
    crisisLiquid: number;
    crisisNetWorth?: number;
    crisisParts: { cls: string; weight: number; shock: number }[];
    /** The worst fall of each class's index in the stored prices (source: the stored series), for reference. */
    indexFalls: { cls: string; bench: string; depth: number; peak: IsoDate; trough: IsoDate }[];
  };
  actions: Action[];
  /** Up to three actions to start with. */
  top: Action[];
  error?: string;
}

const RANK: Record<Priority, number> = { alta: 0, media: 1, baja: 2 };

/** The portfolio the targets apply to, by class. */
function mixRows(values: ReadonlyMap<string, Decimal>, total: Decimal, targets?: Record<string, number>): MixRow[] {
  const classes = [...new Set([...values.keys(), ...Object.keys(targets ?? {})])];
  return classes
    .map((cls) => {
      const value = values.get(cls) ?? ZERO;
      const weight = total.isZero() ? 0 : value.div(total).toNumber();
      const target = targets?.[cls];
      if (targets && target === undefined) return { cls, value, weight, target: 0, drift: weight, outOfBand: weight > band(0) };
      if (target === undefined) return { cls, value, weight };
      const drift = weight - target;
      return { cls, value, weight, target, drift, outOfBand: Math.abs(drift) > band(target) };
    })
    .filter((r) => !r.value.isZero() || (r.target ?? 0) > 0)
    .sort((a, b) => b.value.comparedTo(a.value) || (b.target ?? 0) - (a.target ?? 0));
}

/**
 * Average cost of each open position (account|asset) in `ccy`, every purchase at the rate of its own date and
 * reduced in proportion to the units sold: in Colombia the tax cost of a foreign holding is in pesos at the rate of
 * each purchase.
 */
export function homeCost(ctx: Context, ccy: Ccy, asOf: IsoDate): Map<string, Decimal> {
  const pos = new Map<string, { qty: Decimal; cost: Decimal }>();
  for (const t of sortLedger(ctx.ledger)) {
    if (t.date > asOf) break;
    if (!t.asset) continue;
    const k = `${t.account}|${t.asset}`;
    const p = pos.get(k) ?? { qty: ZERO, cost: ZERO };
    if (!t.qty) {
      // A sale or write-off without units closes the position, as in the ledger replay.
      if (t.type === 'SELL' || t.type === 'WRITE_OFF') pos.set(k, { qty: ZERO, cost: ZERO });
      continue;
    }
    if (t.type === 'BUY') {
      p.cost = p.cost.plus(ctx.book.fx.convert(t.amount.neg(), ctx.book.accounts.get(t.account)!.ccy, ccy, t.date));
      p.qty = p.qty.plus(t.qty);
    } else if ((t.type === 'SELL' || t.type === 'WRITE_OFF') && p.qty.gt(0)) {
      const left = Decimal.max(ZERO, p.qty.minus(t.qty));
      p.cost = p.cost.times(left).div(p.qty);
      p.qty = left;
    }
    pos.set(k, p);
  }
  return new Map([...pos].filter(([, p]) => p.qty.gt(0)).map(([k, p]) => [k, p.cost]));
}

/** WITHDRAWALs that take a dividend out of the portfolio (same account and date, same amount), in the last year. */
function dividendsTakenOut(ctx: Context, ccys: readonly Ccy[], asOf: IsoDate): { totals: Decimal[]; count: number } {
  const since = addDays(asOf, -365);
  const divs = ctx.ledger.filter((t) => t.type === 'DIVIDEND' && t.date > since && t.date <= asOf);
  const used = new Set<(typeof divs)[number]>();
  const totals = ccys.map(() => ZERO);
  let count = 0;
  for (const w of ctx.ledger) {
    if (w.type !== 'WITHDRAWAL' || w.date <= since || w.date > asOf) continue;
    // Each dividend pairs with one withdrawal only.
    const d = divs.find((x) => !used.has(x) && x.account === w.account && x.date === w.date && x.amount.eq(w.amount.neg()));
    if (!d) continue;
    used.add(d);
    ccys.forEach((c, i) => (totals[i] = totals[i]!.plus(ctx.book.fx.convert(d.amount, ctx.book.accounts.get(d.account)!.ccy, c, d.date))));
    count++;
  }
  return { totals, count };
}

/** Past flows added up in the view's currency, each at the rate of its own date (not today's). */
const atTheirDates = (ctx: Context, txs: readonly { amount: Decimal; account: string; date: IsoDate }[], ccy: Ccy, sign = 1) =>
  sum(txs.map((t) => ctx.book.fx.convert(t.amount.times(sign), ctx.book.accounts.get(t.account)!.ccy, ccy, t.date)));


export function advise(ctx: Context, ccy: Ccy, asOf: IsoDate, profile?: InvestorProfile): Advice {
  const usable = profile && !profileProblem(profile) ? profile : undefined;
  const policy = {
    maxPosition: usable?.maxPosition ?? DEFAULT_POLICY.maxPosition,
    maxRealEstate: usable?.maxRealEstate ?? DEFAULT_POLICY.maxRealEstate,
    cashTarget: usable?.targets[CASH] ?? DEFAULT_POLICY.cash,
  };
  const H = homeOf(ctx, ccy, asOf);
  const toView = (x: Decimal) => (ccy === H ? x : ctx.book.fx.convert(x, H, ccy, asOf));
  const base: Advice = {
    asOf, ccy, home: H, toView, profile, policy, netWorth: ZERO, liquid: ZERO, cash: ZERO, mix: [], growth: ZERO, records: [], avoid: {}, currencies: [],
    risk: { crisisLiquid: 0, crisisParts: [], indexFalls: [] }, actions: [], top: [],
  };
  let valuation;
  try {
    valuation = portfolioSeries(ctx.book, ctx.ledger, { kind: 'total' }, H, [asOf]).values[0]!.valuation;
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
  const f = (x: Decimal) => money(toView(x), ccy);
  const share = (x: Decimal, of: Decimal) => (of.isZero() ? undefined : x.div(of).toNumber());
  const netWorth = valuation.total;
  const cash = sum(valuation.cash.map((c) => c.value));
  // Cash in the home currency that can be set apart: never more than the net cash (an account below zero offsets it).
  const copCash = Decimal.max(ZERO, Decimal.min(sum(valuation.cash.filter((c) => ctx.book.accounts.get(c.account)!.ccy === H).map((c) => Decimal.max(ZERO, c.value))), sum(valuation.cash.map((c) => c.value))));
  const homeFixed = sum(valuation.positions.filter((p) => p.bucket === 'renta_fija' && p.valuedIn === H).map((p) => p.value));
  const byClass = new Map<string, Decimal>();
  for (const p of valuation.positions) byClass.set(p.bucket, (byClass.get(p.bucket) ?? ZERO).plus(p.value));
  const reEquity = byClass.get(REAL_ESTATE) ?? ZERO;
  byClass.delete(REAL_ESTATE);
  if (!cash.isZero()) byClass.set(CASH, cash);
  const liquid = netWorth.minus(reEquity);
  const monthly = usable?.monthly ? ctx.book.fx.convert(decimalOr(usable.monthly) ?? ZERO, usable.monthlyCcy ?? H, H, asOf) : undefined;

  // Currency each part depends on.
  const cur = new Map<Ccy, Decimal>();
  for (const p of valuation.positions) cur.set(p.valuedIn, (cur.get(p.valuedIn) ?? ZERO).plus(p.value));
  for (const c of valuation.cash) {
    const k = ctx.book.accounts.get(c.account)!.ccy;
    cur.set(k, (cur.get(k) ?? ZERO).plus(c.value));
  }
  const currencies = [...cur.entries()]
    .filter(([, v]) => !v.isZero())
    .map(([c, value]) => ({ ccy: c, value, share: share(value, netWorth) ?? 0 }))
    .sort((a, b) => b.value.comparedTo(a.value));

  // Real estate: equity, gross valuation and what is still owed on a payment plan.
  let realEstate: RealEstate | undefined;
  const h = holdingsAt(ctx.ledger, asOf);
  const rePositions = [...h.positions.values()].filter((p) => p.open && ctx.book.assets.get(p.asset)?.bucket === REAL_ESTATE);
  if (rePositions.length) {
    let gross = ZERO;
    let owed = ZERO;
    let estimated = false;
    let valuedOn: IsoDate | undefined;
    for (const p of rePositions) {
      const acc = ctx.book.accounts.get(p.account)!.ccy;
      gross = gross.plus(ctx.book.fx.convert(p.valuation?.value ?? p.commitment ?? p.cost, acc, H, asOf));
      if (p.commitment) owed = owed.plus(ctx.book.fx.convert(p.commitment.minus(p.cost), acc, H, asOf));
      if (!p.valuation || p.valuation.estimated) estimated = true;
      if (p.valuation && (!valuedOn || p.valuation.date < valuedOn)) valuedOn = p.valuation.date;
    }
    const ids = new Set(rePositions.map((p) => p.asset));
    const from = addDays(asOf, -183);
    const calls = ctx.ledger.filter((t) => t.type === 'CAPITAL_CALL' && t.asset && ids.has(t.asset) && t.date > from && t.date <= asOf);
    const paid = atTheirDates(ctx, calls, H, -1);
    realEstate = {
      equity: reEquity, gross, owed, share: share(reEquity, netWorth) ?? 0, estimated,
      ...(valuedOn ? { valuedOn } : {}), pace: paid.div(6), names: [...ids].map((id) => ctx.book.assets.get(id)?.name ?? id),
    };
  }

  // The reserve for the balance due: it comes before any investment.
  let reserve: Reserve | undefined;
  const due = usable?.commitmentDue;
  if (realEstate && realEstate.owed.gt(0) && due && due > asOf) {
    const monthsLeft = Math.max(1, Math.round(daysBetween(asOf, due) / 30.44));
    const atDue = Decimal.max(ZERO, realEstate.owed.minus(realEstate.pace.times(monthsLeft)));
    const funding = decimalOr(usable?.commitmentFunding) && ctx.book.fx.convert(decimalOr(usable?.commitmentFunding)!, usable?.monthlyCcy ?? HOME, H, asOf);
    const need = Decimal.max(ZERO, atDue.minus(funding ?? ZERO));
    const safe = copCash.plus(homeFixed);
    const held = Decimal.min(safe, need);
    reserve = { due, monthsLeft, atDue, ...(funding ? { funding } : {}), need, held, shortfall: need.minus(held) };
  }

  // The growth portfolio: the liquid one without what is already set apart for the reserve (cash in pesos first).
  const growthValues = new Map(byClass);
  if (reserve?.held.gt(0)) {
    const fromCash = Decimal.min(reserve.held, copCash);
    growthValues.set(CASH, (growthValues.get(CASH) ?? ZERO).minus(fromCash));
    const fromFixed = reserve.held.minus(fromCash);
    if (fromFixed.gt(0)) growthValues.set('renta_fija', (growthValues.get('renta_fija') ?? ZERO).minus(fromFixed));
  }
  const growth = liquid.minus(reserve?.held ?? ZERO);
  const mix = mixRows(growthValues, growth, usable?.targets);
  // What sits above the targets in the riskier classes: the natural first sale when the contributions fall short.
  const overweight = mix.filter((r) => r.outOfBand && (r.drift ?? 0) > 0 && shockOf(r.cls) < 0);
  const overExcess = sum(overweight.map((r) => r.value.minus(growth.times(r.target ?? 0))));

  const records = classRecords(ctx, H, asOf);

  // Holdings not to add to: one company above the limit, or a price past the user's own target.
  const byAsset = new Map<string, Decimal>();
  for (const p of valuation.positions) {
    const a = ctx.book.assets.get(p.asset);
    if (!a || a.bucket === REAL_ESTATE || a.pricing !== 'market' || a.strategy === INDEX_STRATEGY || a.bucket === 'cripto' || indexOfFund(a.symbol)) continue;
    byAsset.set(p.asset, (byAsset.get(p.asset) ?? ZERO).plus(p.value));
  }
  const heavy = [...byAsset.entries()]
    .map(([id, value]) => ({ id, name: ctx.book.assets.get(id)!.name, bucket: ctx.book.assets.get(id)!.bucket, value, weight: share(value, liquid) ?? 0 }))
    .filter((x) => x.weight > policy.maxPosition)
    .sort((a, b) => b.weight - a.weight);
  let reached: { name: string; bucket: string; upside: number; price?: string; target?: string; ccy: string }[] = [];
  try {
    reached = indicatorRows(ctx, H, asOf, [...new Set([...ctx.book.assets.values()].map((a) => a.bucket))].filter((b) => b !== REAL_ESTATE))
      .filter((r) => r.upside !== undefined && r.upside <= 0)
      .map((r) => ({ name: r.name, bucket: r.bucket, upside: r.upside!, price: r.price?.close.toString(), target: r.target?.toString(), ccy: r.ccy }));
  } catch {
    /* an impossible ledger is reported elsewhere */
  }
  // Why each one: over the per-company limit, past the user's target, or both.
  const avoid: Record<string, string[]> = {};
  const why = new Map<string, string[]>();
  for (const x of heavy) why.set(x.name, ['tu límite por acción']);
  for (const x of reached) why.set(x.name, [...(why.get(x.name) ?? []), 'tu precio objetivo']);
  for (const x of [...heavy, ...reached]) avoid[x.bucket] = [...new Set([...(avoid[x.bucket] ?? []), x.name])];
  // Holdings in a class above its target that are below their cost in the home currency: selling them first creates
  // little or no tax. The cost of a holding bought in another currency is in pesos at each purchase's rate (that is the
  // cost for tax in Colombia), not today's: a stock down in dollars can be a gain in pesos.
  let losers: { name: string; bucket: string; value: Decimal; loss: Decimal }[] = [];
  try {
    const over = new Set(overweight.map((r) => r.cls));
    const cost = homeCost(ctx, H, asOf);
    const byKey = new Map<string, { asset: string; bucket: string; value: Decimal; cost: Decimal }>();
    for (const p of valuation.positions) {
      const c = cost.get(`${p.account}|${p.asset}`);
      const fund = ctx.book.assets.get(p.asset);
      if (!c || p.method !== 'market' || !over.has(p.bucket) || fund?.strategy === INDEX_STRATEGY || indexOfFund(fund?.symbol)) continue;
      const g = byKey.get(p.asset) ?? { asset: p.asset, bucket: p.bucket, value: ZERO, cost: ZERO };
      g.value = g.value.plus(p.value);
      g.cost = g.cost.plus(c);
      byKey.set(p.asset, g);
    }
    losers = [...byKey.values()]
      .map((g) => ({ name: ctx.book.assets.get(g.asset)?.name ?? g.asset, bucket: g.bucket, value: g.value, loss: g.value.minus(g.cost) }))
      .filter((x) => x.loss.lt(0))
      .sort((x, y) => x.loss.comparedTo(y.loss));
  } catch (e) {
    if (!(e instanceof MissingDataError)) throw e;
  }
  const losersText = (n: number) => losers.slice(0, n).map((x) => `${x.name} (${f(x.loss)})`).join(', ');
  const avoidText = (bucket: string) => (avoid[bucket] ?? []).map((n) => `${n} (por encima de ${why.get(n)!.join(' y de ')})`).join(', ');

  // Risk, always in pesos: the liquid portfolio's own worst fall, and the crisis scenario on today's mix.
  const t = tracking(ctx, H, asOf);
  const hist = riskOf(t.exRealEstate, t.months, yearsBack(asOf, RISK_YEARS)).maxDrawdown;
  const crisisParts = [...byClass.entries()].filter(([, v]) => !v.isZero()).map(([cls, v]) => ({ cls, weight: share(v, liquid) ?? 0, shock: shockOf(cls) }));
  const crisisLiquid = crisisParts.reduce((s, p) => s + p.weight * p.shock, 0);
  const crisisLoss = crisisParts.reduce((s, p) => s.plus(liquid.times(p.weight * p.shock)), ZERO).plus(realEstate ? realEstate.gross.times(shockOf(REAL_ESTATE)) : ZERO);
  const risk: Advice['risk'] = {
    ...(hist ? { historical: { depth: hist.depth, peak: hist.peak, trough: hist.trough } } : {}),
    crisisLiquid,
    ...(netWorth.gt(0) ? { crisisNetWorth: crisisLoss.div(netWorth).toNumber() } : {}),
    crisisParts,
    indexFalls: crisisParts.flatMap((p) => {
      const bench = ctx.benchmarks.find((b) => b.buckets.includes(p.cls));
      const fall = bench && t.months[0] ? indexFall(ctx, bench.symbol, H, t.months[0], asOf) : undefined;
      return bench && fall ? [{ cls: p.cls, bench: bench.name, ...fall }] : [];
    }),
  };

  const plan = usable && monthly !== undefined ? contributionPlan(growthValues, usable.targets, monthly, reserve ? { shortfall: reserve.shortfall, monthsLeft: reserve.monthsLeft, sellable: reserve.funding !== undefined && reserve.need.lte(liquid) } : undefined) : undefined;

  const actions: Action[] = [];
  const material = (x: Decimal) => !netWorth.isZero() && x.abs().div(netWorth).toNumber() >= MATERIAL;
  const months = (x: Decimal) => (monthly && monthly.gt(0) ? Math.ceil(x.div(monthly).toNumber()) : undefined);
  const typed = (x: string | undefined) => {
    const d = decimalOr(x);
    return d === undefined ? undefined : ctx.book.fx.convert(d, usable?.monthlyCcy ?? HOME, H, asOf);
  };
  const income = typed(usable?.income);
  const expenses = typed(usable?.expenses);
  const spare = income && expenses ? income.minus(expenses) : undefined;
  // The outside money the balance needs when none is registered: what the reserve cannot gather by the due date.
  const minFunding = reserve && reserve.funding === undefined && plan ? Decimal.max(ZERO, reserve.atDue.minus(reserve.held).minus(plan.gatheredByDue)) : undefined;
  const loan = reserve ? reserve.funding ?? minFunding : undefined;
  const rate = usable?.mortgageRate;
  const years = usable?.mortgageYears;
  // French amortization at the monthly rate equivalent to the effective annual one.
  const i = rate !== undefined ? new Decimal(1).plus(rate).pow(new Decimal(1).div(12)).minus(1) : undefined;
  const n = years ? years * 12 : undefined;
  const payment = loan && loan.gt(0) && i && n ? (i.isZero() ? loan.div(n) : loan.times(i).div(new Decimal(1).minus(i.plus(1).pow(-n)))) : undefined;
  // Interest paid in the first year: twelve payments minus what they repay of the principal.
  const interestYear1 =
    payment && i && loan ? (i.isZero() ? ZERO : payment.times(12).minus(loan.minus(loan.times(i.plus(1).pow(12)).minus(payment.times(i.plus(1).pow(12).minus(1)).div(i))))) : undefined;
  const rentIn = typed(usable?.rent);
  const rentCostsIn = typed(usable?.rentCosts);
  // A year of rent: eleven months let (one empty), twelve of costs; before income tax. Its monthly average is what the budget counts.
  const rentYear = usable?.propertyPlan === 'arrendar' && rentIn ? rentIn.times(11).minus((rentCostsIn ?? ZERO).times(12)) : undefined;
  const netRent = rentYear?.div(12);

  // 1. The policy everything else is measured against.
  if (!profile) {
    actions.push({
      id: 'profile', priority: 'alta', area: 'Perfil', title: 'Define tu perfil de inversión',
      finding: 'La app aún no sabe tu horizonte, cuánta caída aguantas, tu fondo de emergencia, cómo pagarás el saldo del inmueble ni la mezcla que quieres. Sin eso solo puede compararte con los índices y con reglas generales.',
      action: 'Llena el perfil: elige la plantilla más cercana y ajusta cada cifra. Con él, la app separa lo que necesitas para pagos cercanos, te dice cuánto te desvías y a dónde mandar cada aporte.',
      why: 'Un plan escrito (en la industria, la «declaración de política de inversión») es lo que evita decidir por impulso en las caídas, donde más rentabilidad se pierde.',
      evidence: [],
    });
  } else {
    const problem = profileProblem(profile);
    if (problem) actions.push({ id: 'profile', priority: 'alta', area: 'Perfil', title: 'Corrige tu perfil', finding: problem, action: 'Ajusta el perfil: mientras tanto la app usa los límites por defecto.', evidence: [] });
    else if (daysBetween(profile.updatedAt, asOf) > 365) {
      actions.push({ id: 'profile', priority: 'media', area: 'Perfil', title: 'Revisa tu perfil: tiene más de un año', finding: `Lo actualizaste el ${date(profile.updatedAt)}.`, action: 'Revisa horizonte, caída tolerable, aporte y mezcla: tu vida y tus metas cambian.', evidence: [] });
    }
  }

  // 2. An emergency fund before investing more.
  if (usable && usable.emergencyMonths !== undefined && usable.emergencyMonths < 3) {
    actions.push({
      id: 'emergency', priority: 'alta', area: 'Liquidez', title: 'Arma primero tu fondo de emergencia',
      finding: `Tienes ${usable.emergencyMonths} ${usable.emergencyMonths === 1 ? 'mes' : 'meses'} de gastos fuera del portafolio.`,
      action: 'Antes de invertir más, junta entre 3 y 6 meses de gastos en una cuenta o fondo de liquidez en pesos, aparte de tus inversiones.',
      why: 'Sin ese colchón, un gasto imprevisto te obliga a vender inversiones, a veces en el peor momento.',
      ...(expenses ? { impact: expenses.times(3 - usable.emergencyMonths) } : {}),
      evidence: expenses ? [{ label: 'Gastos mensuales', value: f(expenses) }, { label: 'Fondo de 3 a 6 meses', value: `${f(expenses.times(3))} a ${f(expenses.times(6))}` }] : [],
      urgent: true,
    });
  }

  // 3. The balance of a property bought on a payment plan.
  if (realEstate && realEstate.owed.gt(0)) {
    const name = realEstate.names.join(', ');
    const pension = byClass.has('fondos')
      ? ' Si alguno de tus fondos es de aportes voluntarios a pensión, la ley permite retirarlos para comprar vivienda sin perder el beneficio tributario (artículo 126-1 del Estatuto Tributario): pueden ser parte de la fuente; confírmalo con el fondo.'
      : '';
    const evidence = [
      { label: 'Saldo por pagar hoy', value: f(realEstate.owed) },
      { label: 'Ritmo de pago (promedio de los últimos 6 meses)', value: `${f(realEstate.pace)} al mes` },
      { label: 'Portafolio líquido', value: f(liquid) },
      ...(reserve
        ? [
            { label: `Saldo estimado al ${date(reserve.due)}`, value: f(reserve.atDue) },
            { label: 'Cubierto por fuera del portafolio (crédito, cesión…)', value: reserve.funding ? f(reserve.funding) : 'sin registrar' },
            { label: 'A cargo del portafolio', value: `${f(reserve.need)} (${pct(share(reserve.need, liquid), 0)} del líquido)` },
            { label: 'Ya apartado (efectivo en pesos y renta fija)', value: f(reserve.held) },
            ...(plan ? [{ label: `Lo que tus aportes reúnen hasta el ${date(reserve.due)}`, value: f(plan.gatheredByDue) }] : []),
            ...(minFunding ? [{ label: 'Crédito o cesión mínimos, sin vender inversiones', value: f(minFunding) }] : []),
            ...(minFunding && overExcess.gt(0) ? [{ label: 'Crédito o cesión mínimos, vendiendo lo que está por encima de tu mezcla', value: f(Decimal.max(ZERO, minFunding.minus(overExcess))) }] : []),
            ...(payment ? [{ label: `Cuota del crédito (${f(loan!)} a ${pct(rate, 1)} E.A., ${years} años)`, value: `${f(payment)} al mes${income ? ` · ${pct(share(payment, income), 0)} de tu ingreso` : ''}` }] : []),
          ]
        : []),
    ];
    if (due && due <= asOf) {
      actions.push({
        id: 'commitment-due', priority: 'alta', area: 'Liquidez', title: `La fecha del saldo de ${name} ya pasó y aún figura deuda`,
        finding: `En el perfil el saldo vencía el ${date(due)}, pero el registro aún muestra ${f(realEstate.owed)} por pagar.`,
        action: 'Registra los pagos que hiciste (o el crédito con el que se pagó) en Movimientos, o corrige la fecha en el perfil si se aplazó.',
        impact: realEstate.owed, evidence, urgent: true,
      });
    } else if (!reserve) {
      actions.push({
        id: 'commitment-due', priority: 'alta', area: 'Liquidez', title: `Registra cuándo y cómo pagarás el saldo de ${name}`,
        finding: `Aún debes ${f(realEstate.owed)} del contrato (${pct(share(realEstate.owed, liquid), 0)} de tu portafolio líquido) y pagas en promedio ${f(realEstate.pace)} al mes.`,
        action: 'Escribe en el perfil la fecha en que vence el saldo y cuánto cubrirás por fuera del portafolio (crédito hipotecario aprobado, cesión). Sin eso la app no puede saber cuánto apartar ni si el resto de recomendaciones es seguro.',
        why: 'Es la decisión más grande de tu patrimonio: si el dinero para pagarla está en acciones cuando vence, una caída te obliga a vender barato.',
        impact: realEstate.owed, evidence, urgent: true,
      });
    } else if (reserve.need.gt(0) && reserve.shortfall.isZero()) {
      actions.push({
        id: 'commitment-plan', priority: 'baja', area: 'Liquidez', good: true,
        title: `Ya tienes apartado lo que el portafolio debe poner para el saldo de ${name}`,
        finding: `El portafolio debe poner ${f(reserve.need)} al ${date(reserve.due)} y tienes ${f(reserve.held)} en efectivo en pesos y renta fija.`,
        action: `Mantén esa reserva en pesos y de bajo riesgo (CDT o fondo de liquidez que venza antes del ${date(reserve.due)}) y no la uses para invertir.`,
        evidence,
      });
    } else if (reserve.need.gt(0)) {
      const tooBig = reserve.need.gt(liquid);
      const now = reserve.monthsLeft <= 24;
      actions.push({
        id: 'commitment-plan', priority: 'alta', area: 'Liquidez',
        title: tooBig ? `Tu portafolio no alcanza para el saldo de ${name}: asegura el crédito` : `Aparta ${f(reserve.shortfall)} para el saldo de ${name}`,
        finding: `Al ${date(reserve.due)} quedarían por pagar unos ${f(reserve.atDue)}; ${reserve.funding ? `cubres ${f(reserve.funding)} por fuera, así que` : 'como no has registrado crédito ni otra fuente,'} el portafolio tendría que poner ${f(reserve.need)}: ${pct(share(reserve.need, liquid), 0)} de tu portafolio líquido. Ya tienes apartados ${f(reserve.held)} en pesos.`,
        action: tooBig || (plan && !plan.onTime && reserve.funding === undefined)
          ? `${tooBig ? `Ni con todo tu portafolio líquido alcanza: faltarían ${f(reserve.need.minus(liquid))}. ` : ''}${plan ? `Tus aportes reúnen unos ${f(plan.gatheredByDue)} hasta el ${date(reserve.due)}; ${minFunding ? `necesitas un crédito o una cesión de al menos ${f(minFunding)} si no vendes inversiones${overExcess.gt(0) ? `, o de ${f(Decimal.max(ZERO, minFunding.minus(overExcess)))} si vendes los ${f(overExcess)} que tienes por encima de tu mezcla` : ''}. ` : ''}` : ''}Asegura ya el crédito hipotecario (preaprobado) o la cesión y registra el monto en el perfil. Mientras tanto, tu aporte y el efectivo de más van a una reserva en pesos de corto plazo (CDT o fondo de liquidez que venza antes del ${date(reserve.due)}), no a acciones ni cripto.${pension}`
          : `${now ? 'Desde ahora' : `A partir del ${date(addDays(reserve.due, -730))}`}, manda tu aporte y el efectivo de más a una reserva en pesos de corto plazo (CDT o fondo de liquidez que venza antes del ${date(reserve.due)}) hasta completar ${f(reserve.need)}.${plan && plan.sellNeeded.gt(0) ? ` Con tus aportes no alcanzas a tiempo: tendrías que vender unos ${f(plan.sellNeeded)}, mejor de lo que esté por encima de tu mezcla o de lo que más rinde por debajo del índice, mirando antes el impuesto.` : ''}${pension}`,
        why: 'Una deuda en pesos con fecha fija se cubre con activos en pesos de bajo riesgo que venzan cerca de esa fecha. Si ese dinero está en acciones y el mercado cae justo antes, tendrías que vender barato. Mientras la reserva no esté completa, tu capacidad de asumir riesgo es menor que tu tolerancia.',
        impact: reserve.shortfall, evidence, urgent: reserve.monthsLeft <= 12,
      });
    }
  }

  // 3b. After the delivery: the mortgage payment against income, and the rent against the cost of the loan.
  if (realEstate && realEstate.owed.gt(0) && usable && (!due || due > asOf) && (loan === undefined || loan.gt(0))) {
    const evidence = [
      ...(income ? [{ label: 'Ingreso mensual', value: f(income) }] : []),
      ...(expenses ? [{ label: 'Gastos mensuales', value: f(expenses) }] : []),
      ...(payment ? [{ label: 'Cuota del crédito', value: `${f(payment)} al mes (${f(loan!)} a ${pct(rate, 1)} E.A., ${years} años)` }] : []),
      ...(netRent ? [{ label: 'Arriendo neto esperado (promedio con un mes vacío al año, antes de impuestos)', value: `${f(netRent)} al mes` }] : []),
    ];
    if (!payment) {
      const unknown = [!income ? 'tu ingreso' : '', rate === undefined ? 'la tasa' : '', !years ? 'el plazo' : '', !loan ? 'el monto' : ''].filter(Boolean);
      actions.push({
        id: 'mortgage', priority: reserve && reserve.monthsLeft <= 12 ? 'alta' : 'media', area: 'Liquidez', urgent: !!reserve && reserve.monthsLeft <= 12, title: 'Calcula si puedes con la cuota del crédito',
        finding: `Para pagar el saldo necesitarás un crédito${loan?.gt(0) ? ` de unos ${f(loan)}` : ''}, y la app aún no sabe ${unknown.join(', ')}.`,
        action: 'Pide una simulación al banco y escribe en el perfil la tasa efectiva anual, el plazo y tu ingreso y gastos mensuales: la app calcula la cuota, cuánto pesa en tu ingreso y cuánto te queda para seguir invirtiendo.',
        why: 'Después de la entrega la cuota reemplaza buena parte de lo que hoy aportas; conviene saberlo antes de firmar.',
        evidence,
      });
    } else {
      const ratio = income ? share(payment, income) : undefined;
      const after = spare ? spare.minus(payment).plus(netRent ?? ZERO) : undefined;
      const yieldNet = rentYear && realEstate.gross.gt(0) ? rentYear.div(realEstate.gross).toNumber() : undefined;
      // What the loan's interest costs in a year beyond the rent, as a share of the property's value: the appreciation that only breaks even.
      const breakEven = rentYear && interestYear1 && realEstate.gross.gt(0) ? interestYear1.minus(rentYear).div(realEstate.gross).toNumber() : undefined;
      const parts = [
        `La cuota sería de ${f(payment)} al mes${ratio !== undefined ? `, ${pct(ratio, 0)} de tu ingreso` : ''}.`,
        after ? `Después de la entrega te quedarían ${f(after)} al mes para invertir${monthly ? ` (hoy aportas ${f(monthly)})` : ''}.` : '',
        yieldNet !== undefined ? `Arrendado (con un mes vacío al año y antes de impuestos), rendiría ${pct(yieldNet, 1)} neto al año sobre su valor${realEstate.estimated ? ' estimado' : ''}.` : '',
        breakEven !== undefined ? (breakEven > 0 ? `Los intereses del primer año (${f(interestYear1!)}) superan el arriendo en ${f(interestYear1!.minus(rentYear!))}: para no perder, el inmueble tendría que valorizarse al menos ${pct(breakEven, 1)} al año, más lo que tu propio dinero en él ganaría en otra parte.` : 'El arriendo neto cubre los intereses del crédito.') : '',
      ].filter(Boolean);
      const tooHeavy = ratio !== undefined && ratio > 0.3;
      const short = after?.lt(0) ?? false;
      const soon = !!reserve && reserve.monthsLeft <= 12;
      actions.push({
        id: 'mortgage', priority: tooHeavy || short || soon ? 'alta' : 'media', area: 'Liquidez', urgent: soon,
        title: tooHeavy ? 'La cuota del crédito supera el 30 % de tu ingreso' : short ? 'Después de la entrega no te alcanzaría para la cuota' : 'Así quedan tus cuentas después de la entrega',
        finding: parts.join(' '),
        action:
          [
            tooHeavy || short ? 'Así difícilmente se aprueba ni se sostiene: sube la cuota inicial con la reserva, alarga el plazo o considera la cesión del contrato.' : '',
            after && monthly && after.lt(monthly) && !short ? `Desde la entrega ajusta tu aporte mensual a lo que te quede (${f(after)}).` : '',
            breakEven !== undefined
              ? breakEven > 0
                ? `Decide antes del ${reserve ? date(reserve.due) : 'la entrega'} si conservarlo te conviene: compara esa valorización mínima con lo que de verdad esperas de la zona, y con ceder el contrato y llevar la ganancia al portafolio.`
                : 'Conservarlo para arrendar se paga solo; la decisión es si aceptas tener ahí tanta parte de tu patrimonio.'
              : '',
          ].filter(Boolean).join(' ') || 'Revisa estas cifras con el banco antes de firmar.',
        why: 'En Colombia la primera cuota de un crédito de vivienda no puede pasar del 30 % de los ingresos familiares (Ley 546 de 1999). Comparar el arriendo con los intereses dice si el inmueble paga su deuda o si la paga tu sueldo. Con un crédito largo, revisa también los seguros de vida e incapacidad (el banco exige el de vida) y quién depende de tu ingreso. Los intereses de un crédito de vivienda pueden deducirse de la renta con un tope anual (artículo 119 del Estatuto Tributario) y el arriendo tributa; confírmalo con tu contador.',
        // Ranked by what it puts at risk only when the loan does not fit; otherwise it follows the reserve it depends on.
        ...(tooHeavy || short ? { impact: payment.times(12) } : {}),
        evidence,
        caveat: 'Cuota fija en pesos con la tasa que escribiste; no incluye seguros ni cambios de tasa. El valor del inmueble puede ser un estimado.',
      });
    }
  }

  // 3c. Income and expenses against what the plan already uses each month (contribution and contract payments).
  if (usable && income && spare && monthly) {
    const committed = monthly.plus(realEstate?.owed.gt(0) ? realEstate.pace : ZERO);
    const loose = spare.minus(committed);
    if (loose.abs().gt(income.times(0.1))) {
      const more = loose.gt(0);
      const faster = more && reserve?.shortfall.gt(0) ? Math.ceil(reserve.shortfall.div(monthly.plus(loose)).toNumber()) : undefined;
      actions.push({
        id: 'budget', priority: 'media', area: 'Liquidez',
        title: more ? `Te sobran ${f(loose)} al mes que el plan no usa` : `Tu aporte y las cuotas superan lo que te sobra en ${f(loose.abs())} al mes`,
        finding: `Ingreso ${f(income)} − gastos ${f(expenses!)} = ${f(spare)}; tu aporte (${f(monthly)})${realEstate?.owed.gt(0) ? ` y las cuotas del inmueble (${f(realEstate.pace)})` : ''} suman ${f(committed)}.`,
        action: more
          ? `Si es real, súbelo a tu aporte mensual${faster !== undefined ? `: completarías la reserva del inmueble en unos ${faster} meses` : ''}. Si no, tus gastos son mayores de lo que escribiste: corrígelos en el perfil.`
          : 'Revisa el perfil: o tus gastos son menores, o el aporte que escribiste no es sostenible y conviene bajarlo para no tener que vender.',
        evidence: [],
      });
    }
  }

  // 4. Real estate as a share of net worth.
  if (realEstate && realEstate.share > policy.maxRealEstate) {
    const L = policy.maxRealEstate;
    const growLiquid = L > 0 ? Decimal.max(ZERO, realEstate.equity.times((1 - L) / L).minus(liquid)) : undefined;
    const m = growLiquid && !reserve?.shortfall.gt(0) ? months(growLiquid) : undefined;
    const home = usable?.propertyPlan === 'vivir';
    const leverage = share(realEstate.gross, netWorth);
    actions.push({
      id: 'real-estate', priority: home ? 'media' : 'alta', area: 'Concentración',
      title: `${pct(realEstate.share, 0)} de tu patrimonio está en finca raíz`,
      finding: `Tu parte en ${realEstate.names.join(', ')} vale ${f(realEstate.equity)} de un patrimonio de ${f(netWorth)}; tu límite es ${pct(L, 0)}.${realEstate.owed.gt(0) && leverage ? ` Con lo que aún debes, el inmueble vale ${f(realEstate.gross)}, ${pct(leverage, 0)} de tu patrimonio: cada 10 % que cambie su precio mueve tu patrimonio ${pct(leverage * 0.1, 1)}.` : ''}`,
      action: home
        ? 'Como es para vivir, es tu vivienda más que una inversión: no lo sumes a tu meta de rentabilidad y construye aparte un portafolio líquido que pueda crecer sin depender de él.'
        : `No agregues más a finca raíz fuera de las cuotas pactadas. Para bajar a ${pct(L, 0)} tu portafolio líquido tiene que crecer ${growLiquid ? f(growLiquid) : '—'}${m ? ` (unos ${m} meses de aportes)` : reserve?.shortfall.gt(0) ? ', después de completar la reserva para el saldo' : ''}. Antes de la entrega decide si lo conservas o lo cedes con las cuentas de la tarjeta del crédito (arriendo frente a intereses), y pide un avalúo independiente.`,
      why: 'Un solo inmueble es un activo ilíquido y concentrado: no se vende por partes ni rápido, y su precio depende de un solo proyecto y una sola ciudad.',
      ...(growLiquid ? { impact: growLiquid } : {}),
      evidence: [
        { label: 'Patrimonio neto', value: f(netWorth) },
        { label: 'Finca raíz (neto de deuda)', value: `${f(realEstate.equity)} (${pct(realEstate.share, 0)})` },
        { label: 'Valor del inmueble', value: `${f(realEstate.gross)}${realEstate.valuedOn ? ` al ${date(realEstate.valuedOn)}` : ''}${realEstate.estimated ? ' · estimado' : ''}` },
        ...(realEstate.owed.gt(0) ? [{ label: 'Saldo por pagar', value: f(realEstate.owed) }] : []),
      ],
      ...(realEstate.estimated ? { caveat: 'El valor del inmueble es un estimado (precio de lista), no un avalúo ni una venta: la ganancia no está realizada.' } : {}),
    });
  }

  // 5. Selection against the index, class by class (in pesos).
  for (const r of records) {
    const all = r.windows.find((w) => w.id === 'all');
    const last3 = r.windows.find((w) => w.id === '36m');
    if (!all || all.years < MIN_YEARS) continue;
    const crypto = r.bucket === 'cripto';
    const detractors = r.holdings.filter((x) => x.gap?.lt(0)).slice(0, 3);
    const inHome = ccy === H ? '' : `en ${H === HOME ? 'pesos' : H}: `;
    const vs = (w: ClassWindow) =>
      `${inHome}tu TIR ${pct(w.xirr)} · la del ${crypto ? r.bench.name : 'índice'} con el mismo dinero ${w.indexXirr === null ? '— (tus retiros superan lo que habría dejado)' : pct(w.indexXirr)} · KS-PME ${ratio(w.ksPme)} (por cada $100 en el ${crypto ? r.bench.name : 'índice'} tienes $${Math.round(w.ksPme * 100)})`;
    const evidence = [
      { label: `Desde ${date(all.since)} (${all.years.toFixed(1).replace('.', ',')} años)`, value: vs(all) },
      ...(last3 ? [{ label: 'Últimos 3 años', value: vs(last3) }] : []),
      { label: `Frente al mismo dinero en ${crypto ? r.bench.name : 'el índice'}`, value: `${r.gap.gte(0) ? '+' : ''}${f(r.gap)} hoy` },
      ...r.byStrategy.map((g) => ({ label: `Estrategia «${g.key}» (${g.count} ${g.count === 1 ? 'activo' : 'activos'})`, value: `${g.gap.gte(0) ? '+' : ''}${f(g.gap)}` })),
    ];
    const versus = r.indexValue.gt(0) ? `el ${r.bench.name} valdría hoy ${f(r.indexValue)} y tus ${r.label} valen ${f(r.value)}` : `tendrías hoy ${f(r.gap.abs())} ${r.gap.lt(0) ? 'más' : 'menos'} en el ${r.bench.name}`;
    const lagging = all.ksPme < LAG_PME && (!last3 || last3.ksPme < 1);
    const weight = share(r.value, netWorth) ?? 0;
    const decisive = material(r.gap) && weight >= 0.05;
    const caveat = 'Es lo que pasó, no una predicción: unos años no prueban habilidad ni su falta. Los dividendos estimados cuentan como recibidos.';
    if (lagging && crypto) {
      actions.push({
        id: `selection-${r.bucket}`, priority: weight >= 0.05 ? 'media' : 'baja', area: 'Selección',
        title: `Tu cripto rindió mucho menos que ${r.bench.name}`,
        finding: `Con el mismo dinero en las mismas fechas, ${versus}. Pesa ${pct(weight, 1)} de tu patrimonio.`,
        action: `Decide si mantienes ${r.holdings.filter((x) => x.open).map((x) => x.name).join(', ') || 'lo que tienes'} con una razón concreta o lo cambias por ${r.bench.name}, y limita la cripto a lo que dice tu mezcla objetivo (${pct(usable?.targets.cripto ?? 0, 0)}): es la parte más volátil del portafolio.`,
        impact: r.gap, evidence, caveat,
      });
    } else if (lagging) {
      const held = [...ctx.book.assets.values()].filter((a) => a.bucket === r.bucket && a.pricing === 'market' && r.holdings.some((x) => x.open && x.asset === a.id));
      const core = held.filter((a) => indexOfFund(a.symbol) && r.bench.name.includes(indexOfFund(a.symbol)!));
      // Funds the user tagged as an index whose index the app does not know: named, with a check to make.
      const unsure = held.filter((a) => a.strategy === INDEX_STRATEGY && !indexOfFund(a.symbol));
      const others = ctx.benchmarks.filter((b) => b !== r.bench && b.buckets.includes(r.bucket) && /world|acwi|mundo|all-world/i.test(b.name));
      const us = core.filter((a) => usListed(a.symbol));
      const ucits = core.filter((a) => !usListed(a.symbol));
      actions.push({
        id: `selection-${r.bucket}`, priority: decisive ? 'alta' : 'media', area: 'Selección',
        title: `Tus ${r.label} rinden menos que el ${r.bench.name}`,
        finding: `Con los mismos aportes y retiros en las mismas fechas, ${versus}: ${f(r.gap.abs())} menos.${detractors.length ? ` Lo que más restó: ${detractors.map((x) => `${x.name} (${f(x.gap!)})`).join(', ')}.` : ''}`,
        action: `Haz del índice el núcleo: ${reserve?.shortfall.gt(0) ? 'cuando completes la reserva del inmueble, ' : ''}manda la parte de tus aportes que va a ${r.label} a un fondo del ${plainName(r.bench.name)}${core.length ? `, como ${(ucits.length ? ucits : core).map((a) => a.name).join(' o ')}, que ya tienes` : unsure.length ? ` (revisa si ${unsure.map((a) => a.name).join(', ')}, que marcaste como índice, lo replica)` : ''}${others.length ? `; si quieres diversificar más allá de un solo mercado, a uno del ${others.map((b) => plainName(b.name)).join(' o del ')}, con el que también te comparas,` : ''} y deja la selección propia como un satélite acotado (por ejemplo, no más del 20–30 % de la clase), medido cada año contra el índice. No vendas todo de una vez: decide posición por posición con la tabla «contra el índice», mirando antes el impuesto.${us.length ? ` Para vivir en Colombia conviene más un fondo domiciliado en Irlanda y de acumulación${ucits.length ? ` como ${ucits.map((a) => a.name).join(', ')}` : ''} que ${us.map((a) => a.name).join(', ')}: los de EE. UU. pagan dividendos con retención del 30 % y pueden quedar sujetos al impuesto de sucesiones de EE. UU. por encima de US$ 60.000.` : ''}`,
        why: `Los informes SPIVA de S&P Dow Jones Indices muestran año tras año que la gran mayoría de los gestores profesionales queda por debajo de su índice a 10 y 15 años${r.bucket === 'acciones_usd' ? ', en acciones de EE. UU. y en casi todos los mercados que miden' : ' en casi todos los mercados que miden'} (spglobal.com/spdji/en/research-insights/spiva). Tu propio historial apunta en la misma dirección.`,
        impact: r.gap, evidence, caveat,
      });
    } else if (all.ksPme > LEAD_PME && (!last3 || last3.ksPme >= 1)) {
      const closed = sum(r.holdings.filter((x) => !x.open && x.gap).map((x) => x.gap!));
      const fromClosed = r.gap.gt(0) ? Math.max(0, Math.min(1, closed.div(r.gap).toNumber())) : 0;
      const open = r.holdings.filter((x) => x.open).length;
      actions.push({
        id: `selection-${r.bucket}`, priority: 'baja', area: 'Selección', good: true,
        title: `Tus ${r.label} superan al ${r.bench.name}`,
        finding: `Con los mismos aportes y retiros en el índice tendrías hoy ${f(r.gap)} menos de lo que te dejaron tus ${r.label}. ${pct(fromClosed, 0)} de esa ventaja viene de posiciones ya vendidas; hoy tienes ${open} ${open === 1 ? 'acción' : 'acciones'} en la clase.`,
        action: `Mantén el proceso y sigue midiéndolo cada año contra el índice.${avoid[r.bucket]?.length ? ` No le sumes a ${avoidText(r.bucket)}; el dinero nuevo de la clase, mejor a un fondo del índice o a ideas nuevas con tesis escrita.` : ''}`,
        evidence, caveat: `${caveat} Con pocas acciones el resultado depende mucho de una o dos.`,
      });
    }
  }

  // 6. Allocation against the targets.
  if (usable) {
    const off = mix.filter((r) => r.outOfBand);
    if (off.length) {
      const worst = [...off].sort((a, b) => Math.abs(b.drift!) - Math.abs(a.drift!));
      const splitText = plan
        ? `${plan.toReserve.gt(0) ? `primero ${f(plan.toReserve)} a la reserva del inmueble${plan.split.length ? ' y el resto' : ''}` : 'tu aporte'}${plan.idleCash.gt(0) && !plan.toReserve.gt(0) ? ` y ${f(plan.idleCash)} de efectivo de más` : ''}${plan.split.length ? ` así: ${plan.split.map((s) => `${CLASS_LABEL(s.cls)} ${f(s.amount)}${avoid[s.cls]?.length ? ` (no a ${avoid[s.cls]!.join(', ')})` : ''}`).join(', ')}` : ''}.`
        : '';
      actions.push({
        id: 'drift', priority: worst.some((r) => Math.abs(r.drift!) >= 0.1) ? 'alta' : 'media', area: 'Asignación',
        title: `${off.length === 1 ? '1 clase está' : `${off.length} clases están`} fuera de tu mezcla objetivo`,
        finding: `${worst.map((r) => `${CLASS_LABEL(r.cls)} ${pct(r.weight, 0)} (objetivo ${pct(r.target ?? 0, 0)})`).join(' · ')}${reserve?.held.gt(0) ? ` — sin contar ${f(reserve.held)} apartados para el inmueble` : ''}.`,
        action: reserve?.shortfall.gt(0) && (reserve.funding === undefined || reserve.need.gt(liquid))
          ? `Primero el saldo del inmueble: mientras no registres cómo lo pagarás, tu aporte va a la reserva. ${overExcess.gt(0) ? `Lo que tienes de más (${f(overExcess)} en ${overweight.map((r) => CLASS_LABEL(r.cls)).join(' y ')}) conviene venderlo hacia la reserva: mira «Qué vender primero».` : 'Mientras tanto, no compres más de lo que está por encima de su objetivo.'}`
          : plan
          ? `Este mes: ${splitText} ${!plan.onTime && reserve ? `Hasta el ${date(reserve.due)} tus aportes van a la reserva; después, a volver a la mezcla.` : plan.months !== undefined ? (plan.months <= 1 ? 'Con eso quedas dentro de las bandas.' : `Siguiendo así con cada aporte, en unos ${plan.months} meses ${plan.toReserve.gt(0) || (plan.reserveMonths ?? 0) > 0 ? 'completas la reserva y ' : ''}vuelves a las bandas sin vender, a precios de hoy.`) : 'Solo con aportes tardaría más de 10 años: considera vender parte de lo que sobra, mirando antes el impuesto.'}`
          : 'Escribe en el perfil cuánto inviertes al mes y la app te dice a qué clase mandarlo para volver a la mezcla sin vender.',
        why: 'Rebalancear con los aportes nuevos mantiene el riesgo que elegiste sin pagar impuestos ni comisiones por vender. La banda es la regla 5/25: 5 puntos en clases de 20 % o más, un cuarto del objetivo en las menores.',
        evidence: worst.map((r) => ({ label: CLASS_LABEL(r.cls), value: `${f(r.value)} · ${pct(r.weight, 1)} frente a ${pct(r.target ?? 0, 1)} (${r.drift! > 0 ? '+' : ''}${pct(r.drift!, 1)})` })),
      });
    }

    // 7. Risk against the tolerance, in pesos: the mix the user chose, and the one held today.
    const targetFall = Object.entries(usable.targets).reduce((x, [c, w]) => x + w * shockOf(c), 0);
    const worstFall = Math.min(risk.historical?.depth ?? 0, risk.crisisLiquid);
    const evidence = [
      ...(risk.historical ? [{ label: `Tu peor caída, últimos ${RISK_YEARS} años (en pesos)`, value: `${pct(risk.historical.depth, 1)} (${date(risk.historical.peak)} → ${date(risk.historical.trough)})` }] : []),
      { label: `${CRISIS.label}, portafolio líquido de hoy`, value: pct(risk.crisisLiquid, 1) },
      { label: `${CRISIS.label}, con tu mezcla objetivo`, value: pct(targetFall, 1) },
      ...(risk.crisisNetWorth !== undefined ? [{ label: `${CRISIS.label}, patrimonio (con el inmueble y su deuda)`, value: pct(risk.crisisNetWorth, 1) }] : []),
    ];
    if (targetFall < -usable.maxDrawdown) {
      actions.push({
        id: 'risk', priority: 'alta', area: 'Riesgo', title: 'Tu propia mezcla objetivo puede caer más de lo que aguantas',
        finding: `Aguantas una caída de ${pct(usable.maxDrawdown, 0)}; con tu mezcla objetivo, en una ${CRISIS.label.toLowerCase()} caerías ${pct(targetFall, 0)}.`,
        action: 'Sube la renta fija y el efectivo de tu mezcla objetivo (o baja las acciones y la cripto) hasta que el escenario quepa en lo que aguantas, o acepta una caída mayor solo si de verdad no venderías en ella.',
        evidence, caveat: CRISIS.note,
      });
    } else if (worstFall < -usable.maxDrawdown) {
      const over = overweight.map((r) => CLASS_LABEL(r.cls));
      const excess = overExcess;
      const stuck = !!reserve?.shortfall.gt(0) && !!plan && !plan.onTime;
      actions.push({
        id: 'risk', priority: 'alta', area: 'Riesgo', title: 'Tu portafolio de hoy puede caer más de lo que aguantas; tu objetivo no',
        finding: `Aguantas una caída de ${pct(usable.maxDrawdown, 0)}; ${risk.historical && risk.historical.depth < -usable.maxDrawdown ? `tu portafolio líquido ya cayó ${pct(risk.historical.depth, 0)} (${date(risk.historical.peak)} → ${date(risk.historical.trough)})` : `en una ${CRISIS.label.toLowerCase()} caería ${pct(risk.crisisLiquid, 0)}`}.`,
        action: stuck
          ? `Tu mezcla objetivo cabe (${pct(targetFall, 0)} en el escenario): el exceso viene de tener más ${over.join(' y ')} de lo planeado (unos ${f(excess)}). Como tus aportes no alcanzan a completar la reserva, vender esa parte y llevarla a la reserva en pesos resuelve a la vez el riesgo, la desviación y parte del saldo: mira «Qué vender primero».`
          : `Tu mezcla objetivo cabe (${pct(targetFall, 0)} en el escenario): el exceso viene de cómo está hoy${over.length ? `, con más ${over.join(' y ')} de lo planeado (unos ${f(excess)})` : ''}. Acércala al objetivo con los aportes${reserve?.shortfall.gt(0) ? ' en cuanto completes la reserva' : ''} y, si la diferencia es grande, vendiendo parte de lo que sobra (mira «Qué vender primero»).`,
        evidence, caveat: CRISIS.note,
      });
    } else if (usable.horizonYears >= 10 && !reserve?.shortfall.gt(0) && worstFall > -usable.maxDrawdown + 0.15 && (usable.targets.renta_fija ?? 0) + (usable.targets[CASH] ?? 0) > 0.3) {
      actions.push({
        id: 'risk', priority: 'baja', area: 'Riesgo', title: 'Tienes espacio para más renta variable',
        finding: `Con ${usable.horizonYears} años de horizonte aguantas caídas de ${pct(usable.maxDrawdown, 0)}, tu peor caso es ${pct(worstFall, 0)} y tu mezcla objetivo tiene ${pct((usable.targets.renta_fija ?? 0) + (usable.targets[CASH] ?? 0), 0)} en renta fija y efectivo.`,
        action: 'Si buscas la mayor rentabilidad a largo plazo, considera subir la parte en acciones de tu mezcla, siempre dentro de la caída que aguantas.',
        why: 'A horizontes largos las acciones han rendido más que la renta fija, a cambio de caídas más fuertes en el camino.',
        evidence, caveat: CRISIS.note,
      });
    }
  }

  // 7b. One place for what to sell, and in which order (the other cards point here).
  const stuck = !!reserve?.shortfall.gt(0) && !!plan && !plan.onTime;
  const pointsHere = actions.some((x) => (x.id === 'drift' || x.id === 'risk') && x.action.includes('Qué vender primero'));
  if (usable && overExcess.gt(0) && pointsHere) {
    // Class by class: walk that class's holdings below cost and stop at what the class has above its target
    // (whole holdings, then part of the last one); what is still left comes from the rest of the class.
    const steps: string[] = [];
    for (const cls of overweight) {
      let left = cls.value.minus(growth.times(cls.target ?? 0));
      let realized = ZERO;
      const whole: string[] = [];
      let part: string | undefined;
      for (const x of losers.filter((l) => l.bucket === cls.cls)) {
        if (left.lte(0)) break;
        if (x.value.lte(left)) {
          whole.push(x.name);
          realized = realized.plus(x.loss);
          left = left.minus(x.value);
        } else {
          part = `unos ${f(left)} de ${x.name}`;
          realized = realized.plus(x.loss.times(left).div(x.value));
          left = ZERO;
        }
      }
      const label = overweight.length > 1 ? `En ${CLASS_LABEL(cls.cls)}: ` : '';
      if (whole.length || part)
        steps.push(`${label}vende ${[whole.length ? `completas ${whole.join(', ')}` : '', part ?? ''].filter(Boolean).join(' y ')}: están por debajo de su costo en pesos y suelen generar poco o ningún impuesto (realizas una pérdida de unos ${f(realized.abs())}).`);
      if (left.gt(0)) {
        const named = [...new Set([...heavy, ...reached].filter((x) => x.bucket === cls.cls && !whole.includes(x.name)).map((x) => x.name))];
        steps.push(`${label}${whole.length || part ? 'los ' : ''}${f(left)} ${whole.length || part ? 'restantes' : 'que sobran'}, de las que superan tu límite por acción o ya pasaron tu precio objetivo${named.length ? ` (${named.join(', ')})` : ''}, y después de las que más restan frente al índice en la tabla «contra el índice».`);
      }
    }
    const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
    for (let k = 0; k < steps.length; k++) steps[k] = cap(steps[k]!);
    steps.push(stuck ? `Lleva lo vendido a la reserva en pesos (CDT o fondo de liquidez que venza antes del ${date(reserve!.due)}).` : 'Lleva lo vendido a las clases por debajo de su objetivo.');
    actions.push({
      id: 'sell', priority: stuck || actions.some((x) => x.id === 'risk' && x.priority === 'alta') ? 'alta' : 'media', area: 'Venta',
      title: `Qué vender primero: ${f(overExcess)} de ${overweight.map((r) => CLASS_LABEL(r.cls)).join(' y ')}`,
      finding: `Es lo que tienes por encima de tu mezcla objetivo en ${overweight.map((r) => `${CLASS_LABEL(r.cls)} (${pct(r.weight, 0)} frente a ${pct(r.target ?? 0, 0)})`).join(' y ')}.${stuck ? ' Venderlo y llevarlo a la reserva en pesos baja el riesgo, corrige la mezcla y reduce el crédito que necesitas para el inmueble.' : ''} Tus fondos indexados no entran en la lista: son el núcleo.`,
      action: (steps.length > 2 ? steps.map((x, i) => `${i + 1}) ${x}`) : steps).join(' '),
      why: 'Vender primero lo que está en pérdida aprovecha que esa venta casi no paga impuesto; el costo que cuenta para el impuesto de una acción extranjera es en pesos, a la tasa del día de cada compra (la app ya lo calcula así).',
      impact: overExcess,
      evidence: losers.map((x) => ({ label: x.name, value: `vale ${f(x.value)} · ${f(x.loss)} frente a su costo en pesos` })),
      caveat: 'Confirma el costo fiscal y el impuesto de cada venta con tu contador antes de vender.',
    });
  }

  // 8. One company too heavy.
  if (heavy.length) {
    const trim = sum(heavy.map((x) => x.value.minus(liquid.times(policy.maxPosition))));
    actions.push({
      id: 'positions', priority: heavy.some((x) => x.weight > 2 * policy.maxPosition) ? 'alta' : 'media', area: 'Concentración',
      title: `${heavy.length === 1 ? '1 acción pesa' : `${heavy.length} acciones pesan`} más de ${pct(policy.maxPosition, 0)} de tu portafolio líquido`,
      finding: heavy.map((x) => `${x.name} ${pct(x.weight, 1)}`).join(' · '),
      action: `No les sumes más. Para volver al límite sobran ${f(trim)} en total: véndelos por partes o deja que los aportes a otras clases los diluyan, mirando antes el impuesto.`,
      why: 'Una sola empresa puede perder la mayor parte de su valor por razones propias y no recuperarse; un índice también cae, pero reparte ese riesgo entre cientos de empresas. Limitar el peso de cada una acota el daño sin renunciar a tus ideas.',
      impact: trim, evidence: heavy.map((x) => ({ label: x.name, value: `${f(x.value)} · ${pct(x.weight, 1)} (límite ${pct(policy.maxPosition, 0)})` })),
    });
  }

  // 9. Cash that is not working (when no reserve claims it).
  const idle = plan ? plan.idleCash : idleCashOf(growthValues, usable?.targets ?? { [CASH]: policy.cashTarget }, monthly ?? ZERO);
  if (!reserve?.shortfall.gt(0) && realEstate?.owed.gt(0) !== true && growth.gt(0) && idle.gt(growth.times(0.02))) {
    const accounts = valuation.cash.filter((c) => c.value.gt(0)).sort((a, b) => b.value.comparedTo(a.value));
    actions.push({
      id: 'cash', priority: material(idle) ? 'media' : 'baja', area: 'Efectivo',
      title: `Tienes ${f(idle)} de efectivo por encima de tu objetivo`,
      finding: `El efectivo en tus cuentas suma ${f(cash)}, ${pct(share(cash, liquid), 1)} del portafolio líquido; tu objetivo es ${pct(policy.cashTarget, 0)}.`,
      action: `Inviértelo según tu mezcla objetivo${plan ? ' (el plan de aportes te dice a qué clase)' : ''}, salvo que lo tengas apartado para un pago cercano.`,
      why: 'El efectivo en el bróker suele ganar poco o nada: cada año quieto es rentabilidad que no se compone.',
      impact: idle, evidence: accounts.map((c) => ({ label: ctx.book.accounts.get(c.account)?.name ?? c.account, value: f(c.value) })),
    });
  }

  // 10. Dividends taken out instead of reinvested.
  const out = dividendsTakenOut(ctx, [H, ccy], asOf);
  if (out.count > 0) {
    actions.push({
      id: 'dividends', priority: 'baja', area: 'Dividendos', title: `Sacaste ${money(out.totals[1]!, ccy)} de dividendos en el último año`,
      finding: `${out.count} ${out.count === 1 ? 'dividendo salió' : 'dividendos salieron'} del portafolio hacia tu cuenta bancaria en vez de reinvertirse.`,
      action: reserve?.shortfall.gt(0) ? 'Si no los necesitas para gastos, súmalos a la reserva del inmueble.' : 'Si no los necesitas para gastos, vuelve a invertirlos con tu aporte.',
      why: 'A largo plazo, buena parte del retorno total de las acciones viene de reinvertir los dividendos.',
      impact: out.totals[0]!, evidence: [],
    });
  }

  // 11. Prices already at the user's own target.
  if (reached.length) {
    actions.push({
      id: 'targets', priority: 'media', area: 'Tesis',
      title: `${reached.length === 1 ? '1 acción ya llegó' : `${reached.length} acciones ya llegaron`} a tu precio objetivo`,
      finding: reached.map((x) => `${x.name} (precio ${pct(1 / (1 + x.upside) - 1, 0)} por encima del objetivo)`).join(' · '),
      action: 'Revisa la tesis de cada una: si el objetivo se cumplió y no hay razones nuevas, vender (o al menos no comprar más) es seguir tu propio plan; si las hay, sube el objetivo y escribe por qué en Tesis.',
      evidence: reached.map((x) => ({ label: x.name, value: `precio ${x.price ?? '—'} ${x.ccy} · objetivo ${x.target ?? '—'} ${x.ccy}` })),
    });
  }

  // 12. Taxes before selling (Colombia).
  if (actions.some((x) => ['positions', 'targets', 'selection-acciones_usd', 'drift', 'commitment-plan'].includes(x.id) || x.id.startsWith('selection-'))) {
    actions.push({
      id: 'taxes', priority: 'baja', area: 'Impuestos', title: 'Antes de vender, revisa el impuesto de cada venta',
      finding: 'Varias recomendaciones implican vender o cambiar posiciones.',
      action: 'Vende primero lo que menos impuesto genere y, si puedes, rebalancea con aportes en vez de ventas. Agrupa las compras en dólares en pocas transferencias: cada cambio de pesos a dólares tiene costo.',
      why: 'En Colombia la utilidad al vender acciones inscritas en la Bolsa de Valores de Colombia no es renta ni ganancia ocasional si no superas el 10 % de las acciones de la empresa (artículo 36-1 del Estatuto Tributario); la de acciones extranjeras sí tributa: como ganancia ocasional (15 % desde 2023) si las tuviste dos años o más, y como renta si menos. La ganancia de una acción extranjera se mide en pesos: una que perdió en dólares puede tener ganancia en pesos si el dólar subió desde la compra. Confírmalo con tu contador.',
      evidence: [],
    });
  }

  // 13. What the net worth depends on.
  const foreign = currencies.filter((c) => c.ccy !== H).reduce((s, c) => s + c.share, 0);
  if (currencies.length > 1) {
    actions.push({
      id: 'currency', priority: 'baja', area: 'Divisas', title: `${pct(foreign, 0)} de tu patrimonio depende de monedas distintas ${H === HOME ? 'al peso' : `a ${H}`}`,
      finding: currencies.map((c) => `${c.ccy} ${pct(c.share, 0)}`).join(' · '),
      action: `Si vives y gastas en pesos, tener una parte en dólares protege contra la devaluación; lo que vayas a pagar en pesos pronto${realEstate?.owed.gt(0) ? ' (como el saldo del inmueble)' : ''} debe estar en pesos.`,
      evidence: currencies.map((c) => ({ label: c.ccy, value: `${f(c.value)} (${pct(c.share, 1)})` })),
    });
  }

  // 14. How much of this rests on estimates.
  const estDivs = ctx.ledger.filter((x) => x.type === 'DIVIDEND' && x.estimated && x.date <= asOf);
  const atCost = valuation.positions.filter((p) => p.method === 'cost');
  if (atCost.length) {
    actions.push({
      id: 'stale', priority: material(sum(atCost.map((p) => p.value))) ? 'media' : 'baja', area: 'Datos',
      title: `${atCost.length === 1 ? '1 posición está valorada' : `${atCost.length} posiciones están valoradas`} a costo: falta su precio`,
      finding: `${atCost.map((p) => ctx.book.assets.get(p.asset)?.name ?? p.asset).join(', ')}: ${f(sum(atCost.map((p) => p.value)))} a lo que costaron, porque no hay precio ni valor reciente. Las cifras de arriba que las incluyen (patrimonio, mezcla, concentración) no reflejan su valor real.`,
      action: 'Trae los precios del cierre en Datos o escribe su valor de fin de mes en el Cierre del mes.',
      impact: sum(atCost.map((p) => p.value)), evidence: [],
    });
  }
  if (estDivs.length || realEstate?.estimated) {
    const byBucket = new Map<string, Decimal>();
    // In the comparison a dividend D paid on t is money the index would have grown: dropping it moves the gap by D × index(today) / index(t).
    const effect = new Map<string, Decimal>();
    for (const x of estDivs) {
      const b = (x.asset && ctx.book.assets.get(x.asset)?.bucket) || '';
      byBucket.set(b, (byBucket.get(b) ?? ZERO).plus(ctx.book.fx.convert(x.amount, ctx.book.accounts.get(x.account)!.ccy, ccy, x.date)));
      const bench = ctx.benchmarks.find((k) => k.buckets.includes(b));
      if (!bench) continue;
      try {
        const level = levelOf(ctx, bench.symbol, H);
        const d = ctx.book.fx.convert(x.amount, ctx.book.accounts.get(x.account)!.ccy, H, x.date);
        effect.set(b, (effect.get(b) ?? ZERO).plus(d.times(level(asOf).div(level(x.date)))));
      } catch (e) {
        if (!(e instanceof MissingDataError)) throw e;
      }
    }
    actions.push({
      id: 'data', priority: 'baja', area: 'Datos', title: 'Parte del diagnóstico usa datos estimados',
      finding: [
        estDivs.length ? `${estDivs.length} dividendos estimados que suman ${money(sum([...byBucket.values()]), ccy)} (${[...byBucket.entries()].map(([b, v]) => `${CLASS_LABEL(b)} ${money(v, ccy)}`).join(', ')})${effect.size ? `; si no se hubieran pagado, la diferencia con el índice empeoraría hasta ${[...effect.entries()].map(([b, v]) => `${f(v)} en ${CLASS_LABEL(b)}`).join(' y ')}` : ''}` : '',
        realEstate?.estimated ? 'el inmueble está a precio de lista' : '',
      ].filter(Boolean).join('; ') + '.',
      action: 'Cuando tengas el certificado de dividendos y un avalúo, regístralos: todo esto se recalcula solo.',
      evidence: [],
    });
  }

  actions.sort((a, b) => RANK[a.priority] - RANK[b.priority] || Number(b.area === 'Perfil') - Number(a.area === 'Perfil') || Number(!!b.urgent) - Number(!!a.urgent) || (b.impact ?? ZERO).abs().comparedTo((a.impact ?? ZERO).abs()));
  return {
    ...base, netWorth, liquid, cash, mix, growth, ...(reserve ? { reserve } : {}), ...(realEstate ? { realEstate } : {}), records,
    ...(plan ? { plan } : {}), avoid, currencies, risk, actions, top: actions.filter((x) => !x.good).slice(0, 3),
  };
}
