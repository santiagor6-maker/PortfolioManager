import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLedgerCsv } from '../src/data/csv.ts';
import { emptyDataset, toStored } from '../src/data/json.ts';
import type { Dataset } from '../src/data/json.ts';
import { readFxRows, readPriceRows } from '../src/data/load.ts';
import { accountSnapshot, checkAssetPatch, checkFxRows, checkLedgerRows, checkPriceRows, closeStatus, lastClosableMonth } from '../src/app/checks.ts';
import { LedgerError } from '../src/domain/holdings.ts';
import { contextOf } from '../src/app/context.ts';
import { tracking } from '../src/app/tracking.ts';
import { tx } from './helpers.ts';

const read = (f: string) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');

/** The synthetic sample as the app stores it (a backup). Prices and TRM run to 2025-07-08. */
function sample(): Dataset {
  const b = JSON.parse(read('book.json'));
  return {
    ...emptyDataset(),
    accounts: b.accounts,
    assets: b.assets,
    benchmarks: b.benchmarks,
    ledger: parseLedgerCsv(read('ledger.csv')).map((t, i) => toStored({ ...t, id: `s${i}` })),
    prices: readPriceRows(read('prices.csv')),
    fx: readFxRows(read('fx.csv')),
  };
}

const TODAY = '2025-07-10';
const codes = (fs: { code: string }[]) => fs.map((f) => f.code);

describe('month-end close status', () => {
  it('June: prices and TRM are in; only the property list price is missing', () => {
    const d = sample();
    const s = closeStatus(d, contextOf(d), '2025-06', TODAY);
    expect(s.month).toBe('2025-06-30');
    expect(s.error).toBeUndefined();
    expect(s.missing).toEqual([]);
    expect(s.priced).toBe(3);
    expect(s.due.map((x) => x.asset)).toEqual(['APTO-DEMO']);
    expect(s.due[0]!.previous?.date).toBe('2025-05-31');
    expect(s.fx).toEqual([{ ccy: 'COP', last: '2025-06-30', stale: false }]);
    expect(s.benchmarks).toEqual([{ symbol: 'BENCH:DEMO-TR', name: 'Índice demo (retorno total)', last: '2025-06-30' }]);
    // Same figure as the Seguimiento grid.
    const t = tracking(contextOf(d), 'COP', TODAY);
    expect(s.total!.eq(t.total.cells[t.months.indexOf('2025-06-30')]!.value)).toBe(true);
  });

  it('May is complete', () => {
    const d = sample();
    const s = closeStatus(d, contextOf(d), '2025-05-31', TODAY);
    expect([s.missing.length, s.stale.length, s.due.length, s.error]).toEqual([0, 0, 0, undefined]);
  });

  it('a price 6–10 days old is stale; older than 10 days it is missing (valued at cost)', () => {
    const d = sample();
    d.prices = d.prices.filter((p) => !(p.symbol === 'SMPL' && p.date > '2025-06-22') && !(p.symbol === 'ANDES' && p.date > '2025-06-10'));
    const s = closeStatus(d, contextOf(d), '2025-06', TODAY);
    expect(s.stale.map((q) => [q.symbol, q.last])).toEqual([['SMPL', '2025-06-20']]);
    expect(s.missing.map((q) => [q.symbol, q.ccy, q.last])).toEqual([['ANDES', 'COP', '2025-06-10']]);
  });

  it('a TRM more than 5 days old at the month-end is flagged (the engine would still use it)', () => {
    const d = sample();
    const old = { ...d, fx: d.fx.filter((r) => !(r.date > '2025-05-22' && r.date <= '2025-05-31')) };
    const s = closeStatus(old, contextOf(old), '2025-05', TODAY);
    expect(s.error).toBeUndefined();
    expect(s.fx).toEqual([{ ccy: 'COP', last: '2025-05-22', stale: true }]);
  });

  it('a month that has not ended, or without TRM, cannot be valued', () => {
    const d = sample();
    expect(closeStatus(d, contextOf(d), '2025-07', TODAY).error).toBe('El mes todavía no termina');
    const noTrm = { ...d, fx: d.fx.filter((r) => r.date < '2025-06-15') };
    const s = closeStatus(noTrm, contextOf(noTrm), '2025-06', TODAY);
    expect(s.error).toMatch(/Sin tasa COP\/USD vigente/);
    expect(s.total).toBeUndefined();
  });

  it('the month to close is the last one already over', () => {
    expect(lastClosableMonth('2025-07-10')).toBe('2025-06-30');
    expect(lastClosableMonth('2025-07-31')).toBe('2025-07-31');
    expect(lastClosableMonth('2025-03-01')).toBe('2025-02-28');
  });
});

describe('new movements (e.g. from a broker statement)', () => {
  const d = sample();
  const ctx = contextOf(d);
  const ok = { ccy: 'USD' };

  it('rows are validated in order: a buy then its sale in the same file is fine', () => {
    const rows = [
      tx('2025-07-01', 'broker-usd', 'BUY', -505, { ...ok, asset: 'ACME', q: 12 }),
      tx('2025-07-02', 'broker-usd', 'SELL', 1500, { ...ok, asset: 'ACME', q: 42 }),
    ];
    expect(checkLedgerRows(ctx, rows, TODAY)).toEqual([]);
  });

  it('selling more than held, an unknown account or a future date is an error', () => {
    const f = checkLedgerRows(ctx, [
      tx('2025-07-02', 'broker-usd', 'SELL', 1500, { ...ok, asset: 'ACME', q: 31 }),
      tx('2025-07-02', 'nope', 'DEPOSIT', 10, ok),
      tx('2025-07-11', 'broker-usd', 'DEPOSIT', 10, ok),
    ], TODAY);
    expect(codes(f)).toEqual(['OVERSELL', 'ACCOUNT', 'FUTURE_DATE']);
    expect(f[0]!.ref).toBe('fila 1 · 2025-07-02 SELL ACME 1500 USD');
  });

  it('the account after the new rows, to compare with the statement closing balances', () => {
    const buy = tx('2025-07-01', 'broker-usd', 'BUY', -505, { ...ok, asset: 'ACME', q: 12 });
    const snap = accountSnapshot(ctx, 'broker-usd', '2025-07-05', [buy]);
    expect(snap.positions.map((p) => [p.asset, p.qty.toString()])).toEqual([['ACME', '42'], ['COPY-TECH', '0'], ['SMPL', '28']]);
    expect(snap.cash!.eq(accountSnapshot(ctx, 'broker-usd', '2025-07-05').cash!.minus(505))).toBe(true);
    expect(() => accountSnapshot(ctx, 'broker-usd', '2025-07-05', [tx('2025-07-02', 'broker-usd', 'SELL', 1, { ...ok, asset: 'ACME', q: 31 })])).toThrow(LedgerError);
  });

  it('a transfer needs its other leg, in the ledger or in the same file', () => {
    const out = tx('2025-07-01', 'broker-cop', 'TRANSFER_OUT', -2200000, { ccy: 'COP', transferId: 'T9' });
    const inn = tx('2025-07-03', 'broker-usd', 'TRANSFER_IN', 510, { ...ok, transferId: 'T9' });
    const dep = tx('2025-07-01', 'broker-cop', 'DEPOSIT', 2200000, { ccy: 'COP' });
    expect(checkLedgerRows(ctx, [dep, out, inn], TODAY)).toEqual([]);
    expect(codes(checkLedgerRows(ctx, [dep, out], TODAY))).toEqual(['TRANSFER_UNPAIRED']);
    expect(codes(checkLedgerRows(ctx, [{ ...inn, transferId: undefined }], TODAY))).toEqual(['TRANSFER_NO_ID']);
  });

  it('a movement already in the ledger is a duplicate; a used id is an error', () => {
    const f = checkLedgerRows(ctx, [tx('2025-03-12', 'broker-usd', 'DIVIDEND', '11.20', { ...ok, asset: 'SMPL', id: 's0' })], TODAY);
    expect(codes(f)).toEqual(['DUP_ID', 'DUPLICATE']);
    expect(f.map((x) => x.level)).toEqual(['error', 'warning']);
  });
});

describe('quotes and exchange rates to import', () => {
  const d = sample();
  const prices = (csv: string) => checkPriceRows(d, readPriceRows(`symbol,date,close,ccy,source\n${csv}`), TODAY);
  const fx = (csv: string) => checkFxRows(d, readFxRows(`ccy,date,per_usd,source\n${csv}`), TODAY);

  it('a sourced close in the asset currency passes', () => {
    expect(prices('SMPL,2025-07-09,104.5,USD,Nasdaq cierre oficial\nBENCH:DEMO-TR,2025-07-09,5240,USD,S&P DJI')).toEqual([]);
  });

  it('every quote needs a source, a past date, a positive close and the asset currency', () => {
    expect(codes(prices('SMPL,2025-07-09,104.5,USD,'))).toEqual(['SOURCE']);
    expect(codes(prices('SMPL,2025-07-11,104.5,USD,x'))).toEqual(['FUTURE_DATE']);
    expect(codes(prices('SMPL,2025-07-09,0,USD,x'))).toEqual(['CLOSE']);
    expect(codes(prices('ANDES,2025-07-09,12000,USD,x'))).toContain('CCY');
    expect(codes(prices('SMPL,2025-07-09,104.5,USD,x\nSMPL,2025-07-09,104.6,USD,x'))).toEqual(['DUPLICATE']);
  });

  it('flags a symbol nothing uses, a replaced close and a jump that looks like a typo or a split', () => {
    expect(codes(prices('ZZZ,2025-07-09,1,USD,x'))).toEqual(['UNKNOWN_SYMBOL']);
    expect(codes(prices('SMPL,2025-07-08,1.5,USD,x'))).toEqual(['REPLACES', 'JUMP']);
    const j = prices('SMPL,2025-07-09,1045,USD,x')[0]!;
    expect(j.code).toBe('JUMP');
    expect(j.message).toMatch(/^Cambia \+855\.6 % frente a 109\.36 del 2025-07-08/);
  });

  it('rates: a pair is inverted on read; an inverted TRM is flagged', () => {
    expect(fx('COP,2025-07-09,4330.1,Banco de la República')).toEqual([]);
    expect(codes(fx('EUR/USD,2025-07-09,1.17,BCE'))).toEqual([]);
    expect(codes(fx('COP,2025-07-09,0.000231,x'))).toEqual(['JUMP']);
    expect(codes(fx('COP,2025-07-09,4330.1,'))).toEqual(['SOURCE']);
    expect(() => readFxRows('ccy,date,per_usd,source\nEUR/USD,2025-07-09,0,x')).toThrow(/positiva/);
    expect(codes(prices('SMPL,2025-07-09,104.5,usd,x'))).toContain('CCY');
  });
});

describe('accounts and assets file (research, thesis)', () => {
  const d = sample();
  const smpl = d.assets.find((a) => a.id === 'SMPL')!;
  const patch = (assets: unknown[], accounts: unknown[] = []) => checkAssetPatch(d, JSON.stringify({ accounts, assets }), TODAY);
  const moat = { source: 'Morningstar', rating: 'wide', asOf: '2025-07-01', url: 'https://www.morningstar.com/stocks/xnas/smpl/quote' };

  it('an unchanged asset changes nothing', () => {
    expect(patch([smpl])).toEqual({ findings: [], changes: [] });
  });

  it('a dated, linked moat rating is a clean change; kept ratings are not re-judged', () => {
    // The sample's existing rating has no link: it is kept as it was, so it raises nothing.
    const r = patch([{ ...smpl, moats: [...smpl.moats!, moat] }]);
    expect(r.findings).toEqual([]);
    expect(r.changes).toEqual([{ asset: 'SMPL', field: 'moats', before: smpl.moats, after: [...smpl.moats!, moat] }]);
  });

  it('dropping a provider is flagged; updating its rating is not', () => {
    expect(codes(patch([{ ...smpl, moats: [moat] }]).findings)).toEqual(['MOAT_DROPPED']);
    const updated = { ...smpl.moats![0]!, rating: 'narrow', asOf: '2025-07-05', url: 'https://example.com/r' };
    expect(patch([{ ...smpl, moats: [updated] }]).findings).toEqual([]);
  });

  it('a rating needs a provider, a past date and a valid category or score', () => {
    const r = patch([{ ...smpl, moats: [...smpl.moats!, { source: 'GuruFocus', score: 11 }, { source: '', rating: 'huge', asOf: '2025-08-01', url: 'http://x' }, { source: 'X', asOf: '2025-07-01' }] }]);
    expect(codes(r.findings)).toEqual(['MOAT_DATE', 'MOAT_SCORE', 'MOAT_NO_URL', 'MOAT_SOURCE', 'MOAT_DATE', 'MOAT_RATING', 'MOAT_URL', 'MOAT_EMPTY', 'MOAT_NO_URL']);
  });

  it("warns when the file would change the user's own call or erase a field", () => {
    const withTarget = { ...smpl, target: '120' };
    const d2 = { ...d, assets: d.assets.map((a) => (a.id === 'SMPL' ? withTarget : a)) };
    const patch2 = (a: unknown) => checkAssetPatch(d2, JSON.stringify({ accounts: [], assets: [a] }), TODAY);
    const { target: _, ...noTarget } = withTarget;
    expect(codes(patch2({ ...withTarget, target: '999' }).findings)).toEqual(['USER_FIELD']);
    expect(codes(patch2(noTarget).findings)).toEqual(['DROPS_FIELD']);
    expect(codes(patch2({ ...withTarget, bucket: 'cripto' }).findings)).toEqual(['STRUCTURAL']);
    expect(codes(patch2({ ...withTarget, target: '-1' }).findings)).toEqual(['USER_FIELD', 'TARGET']);
  });

  it('fundamentals need their source and date; ratios are decimal strings', () => {
    const f = { ...smpl.fundamentals, asOf: undefined, source: undefined, roe: '18%' };
    expect(codes(patch([{ ...smpl, fundamentals: f }]).findings)).toEqual(['FUND_DATE', 'FUND_SOURCE', 'FUND_NUMBER']);
    const ok = { asOf: '2025-06-30', source: 'SEC 10-K', roe: '0.18', stars: 4, cap: 'large', style: 'blend' };
    expect(patch([{ ...smpl, fundamentals: ok }]).findings).toEqual([]);
  });

  it('new assets and accounts are flagged; a malformed file is rejected', () => {
    expect(codes(patch([{ id: 'NEW', name: 'Nueva', ccy: 'USD', bucket: 'acciones_usd', pricing: 'market', symbol: 'NEW' }]).findings)).toEqual(['NEW_ASSET']);
    expect(codes(patch([{ id: 'X', name: 'X', ccy: 'USD', bucket: 'acciones_usd', pricing: 'market' }]).findings)).toEqual(['SYMBOL', 'NEW_ASSET']);
    expect(codes(patch([], [{ id: 'broker-usd', name: 'Otro', ccy: 'USD' }]).findings)).toEqual(['ACCOUNT_CHANGED']);
    expect(codes(checkAssetPatch(d, '{"assets": []}', TODAY).findings)).toEqual(['SHAPE']);
    expect(codes(checkAssetPatch(d, '{"accounts": [], "assets": [null]}', TODAY).findings)).toEqual(['ASSET']);
  });

  it('a new asset needs a valid currency with rates; a new class or a shared symbol is flagged', () => {
    const base = { id: 'NEW', name: 'Nueva', bucket: 'acciones_usd', pricing: 'market', symbol: 'NEW' };
    expect(codes(patch([{ ...base, ccy: 'usd' }]).findings)).toEqual(['CCY', 'NEW_ASSET']);
    expect(codes(patch([{ ...base, ccy: 'EUR' }]).findings)).toEqual(['NO_FX', 'NEW_ASSET']);
    expect(codes(patch([{ ...base, ccy: 'COP', bucket: 'acciones-usd', symbol: 'SMPL' }]).findings)).toEqual(['BUCKET', 'SYMBOL_USED', 'NEW_ASSET']);
    expect(codes(checkAssetPatch(d, 'nope', TODAY).findings)).toEqual(['JSON']);
  });
});
