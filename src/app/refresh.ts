import { addDays } from '../domain/dates.ts';
import type { IsoDate } from '../domain/dates.ts';
import { holdingsAt } from '../domain/holdings.ts';
import type { Dataset, StoredPrice, StoredRate } from '../data/json.ts';
import { QuoteError, YAHOO_SYMBOL, parseTrm, parseYahooAdjusted, parseYahooCloses, parseYahooFx, yahooFxSymbol } from '../data/quotes.ts';
import { checkFxRows, checkPriceRows, fxStatus } from './checks.ts';
import type { Finding } from './checks.ts';
import { contextOf, coverage } from './context.ts';

/**
 * «Traer precios del cierre»: every series in use, from the same sources as the stored history — Yahoo
 * Finance (through the site's /api/quotes function) for stocks, ETFs, crypto, indices and exchange rates,
 * and the official TRM for COP. Only days after the last stored one are added; nothing stored is replaced.
 */

export type Job =
  | {
      kind: 'price';
      provider: 'yahoo';
      symbol: string;
      yahoo: string;
      name: string;
      ccy: string;
      after: IsoDate;
      /** Chained series (an ETF's adjusted close): the last stored level, and the stored days just before it to check against. */
      anchor?: string;
      overlap?: { date: IsoDate; close: string }[];
    }
  | { kind: 'fx'; provider: 'yahoo'; ccy: string; yahoo: string; after: IsoDate }
  | { kind: 'fx'; provider: 'trm'; ccy: 'COP'; after: IsoDate };

export interface Uncovered {
  symbol: string;
  name: string;
  reason: string;
}

export interface RefreshPlan {
  jobs: Job[];
  /** Series in use that no automatic source covers, with why. */
  uncovered: Uncovered[];
  /** Series already up to date. */
  current: number;
}

/**
 * The benchmark series the app keeps, and how each was built from Yahoo: a total-return index by its close,
 * or an ETF's adjusted close (dividends reinvested), chained onto the stored level.
 */
export const BENCHMARK_SOURCES: Record<string, { yahoo: string; adjusted?: boolean }> = {
  'BENCH:SP500TR': { yahoo: '^SP500TR' },
  'BENCH:QQQ-TR': { yahoo: 'QQQ', adjusted: true },
  'BENCH:URTH-TR': { yahoo: 'URTH', adjusted: true },
  'BENCH:ICOLCAP-TR': { yahoo: 'ICOLCAP.CL', adjusted: true },
  'BENCH:BTC': { yahoo: 'BTC-USD' },
};

/** Calendar days of stored history a chained series is checked against before new days are added. */
const OVERLAP_DAYS = 14;

/** A weekday strictly between `after` and `today`: a completed trading day that may not be stored yet. */
function tradingDayBetween(after: IsoDate, today: IsoDate): boolean {
  for (let d = addDays(after, 1); d < today; d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) return true;
  }
  return false;
}

/** Crypto trades every day; everything else only on weekdays. */
const due = (yahoo: string, after: IsoDate, today: IsoDate) => (/-USD$/.test(yahoo) ? after < addDays(today, -1) : tradingDayBetween(after, today));

export function refreshPlan(d: Dataset, today: IsoDate): RefreshPlan {
  const ctx = contextOf(d);
  const cov = coverage(d);
  const jobs: Job[] = [];
  const uncovered: Uncovered[] = [];
  let current = 0;

  let openAssets = new Set<string>();
  try {
    openAssets = new Set([...holdingsAt(ctx.ledger, today).positions.values()].filter((p) => p.open).map((p) => p.asset));
  } catch {
    /* an impossible ledger is reported elsewhere; refresh only what is still clearly in use */
  }
  const lastTx = new Map<string, IsoDate>();
  for (const t of ctx.ledger) if (t.asset && (!lastTx.has(t.asset) || t.date > lastTx.get(t.asset)!)) lastTx.set(t.asset, t.date);
  const lastRow = new Map<string, StoredPrice>();
  for (const p of d.prices) if (!lastRow.has(p.symbol) || p.date > lastRow.get(p.symbol)!.date) lastRow.set(p.symbol, p);

  const seen = new Set<string>();
  for (const a of d.assets) {
    if (a.pricing !== 'market' || !a.symbol || seen.has(a.symbol)) continue;
    const last = cov.prices.get(a.symbol);
    // In use: still held, or traded after its last stored price.
    if (!openAssets.has(a.id) && !(lastTx.get(a.id) && (!last || lastTx.get(a.id)! > last))) continue;
    seen.add(a.symbol);
    if (!YAHOO_SYMBOL.test(a.symbol)) uncovered.push({ symbol: a.symbol, name: a.name, reason: 'Símbolo con un formato que Yahoo Finance no usa' });
    else if (!last) uncovered.push({ symbol: a.symbol, name: a.name, reason: 'No hay ningún precio guardado para empezar: impórtalo en Datos' });
    else if (!due(a.symbol, last, today)) current++;
    else jobs.push({ kind: 'price', provider: 'yahoo', symbol: a.symbol, yahoo: a.symbol, name: a.name, ccy: a.ccy, after: last });
  }
  for (const b of d.benchmarks) {
    const src = BENCHMARK_SOURCES[b.symbol];
    const last = lastRow.get(b.symbol);
    if (!src) uncovered.push({ symbol: b.symbol, name: b.name, reason: 'La app no sabe de dónde sale este índice' });
    else if (!last) uncovered.push({ symbol: b.symbol, name: b.name, reason: 'No hay ningún valor guardado para empezar: impórtalo en Datos' });
    else if (!due(src.yahoo, last.date, today)) current++;
    else {
      const overlap = src.adjusted
        ? d.prices.filter((p) => p.symbol === b.symbol && p.date < last.date && p.date >= addDays(last.date, -OVERLAP_DAYS)).map((p) => ({ date: p.date, close: p.close }))
        : [];
      jobs.push({ kind: 'price', provider: 'yahoo', symbol: b.symbol, yahoo: src.yahoo, name: b.name, ccy: last.ccy, after: last.date, ...(src.adjusted ? { anchor: last.close, overlap } : {}) });
    }
  }
  for (const r of fxStatus(d, ctx, today)) {
    const last = cov.fx.get(r.ccy);
    if (!last) uncovered.push({ symbol: `${r.ccy}/USD`, name: `Tasa ${r.ccy}`, reason: 'No hay ninguna tasa guardada para empezar: impórtalas en Datos' });
    else if (r.ccy === 'COP') {
      if (last >= today) current++;
      else jobs.push({ kind: 'fx', provider: 'trm', ccy: 'COP', after: last });
    } else if (!tradingDayBetween(last, today)) current++;
    else jobs.push({ kind: 'fx', provider: 'yahoo', ccy: r.ccy, yahoo: yahooFxSymbol(r.ccy), after: last });
  }
  return { jobs, uncovered, current };
}

export function jobLabel(j: Job): string {
  if (j.kind === 'price') return j.name === j.symbol ? j.symbol : `${j.name} (${j.symbol})`;
  return j.provider === 'trm' ? 'TRM (COP)' : `Tasa ${j.ccy}/USD`;
}

export const PROVIDER_LABELS: Record<Job['provider'], string> = { yahoo: 'Yahoo Finance', trm: 'datos.gov.co (TRM oficial)' };

export interface JobResult {
  job: Job;
  prices: StoredPrice[];
  fx: StoredRate[];
  error?: string;
}

export interface RunOptions {
  today: IsoDate;
  /** Unix seconds (tests); sessions that have not ended by then are left out. */
  now?: number;
  fetch?: typeof fetch;
  /** The site's quote function. */
  endpoint?: string;
  /** Symbols per call to the function (it must answer within Netlify's time limit). */
  batch?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

export function trmUrl(after: IsoDate): string {
  const q = new URLSearchParams({ $where: `vigenciadesde > '${after}T00:00:00.000'`, $order: 'vigenciadesde', $limit: '5000' });
  return `https://www.datos.gov.co/resource/32sa-8pi3.json?${q}`;
}

/** First day a job needs from Yahoo: its last stored day, or the stored days it is checked against. */
const fromDay = (j: Job) => (j.kind === 'price' && j.overlap?.length ? j.overlap.reduce((m, o) => (o.date < m ? o.date : m), j.after) : j.after);

/**
 * The call to /api/quotes for some Yahoo jobs. Each Yahoo symbol is asked once, from the earliest day any of
 * its jobs needs (a stock and an index built from the same ETF share it); each job keeps only its own days.
 */
export function quotesUrl(endpoint: string, jobs: readonly Job[]): string {
  const from = new Map<string, IsoDate>();
  for (const j of jobs) {
    if (j.provider !== 'yahoo') continue;
    const f = fromDay(j);
    if (!from.has(j.yahoo) || f < from.get(j.yahoo)!) from.set(j.yahoo, f);
  }
  const q = new URLSearchParams();
  for (const [sym, f] of from) q.append('s', `${sym}@${f}`);
  return `${endpoint}?${q}`;
}

function parseYahoo(j: Job, bars: unknown, today: IsoDate, now: number | undefined): Pick<JobResult, 'prices' | 'fx'> {
  if (j.kind === 'fx') return { prices: [], fx: parseYahooFx(bars, j.ccy, j.after, today, now) };
  if (j.provider !== 'yahoo') return { prices: [], fx: [] };
  if (j.anchor) return { prices: parseYahooAdjusted(bars, j.symbol, j.ccy, j.after, j.anchor, today, j.overlap, now), fx: [] };
  return { prices: parseYahooCloses(bars, j.symbol, j.ccy, j.after, today, now), fx: [] };
}

const reason = (e: unknown, what: string) =>
  e instanceof QuoteError ? e.message : `No se pudo conectar con ${what} (sin internet, o el servicio no respondió).`;

/** Downloads every job: Yahoo ones a few at a time through the site's function, then the TRM. A failure stays with its series. */
export async function runRefresh(plan: RefreshPlan, o: RunOptions): Promise<JobResult[]> {
  const doFetch = o.fetch ?? fetch.bind(globalThis);
  const endpoint = o.endpoint ?? '/api/quotes';
  const size = o.batch ?? 6;
  const total = plan.jobs.length;
  const out = new Map<Job, JobResult>();
  const yahoo = plan.jobs.filter((j) => j.provider === 'yahoo');
  const fail = (j: Job, error: string) => out.set(j, { job: j, prices: [], fx: [], error });

  for (let i = 0; i < yahoo.length; i += size) {
    const group = yahoo.slice(i, i + size);
    o.onProgress?.(out.size, total, group.map(jobLabel).join(', '));
    let body: Record<string, unknown>;
    try {
      const res = await doFetch(quotesUrl(endpoint, group));
      if (res.status === 404) throw new QuoteError('El servicio de precios no está disponible aquí: usa la versión publicada de la app.');
      body = (await res.json().catch(() => {
        throw new QuoteError(`El servicio de precios respondió ${res.status} sin datos.`);
      })) as Record<string, unknown>;
      if (!res.ok) throw new QuoteError(String((body as { error?: string }).error ?? `El servicio de precios respondió ${res.status}.`));
    } catch (e) {
      for (const j of group) fail(j, reason(e, 'el servicio de precios'));
      continue;
    }
    for (const j of group) {
      try {
        if (j.provider !== 'yahoo') continue;
        const bars = body[j.yahoo];
        if (bars === undefined) throw new QuoteError('El servicio de precios no devolvió esta serie.');
        out.set(j, { job: j, ...parseYahoo(j, bars, o.today, o.now) });
      } catch (e) {
        fail(j, reason(e, 'Yahoo Finance'));
      }
    }
  }
  for (const j of plan.jobs.filter((x) => x.provider === 'trm')) {
    o.onProgress?.(out.size, total, jobLabel(j));
    try {
      const res = await doFetch(trmUrl(j.after));
      if (!res.ok) throw new QuoteError(`datos.gov.co respondió ${res.status}.`);
      out.set(j, { job: j, prices: [], fx: parseTrm(await res.json(), j.after, o.today) });
    } catch (e) {
      fail(j, reason(e, 'datos.gov.co'));
    }
  }
  o.onProgress?.(total, total, '');
  return plan.jobs.map((j) => out.get(j)!);
}

export interface Applied {
  next: Dataset;
  prices: number;
  fx: number;
  /** Per result (same order): days actually added and the latest one. */
  added: { count: number; last?: IsoDate }[];
  /** Rows left out because they failed the import checks (with why). */
  rejected: Finding[];
  /** Rows added that deserve a look (a jump from the previous value). */
  warnings: Finding[];
}

const rowOf = (f: Finding) => Number(/^fila (\d+) /.exec(f.ref)?.[1] ?? 0) - 1;

/**
 * Adds the downloaded rows that pass the same checks as an imported file; never replaces a stored value.
 * A series stops at its first rejected row, so a gap is fetched again next time instead of being skipped.
 */
export function applyRefresh(d: Dataset, results: readonly JobResult[], today: IsoDate): Applied {
  const cov = coverage(d);
  const tag = <T>(rows: T[], i: number) => rows.map((row) => ({ row, i }));
  const prices = results.flatMap((r, i) => tag(r.prices, i)).filter(({ row }) => row.date > (cov.prices.get(row.symbol) ?? ''));
  const fx = results.flatMap((r, i) => tag(r.fx, i)).filter(({ row }) => row.date > (cov.fx.get(row.ccy) ?? ''));
  const pf = checkPriceRows(d, prices.map((x) => x.row), today);
  const ff = checkFxRows(d, fx.map((x) => x.row), today);
  const keep = <T extends { date: string }>(rows: { row: T; i: number }[], findings: Finding[], series: (r: T) => string) => {
    const bad = new Set(findings.filter((f) => f.level === 'error').map(rowOf));
    const cut = new Map<string, string>();
    rows.forEach(({ row }, n) => {
      const k = series(row);
      if (bad.has(n) && (!cut.has(k) || row.date < cut.get(k)!)) cut.set(k, row.date);
    });
    return rows.filter(({ row }) => !cut.has(series(row)) || row.date < cut.get(series(row))!);
  };
  const addP = keep(prices, pf, (r) => r.symbol);
  const addF = keep(fx, ff, (r) => r.ccy);
  const added = results.map(() => ({ count: 0, last: undefined as IsoDate | undefined }));
  for (const { row, i } of [...addP, ...addF]) {
    added[i]!.count++;
    if (!added[i]!.last || row.date > added[i]!.last!) added[i]!.last = row.date;
  }
  return {
    next: addP.length || addF.length ? { ...d, prices: [...d.prices, ...addP.map((x) => x.row)], fx: [...d.fx, ...addF.map((x) => x.row)] } : d,
    prices: addP.length,
    fx: addF.length,
    added,
    rejected: [...pf, ...ff].filter((f) => f.level === 'error'),
    warnings: [...pf, ...ff].filter((f) => f.level === 'warning'),
  };
}
