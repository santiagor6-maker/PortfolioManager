import { addDays, isIsoDate, monthEnd } from '../domain/dates.ts';
import type { IsoDate } from '../domain/dates.ts';
import { dec } from '../domain/money.ts';
import type { Decimal } from '../domain/money.ts';
import { holdingsAt } from '../domain/holdings.ts';
import { valuationsDue } from '../domain/monthlyClose.ts';
import type { ValuationDue } from '../domain/monthlyClose.ts';
import type { Asset, Transaction } from '../domain/types.ts';
import { validateTransaction } from '../domain/validate.ts';
import type { BookFile } from '../data/load.ts';
import type { Dataset, MonthClose, StoredPrice, StoredRate } from '../data/json.ts';
import type { Context } from './analysis.ts';
import { tracking } from './tracking.ts';
import type { TrackRow, Tracking } from './tracking.ts';

/**
 * Checks for files prepared outside the app (a month's prices, a broker statement turned into movements,
 * research on an asset) before the user imports them in Datos. Same rules as the app, so a file that
 * passes here imports cleanly and a file that fails says why, row by row.
 */
export interface Finding {
  level: 'error' | 'warning';
  code: string;
  /** Which row or asset: "fila 3 · SMPL 2025-07-31". */
  ref: string;
  message: string;
}

const err = (code: string, ref: string, message: string): Finding => ({ level: 'error', code, ref, message });
const warn = (code: string, ref: string, message: string): Finding => ({ level: 'warning', code, ref, message });

/** Market-priced rows open at month `m` of a tracking grid, and those without a fresh price. Shared with the month-end close screen. */
export function marketStatus(ctx: Context, t: Tracking, m: number): { rows: TrackRow[]; missing: TrackRow[]; stale: TrackRow[] } {
  if (m < 0) return { rows: [], missing: [], stale: [] };
  const rows = t.assets.filter((r) => ctx.book.assets.get(r.id.split('|')[1]!)?.pricing === 'market' && !r.cells[m]!.value.isZero());
  return { rows, missing: rows.filter((r) => r.cells[m]!.flag === 'cost'), stale: rows.filter((r) => r.cells[m]!.flag === 'stale') };
}

export interface MissingQuote {
  asset: string;
  name: string;
  symbol?: string;
  ccy: string;
  /** Latest stored close on or before the month-end. */
  last?: IsoDate;
}

export interface CloseStatus {
  month: IsoDate;
  closed?: MonthClose;
  /** Why the month cannot be valued yet (not over, or a missing exchange rate). */
  error?: string;
  priced: number;
  missing: MissingQuote[];
  stale: MissingQuote[];
  due: ValuationDue[];
  /** Latest stored rate per currency, on or before the month-end. */
  fx: { ccy: string; last?: IsoDate }[];
  /** Latest stored level per benchmark index (for Comparación; does not block the close). */
  benchmarks: { symbol: string; name: string; last?: IsoDate }[];
  /** Month-end totals in COP when the month can be valued. */
  total?: Decimal;
  exRealEstate?: Decimal;
}

/** The month-end close as the Cierre screen sees it, from a stored dataset (a backup). */
export function closeStatus(d: Dataset, ctx: Context, month: IsoDate, today: IsoDate): CloseStatus {
  const end = monthEnd(month);
  const t = tracking(ctx, 'COP', today);
  const m = t.months.indexOf(end);
  const { rows, missing, stale } = marketStatus(ctx, t, m);
  const latest = (dates: string[]) => dates.filter((x) => x <= end).reduce<string | undefined>((x, y) => (!x || y > x ? y : x), undefined);
  const quote = (r: TrackRow): MissingQuote => {
    const a = ctx.book.assets.get(r.id.split('|')[1]!)!;
    const sym = a.symbol ?? a.id;
    const last = latest(d.prices.filter((p) => p.symbol === sym).map((p) => p.date));
    return { asset: a.id, name: a.name, ...(a.symbol ? { symbol: a.symbol } : {}), ccy: a.ccy, ...(last ? { last } : {}) };
  };
  const ccys = new Set([...d.accounts.map((a) => a.ccy), ...d.assets.map((a) => a.ccy)].filter((c) => c !== 'USD'));
  const fx = [...ccys].sort().map((ccy) => {
    const last = latest(d.fx.filter((r) => r.ccy === ccy).map((r) => r.date));
    return { ccy, ...(last ? { last } : {}) };
  });
  const benchmarks = d.benchmarks.map((b) => {
    const last = latest(d.prices.filter((p) => p.symbol === b.symbol).map((p) => p.date));
    return { symbol: b.symbol, name: b.name, ...(last ? { last } : {}) };
  });
  const closed = (d.closes ?? []).find((c) => c.month === end);
  return {
    month: end,
    ...(closed ? { closed } : {}),
    ...(m < 0 ? { error: t.error ?? (end > today ? 'El mes todavía no termina' : 'No hay movimientos hasta ese mes') } : {}),
    priced: rows.length - missing.length,
    missing: missing.map(quote),
    stale: stale.map(quote),
    due: valuationsDue(ctx.ledger, ctx.book.assets, end),
    fx,
    benchmarks,
    ...(m >= 0 ? { total: t.total.cells[m]!.value, exRealEstate: t.exRealEstate.cells[m]!.value } : {}),
  };
}

/** Latest month-end strictly before `today` (the month to close). */
export function lastClosableMonth(today: IsoDate): IsoDate {
  const end = monthEnd(today);
  return end === today ? end : addDays(`${today.slice(0, 8)}01`, -1);
}

/**
 * New movements (e.g. from a broker statement) checked one by one, in file order, against the ledger plus the rows
 * before them — the same validation as the Movimientos form, plus ids that would collide on import.
 */
export function checkLedgerRows(ctx: Context, txs: readonly Transaction[], today: IsoDate): Finding[] {
  const out: Finding[] = [];
  const ids = new Set(ctx.ledger.map((t) => t.id).filter(Boolean));
  let ledger: Transaction[] = [...ctx.ledger];
  txs.forEach((tx, i) => {
    const ref = `fila ${i + 1} · ${tx.date} ${tx.type} ${tx.asset ?? tx.account} ${tx.amount.toString()} ${tx.ccy}`;
    if (tx.id && ids.has(tx.id)) out.push(err('DUP_ID', ref, `Ya existe un movimiento con id ${tx.id}; deja la columna id vacía`));
    const issues = validateTransaction(ledger, tx, { assets: ctx.book.assets, accounts: ctx.book.accounts, today });
    out.push(...issues.map((x) => ({ ...x, ref })));
    if (!issues.some((x) => x.level === 'error')) {
      ledger = [...ledger, tx];
      if (tx.id) ids.add(tx.id);
    }
  });
  return out;
}

/**
 * An account as the ledger (plus new rows) leaves it on `date`: units and cash, to compare with a statement's
 * closing balances. Throws LedgerError when the rows oversell.
 */
export function accountSnapshot(ctx: Context, account: string, date: IsoDate, extra: readonly Transaction[] = []) {
  const h = holdingsAt([...ctx.ledger, ...extra], date);
  const positions = [...h.positions.values()]
    .filter((p) => p.account === account && p.open)
    .map((p) => ({ asset: p.asset, name: ctx.book.assets.get(p.asset)?.name ?? p.asset, qty: p.qty, cost: p.cost, ...(p.valuation ? { valuation: p.valuation } : {}) }))
    .sort((a, b) => a.asset.localeCompare(b.asset));
  return { account, date, cash: h.cash.get(account), positions };
}

const UNKNOWN_SOURCE = 'desconocida';

function jumps<T extends { date: string }>(prior: readonly T[], row: T, value: (r: T) => Decimal): { prev: T; ratio: number } | undefined {
  const prev = prior.filter((p) => p.date < row.date).reduce<T | undefined>((x, p) => (!x || p.date > x.date ? p : x), undefined);
  if (!prev || value(prev).isZero()) return undefined;
  return { prev, ratio: value(row).div(value(prev)).toNumber() };
}

/** Quotes to import (symbol, date, close, ccy, source): each needs a source and a past date, in the asset's currency. */
export function checkPriceRows(d: Dataset, rows: readonly StoredPrice[], today: IsoDate): Finding[] {
  const out: Finding[] = [];
  const bySymbol = new Map<string, Asset>();
  for (const a of d.assets) if (a.symbol && !bySymbol.has(a.symbol)) bySymbol.set(a.symbol, a);
  const benches = new Set(d.benchmarks.map((b) => b.symbol));
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const ref = `fila ${i + 1} · ${r.symbol} ${r.date}`;
    const key = `${r.symbol}|${r.date}`;
    if (!isIsoDate(r.date)) out.push(err('DATE', ref, `Fecha inválida: ${r.date} (usa AAAA-MM-DD)`));
    else if (r.date > today) out.push(err('FUTURE_DATE', ref, `La fecha ${r.date} está en el futuro`));
    if (!r.source || r.source === UNKNOWN_SOURCE) out.push(err('SOURCE', ref, 'Falta la fuente del precio (columna source)'));
    const close = dec(r.close);
    if (!close.gt(0)) out.push(err('CLOSE', ref, `El precio debe ser positivo: ${r.close}`));
    if (seen.has(key)) out.push(err('DUPLICATE', ref, 'El archivo trae dos precios para el mismo símbolo y fecha'));
    seen.add(key);
    const asset = bySymbol.get(r.symbol);
    if (asset && asset.ccy !== r.ccy) out.push(err('CCY', ref, `${asset.name} cotiza en ${asset.ccy}, no en ${r.ccy}`));
    if (!asset && !benches.has(r.symbol)) out.push(warn('UNKNOWN_SYMBOL', ref, `Ningún activo ni índice usa el símbolo ${r.symbol}; el precio no se usaría`));
    const old = d.prices.find((p) => p.symbol === r.symbol && p.date === r.date);
    if (old && !dec(old.close).eq(close)) out.push(warn('REPLACES', ref, `Reemplaza el precio guardado ${old.close} (${old.source})`));
    if (!close.gt(0) || !isIsoDate(r.date)) return;
    const prior = [...d.prices.filter((p) => p.symbol === r.symbol), ...rows.slice(0, i).filter((p) => p.symbol === r.symbol)];
    const j = jumps(prior, r, (p) => dec(p.close));
    if (j && (j.ratio > 1.5 || j.ratio < 0.5)) {
      out.push(warn('JUMP', ref, `Cambia ${fmtPct(j.ratio - 1)} frente a ${j.prev.close} del ${j.prev.date}: ¿split, error de digitación o de moneda?`));
    }
  });
  return out;
}

/** Exchange rates to import (units per USD): each needs a source and a past date. */
export function checkFxRows(d: Dataset, rows: readonly StoredRate[], today: IsoDate): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const ref = `fila ${i + 1} · ${r.ccy} ${r.date}`;
    const key = `${r.ccy}|${r.date}`;
    if (!/^[A-Z]{3}$/.test(r.ccy)) out.push(err('CCY', ref, `Moneda inválida: ${r.ccy} (código de 3 letras, o par XXX/USD)`));
    if (!isIsoDate(r.date)) out.push(err('DATE', ref, `Fecha inválida: ${r.date} (usa AAAA-MM-DD)`));
    else if (r.date > today) out.push(err('FUTURE_DATE', ref, `La fecha ${r.date} está en el futuro`));
    if (!r.source || r.source === UNKNOWN_SOURCE) out.push(err('SOURCE', ref, 'Falta la fuente de la tasa (columna source)'));
    const v = dec(r.perUsd);
    if (!v.gt(0)) out.push(err('RATE', ref, `La tasa debe ser positiva: ${r.perUsd}`));
    if (seen.has(key)) out.push(err('DUPLICATE', ref, 'El archivo trae dos tasas para la misma moneda y fecha'));
    seen.add(key);
    const old = d.fx.find((p) => p.ccy === r.ccy && p.date === r.date);
    if (old && !dec(old.perUsd).eq(v)) out.push(warn('REPLACES', ref, `Reemplaza la tasa guardada ${old.perUsd} (${old.source})`));
    if (!v.gt(0) || !isIsoDate(r.date)) return;
    const prior = [...d.fx.filter((p) => p.ccy === r.ccy), ...rows.slice(0, i).filter((p) => p.ccy === r.ccy)];
    const j = jumps(prior, r, (p) => dec(p.perUsd));
    if (j && (j.ratio > 1.15 || j.ratio < 0.87)) {
      out.push(warn('JUMP', ref, `Cambia ${fmtPct(j.ratio - 1)} frente a ${j.prev.perUsd} del ${j.prev.date}: ¿tasa invertida o mal digitada?`));
    }
  });
  return out;
}

const fmtPct = (x: number) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)} %`;

export interface FieldChange {
  asset: string;
  field: string;
  before: unknown;
  after: unknown;
}

/** Fields that are the user's own call; research never changes them unless the user asked. */
const USER_FIELDS = new Set(['name', 'target', 'targetHigh', 'strategy', 'region', 'ideaSource', 'note']);
/** Fields that change how the asset is valued or grouped. */
const STRUCTURAL = new Set(['ccy', 'bucket', 'pricing', 'symbol']);
const RATIOS = ['salesGrowth5y', 'ebitdaMargin', 'netMargin', 'eps', 'netDebt', 'debtToCapital', 'roic', 'roe', 'pe', 'evEbitda'] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isDecimal = (v: unknown) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);

/**
 * An accounts-and-assets file (the Datos import "Cuentas, activos e índices", which replaces each asset by id).
 * Lists every field it changes and flags what would be lost or unsourced: a field missing from the file is erased
 * on import, and a moat rating or fundamentals block needs its source and date.
 */
export function checkAssetPatch(d: Dataset, json: string, today: IsoDate): { findings: Finding[]; changes: FieldChange[] } {
  const findings: Finding[] = [];
  const changes: FieldChange[] = [];
  let b: BookFile;
  try {
    b = JSON.parse(json) as BookFile;
  } catch (e) {
    return { findings: [err('JSON', 'archivo', `No es JSON válido: ${e instanceof Error ? e.message : e}`)], changes };
  }
  if (!Array.isArray(b.accounts) || !Array.isArray(b.assets)) {
    return { findings: [err('SHAPE', 'archivo', 'El archivo debe tener "accounts" y "assets" (listas; "accounts" puede ir vacía)')], changes };
  }
  for (const a of b.accounts) {
    const old = d.accounts.find((x) => x.id === a.id);
    if (!a.id || !a.name || !a.ccy) findings.push(err('ACCOUNT', `cuenta ${a.id ?? '?'}`, 'Una cuenta necesita id, name y ccy'));
    else if (!old) findings.push(warn('NEW_ACCOUNT', `cuenta ${a.id}`, 'Crea una cuenta nueva'));
    else if (!same(old, a)) findings.push(warn('ACCOUNT_CHANGED', `cuenta ${a.id}`, `Reemplaza la cuenta: ${JSON.stringify(old)} → ${JSON.stringify(a)}`));
  }
  const ids = new Set<string>();
  for (const a of b.assets as (Asset & Record<string, unknown>)[]) {
    const ref = `activo ${a.id ?? '?'}`;
    if (!a.id || !a.name || !a.ccy || !a.bucket || !['market', 'manual'].includes(a.pricing)) {
      findings.push(err('ASSET', ref, 'Un activo necesita id, name, ccy, bucket y pricing (market o manual)'));
      continue;
    }
    if (ids.has(a.id)) findings.push(err('DUP_ASSET', ref, 'El activo aparece dos veces en el archivo'));
    ids.add(a.id);
    if (a.pricing === 'market' && !a.symbol) findings.push(err('SYMBOL', ref, 'Un activo con precio de mercado necesita symbol'));
    const old = d.assets.find((x) => x.id === a.id) as (Asset & Record<string, unknown>) | undefined;
    if (!old) findings.push(warn('NEW_ASSET', ref, 'Crea un activo nuevo'));
    for (const k of new Set([...Object.keys(old ?? {}), ...Object.keys(a)])) {
      const before = old?.[k];
      const after = a[k];
      if (same(before, after)) continue;
      if (old) changes.push({ asset: a.id, field: k, before, after });
      if (old && after === undefined) findings.push(warn('DROPS_FIELD', ref, `Borra "${k}" (${JSON.stringify(before)}): al importar, el activo se reemplaza completo`));
      else if (old && USER_FIELDS.has(k)) findings.push(warn('USER_FIELD', ref, `Cambia "${k}", que es decisión tuya: ${JSON.stringify(before)} → ${JSON.stringify(after)}`));
      else if (old && STRUCTURAL.has(k)) findings.push(warn('STRUCTURAL', ref, `Cambia "${k}", que afecta la valoración o el grupo: ${JSON.stringify(before)} → ${JSON.stringify(after)}`));
      if (after === undefined) continue;
      if ((k === 'target' || k === 'targetHigh') && !(isDecimal(after) && dec(after as string).gt(0))) {
        findings.push(err('TARGET', ref, `"${k}" debe ser un número positivo como texto (ej. "150.5"): ${JSON.stringify(after)}`));
      }
      if (k === 'moats') findings.push(...checkMoats(after, ref, today));
      if (k === 'fundamentals') findings.push(...checkFundamentals(after, ref, today));
    }
  }
  for (const bm of b.benchmarks ?? []) {
    if (!bm.symbol || !bm.name || !Array.isArray(bm.buckets)) findings.push(err('BENCHMARK', `índice ${bm.symbol ?? '?'}`, 'Un índice necesita symbol, name y buckets'));
  }
  return { findings, changes };
}

const pastDate = (v: unknown, today: IsoDate) => typeof v === 'string' && isIsoDate(v) && v <= today;

function checkMoats(v: unknown, ref: string, today: IsoDate): Finding[] {
  if (!Array.isArray(v)) return [err('MOATS', ref, '"moats" debe ser una lista')];
  const out: Finding[] = [];
  const sources = new Set<string>();
  v.forEach((m: Record<string, unknown>, i) => {
    const r = `${ref} · foso ${i + 1} (${String(m.source ?? '?')})`;
    if (typeof m.source !== 'string' || !m.source.trim()) out.push(err('MOAT_SOURCE', r, 'Falta el proveedor (source)'));
    else if (sources.has(m.source)) out.push(warn('MOAT_DUP', r, 'Hay dos calificaciones del mismo proveedor'));
    else sources.add(m.source);
    if (!pastDate(m.asOf, today)) out.push(err('MOAT_DATE', r, `Falta la fecha (asOf AAAA-MM-DD, no futura): ${JSON.stringify(m.asOf)}`));
    if (m.rating !== undefined && !['wide', 'narrow', 'none'].includes(m.rating as string)) out.push(err('MOAT_RATING', r, `rating debe ser wide, narrow o none: ${JSON.stringify(m.rating)}`));
    if (m.score !== undefined && !(typeof m.score === 'number' && m.score >= 0 && m.score <= 10)) out.push(err('MOAT_SCORE', r, `score debe ser un número de 0 a 10: ${JSON.stringify(m.score)}`));
    if (m.rating === undefined && m.score === undefined) out.push(err('MOAT_EMPTY', r, 'Sin rating ni score: si el proveedor no califica el activo, no lo agregues'));
    if (m.url !== undefined && !(typeof m.url === 'string' && /^https:\/\/\S+$/.test(m.url))) out.push(err('MOAT_URL', r, `El enlace debe ser https://…: ${JSON.stringify(m.url)}`));
    if (m.url === undefined) out.push(warn('MOAT_NO_URL', r, 'Sin enlace a la fuente'));
  });
  return out;
}

function checkFundamentals(v: unknown, ref: string, today: IsoDate): Finding[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [err('FUND', ref, '"fundamentals" debe ser un objeto')];
  const f = v as Record<string, unknown>;
  const out: Finding[] = [];
  const r = `${ref} · fundamentales`;
  if (!pastDate(f.asOf, today)) out.push(err('FUND_DATE', r, `Falta la fecha de los datos (asOf AAAA-MM-DD, no futura): ${JSON.stringify(f.asOf)}`));
  if (typeof f.source !== 'string' || !f.source.trim()) out.push(err('FUND_SOURCE', r, 'Falta la fuente (source)'));
  for (const k of RATIOS) if (f[k] !== undefined && !isDecimal(f[k])) out.push(err('FUND_NUMBER', r, `"${k}" debe ser un número como texto; las razones van como fracción (0.134 = 13,4 %): ${JSON.stringify(f[k])}`));
  if (f.stars !== undefined && !(Number.isInteger(f.stars) && (f.stars as number) >= 1 && (f.stars as number) <= 5)) out.push(err('FUND_STARS', r, `stars debe ser un entero de 1 a 5: ${JSON.stringify(f.stars)}`));
  if (f.cap !== undefined && !['large', 'mid', 'small'].includes(f.cap as string)) out.push(err('FUND_CAP', r, `cap debe ser large, mid o small: ${JSON.stringify(f.cap)}`));
  if (f.style !== undefined && !['value', 'blend', 'growth'].includes(f.style as string)) out.push(err('FUND_STYLE', r, `style debe ser value, blend o growth: ${JSON.stringify(f.style)}`));
  return out;
}
