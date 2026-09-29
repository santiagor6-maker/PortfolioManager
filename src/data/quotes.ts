import { isIsoDate } from '../domain/dates.ts';
import type { IsoDate } from '../domain/dates.ts';
import { dec } from '../domain/money.ts';
import type { Decimal } from '../domain/money.ts';
import type { StoredPrice, StoredRate } from './json.ts';

/**
 * Parsers for the quote sources the stored history was built from: Yahoo Finance daily bars (through the
 * site's /api/quotes function) and the official COP TRM. Only closed sessions after the last stored day
 * (`after`) and before today are kept; anything unreadable is rejected, never guessed. A bar is dated by its
 * exchange's local day. The history dated Yahoo bars by their UTC day, which is the same day for every
 * exchange the app uses except currency pairs in British summer time (those rows sit one day early).
 */

export const SOURCES = { yahoo: 'yahoo', trm: 'datos.gov.co 32sa-8pi3' } as const;

/** Symbols the quote function accepts (the same pattern as netlify/functions/quotes.mts). */
export const YAHOO_SYMBOL = /^[A-Z0-9^][A-Z0-9^.=-]{0,19}$/;

/** The source answered, but not with usable data: the reason is shown to the user as is. */
export class QuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteError';
  }
}

/** What /api/quotes returns per symbol (netlify/functions/quotes.mts): Yahoo's bars, untouched. */
export interface YahooBars {
  currency?: string;
  /** The exchange's time zone (e.g. Europe/London for currency pairs). */
  timezone?: string;
  /** Split dates in the window (Unix seconds). */
  splits?: number[];
  timestamps: number[];
  close: (number | null)[];
  adjclose?: (number | null)[];
}

const DAY_S = 86_400;
const formats = new Map<string, Intl.DateTimeFormat>();

/** The local day at the exchange: a currency session that opens Sunday 23:00 UTC in summer is Monday's. */
function localDay(t: number, tz: string | undefined): IsoDate {
  if (!tz) return new Date(t * 1000).toISOString().slice(0, 10);
  let f = formats.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      throw new QuoteError(`Zona horaria desconocida: ${tz}`);
    }
    formats.set(tz, f);
  }
  return f.format(new Date(t * 1000));
}

/**
 * One value per day, only for sessions that are over: a bar is complete a full day after it opens (a daily
 * bar never lasts longer), so a session still trading is never stored. `now` is in Unix seconds.
 */
function days(bars: unknown, pick: 'close' | 'adjclose', now: number): Map<IsoDate, number> {
  const b = bars as Partial<YahooBars> & { error?: string };
  if (b?.error) throw new QuoteError(b.error);
  const values = b?.[pick];
  if (!Array.isArray(b?.timestamps) || !Array.isArray(values)) throw new QuoteError('Yahoo Finance respondió algo que no es una serie de precios.');
  const out = new Map<IsoDate, number>();
  b.timestamps.forEach((t, i) => {
    const v = values[i];
    if (typeof t !== 'number' || t + DAY_S > now || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return;
    out.set(localDay(t, b.timezone), v);
  });
  return out;
}

/** A Yahoo close as stored: rounded to 6 decimals, as an exact decimal string. */
const round6 = (v: number): Decimal => dec(String(Number(v.toFixed(6))));

const inRange = (d: IsoDate, after: IsoDate, before: IsoDate) => isIsoDate(d) && d > after && d < before;
const nowS = () => Math.floor(Date.now() / 1000);

function checkCurrency(bars: unknown, symbol: string, ccy: string) {
  const quoted = (bars as YahooBars | undefined)?.currency;
  if (quoted && quoted !== ccy) throw new QuoteError(`Yahoo Finance cotiza ${symbol} en ${quoted}, no en ${ccy}.`);
}

/**
 * Daily closes of a stock, ETF, crypto or price index, in `ccy` (checked against Yahoo's quote currency).
 * Yahoo's closes are split-adjusted back in time, so a split after the last stored day would put new days
 * on another scale than the stored ones (and than the units in the ledger): the series stops and says so.
 */
export function parseYahooCloses(bars: unknown, symbol: string, ccy: string, after: IsoDate, before: IsoDate, now = nowS()): StoredPrice[] {
  checkCurrency(bars, symbol, ccy);
  const closes = days(bars, 'close', now);
  const b = bars as YahooBars;
  const split = (b.splits ?? []).map((t) => localDay(t, b.timezone)).filter((d) => d > after).sort()[0];
  if (split) throw new QuoteError(`${symbol} tuvo un split el ${split}: registra el cambio de unidades y pídele a Claude la serie de precios; no se agregó nada.`);
  return [...closes]
    .filter(([d]) => inRange(d, after, before))
    .map(([date, v]) => ({ symbol, date, close: round6(v).toString(), ccy, source: SOURCES.yahoo }))
    .sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * A total-return index kept as an ETF's adjusted close. Yahoo rescales the whole adjusted history at every
 * dividend, so new days cannot be appended as they come: each is chained from the last stored level,
 * level(t) = stored(after) × adj(t) / adj(after), with `adj` from this same download. The stored days just
 * before (`overlap`) must move exactly like this download: if not (a dividend Yahoo adjusted late, a
 * rebuilt series), chaining would carry the error forward, so nothing is added.
 */
export function parseYahooAdjusted(
  bars: unknown,
  symbol: string,
  ccy: string,
  after: IsoDate,
  anchor: string,
  before: IsoDate,
  overlap: readonly { date: IsoDate; close: string }[] = [],
  now = nowS(),
): StoredPrice[] {
  checkCurrency(bars, symbol, ccy);
  const adj = days(bars, 'adjclose', now);
  const base = adj.get(after);
  const next = [...adj].filter(([d]) => inRange(d, after, before));
  if (next.length === 0) return [];
  if (base === undefined) throw new QuoteError(`Yahoo Finance no trae el ${after} (el último día guardado), así que no se puede empalmar la serie.`);
  const level = dec(anchor);
  const b = dec(String(base));
  let checked = 0;
  for (const o of overlap) {
    const a = adj.get(o.date);
    if (a === undefined) continue;
    checked++;
    const stored = dec(o.close).div(level);
    const fresh = dec(String(a)).div(b);
    if (stored.minus(fresh).abs().div(fresh).gt(1e-6)) {
      throw new QuoteError(`La serie guardada de ${symbol} no se mueve igual que Yahoo desde el ${o.date} (¿un dividendo ajustado tarde?): pídele a Claude revisarla; no se agregó nada.`);
    }
  }
  if (overlap.length > 0 && checked === 0) throw new QuoteError(`Yahoo Finance no trae los días guardados antes del ${after} de ${symbol}, así que no se pudo comprobar el empalme; no se agregó nada.`);
  return next
    .map(([date, v]) => ({ symbol, date, close: level.times(dec(String(v))).div(b).toSignificantDigits(15).toString(), ccy, source: SOURCES.yahoo }))
    .sort((x, y) => x.date.localeCompare(y.date));
}

/** Yahoo's pair for a currency: `EURUSD=X` is USD per unit, stored inverted as units per USD (as the history). */
export const yahooFxSymbol = (ccy: string) => `${ccy}USD=X`;

export function parseYahooFx(bars: unknown, ccy: string, after: IsoDate, before: IsoDate, now = nowS()): StoredRate[] {
  return [...days(bars, 'close', now)]
    .filter(([d]) => inRange(d, after, before))
    .map(([date, v]) => ({ ccy, date, perUsd: dec(1).div(round6(v)).toString(), source: SOURCES.yahoo }))
    .sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * The official COP TRM (datos.gov.co dataset 32sa-8pi3). One row per rate, dated the day it takes effect:
 * the rate set on a Friday covers the weekend and is stored once, as the history does. It is published
 * the business day before, so today's rate counts (`date ≤ before`).
 */
export function parseTrm(body: unknown, after: IsoDate, before: IsoDate): StoredRate[] {
  if (!Array.isArray(body)) throw new QuoteError('datos.gov.co respondió algo que no es la serie de la TRM.');
  const out: StoredRate[] = [];
  for (const r of body as { valor?: string; unidad?: string; vigenciadesde?: string }[]) {
    const date = r.vigenciadesde?.slice(0, 10);
    let v: Decimal | undefined;
    try {
      v = r.valor ? dec(r.valor) : undefined;
    } catch {
      v = undefined;
    }
    if (r.unidad !== 'COP' || !date || !isIsoDate(date) || !v || !v.gt(0) || date <= after || date > before) continue;
    out.push({ ccy: 'COP', date, perUsd: v.toString(), source: SOURCES.trm });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}
