import { addDays, daysBetween } from '../domain/dates.ts';
import type { IsoDate } from '../domain/dates.ts';
import { dec } from '../domain/money.ts';
import type { Decimal } from '../domain/money.ts';
import type { Fundamentals, SecData, SecInput, SecValue } from '../domain/types.ts';
import { SEC_CONCEPTS, SEC_FORMS } from './secConcepts.ts';
import type { SecRole, Taxonomy } from './secConcepts.ts';

/**
 * Fundamentals from the company's own filings with the SEC (EDGAR companyfacts, relayed by the site's
 * function). `parseCompanyFacts` keeps the reported figures an analysis needs, each with the filing it comes
 * from; `secFundamentals` turns them into the Indicadores ratios. Nothing is estimated: a figure the latest
 * report does not carry (a concept last reported in an older period, or not at all) is left missing with the
 * reason.
 *
 * Periods: flows are the last twelve months, last annual report + current year to date − the same span of
 * the year before (all from the same concept); a foreign filer (20-F) reports once a year, so its figures are
 * annual. Balances are at the end of that same period. The period is the one of the latest revenue figure,
 * and every other figure must reach it.
 */

/** One reported value, as the relay passes it from companyfacts (units: USD, CNY, USD/shares, shares…). */
export interface RawFact {
  start?: string;
  end: string;
  val: number;
  form: string;
  filed: string;
  accn: string;
}

/** What /api/fundamentals returns per ticker (netlify/functions/fundamentals.mts). */
export interface SecFactsReply {
  cik: number;
  entity: string;
  facts: Partial<Record<Taxonomy, Record<string, Record<string, RawFact[]>>>>;
}

const ANNUAL = [350, 380] as const;

interface Item {
  concept: string;
  start?: IsoDate;
  end: IsoDate;
  val: Decimal;
  form: string;
  filed: IsoDate;
  accn: string;
}

/** A concept's values in one unit, one per period (the latest filing wins: restated figures replace old ones). */
function items(reply: SecFactsReply, tax: Taxonomy, concept: string, unit: string): Item[] {
  const raw = reply.facts[tax]?.[concept]?.[unit] ?? [];
  const byPeriod = new Map<string, Item>();
  for (const r of raw) {
    if (!SEC_FORMS.test(r.form) || typeof r.val !== 'number' || !Number.isFinite(r.val)) continue;
    const key = `${r.start ?? ''}|${r.end}`;
    const had = byPeriod.get(key);
    if (had && had.filed >= r.filed) continue;
    byPeriod.set(key, { concept, start: r.start, end: r.end, val: dec(String(r.val)), form: r.form, filed: r.filed, accn: r.accn });
  }
  return [...byPeriod.values()].sort((a, b) => a.end.localeCompare(b.end));
}

const span = (i: Item) => (i.start ? daysBetween(i.start, i.end) : 0);
const isAnnual = (i: Item) => span(i) >= ANNUAL[0] && span(i) <= ANNUAL[1];

const value = (i: Item, extra: Partial<SecValue> = {}): SecValue => ({
  value: i.val.toString(),
  concept: i.concept,
  form: i.form,
  ...(i.start ? { start: i.start } : {}),
  end: i.end,
  filed: i.filed,
  accn: i.accn,
  ...extra,
});

/**
 * Last twelve months of a flow: the last annual figure, plus this year to date, minus the same span a year
 * earlier. Without a later year-to-date figure, the annual one itself.
 */
function ttmParts(list: Item[]): { fy: Item; ytd?: Item; prior?: Item } | undefined {
  const fy = list.filter(isAnnual).at(-1);
  if (!fy) return undefined;
  const nextStart = addDays(fy.end, 1);
  const ytd = list.filter((i) => i.start === nextStart && i.end > fy.end).at(-1);
  if (!ytd) return { fy };
  const prior = list.find((i) => i.start === fy.start && Math.abs(daysBetween(addDays(ytd.end, -365), i.end)) <= 7 && Math.abs(span(i) - span(ytd)) <= 7);
  return prior ? { fy, ytd, prior } : undefined;
}

function ttm(list: Item[]): SecValue | undefined {
  const p = ttmParts(list);
  if (!p) return undefined;
  if (!p.ytd) return value(p.fy);
  const v = p.fy.val.plus(p.ytd.val).minus(p.prior!.val);
  return { ...value(p.ytd), value: v.toString(), start: addDays(p.prior!.end, 1), ttm: true };
}

/** The first concept of a role whose flow reaches `period` (or, with no period, the latest one found). */
function flow(reply: SecFactsReply, tax: Taxonomy, role: SecRole, unit: string, period?: IsoDate): SecValue | undefined {
  let best: SecValue | undefined;
  for (const c of SEC_CONCEPTS[tax][role]) {
    const v = ttm(items(reply, tax, c, unit));
    if (!v) continue;
    if (period ? v.end === period : !best || v.end > best.end) {
      if (period) return v;
      best = v;
    }
  }
  return best;
}

/** The first concept of a role with a balance at `at`. */
function balance(reply: SecFactsReply, tax: Taxonomy, role: SecRole, unit: string, at: IsoDate): SecValue | undefined {
  for (const c of SEC_CONCEPTS[tax][role]) {
    const i = items(reply, tax, c, unit).find((x) => !x.start && x.end === at);
    if (i) return value(i);
  }
  return undefined;
}

/** The balance closest to one year before `at` (within 20 days), for averages. */
function balanceYearBefore(reply: SecFactsReply, tax: Taxonomy, role: SecRole, unit: string, at: IsoDate): SecValue | undefined {
  const target = addDays(at, -365);
  for (const c of SEC_CONCEPTS[tax][role]) {
    const near = items(reply, tax, c, unit)
      .filter((x) => !x.start && Math.abs(daysBetween(target, x.end)) <= 20)
      .sort((a, b) => Math.abs(daysBetween(target, a.end)) - Math.abs(daysBetween(target, b.end)))[0];
    if (near) return value(near);
  }
  return undefined;
}

/** Several reported values added up into one input: the concepts are listed, the filing is the latest one's. */
function total(parts: SecValue[]): SecValue {
  const last = parts.reduce((a, b) => (b.filed > a.filed ? b : a));
  return { ...last, value: parts.reduce((s, p) => s.plus(p.value), dec(0)).toString(), concept: parts.map((p) => p.concept).join(' + ') };
}

/**
 * Total debt at `at` (loans, notes and commercial paper; lease liabilities are not debt here): the combined
 * amount when reported; else long-term debt (it includes its current maturities) plus short-term borrowings;
 * else the non-current part plus the current one.
 */
function debt(reply: SecFactsReply, tax: Taxonomy, unit: string, at: IsoDate): SecValue | undefined {
  const get = (role: SecRole) => balance(reply, tax, role, unit, at);
  const combined = get('debtTotal');
  if (combined) return combined;
  const short = get('shortBorrowings');
  const lt = get('longTermDebt');
  if (lt) return total(short ? [lt, short] : [lt]);
  const noncurrent = get('debtNoncurrent');
  if (noncurrent) {
    const current = get('debtCurrent');
    if (current) return total([noncurrent, current]);
    return total([noncurrent, ...[get('ltdCurrent'), short].filter((x): x is SecValue => x !== undefined)]);
  }
  return short;
}

/**
 * Why a per-share figure over the last twelve months cannot be built: the diluted share count of the
 * annual report and that of last year's span as restated in the latest quarter differ by more than a
 * quarter (a split or a reverse split in between), or there is no share count to tell.
 */
function splitBetween(reply: SecFactsReply, tax: Taxonomy, eps: SecValue, perShare: string): string | undefined {
  const p = ttmParts(items(reply, tax, eps.concept, perShare));
  if (!p?.ytd || !p.prior) return undefined;
  for (const sc of SEC_CONCEPTS[tax].shares) {
    const shares = items(reply, tax, sc, 'shares');
    const a = shares.find((i) => i.start === p.fy.start && i.end === p.fy.end);
    const b = shares.find((i) => i.start === p.prior!.start && i.end === p.prior!.end);
    if (!a || !b || b.val.isZero()) continue;
    const r = a.val.div(b.val);
    return r.gt(1.25) || r.lt(0.8) ? 'posible split entre el reporte anual y el trimestral: el anual aún no está reexpresado' : undefined;
  }
  return 'no se pudo verificar que no haya un split entre el reporte anual y el trimestral (no reporta acciones diluidas)';
}

const MISSING: Record<SecInput, string> = {
  revenue: 'no reporta ventas',
  revenueFY: 'no reporta ventas anuales',
  revenueFY5: 'no hay ventas anuales de hace 5 años',
  operatingIncome: 'no reporta utilidad operativa',
  da: 'no reporta depreciación y amortización',
  netIncome: 'no reporta utilidad neta',
  eps: 'no reporta utilidad por acción diluida',
  pretax: 'no reporta utilidad antes de impuestos',
  tax: 'no reporta impuesto de renta',
  debt: 'no reporta su deuda con un concepto estándar',
  cash: 'no reporta efectivo',
  equity: 'no reporta patrimonio',
  equityPrior: 'no reporta el patrimonio de un año antes',
  shares: 'no reporta acciones diluidas',
};

/** The reported figures for one company, as of `today` (the day they were read). */
export function parseCompanyFacts(reply: SecFactsReply, today: IsoDate): SecData {
  const base = { asOf: today, cik: reply.cik, entity: reply.entity };
  if (!(['us-gaap', 'ifrs-full'] as const).some((t) => SEC_CONCEPTS[t].revenue.some((c) => reply.facts[t]?.[c]))) {
    return { ...base, error: 'La SEC no tiene estados financieros de este activo (p. ej. un ETF o un fondo).' };
  }
  // The taxonomy and reporting currency of the latest revenue figure (a company may have moved to IFRS).
  let tax: Taxonomy | undefined;
  let unit: string | undefined;
  let latest = '';
  for (const t of ['us-gaap', 'ifrs-full'] as const) {
    for (const c of SEC_CONCEPTS[t].revenue) {
      for (const [u, list] of Object.entries(reply.facts[t]?.[c] ?? {})) {
        const end = list.filter((r) => SEC_FORMS.test(r.form)).reduce((m, r) => (r.end > m ? r.end : m), '');
        if (end > latest) [latest, tax, unit] = [end, t, u];
      }
    }
  }
  if (!tax || !unit) return { ...base, error: 'La SEC no tiene ventas reportadas en informes anuales o trimestrales de esta empresa.' };

  const revenue = flow(reply, tax, 'revenue', unit);
  if (!revenue) return { ...base, error: 'No se pudieron armar las ventas de los últimos 12 meses con los informes de la SEC.' };
  const period = revenue.end;
  const values: Partial<Record<SecInput, SecValue>> = { revenue };

  // Five-year growth: the last annual revenue and the one five years before, preferably from the same concept
  // (a company that renamed its revenue concept in between takes the old year from the one it used then).
  const annualRevenue = SEC_CONCEPTS[tax].revenue.map((c) => items(reply, tax, c, unit).filter(isAnnual));
  for (const annual of annualRevenue) {
    const fy = annual.at(-1);
    if (fy && (!values.revenueFY || fy.end > values.revenueFY.end)) values.revenueFY = value(fy);
  }
  if (values.revenueFY) {
    const fyEnd = values.revenueFY.end;
    const near = (i: Item) => Math.abs(daysBetween(addDays(fyEnd, -5 * 365), i.end)) <= 10;
    const same = annualRevenue.flat().find((i) => i.concept === values.revenueFY!.concept && near(i));
    const old = same ?? annualRevenue.flat().find(near);
    if (old) values.revenueFY5 = value(old);
  }

  const perShare = `${unit}/shares`;
  for (const [k, role, u] of [
    ['operatingIncome', 'operatingIncome', unit],
    ['netIncome', 'netIncome', unit],
    ['eps', 'eps', perShare],
    ['pretax', 'pretax', unit],
    ['tax', 'tax', unit],
  ] as const) {
    const v = flow(reply, tax, role, u, period);
    if (v) values[k] = v;
  }
  // A split between the annual report and the latest quarter: the quarter restates last year's figures per
  // share, the annual one is not restated until the next 10-K, and adding them would mix bases.
  const splitWhy = values.eps?.ttm ? splitBetween(reply, tax, values.eps, perShare) : undefined;
  const gapsExtra: Partial<Record<SecInput, string>> = {};
  if (splitWhy) {
    delete values.eps;
    gapsExtra.eps = splitWhy;
  }
  const da = flow(reply, tax, 'da', unit, period);
  if (da) values.da = da;
  else {
    const dep = flow(reply, tax, 'depreciation', unit, period);
    const am = flow(reply, tax, 'amortization', unit, period);
    if (dep && am) values.da = { ...total([dep, am]), start: dep.start, end: dep.end, ...(dep.ttm ? { ttm: true } : {}) };
  }
  const eq = balance(reply, tax, 'equity', unit, period);
  if (eq) values.equity = eq;
  const eqPrior = balanceYearBefore(reply, tax, 'equity', unit, period);
  if (eqPrior) values.equityPrior = eqPrior;
  const cash = balance(reply, tax, 'cash', unit, period);
  if (cash) {
    const inv = balance(reply, tax, 'shortInvestments', unit, period);
    values.cash = inv ? total([cash, inv]) : cash;
  }
  const d = debt(reply, tax, unit, period);
  if (d) values.debt = d;
  // Diluted shares of the latest quarter (the shortest period ending at `period`).
  for (const c of SEC_CONCEPTS[tax].shares) {
    const s = items(reply, tax, c, 'shares')
      .filter((i) => i.start && i.end === period)
      .sort((a, b) => span(a) - span(b))[0];
    if (s) {
      values.shares = value(s);
      break;
    }
  }

  const gaps: Partial<Record<SecInput, string>> = {};
  for (const k of Object.keys(MISSING) as SecInput[]) if (!values[k]) gaps[k] = gapsExtra[k] ?? MISSING[k];
  return { ...base, taxonomy: tax, currency: unit, annualOnly: !Object.values(values).some((v) => v && /^10-[KQ]/.test(v.form)), period, values, gaps };
}

export type SecField = keyof Pick<Fundamentals, 'salesGrowth5y' | 'ebitdaMargin' | 'netMargin' | 'eps' | 'netDebt' | 'debtToCapital' | 'roe' | 'roic' | 'pe' | 'evEbitda'>;

export interface SecResult {
  /** The ratios, as Fundamentals values (fractions and decimal strings). */
  f: Partial<Pick<Fundamentals, SecField>>;
  /** Why a ratio is missing. */
  missing: Partial<Record<SecField, string>>;
  /** The reported figures each ratio uses. */
  inputs: Partial<Record<SecField, SecInput[]>>;
}

const DIGITS = 6;
const out = (d: Decimal) => d.toSignificantDigits(DIGITS).toString();

/**
 * The Indicadores ratios from a company's reported figures and the app's price (in the asset's currency).
 * Per-share and price-based figures need the report in the asset's currency: a foreign filer's are per local
 * share in its own currency, which the ADR price cannot be compared with.
 */
export function secFundamentals(sec: SecData, assetCcy: string, price?: Decimal, asOf?: IsoDate): SecResult {
  const r: SecResult = { f: {}, missing: {}, inputs: {} };
  if (sec.error || !sec.values) return r;
  const v = sec.values;
  const n = (k: SecInput) => (v[k] ? dec(v[k].value) : undefined);
  // A foreign filer's per-share figures are per local share, whatever its currency: an ADR can stand for
  // several shares or a fraction of one.
  const foreignFiler = sec.taxonomy === 'ifrs-full' || /^(20|40)-F/.test(v.revenue?.form ?? '');
  const set = (field: SecField, inputs: SecInput[], compute: () => Decimal | string, inAssetCcy = false) => {
    r.inputs[field] = inputs;
    if (inAssetCcy && sec.currency !== assetCcy) {
      r.missing[field] = `el reporte está en ${sec.currency}${field === 'netDebt' ? '' : ' por acción local'}, no comparable con ${assetCcy}`;
      return;
    }
    if (inAssetCcy && foreignFiler && field !== 'netDebt') {
      r.missing[field] = 'empresa extranjera (20-F): su utilidad por acción es por acción local, no por ADR';
      return;
    }
    const lacking = inputs.find((k) => !v[k]);
    if (lacking) {
      r.missing[field] = sec.gaps?.[lacking] ?? MISSING[lacking];
      return;
    }
    const x = compute();
    if (typeof x === 'string') r.missing[field] = x;
    else r.f[field] = out(x);
  };
  const ebitda = () => n('operatingIncome')!.plus(n('da')!);

  set('salesGrowth5y', ['revenueFY', 'revenueFY5'], () => {
    const [a, b] = [n('revenueFY')!, n('revenueFY5')!];
    if (!a.gt(0) || !b.gt(0)) return 'ventas no positivas';
    return a.div(b).pow(dec(1).div(5)).minus(1);
  });
  set('ebitdaMargin', ['operatingIncome', 'da', 'revenue'], () => (n('revenue')!.gt(0) ? ebitda().div(n('revenue')!) : 'ventas no positivas'));
  set('netMargin', ['netIncome', 'revenue'], () => (n('revenue')!.gt(0) ? n('netIncome')!.div(n('revenue')!) : 'ventas no positivas'));
  set('debtToCapital', ['debt', 'equity'], () => {
    const cap = n('debt')!.plus(n('equity')!);
    return cap.gt(0) ? n('debt')!.div(cap) : 'deuda + patrimonio no positivos';
  });
  set('roe', ['netIncome', 'equity', 'equityPrior'], () => {
    const avg = n('equity')!.plus(n('equityPrior')!).div(2);
    return avg.gt(0) ? n('netIncome')!.div(avg) : 'patrimonio promedio no positivo';
  });
  set('roic', ['operatingIncome', 'pretax', 'tax', 'debt', 'equity', 'cash'], () => {
    const pretax = n('pretax')!;
    if (!pretax.gt(0)) return 'sin utilidad antes de impuestos, la tasa de impuesto no se puede calcular';
    const rate = n('tax')!.div(pretax);
    if (rate.lt(0) || rate.gt(1)) return 'tasa de impuesto fuera de 0–100 %';
    const invested = n('debt')!.plus(n('equity')!).minus(n('cash')!);
    if (!invested.gt(0)) return 'capital invertido no positivo';
    return n('operatingIncome')!.times(dec(1).minus(rate)).div(invested);
  });
  set('eps', ['eps'], () => n('eps')!, true);
  set('netDebt', ['debt', 'cash'], () => n('debt')!.minus(n('cash')!).div(1e6), true);
  set(
    'pe',
    ['eps'],
    () => {
      if (!price) return 'no hay precio';
      if (asOf && sec.period && asOf < sec.period) return 'la fecha de corte es anterior a este reporte';
      return n('eps')!.gt(0) ? price.div(n('eps')!) : 'utilidad por acción negativa';
    },
    true,
  );
  set(
    'evEbitda',
    ['shares', 'debt', 'cash', 'operatingIncome', 'da'],
    () => {
      if (!price) return 'no hay precio';
      if (asOf && sec.period && asOf < sec.period) return 'la fecha de corte es anterior a este reporte';
      if (!ebitda().gt(0)) return 'EBITDA negativo';
      return price.times(n('shares')!).plus(n('debt')!).minus(n('cash')!).div(ebitda());
    },
    true,
  );
  return r;
}

/** Where a figure can be read: the filing's folder on EDGAR. */
export const filingUrl = (cik: number, accn: string) => `https://www.sec.gov/Archives/edgar/data/${cik}/${accn.replace(/-/g, '')}/`;
