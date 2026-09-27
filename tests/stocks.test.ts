import { describe, expect, it } from 'vitest';
import { dec } from '../src/domain/money.ts';
import { FxTable } from '../src/domain/fx.ts';
import { SeriesPriceSource } from '../src/domain/prices.ts';
import { battingAverage, stockBook } from '../src/app/stocks.ts';
import { accounts, assets, tx } from './helpers.ts';

const px = (date: string, close: number, ccy = 'USD') => ({ date, close: dec(close), ccy, source: 'test' });
const fx = new FxTable().set('EUR', [{ date: '2025-01-01', perUsd: dec('0.8'), source: 'test' }]);

function book(prices: SeriesPriceSource, target?: string) {
  const withTarget = new Map(assets);
  withTarget.set('AAA', { ...assets.get('AAA')!, target, strategy: 'Crecimiento' });
  return { accounts, assets: withTarget, prices, fx };
}

describe('price tracking rows (average entry price in the quote currency)', () => {
  const prices = new SeriesPriceSource().set('AAA', [px('2024-06-28', 90), px('2025-03-03', 125), px('2025-05-30', 120), px('2025-06-27', 136), px('2025-06-30', 138)]);
  const ctx = {
    book: book(prices, '161'),
    ledger: [
      tx('2025-01-01', 'usd', 'DEPOSIT', 5000),
      tx('2025-01-01', 'usd', 'BUY', -1001, { asset: 'AAA', q: 10, fee: dec(1) }),
      tx('2025-04-11', 'usd', 'BUY', -1300, { asset: 'AAA', q: 10 }),
      tx('2025-05-01', 'usd', 'SELL', 749, { asset: 'AAA', q: 5, fee: dec(1) }),
    ],
    benchmarks: [],
  };
  const { rows, trades } = stockBook(ctx, 'USD', '2025-06-30');
  const r = rows[0]!;

  it('averages the entry price without commissions; a sale leaves it unchanged', () => {
    expect(rows).toHaveLength(1);
    expect(r.qty.toNumber()).toBe(15);
    expect(r.avgPrice.toNumber()).toBe(115); // (100·10 + 130·10) / 20
    expect(r.lots.map((l) => l.price.toNumber())).toEqual([100, 130]);
    expect(r.since).toBe('2025-02-20'); // midpoint of 1 jan and 11 apr, same quantity
    expect(r.strategy).toBe('Crecimiento');
  });

  it('progress to the target, what is left, and price changes', () => {
    expect(r.price!.close.toNumber()).toBe(138);
    expect(r.ret).toBeCloseTo(138 / 115 - 1, 12);
    expect(r.progress).toBeCloseTo((138 - 115) / (161 - 115), 12); // 0.5
    expect(r.toTarget).toBeCloseTo(161 / 138 - 1, 12);
    expect(r.change1d).toBeCloseTo(138 / 136 - 1, 12);
    expect(r.change1m).toBeCloseTo(138 / 120 - 1, 12); // close on or before 31 may
    expect(r.changeYtd).toBeUndefined(); // no close within 10 days of 31 dec
    expect([r.low52, r.high52]).toEqual([120, 138]); // the 90 close is 367 days old
    expect(r.annual).toBeCloseTo((138 / 115) ** (365 / 130) - 1, 12);
  });

  it('a sale becomes a closed trade on the average entry price', () => {
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t.exit.toNumber()).toBe(150); // (749 + 1) / 5
    expect(t.entry.toNumber()).toBe(115);
    expect(t.ret).toBeCloseTo(150 / 115 - 1, 12);
    expect(t.days).toBe(70); // 20 feb → 1 may
    expect(t.annual).toBeUndefined();
    // Average cost includes the commission: cost 2301 / 20 = 115.05 per unit → 749 − 575.25.
    expect(t.realized.toNumber()).toBeCloseTo(749 - 575.25, 9);
    expect(battingAverage(trades)).toBe(1);
  });

  it('no target, or a target below the entry price, gives no progress', () => {
    const none = stockBook({ ...ctx, book: book(prices) }, 'USD', '2025-06-30').rows[0]!;
    expect(none.progress).toBeUndefined();
    const below = stockBook({ ...ctx, book: book(prices, '110') }, 'USD', '2025-06-30').rows[0]!;
    expect(below.progress).toBeUndefined();
    expect(below.toTarget).toBeCloseTo(110 / 138 - 1, 12);
  });

  it('a full sale closes the row and restarts the entry price on the next buy', () => {
    const more = [...ctx.ledger, tx('2025-05-02', 'usd', 'SELL', 2100, { asset: 'AAA', q: 15 }), tx('2025-06-02', 'usd', 'BUY', -1250, { asset: 'AAA', q: 10 })];
    const b = stockBook({ ...ctx, ledger: more }, 'USD', '2025-06-30');
    expect(b.trades.map((t) => t.qty.toNumber())).toEqual([15, 5]);
    expect(b.rows[0]!.avgPrice.toNumber()).toBe(125);
    expect(b.rows[0]!.lots).toHaveLength(1);
    expect(b.rows[0]!.since).toBe('2025-06-02');
  });
});

it('prices a foreign-currency stock bought from a USD account in its own currency', () => {
  const prices = new SeriesPriceSource().set('EUR1', [px('2025-06-30', 90, 'EUR')]);
  const ctx = {
    book: { accounts, assets, prices, fx },
    ledger: [tx('2025-01-02', 'usd', 'BUY', -1000, { asset: 'EUR1', q: 10 })],
    benchmarks: [],
  };
  const r = stockBook(ctx, 'USD', '2025-06-30').rows[0]!;
  expect(r.ccy).toBe('EUR');
  expect(r.avgPrice.toNumber()).toBe(80); // 1000 USD × 0.8 EUR/USD / 10
  expect(r.ret).toBeCloseTo(90 / 80 - 1, 12);
});
