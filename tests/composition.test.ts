import { describe, expect, it } from 'vitest';
import { dec } from '../src/domain/money.ts';
import { classBase, composition } from '../src/app/composition.ts';
import type { Cell, RowKind, TrackRow, Tracking } from '../src/app/tracking.ts';

const cell = (v: number, flag?: Cell['flag']): Cell => ({ value: dec(v), flow: dec(0), wflow: dec(0), gain: dec(0), r: null, ...(flag ? { flag } : {}) });
const row = (id: string, kind: RowKind, values: number[], bucket?: string, flag?: Cell['flag']): TrackRow => ({ id, kind, label: id, ...(bucket ? { bucket } : {}), cells: values.map((v) => cell(v, flag)), flows: [] });

// Two month-ends. Classes: stocks 600 → 300, property 1.000 → 1.000; cash 400 → −100 (owed to the broker in month 2).
const t: Tracking = {
  ccy: 'COP',
  months: ['2026-01-31', '2026-02-28'],
  assets: [row('AAA', 'asset', [400, 300], 'acciones_usd'), row('BBB', 'asset', [200, 0], 'acciones_usd'), row('Apto', 'asset', [1000, 1000], 'inmobiliario', 'estimated')],
  classes: [row('class:acciones_usd', 'class', [600, 300], 'acciones_usd'), row('class:inmobiliario', 'class', [1000, 1000], 'inmobiliario')],
  cash: row('cash', 'cash', [400, -100]),
  exRealEstate: row('ex', 'subtotal', [1000, 200]),
  total: row('total', 'total', [2000, 1200]),
};

describe('portfolio composition at a month-end', () => {
  it('splits the total into classes plus cash, largest first, and every holding of the same total', () => {
    const c = composition(t, 0, true);
    expect(c.total.toNumber()).toBe(2000);
    expect(c.classes.map((x) => [x.bucket, x.share])).toEqual([['inmobiliario', 0.5], ['acciones_usd', 0.3], ['efectivo', 0.2]]);
    expect(c.holdings.map((x) => [x.id, x.share])).toEqual([['Apto', 0.5], ['AAA', 0.2], ['BBB', 0.1]]);
    // A property list price stays flagged as an estimate.
    expect(c.holdings[0]!.flag).toBe('estimated');
    expect(c.negativeCash).toBeUndefined();
  });

  it('without real estate the shares are of the liquid portfolio', () => {
    const c = composition(t, 0, false);
    expect(c.total.toNumber()).toBe(1000);
    expect(c.classes.map((x) => [x.bucket, x.share])).toEqual([['acciones_usd', 0.6], ['efectivo', 0.4]]);
    expect(c.holdings.map((x) => x.id)).toEqual(['AAA', 'BBB']);
  });

  it('negative cash is shown apart, never netted against a class; a sold holding drops out', () => {
    const c = composition(t, 1, false);
    // 300 of stocks is the whole positive total: the 100 owed is reported separately.
    expect(c.total.toNumber()).toBe(300);
    expect(c.classes.map((x) => [x.bucket, x.share])).toEqual([['acciones_usd', 1]]);
    expect(c.negativeCash!.toNumber()).toBe(100);
    expect(c.holdings.map((x) => x.id)).toEqual(['AAA']);
  });

  it('a holding below zero is listed apart and the class shares are of its positive holdings', () => {
    // Property A 1.000 and B −200 (net of what is owed): the class row is 800, but A is 100 % of what the class holds.
    const u: Tracking = {
      ...t,
      assets: [row('A', 'asset', [1000, 1000], 'inmobiliario'), row('B', 'asset', [-200, -200], 'inmobiliario')],
      classes: [row('class:inmobiliario', 'class', [800, 800], 'inmobiliario')],
      cash: row('cash', 'cash', [0, 0]),
    };
    const c = composition(u, 0, true);
    expect(c.holdings.map((h) => h.id)).toEqual(['A']);
    expect(c.negativeHoldings.map((h) => [h.id, h.value.toNumber()])).toEqual([['B', -200]]);
    expect(classBase(c, 'inmobiliario').toNumber()).toBe(1000);
  });
});
