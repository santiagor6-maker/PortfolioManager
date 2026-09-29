import { describe, expect, it } from 'vitest';
import { emptyDataset, toStored } from '../src/data/json.ts';
import type { Dataset } from '../src/data/json.ts';
import { QuoteError, parseTrm, parseYahooAdjusted, parseYahooCloses, parseYahooFx } from '../src/data/quotes.ts';
import { dec } from '../src/domain/money.ts';
import { applyRefresh, quotesUrl, refreshPlan, runRefresh } from '../src/app/refresh.ts';
import type { JobResult } from '../src/app/refresh.ts';
import { handle } from '../netlify/functions/quotes.mts';
import { tx } from './helpers.ts';

// Yahoo bars as /api/quotes relays them (fictional tickers and values). US bars are stamped at the 13:30 UTC open.
const at = (d: string, hhmm = '13:30') => Date.parse(`${d}T${hhmm}:00Z`) / 1000;
const bars = (rows: [string, number | null][], extra: { currency?: string; adj?: (number | null)[] } = {}) => ({
  ...(extra.currency ? { currency: extra.currency } : {}),
  timestamps: rows.map(([d]) => at(d)),
  close: rows.map(([, c]) => c),
  ...(extra.adj ? { adjclose: extra.adj } : {}),
});

describe('Yahoo closes', () => {
  it('one close per day after the last stored one (the UTC day when Yahoo gives no time zone), rounded to 6 decimals; today and empty bars are left out', () => {
    const b = bars([['2025-07-03', 100], ['2025-07-07', 101.234567891], ['2025-07-08', null], ['2025-07-09', 102.5], ['2025-07-10', 103]], { currency: 'USD' });
    expect(parseYahooCloses(b, 'FAKE', 'USD', '2025-07-03', '2025-07-10')).toEqual([
      { symbol: 'FAKE', date: '2025-07-07', close: '101.234568', ccy: 'USD', source: 'yahoo' },
      { symbol: 'FAKE', date: '2025-07-09', close: '102.5', ccy: 'USD', source: 'yahoo' },
    ]);
  });

  it('a session still trading is never stored: a bar counts once a full day has passed since it opened', () => {
    const b = bars([['2025-07-07', 10], ['2025-07-08', 10.5]], { currency: 'USD' });
    const now = at('2025-07-09', '12:00'); // Tuesday's bar opened 22.5 h ago: still open for this rule
    expect(parseYahooCloses(b, 'FAKE', 'USD', '2025-07-04', '2025-07-10', now).map((r) => r.date)).toEqual(['2025-07-07']);
    expect(parseYahooCloses(b, 'FAKE', 'USD', '2025-07-04', '2025-07-10', at('2025-07-09', '13:30')).map((r) => r.date)).toEqual(['2025-07-07', '2025-07-08']);
  });

  it('a split after the last stored day stops the series (Yahoo rescales earlier closes)', () => {
    const b = { ...bars([['2025-07-07', 50], ['2025-07-08', 51]], { currency: 'USD' }), splits: [at('2025-07-08')] };
    expect(() => parseYahooCloses(b, 'FAKE', 'USD', '2025-07-04', '2025-07-10')).toThrow(/split el 2025-07-08/);
    // One before the last stored day is already in the stored scale.
    expect(parseYahooCloses({ ...b, splits: [at('2025-07-01')] }, 'FAKE', 'USD', '2025-07-04', '2025-07-10')).toHaveLength(2);
  });

  it('rejects another currency (e.g. pence for pounds) and relays the function error', () => {
    expect(() => parseYahooCloses(bars([], { currency: 'GBp' }), 'FAKE.L', 'GBP', '2025-07-01', '2025-07-10')).toThrow(/en GBp, no en GBP/);
    expect(() => parseYahooCloses({ error: 'Yahoo Finance no tiene datos de FAKE (404).' }, 'FAKE', 'USD', '2025-07-01', '2025-07-10')).toThrow(/no tiene datos/);
    expect(() => parseYahooCloses({ nope: 1 }, 'FAKE', 'USD', '2025-07-01', '2025-07-10')).toThrow(QuoteError);
  });

  it('a currency session is dated by its London day: in summer Monday opens Sunday 23:00 UTC', () => {
    const b = { currency: 'USD', timezone: 'Europe/London', timestamps: [at('2025-07-06', '23:00'), at('2025-07-07', '23:00')], close: [1.25, 1.2] };
    // At midday Tuesday, Tuesday's session (opened Monday 23:00 UTC) is still trading: only Monday's is kept.
    expect(parseYahooFx(b, 'EUR', '2025-07-04', '2025-07-10', at('2025-07-08', '12:00')).map((r) => [r.date, r.perUsd])).toEqual([['2025-07-07', '0.8']]);
    // In winter the session opens at 00:00 UTC, the same day.
    const w = { currency: 'USD', timezone: 'Europe/London', timestamps: [at('2025-01-06', '00:00')], close: [1.25] };
    expect(parseYahooFx(w, 'EUR', '2025-01-03', '2025-01-10').map((r) => r.date)).toEqual(['2025-01-06']);
  });

  it('exchange rates: XXXUSD=X is USD per unit, stored inverted as units per USD', () => {
    const b = bars([['2025-07-07', 1.25], ['2025-07-08', 1.173412345]]);
    expect(parseYahooFx(b, 'EUR', '2025-07-04', '2025-07-09')).toEqual([
      { ccy: 'EUR', date: '2025-07-07', perUsd: '0.8', source: 'yahoo' },
      { ccy: 'EUR', date: '2025-07-08', perUsd: dec(1).div('1.173412').toString(), source: 'yahoo' },
    ]);
  });
});

describe('Yahoo adjusted close (total-return index from an ETF)', () => {
  // Stored level on Jul 3 = 200 (an older download). Today's download is rescaled by a later dividend, so Jul 3 reads 98:
  // the new days are chained from the stored level, 200 × adj(t) / adj(Jul 3).
  const b = bars([['2025-07-03', 99], ['2025-07-07', 100], ['2025-07-08', 97]], { currency: 'USD', adj: [98, 99, 98.49] });

  it('chains each new day onto the stored level', () => {
    expect(parseYahooAdjusted(b, 'BENCH:FAKE-TR', 'USD', '2025-07-03', '200', '2025-07-09')).toEqual([
      // 200 × 99 / 98 = 202.04081632653061…; 200 × 98.49 / 98 = 201
      { symbol: 'BENCH:FAKE-TR', date: '2025-07-07', close: '202.040816326531', ccy: 'USD', source: 'yahoo' },
      { symbol: 'BENCH:FAKE-TR', date: '2025-07-08', close: '201', ccy: 'USD', source: 'yahoo' },
    ]);
  });

  it('the stored days just before must move like the download; otherwise nothing is chained', () => {
    const withBefore = bars([['2025-07-02', 97], ['2025-07-03', 99], ['2025-07-07', 100]], { currency: 'USD', adj: [97, 98, 99] });
    // Stored Jul 2 = 200 × 97/98 matches; a stored level that moved differently (a late dividend) is refused.
    const good = [{ date: '2025-07-02', close: dec(200).times(97).div(98).toString() }];
    expect(parseYahooAdjusted(withBefore, 'BENCH:FAKE-TR', 'USD', '2025-07-03', '200', '2025-07-09', good)).toHaveLength(1);
    expect(() => parseYahooAdjusted(withBefore, 'BENCH:FAKE-TR', 'USD', '2025-07-03', '200', '2025-07-09', [{ date: '2025-07-02', close: '199' }])).toThrow(/no se mueve igual/);
    // Stored days the download does not have: nothing could be checked, so nothing is chained.
    expect(() => parseYahooAdjusted(withBefore, 'BENCH:FAKE-TR', 'USD', '2025-07-03', '200', '2025-07-09', [{ date: '2025-06-30', close: '198' }])).toThrow(/no se pudo comprobar/);
  });

  it('without the last stored day in the download it cannot chain, and says so', () => {
    const missing = bars([['2025-07-07', 100]], { adj: [99] });
    expect(() => parseYahooAdjusted(missing, 'BENCH:FAKE-TR', 'USD', '2025-07-03', '200', '2025-07-09')).toThrow(/empalmar/);
    expect(parseYahooAdjusted(bars([['2025-07-03', 99]], { adj: [98] }), 'BENCH:FAKE-TR', 'USD', '2025-07-03', '200', '2025-07-09')).toEqual([]);
  });
});

describe('TRM (datos.gov.co)', () => {
  const body = [
    { valor: '4000.5', unidad: 'COP', vigenciadesde: '2025-07-04T00:00:00.000', vigenciahasta: '2025-07-07T00:00:00.000' },
    { valor: '4010', unidad: 'COP', vigenciadesde: '2025-07-08T00:00:00.000', vigenciahasta: '2025-07-08T00:00:00.000' },
    { valor: '4020', unidad: 'COP', vigenciadesde: '2025-07-09T00:00:00.000', vigenciahasta: '2025-07-09T00:00:00.000' },
  ];
  it('one row per rate on the day it takes effect (a weekend rate once), today included', () => {
    expect(parseTrm(body, '2025-07-03', '2025-07-08')).toEqual([
      { ccy: 'COP', date: '2025-07-04', perUsd: '4000.5', source: 'datos.gov.co 32sa-8pi3' },
      { ccy: 'COP', date: '2025-07-08', perUsd: '4010', source: 'datos.gov.co 32sa-8pi3' },
    ]);
  });
  it('rejects a reply that is not the series', () => {
    expect(() => parseTrm({ message: 'x' }, '2025-07-03', '2025-07-08')).toThrow(QuoteError);
  });
});

/** A small book: a US stock, a Colombian stock, a London ETF, a crypto, a stock sold long ago, three indices; COP and EUR. */
function book(): Dataset {
  const d = emptyDataset();
  d.accounts = [
    { id: 'usd', name: 'USD', ccy: 'USD' },
    { id: 'cop', name: 'COP', ccy: 'COP' },
  ];
  d.assets = [
    { id: 'US1', name: 'US One', ccy: 'USD', bucket: 'acciones_usd', pricing: 'market', symbol: 'USONE' },
    { id: 'CO1', name: 'Colombia One', ccy: 'COP', bucket: 'acciones_cop', pricing: 'market', symbol: 'COONE.CL' },
    { id: 'EU1', name: 'Euro One', ccy: 'EUR', bucket: 'acciones_usd', pricing: 'market', symbol: 'EUONE.PA' },
    { id: 'XRP', name: 'XRP', ccy: 'USD', bucket: 'cripto', pricing: 'market', symbol: 'XRP-USD' },
    { id: 'OLD', name: 'Sold', ccy: 'USD', bucket: 'acciones_usd', pricing: 'market', symbol: 'OLD' },
    { id: 'FND', name: 'Fondo', ccy: 'COP', bucket: 'fondos', pricing: 'manual' },
  ];
  d.benchmarks = [
    { symbol: 'BENCH:BTC', name: 'Bitcoin', buckets: ['cripto'] },
    { symbol: 'BENCH:QQQ-TR', name: 'Nasdaq-100 TR', buckets: ['acciones_usd'] },
    { symbol: 'BENCH:OTHER', name: 'Otro índice', buckets: ['acciones_usd'] },
  ];
  d.ledger = [
    tx('2025-01-02', 'usd', 'DEPOSIT', 10000),
    tx('2025-01-02', 'cop', 'DEPOSIT', 10000000, { ccy: 'COP' }),
    tx('2025-01-03', 'usd', 'BUY', -1000, { asset: 'US1', q: 10 }),
    tx('2025-01-03', 'usd', 'BUY', -1000, { asset: 'EU1', q: 10 }),
    tx('2025-01-03', 'usd', 'BUY', -500, { asset: 'XRP', q: 250 }),
    tx('2025-01-03', 'usd', 'BUY', -500, { asset: 'OLD', q: 5 }),
    tx('2025-02-03', 'usd', 'SELL', 600, { asset: 'OLD', q: 5 }),
    tx('2025-01-03', 'cop', 'BUY', -1000000, { asset: 'CO1', q: 100, ccy: 'COP' }),
  ].map((t, i) => toStored({ ...t, id: `t${i}` }));
  const p = (symbol: string, date: string, close: string, ccy = 'USD') => ({ symbol, date, close, ccy, source: 'yahoo' });
  d.prices = [
    p('USONE', '2025-07-03', '120'),
    p('COONE.CL', '2025-07-03', '11000', 'COP'),
    p('EUONE.PA', '2025-07-03', '95', 'EUR'),
    p('XRP-USD', '2025-07-06', '2.2'),
    p('OLD', '2025-02-03', '120'),
    p('BENCH:BTC', '2025-07-06', '100000'),
    p('BENCH:QQQ-TR', '2025-07-02', '300'),
    p('BENCH:QQQ-TR', '2025-07-03', '303.5'),
    p('BENCH:OTHER', '2025-07-03', '5000'),
  ];
  d.fx = [
    { ccy: 'COP', date: '2025-07-04', perUsd: '4000', source: 'datos.gov.co 32sa-8pi3' },
    { ccy: 'EUR', date: '2025-07-03', perUsd: '0.9', source: 'yahoo' },
  ];
  return d;
}

const TODAY = '2025-07-08'; // a Tuesday: Friday 4 and Monday 7 are completed trading days

describe('refreshPlan', () => {
  it('every series in use comes from Yahoo (any exchange) or the TRM; a sold stock and an unknown index do not', () => {
    const plan = refreshPlan(book(), TODAY);
    expect(plan.jobs).toEqual([
      { kind: 'price', provider: 'yahoo', symbol: 'USONE', yahoo: 'USONE', name: 'US One', ccy: 'USD', after: '2025-07-03' },
      { kind: 'price', provider: 'yahoo', symbol: 'COONE.CL', yahoo: 'COONE.CL', name: 'Colombia One', ccy: 'COP', after: '2025-07-03' },
      { kind: 'price', provider: 'yahoo', symbol: 'EUONE.PA', yahoo: 'EUONE.PA', name: 'Euro One', ccy: 'EUR', after: '2025-07-03' },
      { kind: 'price', provider: 'yahoo', symbol: 'XRP-USD', yahoo: 'XRP-USD', name: 'XRP', ccy: 'USD', after: '2025-07-06' },
      { kind: 'price', provider: 'yahoo', symbol: 'BENCH:BTC', yahoo: 'BTC-USD', name: 'Bitcoin', ccy: 'USD', after: '2025-07-06' },
      // An ETF's adjusted close is chained from the last stored level.
      { kind: 'price', provider: 'yahoo', symbol: 'BENCH:QQQ-TR', yahoo: 'QQQ', name: 'Nasdaq-100 TR', ccy: 'USD', after: '2025-07-03', anchor: '303.5', overlap: [{ date: '2025-07-02', close: '300' }] },
      { kind: 'fx', provider: 'trm', ccy: 'COP', after: '2025-07-04' },
      { kind: 'fx', provider: 'yahoo', ccy: 'EUR', yahoo: 'EURUSD=X', after: '2025-07-03' },
    ]);
    expect(plan.uncovered.map((u) => u.symbol)).toEqual(['BENCH:OTHER']);
  });

  it('on a Sunday, after Friday is stored, stocks and rates are current; crypto trades on weekends', () => {
    const d = book();
    d.prices = d.prices.map((p) => ({ ...p, date: p.symbol === 'XRP-USD' || p.symbol === 'BENCH:BTC' ? '2025-07-04' : p.date === '2025-07-03' ? '2025-07-04' : p.date }));
    d.fx = d.fx.map((r) => ({ ...r, date: '2025-07-04' }));
    const plan = refreshPlan(d, '2025-07-06');
    expect(plan.jobs.map((j) => (j.kind === 'price' ? j.symbol : j.ccy))).toEqual(['XRP-USD', 'BENCH:BTC', 'COP']);
    // A Monday with Friday stored is current; the Tuesday after is not.
    expect(refreshPlan(d, '2025-07-07').jobs.some((j) => j.kind === 'price' && j.symbol === 'USONE')).toBe(false);
    expect(refreshPlan(d, '2025-07-08').jobs.some((j) => j.kind === 'price' && j.symbol === 'USONE')).toBe(true);
  });

  it('asks the function for each Yahoo symbol once, from the earliest day any of its series needs', () => {
    const d = book();
    d.assets.push({ id: 'Q', name: 'QQQ ETF', ccy: 'USD', bucket: 'acciones_usd', pricing: 'market', symbol: 'QQQ' });
    d.ledger.push(toStored({ ...tx('2025-01-03', 'usd', 'BUY', -100, { asset: 'Q', q: 1 }), id: 'q' }));
    d.prices.push({ symbol: 'QQQ', date: '2025-07-03', close: '500', ccy: 'USD', source: 'yahoo' });
    const jobs = refreshPlan(d, TODAY).jobs.filter((j) => j.provider === 'yahoo' && (j.yahoo === 'QQQ' || j.yahoo === 'XRP-USD'));
    expect(jobs).toHaveLength(3);
    expect(decodeURIComponent(quotesUrl('/api/quotes', jobs))).toBe('/api/quotes?s=XRP-USD@2025-07-06&s=QQQ@2025-07-02');
  });

  it('a symbol Yahoo would not accept is listed, not sent', () => {
    const d = book();
    d.assets[0] = { ...d.assets[0]!, symbol: 'us one' };
    d.prices[0] = { ...d.prices[0]!, symbol: 'us one' };
    expect(refreshPlan(d, TODAY).uncovered.map((u) => u.symbol)).toContain('us one');
  });
});

describe('runRefresh', () => {
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

  it('asks the function a few symbols at a time; a failed call or a missing series stays with its own series', async () => {
    const plan = refreshPlan(book(), TODAY);
    const calls: string[] = [];
    const fetch = async (url: string | URL | Request) => {
      const u = decodeURIComponent(String(url));
      calls.push(u);
      if (u.startsWith('https://www.datos.gov.co/')) return reply([{ valor: '4050', unidad: 'COP', vigenciadesde: '2025-07-08T00:00:00.000', vigenciahasta: '2025-07-08T00:00:00.000' }]);
      if (u.includes('XRP-USD')) return reply({ error: 'boom' }, 500);
      return reply({
        USONE: bars([['2025-07-07', 121]], { currency: 'USD' }),
        'COONE.CL': { error: 'Yahoo Finance no tiene datos de COONE.CL (404).' },
        // EUONE.PA left out of the reply
        'BTC-USD': { currency: 'USD', timestamps: [at('2025-07-07', '00:00')], close: [101000] },
        QQQ: bars([['2025-07-03', 500], ['2025-07-07', 505]], { currency: 'USD', adj: [490, 495] }),
        'EURUSD=X': bars([['2025-07-07', 1.25]], { currency: 'USD' }),
      });
    };
    const res = await runRefresh(plan, { today: TODAY, fetch: fetch as typeof globalThis.fetch, batch: 3 });
    expect(calls.map((c) => c.replace(/\?.*/, ''))).toEqual(['/api/quotes', '/api/quotes', '/api/quotes', 'https://www.datos.gov.co/resource/32sa-8pi3.json']);
    expect(res.map((r) => [r.job.kind === 'price' ? r.job.symbol : r.job.ccy, r.prices.length + r.fx.length, r.error ?? ''])).toEqual([
      ['USONE', 1, ''],
      ['COONE.CL', 0, 'Yahoo Finance no tiene datos de COONE.CL (404).'],
      ['EUONE.PA', 0, 'El servicio de precios no devolvió esta serie.'],
      ['XRP-USD', 0, 'boom'],
      ['BENCH:BTC', 0, 'boom'],
      ['BENCH:QQQ-TR', 0, 'boom'],
      ['COP', 1, ''],
      ['EUR', 1, ''],
    ]);
  });

  it('without the function (opened elsewhere than the published site) it says where to use it', async () => {
    const plan = refreshPlan(book(), TODAY);
    const fetch = async (url: string | URL | Request) =>
      String(url).startsWith('/api') ? reply('<html>Not found</html>', 404) : reply([]);
    const res = await runRefresh(plan, { today: TODAY, fetch: fetch as typeof globalThis.fetch });
    expect(res[0]!.error).toMatch(/versión publicada/);
  });
});

describe('the /api/quotes function', () => {
  const yahoo = (symbol: string) => ({
    chart: { result: [{ meta: { currency: 'USD', symbol }, timestamp: [at('2025-07-07')], indicators: { quote: [{ close: [10] }], adjclose: [{ adjclose: [9.5] }] } }], error: null },
  });
  const noWait = async () => {};

  it('relays each symbol from its date, one at a time, and retries a rate limit once', async () => {
    const urls: string[] = [];
    let limited = false;
    const fetch = async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes('/BBB?') && !limited) {
        limited = true;
        return new Response('Too Many Requests', { status: 429 });
      }
      if (String(url).includes('/NOPE?')) return Response.json({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }, { status: 404 });
      return Response.json(yahoo(decodeURIComponent(String(url).split('/chart/')[1]!.split('?')[0]!)));
    };
    const res = await handle(new Request('https://site/api/quotes?s=AAA@2025-07-03&s=BBB@2025-07-01&s=NOPE@2025-07-01&s=%5ESP500TR@2025-07-03'), fetch as typeof globalThis.fetch, noWait);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.AAA).toEqual({ currency: 'USD', timestamps: [at('2025-07-07')], close: [10], adjclose: [9.5] });
    expect(body.BBB.close).toEqual([10]);
    expect(body.NOPE).toEqual({ error: 'No data found, symbol may be delisted' });
    expect(body['^SP500TR'].close).toEqual([10]);
    expect(urls.filter((u) => u.includes('/BBB?'))).toHaveLength(2);
    expect(urls[0]).toContain(`/chart/AAA?period1=${Date.parse('2025-07-03T00:00:00Z') / 1000}&`);
    expect(urls[0]).toContain('includeAdjustedClose=true');
  });

  it('passes on the exchange time zone and the splits', async () => {
    const fetch = (async () =>
      Response.json({
        chart: { result: [{ meta: { currency: 'EUR', exchangeTimezoneName: 'Europe/Paris' }, events: { splits: { '1': { date: 1751876400, numerator: 2, denominator: 1 } } }, timestamp: [1751876400], indicators: { quote: [{ close: [5] }] } }] },
      })) as typeof globalThis.fetch;
    const body = await (await handle(new Request('https://site/api/quotes?s=FAKE.PA@2025-07-01'), fetch, noWait)).json();
    expect(body['FAKE.PA']).toEqual({ currency: 'EUR', timezone: 'Europe/Paris', splits: [1751876400], timestamps: [1751876400], close: [5] });
  });

  it('only relays well-formed symbols (a bad one fails alone), by GET, for the app itself', async () => {
    const never = (async () => {
      throw new Error('should not fetch');
    }) as typeof globalThis.fetch;
    const bad = await (await handle(new Request('https://site/api/quotes?s=https://evil@2025-07-03&s=AAA@yesterday'), never, noWait)).json();
    expect(Object.values(bad)).toEqual([{ error: 'Símbolo o fecha inválidos: https://evil@2025-07-03' }, { error: 'Símbolo o fecha inválidos: AAA@yesterday' }]);
    const other = new Request('https://site/api/quotes?s=AAA@2025-07-03', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect((await handle(other, never, noWait)).status).toBe(403);
    expect((await handle(new Request('https://site/api/quotes'), never, noWait)).status).toBe(400);
    const many = Array.from({ length: 11 }, (_, i) => `s=S${i}@2025-07-03`).join('&');
    expect((await handle(new Request(`https://site/api/quotes?${many}`), never, noWait)).status).toBe(400);
    expect((await handle(new Request('https://site/api/quotes?s=AAA@2025-07-03', { method: 'POST' }), never, noWait)).status).toBe(405);
  });
});

describe('applyRefresh', () => {
  const ok = (rows: Partial<JobResult>): JobResult => ({ job: { kind: 'fx', provider: 'trm', ccy: 'COP', after: '2025-07-04' }, prices: [], fx: [], ...rows });

  it('adds only new days, leaves out rows that fail the import checks and flags jumps', () => {
    const d = book();
    const r = applyRefresh(
      d,
      [
        ok({
          prices: [
            { symbol: 'USONE', date: '2025-07-03', close: '999', ccy: 'USD', source: 'yahoo' }, // already stored: never replaced
            { symbol: 'USONE', date: '2025-07-07', close: '121', ccy: 'USD', source: 'yahoo' },
            { symbol: 'USONE', date: '2025-07-08', close: '400', ccy: 'USD', source: 'yahoo' }, // jump: added, flagged
            { symbol: 'XRP-USD', date: '2025-07-07', close: '2.3', ccy: 'EUR', source: 'yahoo' }, // wrong currency: left out
          ],
          fx: [{ ccy: 'COP', date: '2025-07-08', perUsd: '4050', source: 'datos.gov.co 32sa-8pi3' }],
        }),
      ],
      TODAY,
    );
    expect(r.prices).toBe(2);
    expect(r.fx).toBe(1);
    expect(r.added).toEqual([{ count: 3, last: '2025-07-08' }]);
    expect(r.rejected.map((f) => f.code)).toEqual(['CCY']);
    expect(r.warnings.map((f) => f.code)).toEqual(['JUMP']);
    expect(r.next.prices.find((p) => p.symbol === 'USONE' && p.date === '2025-07-03')!.close).toBe('120');
  });

  it('a series stops at its first rejected row, so the gap is asked for again next time', () => {
    const row = (date: string, close: string) => ({ symbol: 'USONE', date, close, ccy: 'USD', source: 'yahoo' });
    const r = applyRefresh(book(), [ok({ prices: [row('2025-07-04', '121'), row('2025-07-07', '0'), row('2025-07-08', '122')] })], TODAY);
    expect(r.next.prices.filter((p) => p.symbol === 'USONE').map((p) => p.date)).toEqual(['2025-07-03', '2025-07-04']);
    expect(r.added).toEqual([{ count: 1, last: '2025-07-04' }]);
    expect(r.rejected.map((f) => f.code)).toEqual(['CLOSE']);
  });

  it('nothing new leaves the dataset untouched (same object: no save, no sync)', () => {
    const d = book();
    expect(applyRefresh(d, [ok({})], TODAY).next).toBe(d);
  });
});
