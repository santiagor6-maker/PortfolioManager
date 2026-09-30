import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applySec, runSec, secDue, secTargets } from '../src/app/fundamentals.ts';
import { withSec } from '../src/app/indicators.ts';
import { parseLedgerCsv } from '../src/data/csv.ts';
import { readFxRows, readPriceRows } from '../src/data/load.ts';
import { emptyDataset, toStored } from '../src/data/json.ts';
import type { Dataset } from '../src/data/json.ts';
import type { SecFactsReply } from '../src/data/sec.ts';
import { dec } from '../src/domain/money.ts';
import type { SecData } from '../src/domain/types.ts';

const read = (f: string) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');

/** The synthetic sample as the app stores it: SMPL and ACME are US stocks held, ANDES is Colombian, COPY-TECH manual. */
function sample(): Dataset {
  const b = JSON.parse(read('book.json'));
  return {
    ...emptyDataset(),
    accounts: b.accounts,
    assets: b.assets,
    benchmarks: b.benchmarks,
    ledger: parseLedgerCsv(read('ledger.csv')).map((t, i) => toStored({ ...t, id: `s${i}` })),
    prices: readPriceRows(read('prices.csv')),
    fx: readFxRows(read('fx.csv')),
  };
}

const TODAY = '2025-07-10';
const M = 1e6;
const fact = (start: string | undefined, end: string, val: number, form = '10-K') => ({ ...(start ? { start } : {}), end, val, form, filed: '2025-02-10', accn: '0000000001-25-000001' });
const reply = (revenue: number, netIncome: number): SecFactsReply => ({
  cik: 1,
  entity: 'Sample Corp',
  facts: { 'us-gaap': { Revenues: { USD: [fact('2024-01-01', '2024-12-31', revenue)] }, NetIncomeLoss: { USD: [fact('2024-01-01', '2024-12-31', netIncome)] } } },
});
const answer = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

describe('SEC fundamentals in the app', () => {
  it('reads the US stocks held, market-priced in USD, once a month', () => {
    const d = sample();
    expect(secTargets(d, TODAY).map((t) => t.ticker)).toEqual(['SMPL', 'ACME']);
    const read: SecData = { asOf: '2025-07-01', error: 'x' };
    const withRead = { ...d, assets: d.assets.map((a) => (a.id === 'SMPL' ? { ...a, sec: read } : a)) };
    expect(secDue(withRead, TODAY).map((t) => t.ticker)).toEqual(['ACME']);
    expect(secDue(withRead, '2025-08-01').map((t) => t.ticker)).toEqual(['SMPL', 'ACME']);
  });

  it('keeps what it had when a read fails, remembers a symbol the SEC does not list, and lists what changed', async () => {
    const d = sample();
    const targets = secTargets(d, TODAY);
    const first = await runSec(targets, {
      today: TODAY,
      fetch: answer({ SMPL: reply(1000 * M, 100 * M), ACME: { error: 'La SEC no tiene una empresa con el símbolo ACME (los ETF…).' } }),
    });
    const a1 = applySec(d, first);
    expect(a1.updated).toBe(2);
    expect(a1.changes).toEqual([]); // the first read is not a change
    const smpl = a1.next.assets.find((a) => a.id === 'SMPL')!;
    expect(smpl.sec).toMatchObject({ asOf: TODAY, period: '2024-12-31', entity: 'Sample Corp' });
    expect(smpl.fundamentals).toEqual(d.assets.find((a) => a.id === 'SMPL')!.fundamentals); // the hand copy is untouched
    expect(a1.next.assets.find((a) => a.id === 'ACME')!.sec).toEqual({ asOf: TODAY, error: 'La SEC no tiene una empresa con el símbolo ACME (los ETF…).' });

    // A month later: SMPL's net margin moved (a restatement), ACME's service is down.
    const second = await runSec(targets, { today: '2025-08-02', fetch: answer({ SMPL: reply(1000 * M, 120 * M), ACME: { error: 'La SEC respondió 503.' } }) });
    const a2 = applySec(a1.next, second);
    expect(a2.changes).toEqual([{ asset: 'SMPL', name: smpl.name, field: 'netMargin', before: '0.1', after: '0.12' }]);
    expect(a2.failed.map((o) => [o.target.ticker, o.error])).toEqual([['ACME', 'La SEC respondió 503.']]);
    expect(a2.next.assets.find((a) => a.id === 'ACME')!.sec!.asOf).toBe(TODAY);

    // Off the published site the function is not there: every stock fails and nothing is stored.
    const off = await runSec(targets, { today: TODAY, fetch: answer({}, 404) });
    expect(off.every((o) => o.error?.includes('versión publicada'))).toBe(true);
    expect(applySec(d, off).next).toBe(d);
  });

  it('shows the SEC figures over the hand-copied ones only where the filings give them', () => {
    const sec = { asOf: TODAY, cik: 1, entity: 'Sample Corp', taxonomy: 'us-gaap', currency: 'USD', period: '2024-12-31', values: {}, gaps: {} } satisfies SecData;
    const parsed: SecData = {
      ...sec,
      values: {
        revenue: { value: String(1000 * M), concept: 'Revenues', form: '10-K', start: '2024-01-01', end: '2024-12-31', filed: '2025-02-10', accn: 'x' },
        netIncome: { value: String(100 * M), concept: 'NetIncomeLoss', form: '10-K', start: '2024-01-01', end: '2024-12-31', filed: '2025-02-10', accn: 'x' },
      },
    };
    const manual = { netMargin: '0.3', roic: '0.2', stars: 4, asOf: '2024-06-30', source: 'Morningstar' };
    const r = withSec(manual, parsed, 'USD', { date: TODAY, close: dec(50), ccy: 'USD', source: 'demo' }, TODAY);
    expect(r.f).toMatchObject({ netMargin: '0.1', roic: '0.2', stars: 4 });
    expect(r.sec!.fields).toEqual(['netMargin']);
    expect(r.manual).toBe(manual);
    expect(withSec(manual, { asOf: TODAY, error: 'ETF' }, 'USD', undefined, TODAY)).toEqual({ f: manual, manual });
  });
});
