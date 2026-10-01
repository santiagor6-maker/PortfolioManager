import { describe, expect, it } from 'vitest';
import { dec } from '../src/domain/money.ts';
import { FxTable } from '../src/domain/fx.ts';
import { SeriesPriceSource } from '../src/domain/prices.ts';
import { combineRows, tracking, yearToDate } from '../src/app/tracking.ts';
import type { Cell, TrackRow } from '../src/app/tracking.ts';
import { gainBridge, levelSeriesRisk, returnsByYear, riskOf } from '../src/app/insights.ts';
import { accounts, assets, tx } from './helpers.ts';

const px = (date: string, close: number) => ({ date, close: dec(close), ccy: 'USD', source: 'test' });

// Same hand-verified case as tracking.test.ts: total 2100 at the end of January (deposit 2000, +100),
// 2010 at the end of February (−90 on the stock, the dividend stays in cash).
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
const feb = -90 / 2100;

describe('insights on the month-by-month tracking', () => {
  it('the classes plus cash add back up to the total, returns included', () => {
    const all = combineRows([...t.classes, t.cash], 'mix', 'Todo');
    expect(all.cells.map((c) => c.value.toNumber())).toEqual([2100, 2010]);
    expect(all.cells.map((c) => c.gain.toNumber())).toEqual([100, -90]);
    all.cells.forEach((c, m) => expect(c.r).toBeCloseTo(t.total.cells[m]!.r!, 12));
  });

  it('a selection of one class keeps that class figures', () => {
    const usd = combineRows(t.classes.filter((c) => c.bucket === 'acciones_usd'), 'mix', 'USD');
    expect(usd.cells.map((c) => c.value.toNumber())).toEqual([1100, 990]);
    expect(usd.cells[1]!.r).toBeCloseTo(t.classes[0]!.cells[1]!.r!, 12);
  });

  it('returns by year: one slot per month, the year chained like year-to-date', () => {
    const [y] = returnsByYear(t.total, t.months);
    expect(y!.year).toBe('2025');
    expect(y!.months[0]!.r).toBeCloseTo(0.05, 12);
    expect(y!.months[1]!.r).toBeCloseTo(feb, 12);
    expect(y!.months.slice(2).every((c) => c === undefined)).toBe(true);
    expect(y!.total).toBeCloseTo(yearToDate(t.total, t.months, 1)!, 12);
  });

  it('risk: level from 1 the month before, the fall from the January high, volatility of the two months', () => {
    const r = riskOf(t.total, t.months);
    expect(r.underwater.map((u) => u.date)).toEqual(['2024-12-31', '2025-01-31', '2025-02-28']);
    expect(r.maxDrawdown).toEqual({ depth: expect.closeTo(feb, 12), peak: '2025-01-31', trough: '2025-02-28' });
    expect(r.current).toBeCloseTo(feb, 12);
    const mean = (0.05 + feb) / 2;
    expect(r.volatility).toBeCloseTo(Math.sqrt((((0.05 - mean) ** 2 + (feb - mean) ** 2) / 1) * 12), 12);
    expect(r.best).toEqual({ date: '2025-01-31', r: expect.closeTo(0.05, 12) });
    expect(r.worst).toEqual({ date: '2025-02-28', r: expect.closeTo(feb, 12) });
    expect(r.positive).toBe(0.5);
  });

  it('risk over a period starts at the month-end before it', () => {
    const r = riskOf(t.total, t.months, '2025-01-31');
    expect(r.months).toBe(1);
    expect(r.underwater.map((u) => u.date)).toEqual(['2025-01-31', '2025-02-28']);
    expect(r.volatility).toBeUndefined();
    expect(r.maxDrawdown?.depth).toBeCloseTo(feb, 12);
  });

  it('gain bridge: start + money put in + each gain = end, since the beginning and over a period', () => {
    const rows = [...t.classes, t.cash];
    const all = gainBridge(rows, t.months)!;
    expect(all.start).toBe('2024-12-31');
    expect(all.startValue.toNumber()).toBe(0);
    expect(all.flows.toNumber()).toBe(2000);
    expect(all.parts.map((p) => [p.id, p.gain.toNumber()])).toEqual([['class:acciones_usd', 10], ['cash', 0]]);
    expect(all.endValue.toNumber()).toBe(2010);

    const period = gainBridge(rows, t.months, '2025-01-31')!;
    expect(period.start).toBe('2025-01-31');
    expect(period.startValue.toNumber()).toBe(2100);
    // The dividend leaves the stock (−20) and lands in cash (+20): no money came from outside.
    expect(period.flows.toNumber()).toBe(0);
    expect(period.parts.map((p) => p.gain.toNumber())).toEqual([-90, 0]);
    expect(period.endValue.toNumber()).toBe(2010);
    expect(gainBridge(rows, t.months, '2025-02-28')).toBeUndefined();
  });

  it('level series: volatility only from whole months, missing levels skipped', () => {
    const dates = ['2025-01-15', '2025-01-31', '2025-02-28', '2025-03-20', '2025-03-31'];
    const r = levelSeriesRisk(dates, [100, 110, 99, null, 108.9]);
    // Whole months: Feb −10 %, Mar +10 %. The half month from 15 Jan is not a monthly return.
    expect(r.volatility).toBeCloseTo(Math.sqrt(0.24), 12);
    expect(r.maxDrawdown).toEqual({ depth: expect.closeTo(-0.1, 12), peak: '2025-01-31', trough: '2025-02-28' });
    expect(r.current).toBeCloseTo(108.9 / 110 - 1, 12);
    expect(r.underwater).toHaveLength(4);
  });

  it('a class alone: the dividend leaves it as a flow and its gain includes it', () => {
    const b = gainBridge(t.classes, t.months)!;
    expect(b.flows.toNumber()).toBe(980); // buy 1000 − dividend 20
    expect(b.parts.map((p) => p.gain.toNumber())).toEqual([10]); // +100 in January, −90 in February (990 − 1100 + 20)
    expect(b.endValue.toNumber()).toBe(990);
  });

  it('a period starting mid-month begins at the previous month-end', () => {
    const b = gainBridge([...t.classes, t.cash], t.months, '2025-02-15')!;
    expect(b.start).toBe('2025-01-31');
    expect(b.startValue.toNumber()).toBe(2100);
    expect(riskOf(t.total, t.months, '2025-02-15').from).toBe('2025-01-31');
  });

  it('ordinary months are not approximate', () => {
    expect([...t.total.cells, ...t.classes[0]!.cells].some((c) => c.approx)).toBe(false);
  });
});

describe('months where Modified Dietz breaks down', () => {
  // Buy 10 at 100 on 2 January, sell them all at 90 on 2 February: a real −10 %.
  const sale = {
    book: { accounts, assets, prices: new SeriesPriceSource().set('AAA', [px('2025-01-31', 100)]), fx: new FxTable() },
    ledger: [
      tx('2025-01-01', 'usd', 'DEPOSIT', 1000),
      tx('2025-01-02', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }),
      tx('2025-02-02', 'usd', 'SELL', 900, { asset: 'AAA', q: 10 }),
    ],
    benchmarks: [],
  };
  const s = tracking(sale, 'USD', '2025-02-28');
  const cls = s.classes[0]!;

  it('a sale early in the month: the class return is flagged approximate and left out of the risk figures', () => {
    const feb = cls.cells[1]!;
    // Base 1000 − 900 · 26/28 = 164.29 < half of 1000: −100 / 164.29 = −60.9 %, far from the real −10 %.
    expect(feb.r).toBeCloseTo(-100 / (1000 - (900 * 26) / 28), 12);
    expect(feb.approx).toBe(true);
    const r = riskOf(cls, s.months);
    expect(r.approx).toEqual(['2025-02-28']);
    expect(r.months).toBe(1);
    expect(r.worst?.r).toBe(0);
    expect(r.maxDrawdown).toBeUndefined();
    const [y] = returnsByYear(cls, s.months);
    expect(y!.approx).toBe(true);
    expect(y!.months[1]!.approx).toBe(true);
  });

  it('the total, where the money stays, shows the real −10 % and is not flagged', () => {
    const feb = s.total.cells[1]!;
    expect(feb.r).toBeCloseTo(-0.1, 12);
    expect(feb.approx).toBeUndefined();
  });
});

describe('rows built by hand', () => {
  const cell = (value: number, flow: number, r: number | null, flag?: Cell['flag']): Cell => ({
    value: dec(value), flow: dec(flow), wflow: dec(flow), gain: dec(0), fx: dec(0), r, ...(flag ? { flag } : {}),
  });
  const months = ['2024-11-30', '2024-12-31', '2025-01-31', '2025-02-28', '2025-03-31'];
  // Held in November and December, sold, nothing in February, bought again in March.
  const back: TrackRow = { id: 'x', kind: 'asset', label: 'X', cells: [cell(100, 100, 0), cell(110, 0, 0.1), cell(0, -110, null), cell(0, 0, null), cell(105, 100, 0.05)], flows: [] };

  it('a row that leaves and comes back: months without capital keep the level and stay out of the statistics', () => {
    const r = riskOf(back, months);
    expect(r.underwater.map((u) => u.date)).toEqual(['2024-10-31', ...months]);
    expect(r.months).toBe(3);
    expect(r.best).toEqual({ date: '2024-12-31', r: 0.1 });
    expect(r.worst).toEqual({ date: '2024-11-30', r: 0 });
    expect(r.positive).toBeCloseTo(2 / 3, 12);
    expect(r.maxDrawdown).toBeUndefined();
  });

  it('returns by year: most recent year first, each chained on its own', () => {
    const ys = returnsByYear(back, months);
    expect(ys.map((y) => y.year)).toEqual(['2025', '2024']);
    expect(ys[0]!.total).toBeCloseTo(0.05, 12);
    expect(ys[0]!.months[0]!.r).toBeNull();
    expect(ys[1]!.total).toBeCloseTo(0.1, 12);
  });

  it('combining rows keeps the worst data flag of each month', () => {
    const a: TrackRow = { id: 'a', kind: 'asset', label: 'A', cells: [cell(100, 100, 0, 'estimated'), cell(100, 0, 0)], flows: [] };
    const b: TrackRow = { id: 'b', kind: 'asset', label: 'B', cells: [cell(50, 50, 0, 'stale'), cell(50, 0, 0, 'estimated')], flows: [] };
    expect(combineRows([a, b], 'ab', 'AB').cells.map((c) => c.flag)).toEqual(['stale', 'estimated']);
  });
});
