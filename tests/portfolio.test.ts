import { describe, expect, it } from 'vitest';
import { dec } from '../src/domain/money.ts';
import { FxTable } from '../src/domain/fx.ts';
import { SeriesPriceSource } from '../src/domain/prices.ts';
import { portfolioSeries } from '../src/domain/portfolio.ts';
import { performance } from '../src/domain/returns.ts';
import type { Book } from '../src/domain/valuation.ts';
import { accounts, assets, tx } from './helpers.ts';

const trm: [string, number][] = [['2024-12-31', 4000], ['2025-01-10', 4000], ['2025-01-31', 4000], ['2025-02-10', 4200], ['2025-02-15', 4200], ['2025-02-28', 4400]];
const book: Book = {
  assets,
  accounts,
  fx: new FxTable().set('COP', trm.map(([date, r]) => ({ date, perUsd: dec(r), source: 'test' }))),
  prices: new SeriesPriceSource()
    .set('AAA', [['2025-01-31', 110], ['2025-02-28', 130]].map(([date, c]) => ({ date: String(date), close: dec(c!), ccy: 'USD', source: 'test' })))
    .set('BBB', [['2025-01-31', 42000], ['2025-02-28', 44000]].map(([date, c]) => ({ date: String(date), close: dec(c!), ccy: 'COP', source: 'test' }))),
};
const ledger = [
  tx('2025-01-10', 'usd', 'DEPOSIT', 1000),
  tx('2025-01-10', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }),
  tx('2025-01-10', 'cop', 'DEPOSIT', 4_000_000),
  tx('2025-01-10', 'cop', 'BUY', -4_000_000, { asset: 'BBB', q: 100 }),
  tx('2025-02-10', 'cop', 'DIVIDEND', 100_000, { asset: 'BBB' }),
  tx('2025-02-10', 'cop', 'WITHDRAWAL', -100_000, { note: 'dividend paid to the bank account' }),
  tx('2025-02-15', 'usd', 'SELL', 600, { asset: 'AAA', q: 5 }),
];
const dates = ['2024-12-31', '2025-01-31', '2025-02-28'];

describe('portfolio series', () => {
  it('asset-class bucket: trades are the flows, cash stays outside', () => {
    const s = portfolioSeries(book, ledger, { kind: 'bucket', bucket: 'acciones_usd' }, 'USD', dates);
    expect(s.values.map((v) => v.value.toNumber())).toEqual([0, 1100, 650]);
    expect(s.flows.map((f) => [f.date, f.amount.toNumber()])).toEqual([['2025-01-10', 1000], ['2025-02-15', -600]]);
    const p = performance(s, '2024-12-31', '2025-02-28');
    // Jan: 100 / 1000 = 10 %. Feb: 150 / (1100 − 600·13/28) = 4200 / 23000
    expect(p.periods.map((x) => x.r)).toEqual([expect.closeTo(0.1, 12), expect.closeTo(4200 / 23000, 12)]);
    expect(p.twr).toBeCloseTo(1.1 * (1 + 4200 / 23000) - 1, 12);
  });

  it('dividends leave the bucket', () => {
    const s = portfolioSeries(book, ledger, { kind: 'bucket', bucket: 'acciones_cop' }, 'COP', dates);
    expect(s.flows.map((f) => f.amount.toNumber())).toEqual([4_000_000, -100_000]);
  });

  it('total in COP: deposits/withdrawals at the TRM of their date, cash included', () => {
    const s = portfolioSeries(book, ledger, { kind: 'total' }, 'COP', dates);
    expect(s.flows.map((f) => f.amount.toNumber())).toEqual([4_000_000, 4_000_000, -100_000]);
    // Feb: AAA 650·4400 + USD cash 600·4400 + BBB 100·44000
    expect(s.values.map((v) => v.value.toNumber())).toEqual([0, 8_600_000, 9_900_000]);
    const p = performance(s, '2024-12-31', '2025-02-28');
    expect(p.periods.map((x) => x.r)).toEqual([expect.closeTo(0.075, 12), expect.closeTo(39_200_000 / 239_000_000, 12)]);
  });

  it('mix without cash adds up the chosen classes', () => {
    const mix = portfolioSeries(book, ledger, { kind: 'mix', buckets: ['acciones_usd', 'acciones_cop'], cash: false }, 'COP', dates);
    const usd = portfolioSeries(book, ledger, { kind: 'bucket', bucket: 'acciones_usd' }, 'COP', dates);
    const cop = portfolioSeries(book, ledger, { kind: 'bucket', bucket: 'acciones_cop' }, 'COP', dates);
    expect(mix.values.map((v) => v.value.toNumber())).toEqual(usd.values.map((v, i) => v.value.plus(cop.values[i]!.value).toNumber()));
    expect(mix.flows.map((f) => f.amount.toNumber()).sort()).toEqual([...usd.flows, ...cop.flows].map((f) => f.amount.toNumber()).sort());
  });

  it('mix with cash: every class plus cash is the total; leaving a class out subtracts it exactly', () => {
    const total = portfolioSeries(book, ledger, { kind: 'total' }, 'COP', dates);
    const all = portfolioSeries(book, ledger, { kind: 'mix', buckets: ['acciones_usd', 'acciones_cop'], cash: true }, 'COP', dates);
    expect(all.values.map((v) => v.value.toNumber())).toEqual(total.values.map((v) => v.value.toNumber()));
    expect(all.flows.map((f) => f.amount.toNumber())).toEqual(total.flows.map((f) => f.amount.toNumber()));

    // Without COP stocks: the COP buy is money out (−4 M) and the dividend money in (+100 k), at their dates.
    const ex = portfolioSeries(book, ledger, { kind: 'mix', buckets: ['acciones_usd'], cash: true }, 'COP', dates);
    const cop = portfolioSeries(book, ledger, { kind: 'bucket', bucket: 'acciones_cop' }, 'COP', dates);
    expect(ex.flows.map((f) => [f.date, f.amount.toNumber()])).toEqual([
      ['2025-01-10', 4_000_000],
      ['2025-01-10', 4_000_000],
      ['2025-01-10', -4_000_000],
      ['2025-02-10', 100_000],
      ['2025-02-10', -100_000],
    ]);
    const net = (s: typeof ex) => s.flows.reduce((a, f) => a + f.amount.toNumber(), 0);
    expect(net(ex) + net(cop)).toBe(net(total));
    ex.values.forEach((v, i) => expect(v.value.plus(cop.values[i]!.value).eq(total.values[i]!.value)).toBe(true));
    // Feb: AAA 650·4400 + USD cash 600·4400 (COP cash is zero after the withdrawal).
    expect(ex.values[2]!.value.toNumber()).toBe(1250 * 4400);
  });

  it('transfers between accounts are internal to the total but external to each account', () => {
    const withTransfer = [...ledger, tx('2025-02-20', 'cop', 'TRANSFER_OUT', -400_000, { transferId: 'T1' }), tx('2025-02-20', 'usd', 'TRANSFER_IN', 100, { transferId: 'T1' })];
    trm.push(['2025-02-20', 4000]);
    book.fx.set('COP', trm.map(([date, r]) => ({ date, perUsd: dec(r), source: 'test' })));
    const total = portfolioSeries(book, withTransfer, { kind: 'total' }, 'USD', dates);
    expect(total.flows).toHaveLength(3);
    const usd = portfolioSeries(book, withTransfer, { kind: 'accounts', accounts: ['usd'] }, 'USD', dates);
    expect(usd.flows.map((f) => f.amount.toNumber())).toEqual([1000, 100]);
  });
});
