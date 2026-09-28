import { describe, expect, it } from 'vitest';
import { dec } from '../src/domain/money.ts';
import { FxTable } from '../src/domain/fx.ts';
import { SeriesPriceSource } from '../src/domain/prices.ts';
import { addYears, dividends } from '../src/app/dividends.ts';
import { accounts, assets, tx } from './helpers.ts';

const px = (date: string, close: number, ccy: string) => ({ date, close: dec(close), ccy, source: 'test' });
const rate = (date: string, perUsd: number) => ({ date, perUsd: dec(perUsd), source: 'test' });

describe('dividends: history, projection and yield', () => {
  const fx = new FxTable().set('COP', [rate('2025-02-01', 4000), rate('2025-08-01', 4000), rate('2026-04-01', 4000), rate('2026-04-10', 4000), rate('2026-05-01', 4000), rate('2026-06-25', 5000)]);
  const prices = new SeriesPriceSource().set('AAA', [px('2026-06-30', 110, 'USD')]).set('BBB', [px('2026-06-30', 1000, 'COP')]);
  const ctx = {
    book: { accounts, assets, prices, fx },
    ledger: [
      tx('2024-01-02', 'usd', 'DEPOSIT', 10000),
      tx('2024-01-02', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }),
      tx('2024-06-15', 'usd', 'DIVIDEND', 5, { asset: 'AAA' }),
      tx('2024-12-15', 'usd', 'DIVIDEND', 5, { asset: 'AAA' }),
      tx('2025-02-01', 'cop', 'DEPOSIT', 2000000),
      tx('2025-02-01', 'cop', 'BUY', -1000000, { asset: 'FUND' }),
      tx('2025-03-01', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }),
      tx('2025-06-15', 'usd', 'DIVIDEND', 10, { asset: 'AAA' }),
      tx('2025-06-20', 'usd', 'SELL', 600, { asset: 'AAA', q: 5 }),
      tx('2025-08-01', 'cop', 'DIVIDEND', 20000, { asset: 'FUND' }),
      tx('2025-12-15', 'usd', 'DIVIDEND', 7.5, { asset: 'AAA', estimated: true }),
      tx('2026-04-01', 'cop', 'BUY', -100000, { asset: 'BBB', q: 100 }),
      tx('2026-04-10', 'cop', 'DIVIDEND', 40000, { asset: 'BBB' }),
      tx('2026-05-01', 'cop', 'BUY', -60000, { asset: 'BBB', q: 50 }),
      tx('2026-06-30', 'cop', 'VALUATION', 1100000, { asset: 'FUND' }),
      tx('2026-07-15', 'usd', 'DIVIDEND', 99, { asset: 'AAA' }), // after the as-of date: ignored
    ],
    benchmarks: [],
  };
  const d = dividends(ctx, 'USD', '2026-06-30');
  const n = (x: { toNumber(): number }) => x.toNumber();

  it('converts each payment at its own date and splits last 12 months, the 12 before, this year and all', () => {
    expect(d.payments.map((p) => [p.date, n(p.amount!)])).toEqual([
      ['2024-06-15', 5], ['2024-12-15', 5], ['2025-06-15', 10], ['2025-08-01', 5], ['2025-12-15', 7.5], ['2026-04-10', 10],
    ]);
    expect([n(d.last12.total), n(d.last12.estimated)]).toEqual([22.5, 7.5]); // aug 5 + dec 7.5 (estimated) + apr 10
    expect(n(d.prev12!.total)).toBe(15); // dec 2024 5 + jun 2025 10
    expect([n(d.ytd.total), n(d.ytd.estimated)]).toEqual([10, 0]);
    expect([n(d.all.total), n(d.all.estimated)]).toEqual([42.5, 7.5]);
  });

  it('lists every month and year from the first payment, gaps as zero, growth only between whole years', () => {
    expect(d.months).toHaveLength(25); // jun 2024 … jun 2026
    expect(d.months[0]!.date).toBe('2024-06-30');
    expect(n(d.months[1]!.total)).toBe(0);
    expect(d.years.map((y) => [y.year, n(y.total), y.partial, y.growth])).toEqual([
      [2024, 10, false, undefined],
      [2025, 22.5, false, 1.25],
      [2026, 10, true, undefined],
    ]);
  });

  it('projects each payment of the last 12 months a year later, sized to the units held today, at the as-of rate', () => {
    expect(d.projected.map((p) => [p.date, p.asset, n(p.native), n(p.amount!), p.estimated])).toEqual([
      ['2026-08-01', 'FUND', 20000, 4, false], // units-less: repeated as is; 20 000 COP at 5 000
      ['2026-12-15', 'AAA', 7.5, 7.5, true], // 15 units then and now
      ['2027-04-10', 'BBB', 60000, 12, false], // 40 000 × 150 / 100 units
    ]);
    expect([n(d.next12.total), n(d.next12.estimated)]).toEqual([23.5, 7.5]);
    expect(d.calendar.map((c) => c.date)).toEqual(['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30']);
    expect(d.calendar.map((c) => n(c.total))).toEqual([0, 4, 0, 0, 0, 7.5, 0, 0, 0, 12, 0, 0]);
    expect(n(d.calendar[5]!.estimated)).toBe(7.5);
  });

  it('yield of the projection on the value and on the cost of the positions it counts on', () => {
    // value: AAA 15 × 110 = 1 650; BBB 150 × 1 000 COP = 30; FUND 1 100 000 COP = 220 → 1 900
    // cost: AAA 2 000 × 15/20 = 1 500; BBB 160 000 COP = 32; FUND 1 000 000 COP = 200 → 1 732
    expect(n(d.base!.value)).toBe(1900);
    expect(n(d.base!.cost)).toBe(1732);
    expect(d.yieldOnValue).toBeCloseTo(23.5 / 1900, 12);
    expect(d.yieldOnCost).toBeCloseTo(23.5 / 1732, 12);
  });

  it('adds up by asset, largest in the last 12 months first', () => {
    expect(d.byAsset.map((a) => [a.asset, n(a.last12), n(a.total), a.count, a.held])).toEqual([
      ['BBB', 10, 10, 1, true],
      ['AAA', 7.5, 27.5, 4, true],
      ['FUND', 5, 5, 1, true],
    ]);
  });
});

describe('dividends: sold positions and missing rates', () => {
  it('does not project a position sold since, and leaves out a payment whose rate is missing', () => {
    const fx = new FxTable().set('COP', [rate('2026-01-05', 4000)]);
    const ctx = {
      book: { accounts, assets, prices: new SeriesPriceSource(), fx },
      ledger: [
        tx('2025-10-01', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }),
        tx('2025-11-01', 'usd', 'DIVIDEND', 8, { asset: 'AAA' }),
        tx('2026-02-01', 'usd', 'SELL', 1100, { asset: 'AAA', q: 10 }),
        tx('2025-10-01', 'cop', 'BUY', -100000, { asset: 'BBB', q: 100 }),
        tx('2026-03-20', 'cop', 'DIVIDEND', 4000, { asset: 'BBB' }), // no COP rate within 10 days
      ],
      benchmarks: [],
    };
    const d = dividends(ctx, 'USD', '2026-06-30');
    expect(d.payments.map((p) => p.asset)).toEqual(['AAA']);
    expect(d.missingFx.map((p) => p.asset)).toEqual(['BBB']);
    expect(d.all.total.toNumber()).toBe(8);
    expect(d.byAsset[0]!.held).toBe(false);
    // BBB is still held but there is no COP rate on 30 jun either: projected as missing, not converted, and no yield.
    expect(d.projected).toEqual([]);
    expect(d.projectedMissingFx.map((p) => [p.asset, p.native.toNumber()])).toEqual([['BBB', 4000]]);
    expect(d.yieldOnValue).toBeUndefined();
  });

  it('a year later keeps the day; 29 feb falls back to 28 feb', () => {
    expect(addYears('2025-06-15', 1)).toBe('2026-06-15');
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYears('2023-02-28', 1)).toBe('2024-02-28');
  });

  it('with no dividends everything is empty and zero', () => {
    const d = dividends({ book: { accounts, assets, prices: new SeriesPriceSource(), fx: new FxTable() }, ledger: [], benchmarks: [] }, 'USD', '2026-06-30');
    expect(d.months).toEqual([]);
    expect(d.years).toEqual([]);
    expect(d.next12.total.toNumber()).toBe(0);
    expect(d.calendar).toHaveLength(12);
    expect(d.base).toBeUndefined();
  });
});

describe('dividends: edge cases of the projection', () => {
  const fx = new FxTable();
  const run = (ledger: ReturnType<typeof tx>[], asOf: string, prices = new SeriesPriceSource()) => dividends({ book: { accounts, assets, prices, fx }, ledger, benchmarks: [] }, 'USD', asOf);

  it('a same-day sale or buy does not change the units the dividend was paid on', () => {
    const sold = run([tx('2025-01-02', 'usd', 'BUY', -1500, { asset: 'AAA', q: 15 }), tx('2025-09-10', 'usd', 'SELL', 500, { asset: 'AAA', q: 5 }), tx('2025-09-10', 'usd', 'DIVIDEND', 15, { asset: 'AAA' })], '2025-12-31');
    expect(sold.payments[0]!.held.qty.toNumber()).toBe(15);
    expect(sold.projected[0]!.native.toNumber()).toBe(10); // 15 × 10 / 15 units
    const bought = run([tx('2025-01-02', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }), tx('2025-09-10', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }), tx('2025-09-10', 'usd', 'DIVIDEND', 10, { asset: 'AAA' })], '2025-12-31');
    expect(bought.projected[0]!.native.toNumber()).toBe(20); // 10 × 20 / 10 units
  });

  it('after a partial sale the projection shrinks with the units', () => {
    const d = run([tx('2025-01-02', 'usd', 'BUY', -2000, { asset: 'AAA', q: 20 }), tx('2025-03-15', 'usd', 'DIVIDEND', 8, { asset: 'AAA' }), tx('2025-06-01', 'usd', 'SELL', 1500, { asset: 'AAA', q: 15 })], '2025-12-31');
    expect(d.projected.map((p) => [p.date, p.native.toNumber()])).toEqual([['2026-03-15', 2]]); // 8 × 5 / 20
  });

  it('a fund without units scales with its cost basis after a partial withdrawal', () => {
    const d = run([
      tx('2025-01-02', 'cop', 'BUY', -1000, { asset: 'FUND', ccy: 'USD' }),
      tx('2025-03-31', 'cop', 'VALUATION', 1000, { asset: 'FUND', ccy: 'USD' }),
      tx('2025-04-15', 'cop', 'DIVIDEND', 50, { asset: 'FUND', ccy: 'USD' }),
      tx('2025-05-02', 'cop', 'SELL', 900, { asset: 'FUND', ccy: 'USD' }), // 90 % of the value: cost 1 000 → 100
    ].map((t) => ({ ...t, account: 'usd' })), '2025-12-31');
    expect(d.projected.map((p) => p.native.toNumber())).toEqual([5]); // 50 × 100 / 1 000
  });

  it('a position reopened after selling everything projects on the units it was paid on', () => {
    const d = run([
      tx('2025-01-02', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }),
      tx('2025-02-01', 'usd', 'SELL', 1000, { asset: 'AAA', q: 10 }),
      tx('2025-03-01', 'usd', 'BUY', -400, { asset: 'AAA', q: 4 }),
      tx('2025-06-15', 'usd', 'DIVIDEND', 2, { asset: 'AAA' }),
    ], '2025-12-31');
    expect(d.projected.map((p) => p.native.toNumber())).toEqual([2]);
  });

  it('with the as-of date mid-month the calendar has 13 months, first and last partial, and adds up to the total', () => {
    const d = run([tx('2025-01-02', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }), tx('2025-06-20', 'usd', 'DIVIDEND', 3, { asset: 'AAA' }), tx('2025-06-10', 'usd', 'DIVIDEND', 4, { asset: 'AAA' })], '2025-06-15');
    expect(d.calendar).toHaveLength(13);
    expect([d.calendar[0]!.date, d.calendar[12]!.date]).toEqual(['2025-06-30', '2026-06-30']);
    expect(d.calendar.map((c) => c.total.toNumber()).filter((v) => v)).toEqual([4]); // 10 jun 2025 → 10 jun 2026
    expect(d.next12.total.toNumber()).toBe(4); // the 20 jun payment is after the as-of date
  });

  it('29 feb repeated on 28 feb of the as-of date is not ahead: it stays out of the projection', () => {
    const d = run([tx('2024-01-02', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }), tx('2024-02-29', 'usd', 'DIVIDEND', 10, { asset: 'AAA' })], '2025-02-28');
    expect(d.last12.total.toNumber()).toBe(10);
    expect(d.projected).toEqual([]);
    expect(d.next12.total.toNumber()).toBe(0);
  });

  it('yield on value is missing when a position stands at cost (no price); yield on cost stays', () => {
    const prices = new SeriesPriceSource().set('AAA', [px('2024-06-28', 300, 'USD')]);
    const d = run([tx('2024-06-01', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }), tx('2025-09-01', 'usd', 'DIVIDEND', 30, { asset: 'AAA' })], '2025-09-30', prices);
    expect(d.base!.priced).toBe(false);
    expect(d.yieldOnValue).toBeUndefined();
    expect(d.yieldOnCost).toBeCloseTo(0.03, 12);
  });

  it('no comparison with the 12 months before when the ledger starts inside them; the as-of 31 dec closes its year', () => {
    const d = run([
      tx('2024-06-01', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }),
      tx('2024-09-01', 'usd', 'DIVIDEND', 5, { asset: 'AAA' }),
      tx('2025-09-01', 'usd', 'DIVIDEND', 6, { asset: 'AAA' }),
    ], '2025-12-31');
    expect(d.prev12).toBeUndefined();
    expect(d.years.map((y) => [y.year, y.partial, y.growth])).toEqual([[2024, false, undefined], [2025, false, undefined]]); // 2024 starts in june
  });
});
