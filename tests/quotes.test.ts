import { describe, expect, it } from 'vitest';
import { emptyDataset, toStored } from '../src/data/json.ts';
import type { Dataset } from '../src/data/json.ts';
import { QuoteError, fxPair, parseCoinGecko, parseTrm, parseTwelveDataFx, parseTwelveDataSeries } from '../src/data/quotes.ts';
import { applyRefresh, jobUrl, refreshPlan, runRefresh } from '../src/app/refresh.ts';
import type { JobResult } from '../src/app/refresh.ts';
import { tx } from './helpers.ts';

// Synthetic replies in the real formats of each API (made-up tickers and values).
const td = (values: { datetime: string; close: string }[], currency = 'USD') => ({
  meta: { symbol: 'FAKE', interval: '1day', currency, exchange_timezone: 'America/New_York' },
  values: values.map((v) => ({ ...v, open: '1', high: '1', low: '1', volume: '100' })),
  status: 'ok',
});

describe('Twelve Data', () => {
  it('keeps completed days after the last stored one, closes as exact decimals', () => {
    const rows = parseTwelveDataSeries(
      td([
        { datetime: '2025-07-08', close: '10.00000' },
        { datetime: '2025-07-09', close: '10.25000' },
        { datetime: '2025-07-10', close: '10.50000' },
        { datetime: '2025-07-11', close: '10.75000' },
      ]),
      'FAKE',
      'USD',
      '2025-07-08',
      '2025-07-11',
    );
    expect(rows).toEqual([
      { symbol: 'FAKE', date: '2025-07-09', close: '10.25', ccy: 'USD', source: 'twelvedata' },
      { symbol: 'FAKE', date: '2025-07-10', close: '10.5', ccy: 'USD', source: 'twelvedata' },
    ]);
  });

  it('rejects a quote in another currency and reads its error replies', () => {
    expect(() => parseTwelveDataSeries(td([], 'EUR'), 'FAKE', 'USD', '2025-01-01', '2025-02-01')).toThrow(/en EUR, no en USD/);
    expect(parseTwelveDataSeries({ code: 400, message: 'No data is available on the specified dates. Try setting different start/end dates.', status: 'error' }, 'FAKE', 'USD', '2025-01-01', '2025-02-01')).toEqual([]);
    expect(() => parseTwelveDataSeries({ code: 401, message: '**apikey** parameter is incorrect', status: 'error' }, 'FAKE', 'USD', '2025-01-01', '2025-02-01')).toThrow(/clave/);
    try {
      parseTwelveDataSeries({ code: 429, message: 'You have run out of API credits for the current minute.', status: 'error' }, 'FAKE', 'USD', '2025-01-01', '2025-02-01');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QuoteError);
      expect((e as QuoteError).retry).toBe(true);
    }
  });

  it('stores forex as units per USD: EUR/USD is inverted, USD/CAD is not', () => {
    expect(fxPair('EUR')).toEqual({ pair: 'EUR/USD', inverted: true });
    expect(fxPair('CAD')).toEqual({ pair: 'USD/CAD', inverted: false });
    expect(parseTwelveDataFx(td([{ datetime: '2025-07-09', close: '1.25000' }]), 'EUR', '2025-07-08', '2025-07-10')).toEqual([
      { ccy: 'EUR', date: '2025-07-09', perUsd: '0.8', source: 'twelvedata' },
    ]);
    expect(parseTwelveDataFx(td([{ datetime: '2025-07-09', close: '1.36500' }]), 'CAD', '2025-07-08', '2025-07-10')[0]!.perUsd).toBe('1.365');
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

describe('CoinGecko', () => {
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
  it('the 00:00 UTC point is the close of the day before; the live last point is dropped', () => {
    const body = { prices: [[day('2025-07-08'), 2.1], [day('2025-07-09'), 2.2], [day('2025-07-10'), 2.3], [day('2025-07-10') + 3_600_000, 2.35]] };
    expect(parseCoinGecko(body, 'FAKE-USD', '2025-07-07', '2025-07-10')).toEqual([
      { symbol: 'FAKE-USD', date: '2025-07-08', close: '2.2', ccy: 'USD', source: 'coingecko' },
      { symbol: 'FAKE-USD', date: '2025-07-09', close: '2.3', ccy: 'USD', source: 'coingecko' },
    ]);
  });
  it('a rate-limit reply can be retried', () => {
    try {
      parseCoinGecko({ status: { error_code: 429, error_message: 'rate limit' } }, 'FAKE-USD', '2025-07-07', '2025-07-10');
      expect.unreachable();
    } catch (e) {
      expect((e as QuoteError).retry).toBe(true);
    }
  });
});

/** A small book: a US stock, a Colombian stock, a London ETF, a crypto, a stock sold long ago, two indices; COP and EUR. */
function book(): Dataset {
  const d = emptyDataset();
  d.accounts = [
    { id: 'usd', name: 'USD', ccy: 'USD' },
    { id: 'cop', name: 'COP', ccy: 'COP' },
  ];
  d.assets = [
    { id: 'US1', name: 'US One', ccy: 'USD', bucket: 'acciones_usd', pricing: 'market', symbol: 'USONE' },
    { id: 'CO1', name: 'Colombia One', ccy: 'COP', bucket: 'acciones_cop', pricing: 'market', symbol: 'COONE.CL' },
    { id: 'LN1', name: 'London ETF', ccy: 'USD', bucket: 'acciones_usd', pricing: 'market', symbol: 'LNONE.L' },
    { id: 'EU1', name: 'Euro One', ccy: 'EUR', bucket: 'acciones_usd', pricing: 'market', symbol: 'EUONE.PA' },
    { id: 'XRP', name: 'XRP', ccy: 'USD', bucket: 'cripto', pricing: 'market', symbol: 'XRP-USD' },
    { id: 'OLD', name: 'Sold', ccy: 'USD', bucket: 'acciones_usd', pricing: 'market', symbol: 'OLD' },
    { id: 'FND', name: 'Fondo', ccy: 'COP', bucket: 'fondos', pricing: 'manual' },
  ];
  d.benchmarks = [
    { symbol: 'BENCH:BTC', name: 'Bitcoin', buckets: ['cripto'] },
    { symbol: 'BENCH:SP-TR', name: 'S&P TR', buckets: ['acciones_usd'] },
  ];
  d.ledger = [
    tx('2025-01-02', 'usd', 'DEPOSIT', 10000),
    tx('2025-01-02', 'cop', 'DEPOSIT', 10000000, { ccy: 'COP' }),
    tx('2025-01-03', 'usd', 'BUY', -1000, { asset: 'US1', q: 10 }),
    tx('2025-01-03', 'usd', 'BUY', -1000, { asset: 'LN1', q: 10 }),
    tx('2025-01-03', 'usd', 'BUY', -1000, { asset: 'EU1', q: 10 }),
    tx('2025-01-03', 'usd', 'BUY', -500, { asset: 'XRP', q: 250 }),
    tx('2025-01-03', 'usd', 'BUY', -500, { asset: 'OLD', q: 5 }),
    tx('2025-02-03', 'usd', 'SELL', 600, { asset: 'OLD', q: 5 }),
    tx('2025-01-03', 'cop', 'BUY', -1000000, { asset: 'CO1', q: 100, ccy: 'COP' }),
  ].map((t, i) => toStored({ ...t, id: `t${i}` }));
  const p = (symbol: string, date: string, close: string, ccy = 'USD') => ({ symbol, date, close, ccy, source: 'test' });
  d.prices = [p('USONE', '2025-07-03', '120'), p('COONE.CL', '2025-07-03', '11000', 'COP'), p('LNONE.L', '2025-07-03', '105'), p('EUONE.PA', '2025-07-03', '95', 'EUR'), p('XRP-USD', '2025-07-06', '2.2'), p('OLD', '2025-02-03', '120'), p('BENCH:BTC', '2025-07-06', '100000'), p('BENCH:SP-TR', '2025-07-03', '5000')];
  d.fx = [
    { ccy: 'COP', date: '2025-07-04', perUsd: '4000', source: 'test' },
    { ccy: 'EUR', date: '2025-07-03', perUsd: '0.9', source: 'test' },
  ];
  return d;
}

const TODAY = '2025-07-08'; // a Tuesday: Friday 4 and Monday 7 are completed trading days

describe('refreshPlan', () => {
  it('each series in use goes to the source that covers it; the rest is listed with why', () => {
    const plan = refreshPlan(book(), TODAY, true);
    expect(plan.jobs).toEqual([
      { kind: 'price', provider: 'twelvedata', symbol: 'USONE', name: 'US One', ccy: 'USD', after: '2025-07-03' },
      { kind: 'price', provider: 'coingecko', symbol: 'XRP-USD', name: 'XRP', ccy: 'USD', after: '2025-07-06' },
      { kind: 'price', provider: 'coingecko', symbol: 'BENCH:BTC', name: 'Bitcoin', ccy: 'USD', after: '2025-07-06' },
      { kind: 'fx', provider: 'trm', ccy: 'COP', after: '2025-07-04' },
      { kind: 'fx', provider: 'twelvedata', ccy: 'EUR', after: '2025-07-03' },
    ]);
    expect(plan.uncovered.map((u) => [u.symbol, u.reason.split(':')[0]])).toEqual([
      ['COONE.CL', 'Bolsa de Colombia'],
      ['LNONE.L', 'Bolsa de Londres'],
      ['EUONE.PA', 'Euronext París'],
      ['BENCH:SP-TR', 'Índice de retorno total'],
    ]);
    // A stock sold long ago is not refreshed.
    expect(plan.jobs.some((j) => j.kind === 'price' && j.symbol === 'OLD')).toBe(false);
  });

  it('without the Twelve Data key those series wait for it; sources without a key still run', () => {
    const plan = refreshPlan(book(), TODAY, false);
    expect(plan.jobs.map((j) => j.provider)).toEqual(['coingecko', 'coingecko', 'trm']);
    expect(plan.uncovered.filter((u) => /clave/.test(u.reason)).map((u) => u.symbol)).toEqual(['USONE', 'EUR/USD']);
  });

  it('on a Sunday, after Friday is stored, stocks and forex are current; crypto and the TRM are not', () => {
    const d = book();
    d.prices = d.prices.map((p) => ({ ...p, date: p.symbol === 'XRP-USD' || p.symbol === 'BENCH:BTC' ? p.date : '2025-07-04' }));
    d.fx = d.fx.map((r) => ({ ...r, date: '2025-07-04' }));
    const plan = refreshPlan(d, '2025-07-06', true);
    expect(plan.jobs.map((j) => (j.kind === 'price' ? j.symbol : j.ccy))).toEqual(['COP']);
    expect(plan.current).toBe(4);
  });

  it('asks each API for the days after the last stored one', () => {
    const [us, xrp, btc, trm, eur] = refreshPlan(book(), TODAY, true).jobs;
    expect(jobUrl(us!, TODAY, 'k')).toBe('https://api.twelvedata.com/time_series?symbol=USONE&interval=1day&start_date=2025-07-04&end_date=2025-07-08&order=ASC&outputsize=5000&apikey=k');
    expect(jobUrl(eur!, TODAY, 'k')).toContain('symbol=EUR%2FUSD');
    expect(jobUrl(xrp!, TODAY, 'k')).toBe('https://api.coingecko.com/api/v3/coins/ripple/market_chart?vs_currency=usd&days=3&interval=daily');
    expect(jobUrl(btc!, TODAY, 'k')).toContain('/coins/bitcoin/');
    expect(decodeURIComponent(jobUrl(trm!, TODAY, 'k'))).toContain("vigenciadesde+>+'2025-07-04T00:00:00.000'");
  });
});

describe('runRefresh', () => {
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

  it('paces Twelve Data to its per-minute limit, retries a rate limit once and keeps failures per series', async () => {
    const plan = refreshPlan(book(), TODAY, true);
    let clock = 0;
    const waits: number[] = [];
    const seen: string[] = [];
    let limited = false;
    const fetch = async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      if (u.includes('symbol=USONE')) return reply(td([{ datetime: '2025-07-07', close: '121' }]));
      if (u.includes('EUR%2FUSD')) {
        if (!limited) {
          limited = true;
          return reply({ code: 429, message: 'You have run out of API credits for the current minute.', status: 'error' }, 429);
        }
        return reply(td([{ datetime: '2025-07-07', close: '1.25' }]));
      }
      if (u.includes('ripple')) throw new TypeError('Failed to fetch');
      if (u.includes('bitcoin')) return reply({ prices: [[Date.parse('2025-07-08T00:00:00Z'), 101000]] });
      return reply([{ valor: '4050', unidad: 'COP', vigenciadesde: '2025-07-08T00:00:00.000', vigenciahasta: '2025-07-08T00:00:00.000' }]);
    };
    const res = await runRefresh(plan, {
      key: 'k',
      today: TODAY,
      fetch: fetch as typeof globalThis.fetch,
      perMinute: 1,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    expect(res.map((r) => [r.job.kind === 'price' ? r.job.symbol : r.job.ccy, r.prices.length + r.fx.length, r.error ?? ''])).toEqual([
      ['USONE', 1, ''],
      ['XRP-USD', 0, 'No se pudo conectar con CoinGecko (sin internet, o la fuente no acepta consultas desde el navegador).'],
      ['BENCH:BTC', 1, ''],
      ['COP', 1, ''],
      ['EUR', 1, ''],
    ]);
    // One call a minute: EUR waits out the minute of USONE's call (at 0 s), then 61 s after its rate limit;
    // by then that minute is over, so the retry goes straight out.
    expect(waits).toEqual([60_500, 61_000]);
    expect(seen.filter((u) => u.includes('EUR%2FUSD'))).toHaveLength(2);
  });
});

describe('limits and coverage edge cases', () => {
  it('the daily Twelve Data limit is not retried; the per-minute one is', () => {
    const daily = { code: 429, message: 'You have run out of API credits for the day. 800 API credits were used.', status: 'error' };
    try {
      parseTwelveDataSeries(daily, 'FAKE', 'USD', '2025-01-01', '2025-02-01');
      expect.unreachable();
    } catch (e) {
      expect((e as QuoteError).retry).toBe(false);
      expect((e as QuoteError).message).toMatch(/diarias/);
    }
  });

  it('a Monday with Friday stored is current; the Tuesday after is not', () => {
    const d = book();
    d.prices = d.prices.map((p) => (p.symbol === 'USONE' ? { ...p, date: '2025-07-04' } : p));
    const due = (today: string) => refreshPlan(d, today, true).jobs.some((j) => j.kind === 'price' && j.symbol === 'USONE');
    expect(due('2025-07-07')).toBe(false);
    expect(due('2025-07-08')).toBe(true);
  });

  it('CoinGecko only serves a year: an older gap says what is missing', async () => {
    const d = book();
    d.prices = d.prices.map((p) => (p.symbol === 'XRP-USD' ? { ...p, date: '2024-01-01' } : p));
    const plan = refreshPlan(d, TODAY, false);
    const xrp = plan.jobs.find((j) => j.kind === 'price' && j.symbol === 'XRP-USD')!;
    expect(jobUrl(xrp, TODAY, '')).toContain('days=365');
    const res = await runRefresh(
      { ...plan, jobs: [xrp] },
      { key: '', today: TODAY, fetch: (async () => ({ ok: true, status: 200, json: async () => ({ prices: [[Date.parse('2024-07-09T00:00:00Z'), 0.5], [Date.parse('2024-07-10T00:00:00Z'), 0.51]] }) })) as unknown as typeof fetch },
    );
    expect(res[0]!.prices.map((p) => p.date)).toEqual(['2024-07-08', '2024-07-09']);
    expect(res[0]!.note).toBe('CoinGecko solo da el último año: faltan los días del 2024-01-02 al 2024-07-07.');
  });

  it('a crypto quoted in another currency, an unknown coin and a coin index with no series are listed, not guessed', () => {
    const d = book();
    d.assets.push({ id: 'X1', name: 'XRP en COP', ccy: 'COP', bucket: 'cripto', pricing: 'market', symbol: 'ETH-USD' });
    d.assets.push({ id: 'X2', name: 'Moneda rara', ccy: 'USD', bucket: 'cripto', pricing: 'market', symbol: 'RARE-USD' });
    d.ledger.push(toStored({ ...tx('2025-01-03', 'usd', 'BUY', -10, { asset: 'X2', q: 1 }), id: 'x2' }), toStored({ ...tx('2025-01-03', 'cop', 'BUY', -10, { asset: 'X1', q: 1, ccy: 'COP' }), id: 'x1' }));
    d.prices = d.prices.filter((p) => p.symbol !== 'BENCH:BTC');
    const reasons = Object.fromEntries(refreshPlan(d, TODAY, true).uncovered.map((u) => [u.symbol, u.reason]));
    expect(reasons['ETH-USD']).toMatch(/en USD y el activo cotiza en COP/);
    expect(reasons['RARE-USD']).toMatch(/no sabe buscar en CoinGecko/);
    expect(reasons['BENCH:BTC']).toMatch(/ninguna serie guardada/);
  });

  it('a CoinGecko rate limit is retried once after a minute', async () => {
    const plan = refreshPlan(book(), TODAY, false);
    const btc = plan.jobs.find((j) => j.kind === 'price' && j.symbol === 'BENCH:BTC')!;
    let calls = 0;
    const waits: number[] = [];
    const res = await runRefresh(
      { ...plan, jobs: [btc] },
      {
        key: '',
        today: TODAY,
        sleep: async (ms) => void waits.push(ms),
        fetch: (async () => {
          calls++;
          const body = calls === 1 ? { status: { error_code: 429, error_message: 'rate limit' } } : { prices: [[Date.parse('2025-07-08T00:00:00Z'), 101000]] };
          return { ok: calls > 1, status: calls === 1 ? 429 : 200, json: async () => body };
        }) as unknown as typeof fetch,
      },
    );
    expect(calls).toBe(2);
    expect(waits).toEqual([61_000]);
    expect(res[0]!.prices.map((p) => p.date)).toEqual(['2025-07-07']);
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
            { symbol: 'USONE', date: '2025-07-03', close: '999', ccy: 'USD', source: 'twelvedata' }, // already stored: never replaced
            { symbol: 'USONE', date: '2025-07-07', close: '121', ccy: 'USD', source: 'twelvedata' },
            { symbol: 'USONE', date: '2025-07-08', close: '400', ccy: 'USD', source: 'twelvedata' }, // jump: added, flagged
            { symbol: 'XRP-USD', date: '2025-07-07', close: '2.3', ccy: 'EUR', source: 'coingecko' }, // wrong currency: left out
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
    expect(r.next.prices.filter((p) => p.symbol === 'USONE').map((p) => p.date)).toEqual(['2025-07-03', '2025-07-07', '2025-07-08']);
  });

  it('a series stops at its first rejected row, so the gap is asked for again next time', () => {
    const row = (date: string, close: string) => ({ symbol: 'USONE', date, close, ccy: 'USD', source: 'twelvedata' });
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
