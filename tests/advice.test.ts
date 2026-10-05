import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLedgerCsv } from '../src/data/csv.ts';
import { readFxRows, readPriceRows } from '../src/data/load.ts';
import { emptyDataset, toStored } from '../src/data/json.ts';
import type { Dataset, InvestorProfile } from '../src/data/json.ts';
import { dec, sum, ZERO } from '../src/domain/money.ts';
import { FxTable } from '../src/domain/fx.ts';
import { SeriesPriceSource } from '../src/domain/prices.ts';
import type { Asset } from '../src/domain/types.ts';
import { CRISIS, PRESETS, advise, homeCost, band, classRecords, contributionPlan, presetProfile, profileProblem, splitContribution } from '../src/app/advice.ts';
import { contextOf } from '../src/app/context.ts';
import { accounts, tx } from './helpers.ts';

const px = (date: string, close: number) => ({ date, close: dec(close), ccy: 'USD', source: 'test' });
const m = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [k, dec(v)]));
const amounts = (s: { cls: string; amount: { toNumber: () => number } }[]) => Object.fromEntries(s.map((x) => [x.cls, Number(x.amount.toNumber().toFixed(6))]));

/**
 * One account in USD. A stock (AAA, «Valor») bought at 100 and again at 120, now at 90; an index fund (IDX)
 * bought at 120, now at 150, the same as the index. Index: 100 → 120 → 150.
 */
const assets = new Map<string, Asset>([
  ['AAA', { id: 'AAA', name: 'AAA Corp', ccy: 'USD', bucket: 'acciones_usd', pricing: 'market', symbol: 'AAA', strategy: 'Valor' }],
  ['IDX', { id: 'IDX', name: 'Index ETF', ccy: 'USD', bucket: 'acciones_usd', pricing: 'market', symbol: 'IDX', strategy: 'Índice' }],
  ['APTO', { id: 'APTO', name: 'Apartamento', ccy: 'COP', bucket: 'inmobiliario', pricing: 'manual' }],
  ['BBB', { id: 'BBB', name: 'BBB SA', ccy: 'COP', bucket: 'acciones_cop', pricing: 'market', symbol: 'BBB' }],
]);
const stocks = {
  book: {
    accounts,
    assets,
    prices: new SeriesPriceSource()
      .set('AAA', [px('2022-12-31', 100), px('2023-06-30', 120), px('2026-06-30', 90)])
      .set('IDX', [px('2023-06-30', 120), px('2026-06-30', 150)])
      .set('BENCH', [px('2022-12-31', 100), px('2023-06-30', 120), px('2026-06-30', 150)]),
    // The advice is taken in pesos: a flat 4.000 COP per dollar keeps the hand figures in dollars ×4.000.
    fx: new FxTable(100_000).set('COP', [{ date: '2020-01-01', perUsd: dec(4000), source: 'test' }]),
  },
  ledger: [
    tx('2022-12-31', 'usd', 'DEPOSIT', 3000),
    tx('2022-12-31', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }),
    tx('2023-06-30', 'usd', 'BUY', -1200, { asset: 'AAA', q: 10 }),
    tx('2023-06-30', 'usd', 'BUY', -600, { asset: 'IDX', q: 5 }),
  ],
  benchmarks: [{ symbol: 'BENCH', name: 'Índice demo', buckets: ['acciones_usd'] }],
};
const AS_OF = '2026-06-30';

describe('holdings against their index, hand-verified', () => {
  const [r] = classRecords(stocks, 'USD', AS_OF);

  it('each holding: its money bought and sold in the index on the same dates', () => {
    // AAA: 1000 × 150/100 + 1200 × 150/120 = 3000 in the index; 20 shares × 90 = 1800 → −1200.
    const aaa = r!.holdings.find((h) => h.asset === 'AAA')!;
    expect(aaa.value!.toNumber()).toBe(1800);
    expect(aaa.indexValue!.toNumber()).toBe(3000);
    expect(aaa.gap!.toNumber()).toBe(-1200);
    // IDX: 600 × 150/120 = 750, and it is worth 750: it is the index.
    expect(r!.holdings.find((h) => h.asset === 'IDX')!.gap!.toNumber()).toBe(0);
    expect(r!.holdings[0]!.asset).toBe('AAA'); // worst first
  });

  it('the holdings add up to the class, by strategy too, and the KS-PME is value / index value', () => {
    expect(r!.value.toNumber()).toBe(2550);
    expect(r!.indexValue.toNumber()).toBe(3750);
    expect(r!.gap.toNumber()).toBe(-1200);
    expect(r!.byStrategy.map((g) => [g.key, g.gap.toNumber()])).toEqual([['Valor', -1200], ['Índice', 0]]);
    const all = r!.windows.find((w) => w.id === 'all')!;
    expect(all.ksPme).toBeCloseTo(2550 / 3750, 12);
    expect(all.indexValue.toNumber()).toBe(3750);
    // Three years back (30 jun 2023) the class was worth 2400 + 600: that is the money in.
    const last3 = r!.windows.find((w) => w.id === '36m')!;
    expect(last3.since).toBe('2023-06-30');
    expect(last3.ksPme).toBeCloseTo(2550 / (3000 * 1.25), 12);
    expect(r!.indexHeld).toEqual(['Index ETF']);
  });

  it('on the synthetic sample, closed positions and dividends included, the holdings add up to the class', () => {
    const read = (f: string) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
    const b = JSON.parse(read('book.json'));
    const d: Dataset = { ...emptyDataset(), accounts: b.accounts, assets: b.assets, benchmarks: b.benchmarks, ledger: parseLedgerCsv(read('ledger.csv')).map((t, i) => toStored({ ...t, id: `s${i}` })), prices: readPriceRows(read('prices.csv')), fx: readFxRows(read('fx.csv')) };
    const recs = classRecords(contextOf(d), 'COP', '2025-06-30');
    expect(recs.length).toBeGreaterThan(0);
    for (const rec of recs) {
      const all = rec.windows.find((w) => w.id === 'all');
      if (!all || rec.missing.length) continue;
      expect(rec.gap.minus(all.value.minus(all.indexValue)).abs().toNumber()).toBeLessThan(1e-6);
      expect(rec.value.minus(all.value).abs().toNumber()).toBeLessThan(1e-6);
      expect(sum(rec.byStrategy.map((g) => g.gap)).minus(rec.gap).abs().toNumber()).toBeLessThan(1e-6);
    }
  });
});

describe('the action plan on the stock case', () => {
  const a = advise(stocks, 'USD', AS_OF);
  const by = (id: string) => a.actions.find((x) => x.id === id);
  const usd = (x: { toNumber: () => number } | undefined) => Number((x ? a.toView(x as never).toNumber() : NaN).toFixed(9));

  it('without a profile, asks for one first and uses the default limits', () => {
    expect(a.actions[0]!.id).toBe('profile');
    expect(a.policy).toEqual({ maxPosition: 0.05, maxRealEstate: 0.5, cashTarget: 0.03 });
    expect(a.netWorth.toNumber()).toBe(2750 * 4000); // 1800 + 750 + 200 of cash, in pesos
    expect(usd(a.liquid)).toBe(2750);
  });

  it('flags the selection that lags its index, with the money at stake and the index fund already held', () => {
    const s = by('selection-acciones_usd')!;
    expect(s.priority).toBe('alta');
    expect(usd(s.impact)).toBe(-1200);
    expect(s.action).toMatch(/revisa si Index ETF, que marcaste como índice, lo replica/);
    expect(s.finding).toMatch(/AAA Corp/);
  });

  it('one company above the limit (index funds are not companies): the excess to the limit', () => {
    const p = by('positions')!;
    expect(p.priority).toBe('alta'); // 65 % against 5 %
    expect(p.finding).toBe('AAA Corp 65,5 %');
    expect(usd(p.impact)).toBe(1800 - 2750 * 0.05);
  });

  it('cash above its target', () => {
    const c = by('cash')!;
    expect(usd(c.impact)).toBe(200 - 2750 * 0.03);
    expect(c.priority).toBe('media');
  });

  it('a fall beyond the tolerance: the liquid portfolio went from 3200 to 2750', () => {
    const p: InvestorProfile = { ...presetProfile('conservador', AS_OF), maxDrawdown: 0.1 };
    const r = advise(stocks, 'USD', AS_OF, p);
    expect(r.risk.historical!.depth).toBeCloseTo(2750 / 3200 - 1, 12);
    expect(r.actions.find((x) => x.id === 'risk')!.priority).toBe('alta');
  });
});

describe('a property on a payment plan, hand-verified', () => {
  // Contract 2000; five payments of 100; valued at 2400 (list price, estimated). A stock in pesos worth 300.
  const ctx = {
    book: { accounts, assets, prices: new SeriesPriceSource().set('BBB', [{ date: '2026-01-31', close: dec(10), ccy: 'COP', source: 'test' }, { date: '2026-06-30', close: dec(10), ccy: 'COP', source: 'test' }]), fx: new FxTable() },
    ledger: [
      tx('2026-01-31', 'cop-prop', 'COMMITMENT', -2000, { asset: 'APTO' }),
      tx('2026-01-31', 'cop', 'DEPOSIT', 300),
      tx('2026-01-31', 'cop', 'BUY', -300, { asset: 'BBB', q: 30 }),
      ...['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'].flatMap((d) => [tx(d, 'cop-prop', 'DEPOSIT', 100), tx(d, 'cop-prop', 'CAPITAL_CALL', -100, { asset: 'APTO' })]),
      tx('2026-06-30', 'cop-prop', 'VALUATION', 2400, { asset: 'APTO', estimated: true }),
    ],
    benchmarks: [],
  };

  it('equity, gross value, what is owed and the payment pace', () => {
    const a = advise(ctx, 'COP', AS_OF);
    expect(a.realEstate!.owed.toNumber()).toBe(1500);
    expect(a.realEstate!.equity.toNumber()).toBe(900);
    expect(a.realEstate!.gross.toNumber()).toBe(2400);
    expect(a.realEstate!.pace.toNumber()).toBeCloseTo(500 / 6, 9);
    expect(a.netWorth.toNumber()).toBe(1200);
    expect(a.liquid.toNumber()).toBe(300);
    const re = a.actions.find((x) => x.id === 'real-estate')!;
    expect(re.impact!.toNumber()).toBe(600); // to be 50 %, the liquid 300 has to reach the equity 900
    expect(re.caveat).toMatch(/estimado/);
    expect(a.actions.find((x) => x.id === 'commitment-due')!.priority).toBe('alta'); // no due date yet: the plan cannot be safe without it
  });

  it('with a due date: what will still be owed then, against the liquid portfolio', () => {
    const a = advise(ctx, 'COP', AS_OF, { ...presetProfile('crecimiento', AS_OF), commitmentDue: '2027-06-30' });
    const c = a.actions.find((x) => x.id === 'commitment-plan')!;
    // 12 months at 83,33 a month: 1500 − 1000 = 500, 167 % of the liquid 300.
    expect(c.impact!.toNumber()).toBeCloseTo(500, 6);
    expect(c.finding).toMatch(/167 %/);
    expect(c.priority).toBe('alta');
  });
});

describe('the allocation and the contribution plan, hand-verified', () => {
  it('the 5/25 band', () => {
    expect(band(0.6)).toBe(0.05);
    expect(band(0.1)).toBe(0.025);
    expect(band(0)).toBe(0.01);
  });

  it('the cash above its target and the contribution fill the shortfalls exactly', () => {
    // 600 / 200 / 200 against 60 / 35 / 5 %, investing 100: the cash target after it is 5 % of 1100 = 55, so 145 is idle.
    const p = contributionPlan(m({ acciones_usd: 600, renta_fija: 200, efectivo: 200 }), { acciones_usd: 0.6, renta_fija: 0.35, efectivo: 0.05 }, dec(100));
    expect(p.idleCash.toNumber()).toBe(145);
    expect(amounts(p.split)).toEqual({ renta_fija: 185, acciones_usd: 60 });
    expect(p.months).toBe(1);
  });

  it('when the shortfall is larger than the money, it goes in proportion; months until back in the band', () => {
    // 500 / 500 against 60 / 40: month 1 all 100 to stocks (600/500, 54,5 %: 5,5 points off); month 2 back in.
    const p = contributionPlan(m({ acciones_usd: 500, renta_fija: 500 }), { acciones_usd: 0.6, renta_fija: 0.4 }, dec(100));
    expect(amounts(p.split)).toEqual({ acciones_usd: 100 });
    expect(p.months).toBe(2);
  });

  it('money left once every class is at its target follows the other targets; cash only up to its target', () => {
    const s = splitContribution(m({ acciones_usd: 600, renta_fija: 400, efectivo: 55 }), { acciones_usd: 0.6, renta_fija: 0.35, efectivo: 0.05 }, dec(100));
    // Total 1155: stocks need 693 − 600 = 93, fixed income 0 (404,25 > 400 by 4,25: it needs 4,25), cash 57,75 − 55 = 2,75.
    const out = amounts(s);
    expect(out.acciones_usd).toBeCloseTo(93, 6);
    expect(out.renta_fija).toBeCloseTo(4.25, 6);
    expect(out.efectivo).toBeCloseTo(2.75, 6);
    // Nothing short: the money follows the targets of the classes other than cash.
    const rest = amounts(splitContribution(m({ acciones_usd: 600, renta_fija: 350, efectivo: 50 }), { acciones_usd: 0.6, renta_fija: 0.35, efectivo: 0.05 }, dec(0.95)));
    expect(rest.acciones_usd! + rest.renta_fija! + (rest.efectivo ?? 0)).toBeCloseTo(0.95, 9);
    expect(sum(s.map((x) => x.amount)).toNumber()).toBeCloseTo(100, 9);
  });

  it('every template adds up to 100 % and passes the checks; a bad profile says why', () => {
    for (const k of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) expect(profileProblem(presetProfile(k, AS_OF))).toBeUndefined();
    expect(profileProblem({ ...presetProfile('moderado', AS_OF), targets: { acciones_usd: 0.5 } })).toMatch(/suman 50,0 %/);
  });
});

describe('dividends taken out of the portfolio', () => {
  it('counts a withdrawal of the same amount on the same day as a dividend, in the last year only', () => {
    const ctx = {
      ...stocks,
      ledger: [
        ...stocks.ledger,
        tx('2026-03-01', 'usd', 'DIVIDEND', 10, { asset: 'AAA' }),
        tx('2026-03-01', 'usd', 'WITHDRAWAL', -10),
        tx('2026-04-01', 'usd', 'WITHDRAWAL', -50),
        tx('2025-03-01', 'usd', 'DIVIDEND', 7, { asset: 'AAA' }),
        tx('2025-03-01', 'usd', 'WITHDRAWAL', -7),
      ],
    };
    const d = advise(ctx, 'USD', AS_OF).actions.find((x) => x.id === 'dividends')!;
    expect(d.impact!.toNumber()).toBe(10 * 4000);
    expect(advise(stocks, 'USD', AS_OF).actions.some((x) => x.id === 'dividends')).toBe(false);
    expect(ZERO.toNumber()).toBe(0);
  });
});

describe('the balance due comes before investing', () => {
  // The property case of above plus 600 of cash in pesos: owes 1500, pays 83,33 a month, due in 12 months.
  const rate = { date: '2020-01-01', perUsd: dec(4000), source: 'test' };
  const base = {
    book: { accounts, assets, prices: new SeriesPriceSource().set('BBB', [{ date: '2026-01-31', close: dec(10), ccy: 'COP', source: 'test' }, { date: '2026-06-30', close: dec(10), ccy: 'COP', source: 'test' }]), fx: new FxTable(100_000).set('COP', [rate]) },
    ledger: [
      tx('2026-01-31', 'cop-prop', 'COMMITMENT', -2000, { asset: 'APTO' }),
      tx('2026-01-31', 'cop', 'DEPOSIT', 900),
      tx('2026-01-31', 'cop', 'BUY', -300, { asset: 'BBB', q: 30 }),
      ...['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'].flatMap((d) => [tx(d, 'cop-prop', 'DEPOSIT', 100), tx(d, 'cop-prop', 'CAPITAL_CALL', -100, { asset: 'APTO' })]),
      tx('2026-06-30', 'cop-prop', 'VALUATION', 2400, { asset: 'APTO', estimated: true }),
    ],
    benchmarks: [],
  };
  const profile = { ...presetProfile('crecimiento', AS_OF), monthly: '50', commitmentDue: '2027-06-30', emergencyMonths: 6 };

  it('cash in pesos counts as set apart; the contribution fills the rest of the reserve before the mix', () => {
    // At due: 1500 − 12 × 83,33 = 500; with 400 from a mortgage the portfolio must put 100, and the 600 of cash covers it.
    const covered = advise(base, 'COP', AS_OF, { ...profile, commitmentFunding: '400' });
    expect(covered.reserve!.need.toNumber()).toBeCloseTo(100, 6);
    expect(covered.reserve!.shortfall.toNumber()).toBeCloseTo(0, 6);
    expect(covered.growth.toNumber()).toBeCloseTo(900 - 100, 6);
    expect(covered.actions.find((x) => x.id === 'commitment-plan')!.good).toBe(true);

    // Nothing from outside: the portfolio must put 500, it has 600 of cash → 500 set apart, nothing left to gather.
    const all = advise(base, 'COP', AS_OF, profile);
    expect(all.reserve!.held.toNumber()).toBeCloseTo(500, 6);
    expect(all.plan!.toReserve.toNumber()).toBe(0);
  });

  it('a reserve larger than the cash: this month all the contribution goes to it, and no sale is suggested while the funding is unknown', () => {
    const poor = { ...base, ledger: base.ledger.map((t) => (t.type === 'DEPOSIT' && t.account === 'cop' ? { ...t, amount: dec(300) } : t)) };
    const a = advise(poor, 'COP', AS_OF, profile);
    expect(a.reserve!.need.toNumber()).toBeCloseTo(500, 6);
    expect(a.reserve!.held.toNumber()).toBe(0);
    expect(a.plan!.toReserve.toNumber()).toBe(50);
    expect(a.plan!.split).toEqual([]);
    expect(a.plan!.sellNeeded.toNumber()).toBe(0); // unknown funding: never "sell everything"
    expect(a.actions.find((x) => x.id === 'commitment-plan')!.title).toMatch(/no alcanza/);
    // Funding registered and within reach: what the contributions cannot gather in time is a sale to plan.
    const b = advise(poor, 'COP', AS_OF, { ...profile, commitmentFunding: '250' });
    expect(b.reserve!.need.toNumber()).toBeCloseTo(250, 6);
    expect(b.plan!.sellNeeded.toNumber()).toBe(0); // 12 months × 50 = 600 ≥ 250
    const c = advise(poor, 'COP', AS_OF, { ...profile, commitmentFunding: '250', monthly: '10' });
    expect(c.plan!.sellNeeded.toNumber()).toBeCloseTo(250 - 12 * 10, 6);
  });

  it('decisions do not depend on the currency on screen', () => {
    const cop = advise(base, 'COP', AS_OF, profile);
    const usd = advise(base, 'USD', AS_OF, profile);
    expect(usd.actions.map((x) => [x.id, x.priority])).toEqual(cop.actions.map((x) => [x.id, x.priority]));
    expect(usd.risk).toEqual(cop.risk);
    expect(usd.toView(usd.netWorth).toNumber()).toBeCloseTo(cop.netWorth.toNumber() / 4000, 9);
  });
});

describe('templates and wording', () => {
  it('each template tolerates what its own mix would lose in the crisis scenario', () => {
    for (const [k, p] of Object.entries(PRESETS)) {
      const loss = Object.entries(p.targets).reduce((s, [c, w]) => s + w * (CRISIS.shocks[c] ?? CRISIS.equity), 0);
      expect(-loss, k).toBeLessThanOrEqual(p.maxDrawdown);
    }
  });

  it('crypto is measured against Bitcoin without the stock-picking evidence, and ranked by its weight', () => {
    const btc = new Map<string, Asset>([...assets, ['XRP', { id: 'XRP', name: 'XRP', ccy: 'USD', bucket: 'cripto', pricing: 'market', symbol: 'XRP' }]]);
    const ctx = {
      ...stocks,
      book: { ...stocks.book, assets: btc, prices: new SeriesPriceSource().set('XRP', [px('2022-12-31', 1), px('2026-06-30', 1)]).set('BTC', [px('2022-12-31', 100), px('2026-06-30', 300)]).set('IDX', [px('2026-06-30', 150)]).set('AAA', [px('2026-06-30', 90)]).set('BENCH', [px('2022-12-31', 100), px('2023-06-30', 120), px('2026-06-30', 150)]) },
      ledger: [tx('2022-12-31', 'usd', 'DEPOSIT', 100), tx('2022-12-31', 'usd', 'BUY', -100, { asset: 'XRP', q: 100 })],
      benchmarks: [{ symbol: 'BTC', name: 'Bitcoin', buckets: ['cripto'] }],
    };
    const x = advise(ctx, 'USD', AS_OF).actions.find((a) => a.id === 'selection-cripto')!;
    expect(x.title).toBe('Tu cripto rindió mucho menos que Bitcoin');
    expect(x.why).toBeUndefined();
    expect(x.priority).toBe('media'); // all the net worth is crypto here
  });

  it('a class that beats its index says how much of it comes from what was already sold', () => {
    const ctx = {
      ...stocks,
      ledger: [
        tx('2022-12-31', 'usd', 'DEPOSIT', 1000),
        tx('2022-12-31', 'usd', 'BUY', -1000, { asset: 'IDX', q: 10 }),
      ],
      book: { ...stocks.book, prices: new SeriesPriceSource().set('IDX', [px('2022-12-31', 100), px('2026-06-30', 300)]).set('BENCH', [px('2022-12-31', 100), px('2023-06-30', 120), px('2026-06-30', 150)]) },
    };
    const g = advise(ctx, 'USD', AS_OF).actions.find((a) => a.id === 'selection-acciones_usd')!;
    expect(g.good).toBe(true);
    expect(g.finding).toMatch(/0 % de esa ventaja viene de posiciones ya vendidas; hoy tienes 1 acción/);
    expect(g.caveat).toMatch(/no prueban habilidad/);
  });
});

describe('edge cases the review found', () => {
  it('the crisis scenario on the stock case: −50 % on the stocks, 0 on the cash', () => {
    const a = advise(stocks, 'USD', AS_OF);
    // 2550 of stocks and 200 of cash out of 2750.
    expect(a.risk.crisisLiquid).toBeCloseTo((2550 / 2750) * -0.5, 12);
    expect(a.risk.crisisNetWorth).toBeCloseTo((2550 * -0.5) / 2750, 12);
  });

  it('a class closed before the last three years: no 3-year window, and the tab still works', () => {
    const ctx = {
      ...stocks,
      ledger: [tx('2020-01-31', 'usd', 'DEPOSIT', 1000), tx('2020-01-31', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }), tx('2021-01-31', 'usd', 'SELL', 1200, { asset: 'AAA', q: 10 })],
      book: { ...stocks.book, prices: new SeriesPriceSource().set('AAA', [px('2020-01-31', 100), px('2021-01-31', 120)]).set('BENCH', [px('2020-01-31', 100), px('2021-01-31', 110), px('2023-06-30', 120), px('2026-06-30', 150)]) },
    };
    const [r] = classRecords(ctx, 'COP', AS_OF);
    expect(r!.windows.map((w) => w.id)).toEqual(['all']);
    // 1000 in, 1200 out a year later: the index made 10 % that year, so the sale left 100 more than the index would have.
    expect(r!.gap.toNumber()).toBeCloseTo((1200 - 1000 * 1.1) * 4000 * (150 / 110), 6);
    expect(() => advise(ctx, 'COP', AS_OF)).not.toThrow();
  });

  it('a rate missing on a trade date leaves that holding out, not the whole tab', () => {
    const eur = new Map<string, Asset>([...assets, ['EUR1', { id: 'EUR1', name: 'Euro Co', ccy: 'EUR', bucket: 'acciones_usd', pricing: 'market', symbol: 'EUR1' }]]);
    const ctx = {
      ...stocks,
      book: { ...stocks.book, assets: eur, accounts: new Map([...accounts, ['eur', { id: 'eur', name: 'Bróker EUR', ccy: 'EUR' }]]) },
      ledger: [...stocks.ledger, tx('2024-01-31', 'eur', 'DEPOSIT', 100, { ccy: 'EUR' }), tx('2024-01-31', 'eur', 'BUY', -100, { asset: 'EUR1', q: 1, ccy: 'EUR' })],
    };
    const recs = classRecords(ctx, 'COP', AS_OF);
    expect(recs[0]!.missing).toEqual(['Euro Co']);
    expect(recs[0]!.gap.toNumber()).toBeCloseTo(-1200 * 4000, 6);
  });

  it('cash below its target takes part of the contribution', () => {
    const p = contributionPlan(m({ acciones_usd: 970, efectivo: 0 }), { acciones_usd: 0.97, efectivo: 0.03 }, dec(30));
    // Total 1000: stocks at their 970, cash short of its 30.
    expect(amounts(p.split)).toEqual({ efectivo: 30 });
    expect(p.months).toBe(1);
  });

  it('a dividend pairs with one withdrawal only', () => {
    const ctx = { ...stocks, ledger: [...stocks.ledger, tx('2026-03-01', 'usd', 'DIVIDEND', 10, { asset: 'AAA' }), tx('2026-03-01', 'usd', 'WITHDRAWAL', -10), tx('2026-03-01', 'usd', 'WITHDRAWAL', -10)] };
    expect(advise(ctx, 'USD', AS_OF).actions.find((x) => x.id === 'dividends')!.title).toBe('Sacaste US$\u00a010,00 de dividendos en el último año');
  });

  it('a price past the target says how far above it is', () => {
    const t = new Map<string, Asset>([...assets, ['AAA', { ...assets.get('AAA')!, target: '75' }]]);
    const a = advise({ ...stocks, book: { ...stocks.book, assets: t } }, 'USD', AS_OF);
    // 90 against a target of 75: 20 % above.
    expect(a.actions.find((x) => x.id === 'targets')!.finding).toBe('AAA Corp (precio 20 % por encima del objetivo)');
  });

  it('without peso rates the advice is taken in the view currency', () => {
    const usdOnly = { ...stocks, book: { ...stocks.book, fx: new FxTable() } };
    const a = advise(usdOnly, 'USD', AS_OF);
    expect(a.error).toBeUndefined();
    expect(a.home).toBe('USD');
    expect(a.netWorth.toNumber()).toBe(2750);
  });
});

describe('round two: the reserve, the mortgage, urgency and the figures behind them', () => {
  const rate = { date: '2020-01-01', perUsd: dec(4000), source: 'test' };
  const flat = new FxTable(100_000).set('COP', [rate]);
  const prop = (cash: number) => ({
    book: { accounts, assets, prices: new SeriesPriceSource().set('BBB', [{ date: '2026-01-31', close: dec(10), ccy: 'COP', source: 'test' }, { date: '2026-06-30', close: dec(10), ccy: 'COP', source: 'test' }]), fx: flat },
    ledger: [
      tx('2026-01-31', 'cop-prop', 'COMMITMENT', -2000, { asset: 'APTO' }),
      tx('2026-01-31', 'cop', 'DEPOSIT', 300 + cash),
      tx('2026-01-31', 'cop', 'BUY', -300, { asset: 'BBB', q: 30 }),
      ...['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'].flatMap((d) => [tx(d, 'cop-prop', 'DEPOSIT', 100), tx(d, 'cop-prop', 'CAPITAL_CALL', -100, { asset: 'APTO' })]),
      tx('2026-06-30', 'cop-prop', 'VALUATION', 2400, { asset: 'APTO', estimated: true }),
    ],
    benchmarks: [],
  });
  const profile = { ...presetProfile('crecimiento', AS_OF), monthly: '20', commitmentDue: '2027-06-30', emergencyMonths: 6 };

  it('the reserve stops at the due date: what is missing then is the minimum outside money', () => {
    // Owed at due 500, nothing held; 20 now + 11 × 20 = 240 gathered by then: a mortgage of at least 260.
    const a = advise(prop(0), 'COP', AS_OF, profile);
    expect(a.plan!.gatheredByDue.toNumber()).toBeCloseTo(240, 6);
    expect(a.plan!.onTime).toBe(false);
    expect(a.plan!.months).toBeUndefined();
    const c = a.actions.find((x) => x.id === 'commitment-plan')!;
    expect(c.evidence.find((e) => e.label.startsWith('Crédito o cesión mínimos'))!.value).toBe('$\u00a0260');
    expect(c.urgent).toBe(true);
    expect(a.actions[0]!.id).toBe('commitment-plan'); // dated within a year: first among the high ones
  });

  it('the mortgage payment, its weight in income, and what is left after the delivery', () => {
    // 260 at 0 % over 1 year: 21,67 a month; income 100, expenses 70 → 30 − 21,67 = 8,33 left.
    const a = advise(prop(0), 'COP', AS_OF, { ...profile, mortgageRate: 0, mortgageYears: 1, income: '100', expenses: '70' });
    const m = a.actions.find((x) => x.id === 'mortgage')!;
    expect(m.finding).toMatch(/La cuota sería de \$\s22 al mes, 22 % de tu ingreso/);
    expect(m.finding).toMatch(/te quedarían \$\s8 al mes para invertir/);
    expect(m.priority).toBe('alta'); // the balance falls due within a year
    // At 12 % E.A. over 1 year the monthly rate is 1,12^(1/12) − 1.
    const i = 1.12 ** (1 / 12) - 1;
    const b = advise(prop(0), 'COP', AS_OF, { ...profile, mortgageRate: 0.12, mortgageYears: 1, income: '60', expenses: '50' });
    const pay = (260 * i) / (1 - (1 + i) ** -12);
    expect(b.actions.find((x) => x.id === 'mortgage')!.impact!.toNumber()).toBeCloseTo(pay * 12, 6);
    expect(b.actions.find((x) => x.id === 'mortgage')!.title).toBe('La cuota del crédito supera el 30 % de tu ingreso');
  });

  it('cash in an account below zero offsets what can be set apart', () => {
    const ctx = prop(400);
    ctx.ledger.push(tx('2026-06-30', 'usd', 'WITHDRAWAL', -0.05)); // −200 pesos in the dollar account
    const a = advise(ctx, 'COP', AS_OF, profile);
    expect(a.reserve!.held.toNumber()).toBeCloseTo(200, 6);
    expect(a.growth.toNumber()).toBeGreaterThanOrEqual(0);
    expect(a.mix.every((r) => r.value.gte(0) || r.cls === 'efectivo')).toBe(true);
  });

  it('the crisis on net worth counts the property at its full value and the debt that does not fall', () => {
    const a = advise(prop(0), 'COP', AS_OF);
    // Liquid 300 of stocks (−150), property 2400 (−360): −510 on a net worth of 1200.
    expect(a.risk.crisisNetWorth).toBeCloseTo(-510 / 1200, 12);
  });

  it('a target mix within the tolerance blames today’s mix, not the target', () => {
    const p = { ...presetProfile('crecimiento', AS_OF), maxDrawdown: 0.45 };
    const r = advise(stocks, 'USD', AS_OF, p).actions.find((x) => x.id === 'risk');
    // Today: 93 % stocks → −46 %; the growth template loses 39 %.
    expect(r!.title).toBe('Tu portafolio de hoy puede caer más de lo que aguantas; tu objetivo no');
    const strict = advise(stocks, 'USD', AS_OF, { ...p, maxDrawdown: 0.3 }).actions.find((x) => x.id === 'risk');
    expect(strict!.title).toBe('Tu propia mezcla objetivo puede caer más de lo que aguantas');
  });

  it('positions without a price and a due date already past get their own points; no property value from nothing', () => {
    const stale = { ...stocks, book: { ...stocks.book, prices: new SeriesPriceSource().set('AAA', [px('2022-12-31', 100), px('2023-06-30', 120)]).set('IDX', [px('2026-06-30', 150)]).set('BENCH', [px('2022-12-31', 100), px('2023-06-30', 120), px('2026-06-30', 150)]) } };
    expect(advise(stale, 'USD', AS_OF).actions.find((x) => x.id === 'stale')!.finding).toMatch(/^AAA Corp: /);
    const past = advise(prop(0), 'COP', AS_OF, { ...profile, commitmentDue: '2026-05-31' });
    expect(past.actions.find((x) => x.id === 'commitment-due')!.title).toMatch(/ya pasó/);
    const noValuation = prop(0);
    noValuation.ledger = noValuation.ledger.filter((t) => t.type !== 'VALUATION');
    expect(advise(noValuation, 'COP', AS_OF).realEstate!.gross.toNumber()).toBe(2000); // the contract price
  });

  it('an estimated dividend moves the comparison by its value grown in the index', () => {
    const ctx = { ...stocks, ledger: [...stocks.ledger, tx('2022-12-31', 'usd', 'DIVIDEND', 10, { asset: 'AAA', estimated: true })] };
    // 10 dollars on 31 dec 2022, the index ×1,5 since: 15 dollars, 60.000 pesos.
    const d = advise(ctx, 'COP', AS_OF).actions.find((x) => x.id === 'data')!;
    expect(d.finding).toMatch(/empeoraría hasta \$\s60\.000 en Acciones USD/);
  });
});

describe('round three: rent against the loan, the budget, and what to sell first', () => {
  const rate = { date: '2020-01-01', perUsd: dec(4000), source: 'test' };
  const prop = {
    book: { accounts, assets, prices: new SeriesPriceSource().set('BBB', [{ date: '2026-01-31', close: dec(10), ccy: 'COP', source: 'test' }, { date: '2026-06-30', close: dec(10), ccy: 'COP', source: 'test' }]), fx: new FxTable(100_000).set('COP', [rate]) },
    ledger: [
      tx('2026-01-31', 'cop-prop', 'COMMITMENT', -2000, { asset: 'APTO' }),
      tx('2026-01-31', 'cop', 'DEPOSIT', 300),
      tx('2026-01-31', 'cop', 'BUY', -300, { asset: 'BBB', q: 30 }),
      ...['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'].flatMap((d) => [tx(d, 'cop-prop', 'DEPOSIT', 100), tx(d, 'cop-prop', 'CAPITAL_CALL', -100, { asset: 'APTO' })]),
      tx('2026-06-30', 'cop-prop', 'VALUATION', 2400, { asset: 'APTO', estimated: true }),
    ],
    benchmarks: [],
  };
  const profile = { ...presetProfile('crecimiento', AS_OF), monthly: '20', commitmentDue: '2027-06-30', emergencyMonths: 6, commitmentFunding: '500', mortgageRate: 0.1, mortgageYears: 10 };

  it('the appreciation that only breaks even, on the financed part and with one empty month', () => {
    // Rent 10 a month, costs 2: 11 × 10 − 12 × 2 = 86 a year, 3,6 % of 2400. Interest 10 % of 500 = 50 < 86: the rent covers it.
    const a = advise(prop, 'COP', AS_OF, { ...profile, propertyPlan: 'arrendar', rent: '10', rentCosts: '2' });
    const m = a.actions.find((x) => x.id === 'mortgage')!;
    expect(m.finding).toMatch(/rendiría 3,6 % neto al año sobre su valor estimado/);
    expect(m.finding).toMatch(/El arriendo neto cubre los intereses del crédito/);
    expect(m.priority).toBe('alta'); // due within a year
    // Rent 4: 44 − 24 = 20 a year. Interest of the first year on 500 at 10 % E.A. over 10 years: 12 payments minus what they repay.
    const i = 1.1 ** (1 / 12) - 1;
    const pay = (500 * i) / (1 - (1 + i) ** -120);
    const balance12 = 500 * (1 + i) ** 12 - (pay * ((1 + i) ** 12 - 1)) / i;
    const interest = 12 * pay - (500 - balance12);
    expect(interest).toBeCloseTo(46.49, 2); // less than 10 % of 500 (= 50): the balance falls during the year
    const b = advise(prop, 'COP', AS_OF, { ...profile, propertyPlan: 'arrendar', rent: '4', rentCosts: '2' });
    const breakEven = ((interest - 20) / 2400) * 100;
    expect(b.actions.find((x) => x.id === 'mortgage')!.finding).toContain(`al menos ${breakEven.toFixed(1).replace('.', ',')} % al año`);
  });

  it('no mortgage card when the reserve already covers the balance, and bad profile fields are refused', () => {
    const covered = advise(prop, 'COP', AS_OF, { ...profile, commitmentFunding: undefined, monthly: '100' });
    expect(covered.plan!.onTime).toBe(true);
    expect(covered.actions.some((x) => x.id === 'mortgage')).toBe(false);
    expect(profileProblem({ ...profile, income: 'x' })).toBe('El ingreso no es un número.');
    expect(profileProblem({ ...profile, mortgageRate: NaN })).toMatch(/tasa del crédito/);
    expect(profileProblem({ ...profile, emergencyMonths: NaN })).toMatch(/fondo de emergencia/);
  });

  it('money the budget leaves without a use is pointed out', () => {
    // Income 200, expenses 100: 100 spare; contribution 20 + payments 83,33 = 103,33 → within 10 % of income: nothing.
    expect(advise(prop, 'COP', AS_OF, { ...profile, income: '200', expenses: '100' }).actions.some((x) => x.id === 'budget')).toBe(false);
    // Expenses 50: 150 spare, 46,67 unused.
    const a = advise(prop, 'COP', AS_OF, { ...profile, income: '200', expenses: '50' });
    expect(a.actions.find((x) => x.id === 'budget')!.title).toBe('Te sobran $\u00a047 al mes que el plan no usa');
  });

  it('what to sell first: holdings of an overweight class below their cost, biggest loss first', () => {
    const p = { ...presetProfile('crecimiento', AS_OF), maxDrawdown: 0.45, monthly: '10' };
    const a = advise(stocks, 'USD', AS_OF, p);
    // AAA cost 2200, worth 1800: 400 dollars below cost; the index fund is above its cost.
    expect(a.actions.find((x) => x.id === 'risk')!.action).toMatch(/mira «Qué vender primero»/);
    const sell = a.actions.find((x) => x.id === 'sell')!;
    // Stocks 2550 against 55 % of 2750: 1037,50 above. AAA (worth 1800, 400 below cost) covers it in part: stop there.
    expect(sell.action).toMatch(/Vende unos US\$\s1\.037,50 de AAA Corp: .*realizas una pérdida de unos US\$\s230,56/);
    expect(sell.action).not.toMatch(/Index ETF/); // the index fund is the core, not a sale
    expect(sell.action).not.toMatch(/^1\)/);
    expect(a.actions.find((x) => x.id === 'taxes')!.action).not.toMatch(/AAA Corp/); // said once, in «Qué vender primero»
  });
});

describe('round four: one story across the cards', () => {
  const rate = { date: '2020-01-01', perUsd: dec(4000), source: 'test' };
  // Stocks 300 (BBB) of a liquid 300, owing 1500 at 83,33 a month: the reserve cannot be gathered with 20 a month.
  const prop = {
    book: { accounts, assets, prices: new SeriesPriceSource().set('BBB', [{ date: '2026-01-31', close: dec(10), ccy: 'COP', source: 'test' }, { date: '2026-06-30', close: dec(10), ccy: 'COP', source: 'test' }]), fx: new FxTable(100_000).set('COP', [rate]) },
    ledger: [
      tx('2026-01-31', 'cop-prop', 'COMMITMENT', -2000, { asset: 'APTO' }),
      tx('2026-01-31', 'cop', 'DEPOSIT', 300),
      tx('2026-01-31', 'cop', 'BUY', -300, { asset: 'BBB', q: 30 }),
      ...['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'].flatMap((d) => [tx(d, 'cop-prop', 'DEPOSIT', 100), tx(d, 'cop-prop', 'CAPITAL_CALL', -100, { asset: 'APTO' })]),
      tx('2026-06-30', 'cop-prop', 'VALUATION', 2400, { asset: 'APTO', estimated: true }),
    ],
    benchmarks: [],
  };
  const profile = { ...presetProfile('crecimiento', AS_OF), monthly: '20', commitmentDue: '2027-06-30', emergencyMonths: 6 };

  it('the minimum loan with and without selling the overweight, and the allocation card points to that sale', () => {
    const a = advise(prop, 'COP', AS_OF, profile);
    // Acciones COP 300 against a 10 % target of 300: 270 above it. Minimum loan 500 − 0 − 240 = 260 without selling, 0 selling the 270.
    const c = a.actions.find((x) => x.id === 'commitment-plan')!;
    expect(c.evidence.find((e) => e.label.startsWith('Crédito o cesión mínimos, vendiendo'))!.value).toBe('$\u00a00');
    expect(c.action).toMatch(/al menos \$\s260 si no vendes inversiones, o de \$\s0 si vendes los \$\s270/);
    expect(a.actions.find((x) => x.id === 'drift')!.action).toMatch(/Lo que tienes de más \(\$\s270 en Acciones COP\) conviene venderlo hacia la reserva: mira «Qué vender primero»/);
    expect(a.actions.find((x) => x.id === 'sell')!.priority).toBe('alta');
  });

  it('the loan card follows the reserve when the balance is due within a year, even before the loan is known', () => {
    const a = advise(prop, 'COP', AS_OF, profile);
    const ids = a.actions.map((x) => x.id);
    expect(a.actions.find((x) => x.id === 'mortgage')!.priority).toBe('alta');
    expect(ids.indexOf('commitment-plan')).toBeLessThan(ids.indexOf('mortgage'));
    expect(ids.indexOf('mortgage')).toBeLessThan(ids.indexOf('real-estate'));
  });

  it('the rent counted in the budget is the same one-empty-month average as in the yield', () => {
    const a = advise(prop, 'COP', AS_OF, { ...profile, commitmentFunding: '500', mortgageRate: 0, mortgageYears: 10, propertyPlan: 'arrendar', rent: '12', rentCosts: '0', income: '300', expenses: '100' });
    const m = a.actions.find((x) => x.id === 'mortgage')!;
    // 11 × 12 = 132 a year: 11 a month on average. Payment 500 / 120 = 4,17; left 200 − 4,17 + 11 = 206,83.
    expect(m.evidence.find((e) => e.label.startsWith('Arriendo neto esperado'))!.value).toBe('$\u00a011 al mes');
    expect(m.finding).toMatch(/te quedarían \$\s207 al mes para invertir/);
  });
});

describe('the tax cost of a foreign holding is in pesos at each purchase’s rate', () => {
  it('a stock down in dollars can be a gain in pesos', () => {
    // 10 shares at 100 dollars with the TRM at 3.700, sold 4 later; today at 95 dollars with the TRM at 4.100.
    const fx = new FxTable(100_000).set('COP', [{ date: '2024-01-01', perUsd: dec(3700), source: 'test' }, { date: '2026-06-01', perUsd: dec(4100), source: 'test' }]);
    const ctx = {
      book: { accounts, assets, prices: new SeriesPriceSource().set('AAA', [px('2024-01-02', 100), px('2026-06-30', 95)]), fx },
      ledger: [tx('2024-01-02', 'usd', 'DEPOSIT', 1000), tx('2024-01-02', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }), tx('2025-01-02', 'usd', 'SELL', 400, { asset: 'AAA', q: 4 })],
      benchmarks: [],
    };
    // Cost in pesos: 3.700.000, six tenths of it left after selling 4 of 10 → 2.220.000; worth 6 × 95 × 4.100 = 2.337.000: a gain.
    expect(homeCost(ctx, 'COP', AS_OF).get('usd|AAA')!.toNumber()).toBe(2_220_000);
    // In dollars the same holding is 30 below its cost of 600.
    expect(homeCost(ctx, 'USD', AS_OF).get('usd|AAA')!.toNumber()).toBe(600);
  });

  it('a sale without units closes the position', () => {
    const fx = new FxTable(100_000).set('COP', [{ date: '2024-01-01', perUsd: dec(3700), source: 'test' }]);
    const ctx = {
      book: { accounts, assets, prices: new SeriesPriceSource().set('AAA', [px('2024-01-02', 100)]), fx },
      ledger: [tx('2024-01-02', 'usd', 'DEPOSIT', 1000), tx('2024-01-02', 'usd', 'BUY', -1000, { asset: 'AAA', q: 10 }), tx('2025-01-02', 'usd', 'SELL', 900, { asset: 'AAA' })],
      benchmarks: [],
    };
    expect(homeCost(ctx, 'COP', AS_OF).get('usd|AAA')).toBeUndefined();
  });
});

describe('the sale is split class by class', () => {
  it('each class sells only what it has above its own target', () => {
    const cop = (d: string, c: number) => ({ date: d, close: dec(c), ccy: 'COP', source: 'test' });
    const a2 = new Map<string, Asset>([...assets, ['CRY', { id: 'CRY', name: 'Cripto COP', ccy: 'COP', bucket: 'cripto', pricing: 'market', symbol: 'CRY' }]]);
    const ctx = {
      book: { accounts, assets: a2, prices: new SeriesPriceSource().set('BBB', [cop('2025-01-02', 30), cop('2026-06-30', 24)]).set('CRY', [cop('2025-01-02', 30), cop('2026-06-30', 30)]), fx: new FxTable() },
      ledger: [
        tx('2025-01-02', 'cop', 'DEPOSIT', 12000),
        tx('2025-01-02', 'cop', 'BUY', -3000, { asset: 'BBB', q: 100 }),
        tx('2025-01-02', 'cop', 'BUY', -3000, { asset: 'CRY', q: 100 }),
      ],
      benchmarks: [],
    };
    // Today: BBB 2400 (600 below cost), crypto 3000, cash 6000 = 11.400. Targets: Colombian stocks 15 % (1.710), crypto 0 %.
    const profile = { ...presetProfile('moderado', AS_OF), maxDrawdown: 0.2, targets: { acciones_cop: 0.15, cripto: 0, renta_fija: 0.35, efectivo: 0.5 } };
    const sell = advise(ctx, 'COP', AS_OF, profile).actions.find((x) => x.id === 'sell')!;
    expect(sell.action).toMatch(/En Acciones COP: vende unos \$\s690 de BBB SA/);
    expect(sell.action).toMatch(/En Cripto: \$\s3\.000 que sobran/);
    expect(sell.action).not.toMatch(/completas BBB/);
  });
});
