import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLedgerCsv } from '../src/data/csv.ts';
import { parseBook, parseFx, parsePrices } from '../src/data/load.ts';
import { dec } from '../src/domain/money.ts';
import { FxTable } from '../src/domain/fx.ts';
import { SeriesPriceSource } from '../src/domain/prices.ts';
import { portfolioSeries } from '../src/domain/portfolio.ts';
import { performance } from '../src/domain/returns.ts';
import { seriesDates } from '../src/app/analysis.ts';
import { tracking, xirrToDate, yearToDate } from '../src/app/tracking.ts';
import { accounts, assets, tx } from './helpers.ts';

const px = (date: string, close: number) => ({ date, close: dec(close), ccy: 'USD', source: 'test' });

describe('month-by-month tracking, hand-verified', () => {
  const ctx = {
    book: { accounts, assets, prices: new SeriesPriceSource().set('AAA', [px('2025-01-31', 110), px('2025-02-28', 99)]), fx: new FxTable() },
    ledger: [
      tx('2025-01-01', 'usd', 'DEPOSIT', 2000),
      tx('2025-01-16', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }),
      tx('2025-02-10', 'usd', 'DIVIDEND', 20, { asset: 'AAA' }),
    ],
    benchmarks: [],
  };
  const t = tracking(ctx, 'USD', '2025-02-28');
  const aaa = t.assets.find((r) => r.id === 'usd|AAA')!;

  it('a buy inside the month: gain over the money put in (full weight when the row starts that month)', () => {
    expect(t.months).toEqual(['2025-01-31', '2025-02-28']);
    const c = aaa.cells[0]!;
    expect(c.value.toNumber()).toBe(1100);
    expect(c.flow.toNumber()).toBe(1000);
    expect(c.gain.toNumber()).toBe(100);
    expect(c.r).toBeCloseTo(0.1, 12);
  });

  it('a dividend is part of the month result and a Modified Dietz outflow', () => {
    const c = aaa.cells[1]!;
    expect(c.value.toNumber()).toBe(990);
    expect(c.flow.toNumber()).toBe(-20);
    expect(c.gain.toNumber()).toBe(-90); // 990 − 1100 + 20
    expect(c.r).toBeCloseTo(-90 / (1100 - (20 * 18) / 28), 12);
  });

  it('total counts only deposits and withdrawals; cash carries the rest', () => {
    expect(t.total.cells.map((c) => c.value.toNumber())).toEqual([2100, 2010]);
    expect(t.total.cells[0]!.r).toBeCloseTo(0.05, 12);
    expect(t.total.cells[1]!.r).toBeCloseTo(-90 / 2100, 12);
    expect(t.cash.cells.map((c) => c.value.toNumber())).toEqual([1000, 1020]);
    expect(t.cash.cells.map((c) => c.gain.toNumber())).toEqual([0, 0]);
  });

  it('year to date chains the monthly returns', () => {
    expect(yearToDate(t.total, t.months, 1)).toBeCloseTo(1.05 * (1 - 90 / 2100) - 1, 12);
  });

  it('stops at the last month it can value and says why', () => {
    const cop = tracking(ctx, 'COP', '2025-02-28');
    expect(cop.months).toEqual([]);
    expect(cop.error).toMatch(/COP/);
  });
});

const read = (f: string) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
const book = parseBook(read('book.json'));
const sample = { book: { ...book, prices: parsePrices(read('prices.csv')), fx: parseFx(read('fx.csv')) }, ledger: parseLedgerCsv(read('ledger.csv')), benchmarks: book.benchmarks };

describe('tracking on the synthetic sample', () => {
  const t = tracking(sample, 'COP', '2025-06-30');
  const last = t.months.length - 1;

  it('covers every month-end and adds up: classes + cash = total = subtotal + real estate', () => {
    expect(t.error).toBeUndefined();
    expect(t.months[0]).toBe('2025-01-31');
    expect(t.months[last]).toBe('2025-06-30');
    const re = t.classes.find((c) => c.bucket === 'inmobiliario')!;
    for (let m = 0; m <= last; m++) {
      for (const k of ['value', 'gain', 'flow'] as const) {
        const classes = t.classes.reduce((a, c) => a.plus(c.cells[m]![k]), dec(0)).plus(t.cash.cells[m]![k]);
        expect(classes.minus(t.total.cells[m]![k]).abs().lt(1e-6)).toBe(true);
        expect(t.exRealEstate.cells[m]![k].plus(re.cells[m]![k]).minus(t.total.cells[m]![k]).abs().lt(1e-6)).toBe(true);
      }
      for (const c of t.classes) {
        const assetsSum = t.assets.filter((a) => a.bucket === c.bucket).reduce((a, r) => a.plus(r.cells[m]!.value), dec(0));
        expect(assetsSum.minus(c.cells[m]!.value).abs().lt(1e-6)).toBe(true);
      }
    }
  });

  it('total values, chained TWR and XIRR match the engine', () => {
    const s = portfolioSeries(sample.book, sample.ledger, { kind: 'total' }, 'COP', seriesDates('2024-12-31', '2025-06-30'));
    const p = performance(s, '2024-12-31', '2025-06-30');
    t.months.forEach((d, m) => expect(t.total.cells[m]!.value.eq(s.values.find((v) => v.date === d)!.value)).toBe(true));
    expect(yearToDate(t.total, t.months, last)).toBeCloseTo(p.twr, 12);
    expect(xirrToDate(t.total, t.months, last)).toBeCloseTo(p.xirr!, 9);
  });

  it('a class matches the engine for that bucket', () => {
    const s = portfolioSeries(sample.book, sample.ledger, { kind: 'bucket', bucket: 'acciones_usd' }, 'COP', seriesDates('2024-12-31', '2025-06-30'));
    const p = performance(s, '2024-12-31', '2025-06-30');
    const usd = t.classes.find((c) => c.bucket === 'acciones_usd')!;
    expect(usd.cells[last]!.value.eq(p.endValue)).toBe(true);
    expect(yearToDate(usd, t.months, last)).toBeCloseTo(p.twr, 12);
    expect(xirrToDate(usd, t.months, last)).toBeCloseTo(p.xirr!, 9);
  });
});
