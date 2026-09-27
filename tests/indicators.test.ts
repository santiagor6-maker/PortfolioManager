import { describe, expect, it } from 'vitest';
import { dec } from '../src/domain/money.ts';
import { FxTable } from '../src/domain/fx.ts';
import { SeriesPriceSource } from '../src/domain/prices.ts';
import { breakdown, concentration, indicatorRows, moatOf, weightedUpside } from '../src/app/indicators.ts';
import { accounts, assets, tx } from './helpers.ts';

const px = (close: number, ccy: string) => [{ date: '2025-06-30', close: dec(close), ccy, source: 'test' }];
const book = new Map(assets);
book.set('AAA', { ...assets.get('AAA')!, target: '150', targetHigh: '180', region: 'USA', ideaSource: 'Propia', fundamentals: { cap: 'large', style: 'growth' } });
book.set('BBB', { ...assets.get('BBB')!, target: '50400', region: 'Colombia' });
book.set('COPY', { ...assets.get('COPY')!, region: 'USA' });
const prices = new SeriesPriceSource().set('AAA', px(120, 'USD')).set('BBB', px(42000, 'COP'));
const ctx = {
  book: { accounts, assets: book, prices, fx: new FxTable().set('COP', ['2025-01-02', '2025-01-03', '2025-06-30'].map((date) => ({ date, perUsd: dec(4000), source: 'test' }))) },
  ledger: [
    tx('2025-01-02', 'usd', 'DEPOSIT', 3000),
    tx('2025-01-02', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }),
    tx('2025-01-02', 'cop', 'DEPOSIT', 4_400_000),
    tx('2025-01-02', 'cop', 'BUY', -4_000_000, { asset: 'BBB', q: 100 }),
    tx('2025-01-03', 'cop', 'BUY', -400_000, { asset: 'AAA', q: 1 }),
    tx('2025-01-02', 'usd', 'BUY', -1000, { asset: 'COPY' }),
    tx('2025-06-30', 'usd', 'VALUATION', 1200, { asset: 'COPY' }),
  ],
  benchmarks: [],
};

describe('indicators: weights, composition and potential', () => {
  const rows = indicatorRows(ctx, 'USD', '2025-06-30', ['acciones_usd', 'acciones_cop']);
  const by = (id: string) => rows.find((r) => r.asset === id)!;
  // AAA 11 × 120 = 1320 (two accounts), BBB 100 × 42 000 / 4 000 = 1050, COPY 1200 (manual) → 3570.
  const total = 3570;

  it('adds the same asset across accounts and weighs each holding in the portfolio', () => {
    expect(rows.map((r) => r.asset)).toEqual(['AAA', 'COPY', 'BBB']);
    expect(by('AAA').value.toNumber()).toBe(1320);
    expect(by('AAA').accounts).toEqual(['Bróker USD', 'Bróker COP']);
    expect(by('AAA').weight).toBeCloseTo(1320 / total, 12);
    expect(rows.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 12);
    expect(by('COPY').method).toBe('manual');
    expect(by('COPY').price).toBeUndefined();
  });

  it('potential to the base and optimistic targets, in the quote currency', () => {
    expect(by('AAA').upside).toBeCloseTo(0.25, 12);
    expect(by('AAA').upsideHigh).toBeCloseTo(0.5, 12);
    expect(by('BBB').upside).toBeCloseTo(0.2, 12);
    expect(by('COPY').upside).toBeUndefined();
    const base = weightedUpside(rows, 'upside');
    expect(base.upside).toBeCloseTo((1320 * 0.25 + 1050 * 0.2) / (1320 + 1050), 12);
    expect(base.coverage).toBeCloseTo((1320 + 1050) / total, 12);
    expect(weightedUpside(rows, 'upsideHigh')).toEqual({ upside: expect.closeTo(0.5, 12), coverage: expect.closeTo(1320 / total, 12) });
  });

  it('breaks the portfolio down by a dimension, unassigned last', () => {
    expect(breakdown(rows, (r) => r.region).map((s) => [s.key, s.value.toNumber()])).toEqual([['USA', 2520], ['Colombia', 1050]]);
    const src = breakdown(rows, (r) => r.ideaSource);
    expect(src.map((s) => s.key)).toEqual(['Propia', '']);
    expect(src[1]!.names).toEqual(['COPY', 'BBB'].map((id) => by(id).name));
  });

  it('concentration: top five and effective number of holdings', () => {
    const c = concentration(rows);
    expect(c.top5).toBeCloseTo(1, 12);
    expect(c.effective).toBeCloseTo(1 / rows.reduce((s, r) => s + r.weight ** 2, 0), 12);
    expect(concentration([]).effective).toBeUndefined();
  });
});

describe('moat from external providers', () => {
  it("uses Morningstar's category first, then any provider with a category; a score alone is not a category", () => {
    const ms = { source: 'Morningstar', rating: 'narrow' as const, asOf: '2026-08-28' };
    const gf = { source: 'GuruFocus', score: 8, asOf: '2026-07-07' };
    const other = { source: 'Otro', rating: 'wide' as const, asOf: '2026-01-01' };
    expect(moatOf([gf, other, ms])).toBe('narrow');
    expect(moatOf([gf, other])).toBe('wide');
    expect(moatOf([gf])).toBeUndefined();
    expect(moatOf([])).toBeUndefined();
  });
});
