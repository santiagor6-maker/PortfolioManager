import { addDays, isIsoDate } from '../domain/dates.ts';
import type { IsoDate } from '../domain/dates.ts';
import { dec } from '../domain/money.ts';
import type { StoredPrice, StoredRate } from './json.ts';

/**
 * Parsers for the public quote APIs the app downloads from. Each keeps only completed days after the last
 * stored one (`after` < date < `before`, or ≤ `before` for rates published in advance), tags the row with
 * its source, and rejects anything it cannot read instead of guessing.
 */

export const SOURCES = {
  twelvedata: 'twelvedata',
  trm: 'datos.gov.co 32sa-8pi3',
  coingecko: 'coingecko',
} as const;

/** The API answered, but not with data: the reason is shown to the user as is. */
export class QuoteError extends Error {
  /** Retrying later can work (per-minute limit). */
  readonly retry: boolean;

  constructor(message: string, retry = false) {
    super(message);
    this.name = 'QuoteError';
    this.retry = retry;
  }
}

interface TwelveDataBar {
  datetime: string;
  close: string;
}
interface TwelveDataReply {
  status?: string;
  code?: number;
  message?: string;
  meta?: { symbol?: string; currency?: string };
  values?: TwelveDataBar[];
}

/** Twelve Data's error body; "no data in range" is not an error, just nothing new. */
function twelveDataBars(body: unknown): TwelveDataBar[] {
  const r = body as TwelveDataReply;
  if (r?.status === 'error') {
    if (r.code === 400 && /no data is available/i.test(r.message ?? '')) return [];
    if (r.code === 401) throw new QuoteError('Twelve Data no acepta la clave: revísala en Datos.');
    if (r.code === 404) throw new QuoteError('Twelve Data no conoce ese símbolo.');
    if (r.code === 429 && /for the day|daily/i.test(r.message ?? '')) throw new QuoteError('Se agotaron las 800 consultas diarias de Twelve Data. Intenta mañana.');
    if (r.code === 429) throw new QuoteError('Se agotaron las consultas de Twelve Data por este minuto (8 por minuto).', true);
    throw new QuoteError(`Twelve Data: ${r.message ?? `error ${r.code}`}`);
  }
  if (!Array.isArray(r?.values)) throw new QuoteError('Twelve Data respondió algo que no es una serie de precios.');
  return r.values;
}

const positive = (s: unknown) => {
  if (typeof s !== 'string' && typeof s !== 'number') return undefined;
  try {
    const v = dec(s);
    return v.isFinite() && v.gt(0) ? v : undefined;
  } catch {
    return undefined;
  }
};

/** Daily closes of a stock or ETF (`/time_series?interval=1day`), in the asset's currency. */
export function parseTwelveDataSeries(body: unknown, symbol: string, ccy: string, after: IsoDate, before: IsoDate): StoredPrice[] {
  const bars = twelveDataBars(body);
  const quoted = (body as TwelveDataReply).meta?.currency;
  if (quoted && quoted !== ccy) throw new QuoteError(`Twelve Data cotiza ${symbol} en ${quoted}, no en ${ccy}.`);
  const out: StoredPrice[] = [];
  for (const b of bars) {
    const date = b.datetime?.slice(0, 10);
    const close = positive(b.close);
    if (!date || !isIsoDate(date) || !close || date <= after || date >= before) continue;
    out.push({ symbol, date, close: close.toString(), ccy, source: SOURCES.twelvedata });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/** Currencies quoted against USD by market convention (EUR/USD); the rest as USD/XXX. */
const QUOTED_IN_USD = new Set(['EUR', 'GBP', 'AUD', 'NZD']);

/** The Twelve Data forex pair for a currency, and whether its close is USD per unit (to invert). */
export function fxPair(ccy: string): { pair: string; inverted: boolean } {
  return QUOTED_IN_USD.has(ccy) ? { pair: `${ccy}/USD`, inverted: true } : { pair: `USD/${ccy}`, inverted: false };
}

/** Daily closes of a forex pair, stored as units of `ccy` per USD (inverted for EUR/USD-style pairs). */
export function parseTwelveDataFx(body: unknown, ccy: string, after: IsoDate, before: IsoDate): StoredRate[] {
  const { inverted } = fxPair(ccy);
  const out: StoredRate[] = [];
  for (const b of twelveDataBars(body)) {
    const date = b.datetime?.slice(0, 10);
    const v = positive(b.close);
    if (!date || !isIsoDate(date) || !v || date <= after || date >= before) continue;
    out.push({ ccy, date, perUsd: (inverted ? dec(1).div(v) : v).toString(), source: SOURCES.twelvedata });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * The official COP TRM (datos.gov.co dataset 32sa-8pi3). One row per rate, dated the day it takes effect:
 * the rate set on a Friday covers the weekend and is stored once, as the app already does. It is published
 * the business day before, so today's rate counts (`date ≤ before`).
 */
export function parseTrm(body: unknown, after: IsoDate, before: IsoDate): StoredRate[] {
  if (!Array.isArray(body)) throw new QuoteError('datos.gov.co respondió algo que no es la serie de la TRM.');
  const out: StoredRate[] = [];
  for (const r of body as { valor?: string; unidad?: string; vigenciadesde?: string }[]) {
    const date = r.vigenciadesde?.slice(0, 10);
    const v = positive(r.valor);
    if (r.unidad !== 'COP' || !date || !isIsoDate(date) || !v || date <= after || date > before) continue;
    out.push({ ccy: 'COP', date, perUsd: v.toString(), source: SOURCES.trm });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/** CoinGecko coin ids for the crypto symbols the app uses (Yahoo style, e.g. XRP-USD). */
export const COINGECKO_IDS: Record<string, string> = {
  'BTC-USD': 'bitcoin',
  'ETH-USD': 'ethereum',
  'XRP-USD': 'ripple',
  'SOL-USD': 'solana',
  'ADA-USD': 'cardano',
  'DOGE-USD': 'dogecoin',
  'BNB-USD': 'binancecoin',
  'LTC-USD': 'litecoin',
};

const DAY_MS = 86_400_000;

/**
 * Daily USD prices from CoinGecko's `/market_chart?interval=daily`. The point at 00:00 UTC is the price
 * when day D ends, i.e. the close of the day before (the convention of the stored Yahoo series); the last
 * point, taken at the moment of the request, is not a close and is dropped.
 */
export function parseCoinGecko(body: unknown, symbol: string, after: IsoDate, before: IsoDate): StoredPrice[] {
  const r = body as { prices?: unknown; status?: { error_code?: number; error_message?: string }; error?: string };
  if (r?.status?.error_code === 429) throw new QuoteError('CoinGecko limita las consultas por minuto. Intenta en un momento.', true);
  if (!Array.isArray(r?.prices)) throw new QuoteError(`CoinGecko: ${r?.status?.error_message ?? r?.error ?? 'respuesta sin precios'}`);
  const out = new Map<string, StoredPrice>();
  for (const p of r.prices as unknown[]) {
    if (!Array.isArray(p) || typeof p[0] !== 'number' || p[0] % DAY_MS !== 0) continue;
    const date = addDays(new Date(p[0]).toISOString().slice(0, 10), -1);
    const close = positive(p[1]);
    if (!close || date <= after || date >= before) continue;
    out.set(date, { symbol, date, close: close.toSignificantDigits(10).toString(), ccy: 'USD', source: SOURCES.coingecko });
  }
  return [...out.values()].sort((x, y) => x.date.localeCompare(y.date));
}
