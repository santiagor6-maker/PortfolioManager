import { addDays, daysBetween } from '../domain/dates.ts';
import type { IsoDate } from '../domain/dates.ts';
import { holdingsAt } from '../domain/holdings.ts';
import type { Dataset, StoredPrice, StoredRate } from '../data/json.ts';
import { COINGECKO_IDS, QuoteError, fxPair, parseCoinGecko, parseTrm, parseTwelveDataFx, parseTwelveDataSeries } from '../data/quotes.ts';
import { checkFxRows, checkPriceRows, fxStatus } from './checks.ts';
import type { Finding } from './checks.ts';
import { contextOf, coverage } from './context.ts';

/**
 * "Actualizar precios": which series the app can download by itself, from where, and what stays manual.
 * Only days after the last stored one are fetched and added; nothing already stored is replaced.
 */

export type Job =
  | { kind: 'price'; provider: 'twelvedata' | 'coingecko'; symbol: string; name: string; ccy: string; after: IsoDate }
  | { kind: 'fx'; provider: 'twelvedata' | 'trm'; ccy: string; after: IsoDate };

export interface Uncovered {
  symbol: string;
  name: string;
  reason: string;
}

export interface RefreshPlan {
  jobs: Job[];
  /** Series in use that no automatic source covers (or that need the Twelve Data key). */
  uncovered: Uncovered[];
  /** Series already up to date. */
  current: number;
}

const EXCHANGES: [RegExp, string][] = [
  [/\.CL$/, 'Bolsa de Colombia'],
  [/\.L$/, 'Bolsa de Londres'],
  [/\.PA$/, 'Euronext París'],
  [/\.(DE|F)$/, 'Bolsa de Alemania'],
  [/\.TO$/, 'Bolsa de Toronto'],
  [/\.HK$/, 'Bolsa de Hong Kong'],
  [/\.OL$/, 'Bolsa de Oslo'],
  [/\.AS$/, 'Euronext Ámsterdam'],
  [/\.MC$/, 'Bolsa de Madrid'],
];

const NEEDS_KEY = 'Falta la clave de Twelve Data (gratis): pégala arriba.';
const NOT_FREE = 'el plan gratis de Twelve Data solo cubre EE. UU.';

/** Symbols that name a benchmark series the app can refresh (a price index with no dividends to reinvest). */
const BENCHMARK_COINS: Record<string, string> = { 'BENCH:BTC': 'BTC-USD' };

/** A weekday strictly between `after` and `today`: a completed trading day that may not be stored yet. */
function tradingDayBetween(after: IsoDate, today: IsoDate): boolean {
  for (let d = addDays(after, 1); d < today; d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) return true;
  }
  return false;
}

export function refreshPlan(d: Dataset, today: IsoDate, hasKey: boolean): RefreshPlan {
  const ctx = contextOf(d);
  const cov = coverage(d);
  const jobs: Job[] = [];
  const uncovered: Uncovered[] = [];
  let current = 0;

  let openAssets = new Set<string>();
  try {
    openAssets = new Set([...holdingsAt(ctx.ledger, today).positions.values()].filter((p) => p.open).map((p) => p.asset));
  } catch {
    /* an impossible ledger is reported elsewhere; refresh only what has a stored series */
  }
  const firstTx = new Map<string, IsoDate>();
  const lastTx = new Map<string, IsoDate>();
  for (const t of ctx.ledger) {
    if (!t.asset) continue;
    if (!firstTx.has(t.asset) || t.date < firstTx.get(t.asset)!) firstTx.set(t.asset, t.date);
    if (!lastTx.has(t.asset) || t.date > lastTx.get(t.asset)!) lastTx.set(t.asset, t.date);
  }

  const seen = new Set<string>();
  const addPrice = (symbol: string, name: string, ccy: string, after: IsoDate | undefined, coin: string | undefined) => {
    if (seen.has(symbol) || !after) return;
    seen.add(symbol);
    if (coin) {
      if (after >= addDays(today, -1)) current++;
      else jobs.push({ kind: 'price', provider: 'coingecko', symbol, name, ccy, after });
      return;
    }
    if (ccy === 'USD' && /^[A-Z]{1,5}$/.test(symbol)) {
      if (!tradingDayBetween(after, today)) current++;
      else if (!hasKey) uncovered.push({ symbol, name, reason: NEEDS_KEY });
      else jobs.push({ kind: 'price', provider: 'twelvedata', symbol, name, ccy, after });
      return;
    }
    if (/-USD$/.test(symbol)) {
      uncovered.push({ symbol, name, reason: 'Criptomoneda que la app todavía no sabe buscar en CoinGecko' });
      return;
    }
    const where = EXCHANGES.find(([re]) => re.test(symbol))?.[1] ?? 'Bolsa fuera de EE. UU.';
    uncovered.push({ symbol, name, reason: `${where}: ${NOT_FREE}` });
  };

  for (const a of d.assets) {
    if (a.pricing !== 'market' || !a.symbol) continue;
    const last = cov.prices.get(a.symbol);
    // In use: still held, or traded after its last stored price.
    if (!openAssets.has(a.id) && !(lastTx.get(a.id) && (!last || lastTx.get(a.id)! > last))) continue;
    const coin = COINGECKO_IDS[a.symbol];
    if (coin && a.ccy !== 'USD') {
      uncovered.push({ symbol: a.symbol, name: a.name, reason: `CoinGecko da el precio en USD y el activo cotiza en ${a.ccy}` });
      continue;
    }
    addPrice(a.symbol, a.name, a.ccy, last ?? (firstTx.get(a.id) ? addDays(firstTx.get(a.id)!, -1) : undefined), coin);
  }
  for (const b of d.benchmarks) {
    const coin = BENCHMARK_COINS[b.symbol];
    const last = cov.prices.get(b.symbol);
    if (coin && last) addPrice(b.symbol, b.name, 'USD', last, COINGECKO_IDS[coin]);
    else if (coin) uncovered.push({ symbol: b.symbol, name: b.name, reason: 'No hay ninguna serie guardada para empezar: impórtala en Datos' });
    else uncovered.push({ symbol: b.symbol, name: b.name, reason: 'Índice de retorno total: no hay fuente gratuita automática' });
  }

  for (const r of fxStatus(d, ctx, today)) {
    const last = cov.fx.get(r.ccy);
    if (!last) {
      uncovered.push({ symbol: `${r.ccy}/USD`, name: `Tasa ${r.ccy}`, reason: 'No hay ninguna tasa guardada para empezar: impórtalas en Datos' });
    } else if (r.ccy === 'COP') {
      if (last >= today) current++;
      else jobs.push({ kind: 'fx', provider: 'trm', ccy: 'COP', after: last });
    } else if (!tradingDayBetween(last, today)) current++;
    else if (!hasKey) uncovered.push({ symbol: `${r.ccy}/USD`, name: `Tasa ${r.ccy}`, reason: NEEDS_KEY });
    else jobs.push({ kind: 'fx', provider: 'twelvedata', ccy: r.ccy, after: last });
  }
  return { jobs, uncovered, current };
}

export function jobLabel(j: Job): string {
  if (j.kind === 'price') return j.name === j.symbol ? j.symbol : `${j.name} (${j.symbol})`;
  return j.provider === 'trm' ? 'TRM (COP)' : `Tasa ${fxPair(j.ccy).pair}`;
}

export const PROVIDER_LABELS: Record<Job['provider'], string> = { twelvedata: 'Twelve Data', coingecko: 'CoinGecko', trm: 'datos.gov.co (TRM oficial)' };

/** CoinGecko's free API serves at most this many days of daily history. */
const COINGECKO_MAX_DAYS = 365;

export function jobUrl(j: Job, today: IsoDate, key: string): string {
  const from = addDays(j.after, 1);
  if (j.provider === 'twelvedata') {
    const symbol = j.kind === 'price' ? j.symbol : fxPair(j.ccy).pair;
    const q = new URLSearchParams({ symbol, interval: '1day', start_date: from, end_date: today, order: 'ASC', outputsize: '5000', apikey: key });
    return `https://api.twelvedata.com/time_series?${q}`;
  }
  if (j.provider === 'trm') {
    const q = new URLSearchParams({ $where: `vigenciadesde > '${j.after}T00:00:00.000'`, $order: 'vigenciadesde', $limit: '5000' });
    return `https://www.datos.gov.co/resource/32sa-8pi3.json?${q}`;
  }
  const symbol = j.kind === 'price' ? j.symbol : '';
  const id = COINGECKO_IDS[BENCHMARK_COINS[symbol] ?? symbol]!;
  const days = Math.min(COINGECKO_MAX_DAYS, daysBetween(j.after, today) + 1);
  return `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
}

export interface JobResult {
  job: Job;
  prices: StoredPrice[];
  fx: StoredRate[];
  error?: string;
  /** Something the user should know even though rows came in (e.g. history cut to CoinGecko's year). */
  note?: string;
}

export interface RunOptions {
  key: string;
  today: IsoDate;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Twelve Data's free plan: 8 requests per minute. */
  perMinute?: number;
  onProgress?: (done: number, total: number, label: string, waiting: boolean) => void;
}

function parse(j: Job, body: unknown, today: IsoDate): Pick<JobResult, 'prices' | 'fx'> {
  if (j.provider === 'trm') return { prices: [], fx: parseTrm(body, j.after, today) };
  if (j.kind === 'fx') return { prices: [], fx: parseTwelveDataFx(body, j.ccy, j.after, today) };
  if (j.provider === 'coingecko') return { prices: parseCoinGecko(body, j.symbol, j.after, today), fx: [] };
  return { prices: parseTwelveDataSeries(body, j.symbol, j.ccy, j.after, today), fx: [] };
}

/** Downloads every job in order, pacing Twelve Data to its per-minute limit. A failure stays with its job. */
export async function runRefresh(plan: RefreshPlan, o: RunOptions): Promise<JobResult[]> {
  const doFetch = o.fetch ?? fetch.bind(globalThis);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const perMinute = o.perMinute ?? 8;
  const calls: number[] = [];
  const out: JobResult[] = [];
  const total = plan.jobs.length;

  const pace = async (label: string, done: number) => {
    const recent = calls.filter((t) => now() - t < 60_000);
    if (recent.length >= perMinute) {
      o.onProgress?.(done, total, label, true);
      await sleep(60_000 - (now() - recent[recent.length - perMinute]!) + 500);
    }
    calls.push(now());
  };

  for (const [i, j] of plan.jobs.entries()) {
    const label = jobLabel(j);
    o.onProgress?.(i, total, label, false);
    let result: JobResult | undefined;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      if (j.provider === 'twelvedata') await pace(label, i);
      try {
        const res = await doFetch(jobUrl(j, o.today, o.key));
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          throw new QuoteError(`${PROVIDER_LABELS[j.provider]} respondió ${res.status} sin datos legibles.`);
        }
        if (!res.ok && j.provider !== 'twelvedata' && !(j.provider === 'coingecko' && res.status === 429)) {
          throw new QuoteError(`${PROVIDER_LABELS[j.provider]} respondió ${res.status}.`);
        }
        result = { job: j, ...parse(j, body, o.today) };
        const first = result.prices[0]?.date;
        if (j.provider === 'coingecko' && daysBetween(j.after, o.today) > COINGECKO_MAX_DAYS && first && first > addDays(j.after, 1)) {
          result.note = `CoinGecko solo da el último año: faltan los días del ${addDays(j.after, 1)} al ${addDays(first, -1)}.`;
        }
      } catch (e) {
        if (e instanceof QuoteError && e.retry && attempt === 0) {
          o.onProgress?.(i, total, label, true);
          await sleep(61_000);
          continue;
        }
        const reason =
          e instanceof QuoteError
            ? e.message
            : `No se pudo conectar con ${PROVIDER_LABELS[j.provider]} (sin internet, o la fuente no acepta consultas desde el navegador).`;
        result = { job: j, prices: [], fx: [], error: reason };
      }
    }
    out.push(result!);
  }
  o.onProgress?.(total, total, '', false);
  return out;
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
