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

  it('the month in course is a last column valued on the day, month to date, only when asked', () => {
    // On 15 Mar AAA is at 105 (last stored close 12 Mar) and a sale of 2 at 105 put 210 back in cash on 10 Mar.
    const mid = { ...ctx, book: { ...ctx.book, prices: new SeriesPriceSource().set('AAA', [px('2025-01-31', 110), px('2025-02-28', 99), px('2025-03-12', 105)]) }, ledger: [...ctx.ledger, tx('2025-03-10', 'usd', 'SELL', 210, { asset: 'AAA', q: 2 })] };
    const p = tracking(mid, 'USD', '2025-03-15', { partial: true });
    expect(p.months).toEqual(['2025-01-31', '2025-02-28', '2025-03-15']);
    expect(p.partial).toBe('2025-03-15');
    const a = p.assets.find((r) => r.id === 'usd|AAA')!.cells[2]!;
    // 8 × 105 = 840; flow −210; gain 840 − 990 + 210 = 60.
    expect(a.value.toNumber()).toBe(840);
    expect(a.flow.toNumber()).toBe(-210);
    expect(a.gain.toNumber()).toBe(60);
    // The closed months are the same as without it; without the option there is no March column.
    expect(p.total.cells.slice(0, 2).map((c) => c.value.toNumber())).toEqual([2100, 2010]);
    expect(p.total.cells[2]!.value.toNumber()).toBe(2070); // 840 + 1020 + 210
    const plain = tracking(mid, 'USD', '2025-03-15');
    expect(plain.months).toEqual(['2025-01-31', '2025-02-28']);
    expect(plain.partial).toBeUndefined();
    // On a month-end the month is a regular column, not one in course.
    expect(tracking(mid, 'USD', '2025-02-28', { partial: true }).partial).toBeUndefined();
    // Modified Dietz over the 15 days from 28 Feb: the sale of 10 Mar weighs 5/15 → −70; AAA 60 / (990 − 70); no external flow in the total.
    expect(a.wflow.toNumber()).toBeCloseTo(-70, 12);
    expect(a.r).toBeCloseTo(60 / 920, 12);
    expect(p.total.cells[2]!.r).toBeCloseTo(60 / 2010, 12);
  });

  it('the month in course in pesos: each flow at its date\'s rate, the currency effect up to the day', () => {
    // TRM 4.000 until 9 Mar, 4.200 from 10 Mar, 4.400 from 15 Mar.
    const fx = new FxTable(100_000).set('COP', [
      { date: '2025-01-01', perUsd: dec(4000), source: 'test' },
      { date: '2025-03-10', perUsd: dec(4200), source: 'test' },
      { date: '2025-03-15', perUsd: dec(4400), source: 'test' },
    ]);
    const mid = { ...ctx, book: { ...ctx.book, fx, prices: new SeriesPriceSource().set('AAA', [px('2025-01-31', 110), px('2025-02-28', 99), px('2025-03-12', 105)]) }, ledger: [...ctx.ledger, tx('2025-03-10', 'usd', 'SELL', 210, { asset: 'AAA', q: 2 })] };
    const p = tracking(mid, 'COP', '2025-03-15', { partial: true });
    const a = p.assets.find((r) => r.id === 'usd|AAA')!.cells[2]!;
    // 840 × 4.400 − 990 × 4.000 + 210 × 4.200 = 3.696.000 − 3.960.000 + 882.000 = 618.000.
    expect(a.gain.toNumber()).toBe(618000);
    // 3.960.000 × (4.400/4.000 − 1) − 882.000 × (4.400/4.200 − 1) = 396.000 − 42.000.
    expect(a.fx!.toNumber()).toBeCloseTo(354000, 6);
    // Cash: 1.020 × 4.000 × 0,1 + 882.000 × (4.400/4.200 − 1) = 408.000 + 42.000.
    expect(p.cash.cells[2]!.fx!.toNumber()).toBeCloseTo(450000, 6);
  });

  it('the month in course waits for prices: a close too old is never shown as a fall to cost', () => {
    // On 25 Mar the last close (28 Feb) is over 10 days old: no March column, and the reason says what to do.
    const p = tracking(ctx, 'USD', '2025-03-25', { partial: true });
    expect(p.months).toEqual(['2025-01-31', '2025-02-28']);
    expect(p.partial).toBeUndefined();
    expect(p.error).toMatch(/Sin precio reciente de .* al 2025-03-25 \(el último es del 2025-02-28\)/);
  });

  it('stops at the last month it can value and says why', () => {
    const cop = tracking(ctx, 'COP', '2025-02-28');
    expect(cop.months).toEqual([]);
    expect(cop.error).toMatch(/COP/);
  });
});

describe('the exchange-rate part of the month result, hand-verified', () => {
  const rate = (date: string, perUsd: number) => ({ date, perUsd: dec(perUsd), source: 'test' });
  const fx = (c: { fx?: { toFixed: (n: number) => string } }) => c.fx?.toFixed(4);

  // A fund in pesos, reported in dollars. TRM: 3.200 on Aug 31, 3.300 on Sep 15, 3.400 on Sep 30.
  const fund = {
    book: { accounts, assets, prices: new SeriesPriceSource(), fx: new FxTable().set('COP', [rate('2025-08-01', 3200), rate('2025-08-31', 3200), rate('2025-09-15', 3300), rate('2025-09-30', 3400)]) },
    ledger: [
      tx('2025-08-01', 'cop', 'DEPOSIT', 3_200_000),
      tx('2025-08-01', 'cop', 'BUY', -3_200_000, { asset: 'FUND', q: 1 }),
      tx('2025-08-31', 'cop', 'VALUATION', 3_200_000, { asset: 'FUND' }),
      tx('2025-09-15', 'cop', 'DEPOSIT', 330_000),
      tx('2025-09-15', 'cop', 'BUY', -330_000, { asset: 'FUND', q: 0.1 }),
      tx('2025-09-30', 'cop', 'VALUATION', 3_630_000, { asset: 'FUND' }),
    ],
    benchmarks: [],
  };

  it('splits the dollar result into what the fund made in pesos and what the peso lost', () => {
    const t = tracking(fund, 'USD', '2025-09-30');
    const c = t.assets.find((r) => r.id === 'cop|FUND')!.cells[1]!;
    // 1.000 USD at the start (3.200.000 / 3.200), 100 put in (330.000 / 3.300), 1.067,65 at the end (3.630.000 / 3.400).
    expect(c.gain.toFixed(4)).toBe('-32.3529');
    // The peso: 1.000 × (3.200/3.400 − 1) + 100 × (3.300/3.400 − 1) = −58,8235 − 2,9412.
    expect(fx(c)).toBe('-61.7647');
    // The fund: 100.000 pesos gained, at the month-end rate.
    expect(c.gain.minus(c.fx!).toFixed(4)).toBe('29.4118');
    // Cash went in and out the same day: no effect on it; the total carries the fund's.
    expect(fx(t.cash.cells[1]!)).toBe('0.0000');
    expect(fx(t.total.cells[1]!)).toBe('-61.7647');
    expect(fx(t.total.cells[0]!)).toBe('0.0000');
    // In pesos there is no currency effect on peso holdings.
    const cop = tracking(fund, 'COP', '2025-09-30');
    expect(cop.total.cells.map((x) => x.fx!.toNumber())).toEqual([0, 0]);
    expect(cop.total.cells[1]!.gain.toNumber()).toBe(100_000);
  });

  // A US stock, partly sold in the middle of February, reported in pesos. TRM 4.000, then 4.200 on Feb 15, 4.400 on Feb 28.
  const sale = {
    book: {
      accounts,
      assets,
      prices: new SeriesPriceSource().set('AAA', [px('2025-01-31', 100), px('2025-02-28', 110)]),
      fx: new FxTable().set('COP', [rate('2025-01-02', 4000), rate('2025-01-31', 4000), rate('2025-02-15', 4200), rate('2025-02-28', 4400)]),
    },
    ledger: [
      tx('2025-01-02', 'usd', 'DEPOSIT', 1000),
      tx('2025-01-02', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }),
      tx('2025-02-15', 'usd', 'SELL', 525, { asset: 'AAA', q: 5 }),
    ],
    benchmarks: [],
  };

  it('a sale in the middle of the month: the stock’s dollars and the cash it left, each from its date', () => {
    const t = tracking(sale, 'COP', '2025-02-28');
    const c = t.assets.find((r) => r.id === 'usd|AAA')!.cells[1]!;
    // 4.000.000 at the start, −2.205.000 out (525 × 4.200), 2.420.000 at the end (5 × 110 × 4.400).
    expect(c.gain.toNumber()).toBe(625_000);
    // The dollar: 4.000.000 × (4.400/4.000 − 1) − 2.205.000 × (4.400/4.200 − 1) = 400.000 − 105.000.
    expect(c.fx!.toNumber()).toBe(295_000);
    // The stock: 550 − 1.000 + 525 = 75 dollars, at 4.400.
    expect(c.gain.minus(c.fx!).toNumber()).toBe(330_000);
    // The 525 dollars of cash rose with the dollar from Feb 15: 2.205.000 × (4.400/4.200 − 1); they earned nothing else.
    expect(t.cash.cells[1]!.fx!.toNumber()).toBe(105_000);
    expect(t.cash.cells[1]!.gain.toNumber()).toBe(105_000);
    expect(t.total.cells[1]!.fx!.toNumber()).toBe(400_000);
  });

  it('a manual value is in its account’s currency, whatever the asset’s: a USD copy portfolio valued in pesos', () => {
    const ctx = {
      book: { accounts, assets, prices: new SeriesPriceSource(), fx: new FxTable().set('COP', [rate('2025-01-02', 4000), rate('2025-01-31', 4000), rate('2025-02-28', 4400)]) },
      ledger: [
        tx('2025-01-02', 'cop', 'DEPOSIT', 4_000_000),
        tx('2025-01-02', 'cop', 'BUY', -4_000_000, { asset: 'COPY', q: 1 }),
        tx('2025-01-31', 'cop', 'VALUATION', 4_000_000, { asset: 'COPY' }),
        tx('2025-02-28', 'cop', 'VALUATION', 4_000_000, { asset: 'COPY' }),
      ],
      benchmarks: [],
    };
    // Same pesos: in dollars all of the −90,91 is the peso (1.000 × (4.000/4.400 − 1)); in pesos nothing moved.
    const usd = tracking(ctx, 'USD', '2025-02-28').assets[0]!.cells[1]!;
    expect(usd.gain.toFixed(4)).toBe('-90.9091');
    expect(usd.fx!.toFixed(4)).toBe('-90.9091');
    const cop = tracking(ctx, 'COP', '2025-02-28').assets[0]!.cells[1]!;
    expect([cop.gain.toNumber(), cop.fx!.toNumber()]).toEqual([0, 0]);
  });

  it('a US stock bought and sold within the month from a peso account: the dollar’s move is the currency effect', () => {
    const ctx = {
      book: {
        accounts,
        assets,
        prices: new SeriesPriceSource().set('AAA', [px('2025-01-31', 100), px('2025-02-28', 100)]),
        fx: new FxTable().set('COP', [rate('2025-01-02', 4000), rate('2025-01-31', 4000), rate('2025-02-05', 4000), rate('2025-02-20', 4400), rate('2025-02-28', 4400)]),
      },
      ledger: [
        tx('2025-01-02', 'cop', 'DEPOSIT', 4_000_000),
        tx('2025-02-05', 'cop', 'BUY', -4_000_000, { asset: 'AAA', q: 10 }),
        tx('2025-02-20', 'cop', 'SELL', 4_400_000, { asset: 'AAA', q: 10 }),
      ],
      benchmarks: [],
    };
    // 1.000 dollars of stock, same price: the 400.000 pesos it made are all the dollar (4.000 → 4.400).
    const c = tracking(ctx, 'COP', '2025-02-28').assets.find((r) => r.id === 'cop|AAA')!.cells[1]!;
    expect(c.gain.toNumber()).toBe(400_000);
    expect(c.fx!.toNumber()).toBe(400_000);
  });

  it('a rate missing only for the split leaves the effect unknown, not the month', () => {
    const ctx = {
      book: {
        accounts,
        assets,
        prices: new SeriesPriceSource().set('EUR1', [{ date: '2025-02-28', close: dec(11), ccy: 'EUR', source: 'test' }]),
        // Euro rates only at month-ends: none on Feb 15, the day of the buy.
        fx: new FxTable().set('EUR', [rate('2025-01-31', 0.9), rate('2025-02-28', 0.9)]),
      },
      ledger: [tx('2025-01-02', 'usd', 'DEPOSIT', 1000), tx('2025-02-15', 'usd', 'BUY', -1000, { asset: 'EUR1', q: 90 })],
      benchmarks: [],
    };
    const t = tracking(ctx, 'USD', '2025-02-28');
    expect(t.error).toBeUndefined();
    expect(t.months).toEqual(['2025-01-31', '2025-02-28']);
    const c = t.assets.find((r) => r.id === 'usd|EUR1')!.cells[1]!;
    expect(c.gain.toNumber()).toBe(100); // 90 × 11 / 0,9 − 1.000
    expect(c.fx).toBeUndefined();
    expect(t.total.cells[1]!.fx).toBeUndefined();
    expect(t.total.cells[0]!.fx!.toNumber()).toBe(0);
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
      // The currency effect adds up the same way (the sample is in pesos with US holdings, so it is not zero).
      const fx = (c: { fx?: ReturnType<typeof dec> }) => c.fx!;
      expect(t.classes.reduce((a, c) => a.plus(fx(c.cells[m]!)), fx(t.cash.cells[m]!)).minus(fx(t.total.cells[m]!)).abs().lt(1e-6)).toBe(true);
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
