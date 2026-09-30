import { describe, expect, it } from 'vitest';
import { forgetTickers, handle } from '../netlify/functions/fundamentals.mts';
import { parseCompanyFacts, secFundamentals } from '../src/data/sec.ts';
import type { RawFact, SecFactsReply } from '../src/data/sec.ts';
import { dec } from '../src/domain/money.ts';

// Synthetic company (made-up figures in the real companyfacts shape): fiscal year = calendar year, latest
// report a 10-Q for the first half of 2026. Amounts in millions below, stored in units.
const M = 1e6;
const f = (start: string | undefined, end: string, val: number, form = '10-Q', filed = '2026-07-30', accn = '0000000001-26-000002'): RawFact => ({
  ...(start ? { start } : {}),
  end,
  val,
  form,
  filed,
  accn,
});
const FY25 = ['2025-01-01', '2025-12-31'] as const;
const H126 = ['2026-01-01', '2026-06-30'] as const;
const H125 = ['2025-01-01', '2025-06-30'] as const;
const K = (start: string, end: string, val: number) => f(start, end, val, '10-K', '2026-02-10', '0000000001-26-000001');
/** Annual, first half 2026 and first half 2025 of a flow. */
const flow = (fy: number, h126: number, h125: number) => [K(...FY25, fy), f(...H126, h126), f(...H125, h125)];

function company(): SecFactsReply {
  return {
    cik: 1,
    entity: 'Demo Corp',
    facts: {
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          USD: [
            ...flow(1000 * M, 600 * M, 500 * M),
            // An earlier filing of the same year, restated later: the latest filing wins.
            f(...FY25, 990 * M, '10-K', '2026-01-15', '0000000001-26-000000'),
            // A foreign interim report is not read.
            f('2026-01-01', '2026-09-30', 999 * M, '6-K', '2026-10-01'),
          ],
        },
        // The concept used before: its 2020 figure is the one five years back.
        SalesRevenueNet: { USD: [K('2020-01-01', '2020-12-31', 500 * M)] },
        OperatingIncomeLoss: { USD: flow(200 * M, 130 * M, 100 * M) },
        DepreciationDepletionAndAmortization: { USD: flow(50 * M, 30 * M, 25 * M) },
        // Net income moved to another concept this year (as some filers do): the one reaching the period is used.
        NetIncomeLoss: { USD: [K(...FY25, 150 * M)] },
        ProfitLoss: { USD: flow(150 * M, 90 * M, 80 * M) },
        EarningsPerShareDiluted: { 'USD/shares': flow(1.5, 0.9, 0.8) },
        IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: { USD: flow(190 * M, 115 * M, 100 * M) },
        IncomeTaxExpenseBenefit: { USD: flow(40 * M, 25 * M, 20 * M) },
        StockholdersEquity: { USD: [f(undefined, '2026-06-30', 800 * M), f(undefined, '2025-06-30', 700 * M, '10-Q', '2025-07-30')] },
        CashAndCashEquivalentsAtCarryingValue: { USD: [f(undefined, '2026-06-30', 100 * M)] },
        ShortTermInvestments: { USD: [f(undefined, '2026-06-30', 50 * M)] },
        LongTermDebt: { USD: [f(undefined, '2026-06-30', 300 * M)] },
        ShortTermBorrowings: { USD: [f(undefined, '2026-06-30', 20 * M)] },
        WeightedAverageNumberOfDilutedSharesOutstanding: { shares: [f('2026-04-01', '2026-06-30', 100 * M), f(...H126, 100.5 * M), K(...FY25, 101 * M), f(...H125, 102 * M)] },
      },
    },
  };
}

describe('SEC figures', () => {
  const sec = parseCompanyFacts(company(), '2026-09-30');

  it('builds the last twelve months from the annual report and the year-to-date figures, with their filing', () => {
    expect(sec.period).toBe('2026-06-30');
    expect(sec.currency).toBe('USD');
    expect(sec.annualOnly).toBe(false);
    // 1000 + 600 − 500 (the restated 1000, not the first 990; the 6-K is ignored).
    expect(sec.values!.revenue).toMatchObject({ value: String(1100 * M), start: '2025-07-01', end: '2026-06-30', form: '10-Q', ttm: true });
    expect(sec.values!.netIncome).toMatchObject({ value: String(160 * M), concept: 'ProfitLoss' });
    expect(sec.values!.revenueFY5).toMatchObject({ value: String(500 * M), concept: 'SalesRevenueNet', end: '2020-12-31' });
    expect(sec.values!.debt).toMatchObject({ value: String(320 * M), concept: 'LongTermDebt + ShortTermBorrowings' });
    expect(sec.values!.cash).toMatchObject({ value: String(150 * M) });
    expect(sec.values!.shares!.start).toBe('2026-04-01');
    expect(sec.gaps).toEqual({});
  });

  it('computes the Indicadores ratios by hand', () => {
    const r = secFundamentals(sec, 'USD', dec(32));
    expect(r.f).toEqual({
      salesGrowth5y: '0.148698', // (1000 / 500)^(1/5) − 1
      ebitdaMargin: '0.259091', // (230 + 55) / 1100
      netMargin: '0.145455', // 160 / 1100
      debtToCapital: '0.285714', // 320 / (320 + 800)
      roe: '0.213333', // 160 / ((800 + 700) / 2)
      roic: '0.185064', // 230 × (1 − 45/205) / (320 + 800 − 150)
      eps: '1.6', // 1.5 + 0.9 − 0.8
      netDebt: '170', // (320 − 150) in millions
      pe: '20', // 32 / 1.6
      evEbitda: '11.8246', // (32 × 100 + 320 − 150) / 285
    });
    expect(r.missing).toEqual({});
  });

  it('leaves a figure missing, with the reason, when the latest report does not carry it or it makes no sense', () => {
    const c = company();
    delete c.facts['us-gaap']!.DepreciationDepletionAndAmortization;
    c.facts['us-gaap']!.EarningsPerShareDiluted = { 'USD/shares': flow(-1.5, -0.9, -0.8) };
    // Operating income last reported for 2025: it does not reach the period.
    c.facts['us-gaap']!.OperatingIncomeLoss = { USD: [K(...FY25, 200 * M)] };
    const s = parseCompanyFacts(c, '2026-09-30');
    const r = secFundamentals(s, 'USD', dec(32));
    expect(r.missing.ebitdaMargin).toBe('no reporta utilidad operativa');
    expect(r.missing.roic).toBe('no reporta utilidad operativa');
    expect(r.missing.pe).toBe('utilidad por acción negativa');
    expect(r.f.eps).toBe('-1.6');
    expect(secFundamentals(sec, 'USD').missing.pe).toBe('no hay precio');
  });

  it('a foreign filer: annual figures in its own currency, and nothing per share or priced', () => {
    const c: SecFactsReply = {
      cik: 2,
      entity: 'Demo A/S',
      facts: {
        'ifrs-full': {
          Revenue: { DKK: [K('2025-01-01', '2025-12-31', 300 * M), K('2020-01-01', '2020-12-31', 150 * M)].map((x) => ({ ...x, form: '20-F' })) },
          ProfitLossAttributableToOwnersOfParent: { DKK: [{ ...K(...FY25, 90 * M), form: '20-F' }] },
          DilutedEarningsLossPerShare: { 'DKK/shares': [{ ...K(...FY25, 20), form: '20-F' }] },
        },
      },
    };
    const s = parseCompanyFacts(c, '2026-09-30');
    expect(s).toMatchObject({ taxonomy: 'ifrs-full', currency: 'DKK', annualOnly: true, period: '2025-12-31' });
    const r = secFundamentals(s, 'USD', dec(100));
    expect(r.f.netMargin).toBe('0.3');
    expect(r.f.salesGrowth5y).toBe('0.148698');
    expect(r.missing.pe).toBe('el reporte está en DKK por acción local, no comparable con USD');
    expect(r.missing.netDebt).toBe('el reporte está en DKK, no comparable con USD');
    expect(r.f.eps).toBeUndefined();
  });

  it('a fund without financial statements, or a year to date without last year’s, gives no figures', () => {
    expect(parseCompanyFacts({ cik: 3, entity: 'Demo ETF', facts: {} }, '2026-09-30').error).toMatch(/no tiene estados financieros/);
    const c = company();
    c.facts['us-gaap']!.RevenueFromContractWithCustomerExcludingAssessedTax = { USD: [K(...FY25, 1000 * M), f(...H126, 600 * M)] };
    delete c.facts['us-gaap']!.SalesRevenueNet;
    // Without the first half of 2025 the last twelve months cannot be built: the annual figure is not passed off as current.
    const s = parseCompanyFacts(c, '2026-09-30');
    expect(s.values?.revenue?.end).not.toBe('2026-06-30');
  });
});

describe('SEC figures, edge cases', () => {
  it('a 52/53-week fiscal year: the year to date and last year’s span line up within a week', () => {
    const c: SecFactsReply = {
      cik: 4,
      entity: 'Retail Demo',
      facts: {
        'us-gaap': {
          Revenues: {
            USD: [
              f('2024-01-29', '2025-02-02', 1000 * M, '10-K', '2025-03-20'),
              f('2025-02-03', '2025-08-03', 520 * M, '10-Q', '2025-09-01'),
              f('2024-01-29', '2024-07-28', 480 * M, '10-Q', '2025-09-01'),
            ],
          },
        },
      },
    };
    const s = parseCompanyFacts(c, '2025-09-30');
    expect(s.values!.revenue).toMatchObject({ value: String(1040 * M), start: '2024-07-29', end: '2025-08-03', ttm: true });
  });

  it('debt without a total: non-current plus current, or plus its current maturities and short-term borrowings; D&A as depreciation plus amortization; last year’s equity a few days off', () => {
    const c = company();
    const g = c.facts['us-gaap']!;
    delete g.LongTermDebt;
    delete g.DepreciationDepletionAndAmortization;
    g.LongTermDebtNoncurrent = { USD: [f(undefined, '2026-06-30', 250 * M)] };
    g.LongTermDebtCurrent = { USD: [f(undefined, '2026-06-30', 30 * M)] };
    g.Depreciation = { USD: flow(40 * M, 24 * M, 20 * M) };
    g.AmortizationOfIntangibleAssets = { USD: flow(10 * M, 6 * M, 5 * M) };
    g.StockholdersEquity = { USD: [f(undefined, '2026-06-30', 800 * M), f(undefined, '2025-07-12', 700 * M, '10-Q', '2025-08-01')] };
    let s = parseCompanyFacts(c, '2026-09-30');
    expect(s.values!.debt).toMatchObject({ value: String(300 * M), concept: 'LongTermDebtNoncurrent + LongTermDebtCurrent + ShortTermBorrowings' });
    expect(s.values!.da).toMatchObject({ value: String(55 * M), concept: 'Depreciation + AmortizationOfIntangibleAssets', end: '2026-06-30' });
    expect(s.values!.equityPrior!.end).toBe('2025-07-12');
    g.DebtCurrent = { USD: [f(undefined, '2026-06-30', 45 * M)] };
    s = parseCompanyFacts(c, '2026-09-30');
    expect(s.values!.debt).toMatchObject({ value: String(295 * M), concept: 'LongTermDebtNoncurrent + DebtCurrent' });
    g.StockholdersEquity = { USD: [f(undefined, '2026-06-30', 800 * M), f(undefined, '2025-08-05', 700 * M, '10-Q', '2025-08-20')] };
    expect(parseCompanyFacts(c, '2026-09-30').gaps!.equityPrior).toBe('no reporta el patrimonio de un año antes');
  });

  it('a split between the annual report and the latest quarter leaves EPS missing instead of mixing bases', () => {
    const c = company();
    // 10:1 split in 2026: the quarter restates the first half of 2025 per share, the 2025 annual is not.
    c.facts['us-gaap']!.EarningsPerShareDiluted = { 'USD/shares': flow(10, 0.6, 0.5) };
    c.facts['us-gaap']!.WeightedAverageNumberOfDilutedSharesOutstanding = {
      shares: [K(...FY25, 10 * M), f(...H125, 100 * M), f(...H126, 100.5 * M), f('2026-04-01', '2026-06-30', 100 * M)],
    };
    const s = parseCompanyFacts(c, '2026-09-30');
    expect(s.values!.eps).toBeUndefined();
    expect(s.gaps!.eps).toMatch(/posible split/);
    const r = secFundamentals(s, 'USD', dec(20));
    expect(r.missing.pe).toMatch(/posible split/);
    expect(r.f.pe).toBeUndefined();

    // The count under the other concept (companies with losses often report only that one) is used too.
    c.facts['us-gaap']!.WeightedAverageNumberOfShareOutstandingBasicAndDiluted = { shares: c.facts['us-gaap']!.WeightedAverageNumberOfDilutedSharesOutstanding!.shares! };
    delete c.facts['us-gaap']!.WeightedAverageNumberOfDilutedSharesOutstanding;
    expect(parseCompanyFacts(c, '2026-09-30').gaps!.eps).toMatch(/posible split/);
    // With EPS in two currencies, the report's is the one checked.
    c.facts['us-gaap']!.EarningsPerShareDiluted = { 'CNY/shares': flow(70, 4, 3.5), 'USD/shares': flow(10, 0.6, 0.5) };
    expect(parseCompanyFacts(c, '2026-09-30').gaps!.eps).toMatch(/posible split/);
    // With no share count at all the split cannot be ruled out: EPS stays missing, with why.
    delete c.facts['us-gaap']!.WeightedAverageNumberOfShareOutstandingBasicAndDiluted;
    expect(parseCompanyFacts(c, '2026-09-30').gaps!.eps).toMatch(/no se pudo verificar que no haya un split/);
  });

  it('a 20-F in US dollars still shows nothing per share: an ADR is not a local share', () => {
    const c: SecFactsReply = {
      cik: 5,
      entity: 'Demo plc',
      facts: {
        'ifrs-full': {
          Revenue: { USD: [{ ...K(...FY25, 300 * M), form: '20-F' }] },
          DilutedEarningsLossPerShare: { 'USD/shares': [{ ...K(...FY25, 0.5), form: '20-F' }] },
          Borrowings: { USD: [{ ...f(undefined, '2025-12-31', 100 * M), form: '20-F' }] },
          CashAndCashEquivalents: { USD: [{ ...f(undefined, '2025-12-31', 40 * M), form: '20-F' }] },
        },
      },
    };
    const r = secFundamentals(parseCompanyFacts(c, '2026-09-30'), 'USD', dec(30));
    expect(r.missing.eps).toMatch(/empresa extranjera/);
    expect(r.missing.pe).toMatch(/empresa extranjera/);
    expect(r.f.netDebt).toBe('60');
  });

  it('a company that moved to IFRS is read from its latest reports', () => {
    const c: SecFactsReply = {
      cik: 6,
      entity: 'Switch Co',
      facts: {
        'us-gaap': { Revenues: { USD: [K('2019-01-01', '2019-12-31', 100 * M)] } },
        'ifrs-full': { Revenue: { EUR: [{ ...K(...FY25, 200 * M), form: '20-F' }] } },
      },
    };
    expect(parseCompanyFacts(c, '2026-09-30')).toMatchObject({ taxonomy: 'ifrs-full', currency: 'EUR', period: '2025-12-31' });
  });

  it('a cut-off date before the report does not divide an old price by newer earnings', () => {
    const r = secFundamentals(parseCompanyFacts(company(), '2026-09-30'), 'USD', dec(32), '2026-03-31');
    expect(r.missing.pe).toBe('la fecha de corte es anterior a este reporte');
    expect(r.missing.evEbitda).toBe('la fecha de corte es anterior a este reporte');
    expect(r.f.netMargin).toBe('0.145455');
  });
});

describe('the fundamentals function', () => {
  const agent = 'Demo test@example.com';
  const req = (q: string, h: Record<string, string> = {}) => new Request(`http://site/api/fundamentals?${q}`, { headers: h });
  const now = () => Promise.resolve();
  const sec = (asked: string[]) =>
    (async (url: string, init?: RequestInit) => {
      asked.push(`${String(url)} ${(init?.headers as Record<string, string>)['user-agent']}`);
      if (String(url).endsWith('company_tickers.json')) return Response.json({ 0: { cik_str: 1, ticker: 'DEMO' }, 1: { cik_str: 9, ticker: 'NOFACTS' } });
      if (String(url).includes('CIK0000000009')) return new Response('', { status: 404 });
      const c = company().facts['us-gaap']!;
      return Response.json({
        cik: 1,
        entityName: 'Demo Corp',
        facts: { 'us-gaap': { ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { units: v }])), Goodwill: { units: { USD: [f(undefined, '2026-06-30', 5)] } } } },
      });
    }) as typeof fetch;

  it('relays only the concepts and reports the app reads, with the contact from the environment', async () => {
    forgetTickers();
    const asked: string[] = [];
    const res = await handle(req('t=DEMO&t=NOFACTS&t=ZZZ'), sec(asked), now, agent);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, SecFactsReply & { error?: string }>;
    expect(asked[0]).toBe(`https://www.sec.gov/files/company_tickers.json ${agent}`);
    expect(asked[1]).toBe(`https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json ${agent}`);
    expect(Object.keys(body.DEMO!.facts['us-gaap']!)).not.toContain('Goodwill');
    expect(body.DEMO!.facts['us-gaap']!.RevenueFromContractWithCustomerExcludingAssessedTax!.USD!.some((x) => x.form === '6-K')).toBe(false);
    expect(parseCompanyFacts(body.DEMO!, '2026-09-30').values!.revenue!.value).toBe(String(1100 * M));
    expect(parseCompanyFacts(body.NOFACTS!, '2026-09-30').error).toMatch(/no tiene estados financieros/);
    expect(body.ZZZ!.error).toMatch(/no tiene una empresa con el símbolo ZZZ/);
  });

  it('refuses other sites, other methods, too many tickers, bad ones, and a missing contact', async () => {
    const asked: string[] = [];
    expect((await handle(req('t=DEMO', { 'sec-fetch-site': 'cross-site' }), sec(asked), now, agent)).status).toBe(403);
    expect((await handle(new Request('http://site/api/fundamentals?t=DEMO', { method: 'POST' }), sec(asked), now, agent)).status).toBe(405);
    expect((await handle(req('t=A&t=B&t=C&t=D'), sec(asked), now, agent)).status).toBe(400);
    const noAgent = await handle(req('t=DEMO'), sec(asked), now, undefined);
    expect(noAgent.status).toBe(500);
    expect(((await noAgent.json()) as { error: string }).error).toMatch(/SEC_USER_AGENT/);
    const bad = (await (await handle(req('t=demo%2F..'), sec(asked), now, agent)).json()) as Record<string, { error: string }>;
    expect(Object.values(bad)[0]!.error).toMatch(/Símbolo inválido/);
    expect(asked).toEqual([]);
  });
});
