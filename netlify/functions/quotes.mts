/**
 * GET /api/quotes?s=SYMBOL@YYYY-MM-DD&s=…  → daily bars from Yahoo Finance's chart API, from that date to now.
 *
 * The browser cannot call Yahoo (no CORS), so the app asks this function, on its own origin. It only relays
 * Yahoo's chart data for a few symbols per call (the Netlify time limit), one request at a time, and returns
 * the raw bars: dates, rounding and checks are done by the app (src/data/quotes.ts), with the same
 * conventions as the stored history.
 */

const MAX_SYMBOLS = 10;
// Same pattern as YAHOO_SYMBOL in src/data/quotes.ts (the app leaves out anything else before asking).
const SYMBOL = /^[A-Z0-9^][A-Z0-9^.=-]{0,19}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Bars {
  currency?: string;
  /** The exchange's time zone: a bar's date is its local day there (FX sessions start at 23:00 UTC in summer). */
  timezone?: string;
  /** Split dates (Unix seconds) in the window: Yahoo's closes are split-adjusted, so the app will not append across one. */
  splits?: number[];
  timestamps: number[];
  close: (number | null)[];
  adjclose?: (number | null)[];
}
export type Reply = Record<string, Bars | { error: string }>;

interface YahooChart {
  chart?: {
    result?: {
      meta?: { currency?: string; exchangeTimezoneName?: string };
      events?: { splits?: Record<string, { date?: number }> };
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[]; adjclose?: { adjclose?: (number | null)[] }[] };
    }[];
    error?: { description?: string } | null;
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function one(symbol: string, from: string, doFetch: typeof fetch, wait: (ms: number) => Promise<void>): Promise<Bars | { error: string }> {
  const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit&includeAdjustedClose=true`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
    } catch {
      return { error: 'No se pudo conectar con Yahoo Finance.' };
    }
    if (res.status === 429 && attempt === 0) {
      await wait(2000);
      continue;
    }
    if (res.status === 429) return { error: 'Yahoo Finance limitó las consultas. Intenta en unos minutos.' };
    let body: YahooChart;
    try {
      body = (await res.json()) as YahooChart;
    } catch {
      return { error: `Yahoo Finance respondió ${res.status} sin datos.` };
    }
    const r = body.chart?.result?.[0];
    if (!r) return { error: body.chart?.error?.description ?? `Yahoo Finance no tiene datos de ${symbol} (${res.status}).` };
    const splits = Object.values(r.events?.splits ?? {})
      .map((x) => x.date)
      .filter((t): t is number => typeof t === 'number');
    return {
      ...(r.meta?.currency ? { currency: r.meta.currency } : {}),
      ...(r.meta?.exchangeTimezoneName ? { timezone: r.meta.exchangeTimezoneName } : {}),
      ...(splits.length ? { splits } : {}),
      timestamps: r.timestamp ?? [],
      close: r.indicators?.quote?.[0]?.close ?? [],
      ...(r.indicators?.adjclose?.[0]?.adjclose ? { adjclose: r.indicators.adjclose[0].adjclose } : {}),
    };
  }
  return { error: 'Yahoo Finance no respondió.' };
}

export async function handle(req: Request, doFetch: typeof fetch = fetch, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<Response> {
  if (req.method !== 'GET') return json(405, { error: 'Solo GET' });
  // Only for the app's own pages (browsers send this header; a missing one is a direct call, e.g. a test).
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return json(403, { error: 'Solo para la app' });
  const asked = new URL(req.url).searchParams.getAll('s');
  if (asked.length === 0 || asked.length > MAX_SYMBOLS) return json(400, { error: `Pide entre 1 y ${MAX_SYMBOLS} símbolos` });
  const out: Reply = {};
  let calls = 0;
  for (const s of asked) {
    const at = s.lastIndexOf('@');
    const symbol = s.slice(0, at);
    const from = s.slice(at + 1);
    // A bad entry fails alone; the rest of the batch still goes through.
    if (at < 1 || !SYMBOL.test(symbol) || !DATE.test(from) || Number.isNaN(Date.parse(from))) {
      out[symbol || s] = { error: `Símbolo o fecha inválidos: ${s}` };
      continue;
    }
    if (calls++ > 0) await wait(150);
    out[symbol] = await one(symbol, from, doFetch, wait);
  }
  return json(200, out);
}

export default (req: Request) => handle(req);

export const config = { path: '/api/quotes' };
