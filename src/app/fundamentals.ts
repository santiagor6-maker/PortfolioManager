import type { IsoDate } from '../domain/dates.ts';
import { holdingsAt } from '../domain/holdings.ts';
import type { SecData } from '../domain/types.ts';
import type { Dataset } from '../data/json.ts';
import { parseCompanyFacts, secFundamentals } from '../data/sec.ts';
import type { SecFactsReply, SecField } from '../data/sec.ts';
import { contextOf } from './context.ts';

/**
 * Fundamentals from SEC EDGAR for the stocks held, once a month: the site's function
 * (netlify/functions/fundamentals.mts, /api/fundamentals) relays the reported figures and
 * src/data/sec.ts turns them into ratios. They are kept in `Asset.sec`, apart from what the user copies
 * by hand (`fundamentals`), which is never touched.
 */

/** A US ticker as the SEC lists it (class shares with a dash, as Yahoo writes them). */
export const SEC_TICKER = /^[A-Z][A-Z0-9-]{0,9}$/;

export interface SecTarget {
  asset: string;
  name: string;
  ticker: string;
}

/** Stocks the SEC may cover: held today, market-priced in USD, with a US ticker (no exchange suffix). */
export function secTargets(d: Dataset, today: IsoDate): SecTarget[] {
  let open = new Set<string>();
  try {
    open = new Set([...holdingsAt(contextOf(d).ledger, today).positions.values()].filter((p) => p.open).map((p) => p.asset));
  } catch {
    /* an impossible ledger is reported elsewhere */
  }
  const seen = new Set<string>();
  const out: SecTarget[] = [];
  for (const a of d.assets) {
    if (!open.has(a.id) || a.pricing !== 'market' || a.ccy !== 'USD' || a.bucket === 'cripto' || !a.symbol || !SEC_TICKER.test(a.symbol) || seen.has(a.symbol)) continue;
    seen.add(a.symbol);
    out.push({ asset: a.id, name: a.name, ticker: a.symbol });
  }
  return out;
}

/** Due once a month: never read, or last read in an earlier month. */
export function secDue(d: Dataset, today: IsoDate): SecTarget[] {
  return secTargets(d, today).filter((t) => {
    const sec = d.assets.find((a) => a.id === t.asset)?.sec;
    return !sec || sec.asOf.slice(0, 7) < today.slice(0, 7);
  });
}

export interface SecOutcome {
  target: SecTarget;
  /** The figures read (or, for a symbol the SEC does not have, why there are none). */
  sec?: SecData;
  /** A failure to read: the figures stored before stay, and it is tried again next time. */
  error?: string;
}

export interface SecRunOptions {
  today: IsoDate;
  fetch?: typeof fetch;
  endpoint?: string;
  batch?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

/** Symbols the SEC does not list: not retried until next month. */
const NOT_LISTED = /no tiene una empresa con el símbolo/;

export async function runSec(targets: readonly SecTarget[], o: SecRunOptions): Promise<SecOutcome[]> {
  const doFetch = o.fetch ?? fetch.bind(globalThis);
  const endpoint = o.endpoint ?? '/api/fundamentals';
  const size = o.batch ?? 3;
  const out: SecOutcome[] = [];
  for (let i = 0; i < targets.length; i += size) {
    const group = targets.slice(i, i + size);
    o.onProgress?.(out.length, targets.length, group.map((t) => t.name).join(', '));
    let body: Record<string, SecFactsReply | { error: string }>;
    try {
      const res = await doFetch(`${endpoint}?${group.map((t) => `t=${encodeURIComponent(t.ticker)}`).join('&')}`);
      if (res.status === 404) throw new Error('El servicio de fundamentales no está disponible aquí: usa la versión publicada de la app.');
      const parsed = (await res.json().catch(() => undefined)) as typeof body | { error?: string } | undefined;
      if (!res.ok || !parsed) throw new Error((parsed as { error?: string } | undefined)?.error ?? `El servicio de fundamentales respondió ${res.status}.`);
      body = parsed as typeof body;
    } catch (e) {
      const error = e instanceof TypeError ? 'No se pudo conectar con el servicio de fundamentales.' : e instanceof Error ? e.message : String(e);
      for (const target of group) out.push({ target, error });
      continue;
    }
    for (const target of group) {
      const r = body[target.ticker];
      if (!r) out.push({ target, error: 'El servicio de fundamentales no devolvió esta acción.' });
      else if ('error' in r) out.push(NOT_LISTED.test(r.error) ? { target, sec: { asOf: o.today, error: r.error } } : { target, error: r.error });
      else {
        try {
          out.push({ target, sec: parseCompanyFacts(r, o.today) });
        } catch (e) {
          out.push({ target, error: `La SEC respondió algo que no se pudo leer: ${e instanceof Error ? e.message : e}` });
        }
      }
    }
  }
  o.onProgress?.(targets.length, targets.length, '');
  return out;
}

export interface SecChange {
  asset: string;
  name: string;
  field: SecField;
  before?: string;
  after?: string;
}

/** The ratios that come from the filings alone (price-based ones move with the price every day). */
const FILING_FIELDS: SecField[] = ['salesGrowth5y', 'ebitdaMargin', 'netMargin', 'roic', 'roe', 'eps', 'debtToCapital', 'netDebt'];

export interface SecApplied {
  next: Dataset;
  updated: number;
  changes: SecChange[];
  failed: SecOutcome[];
}

/** Stores what was read on each asset (a failed read keeps what it had) and lists the ratios that changed. */
export function applySec(d: Dataset, outcomes: readonly SecOutcome[]): SecApplied {
  const byAsset = new Map(outcomes.filter((o) => o.sec).map((o) => [o.target.asset, o]));
  const changes: SecChange[] = [];
  const assets = d.assets.map((a) => {
    const o = byAsset.get(a.id);
    if (!o?.sec) return a;
    // The first read is not a change; later ones list each ratio that moved (a new filing, a restatement).
    if (a.sec && !a.sec.error) {
      const before = secFundamentals(a.sec, a.ccy).f;
      const after = secFundamentals(o.sec, a.ccy).f;
      for (const field of FILING_FIELDS) if (before[field] !== after[field]) changes.push({ asset: a.id, name: a.name, field, before: before[field], after: after[field] });
    }
    return { ...a, sec: o.sec };
  });
  return { next: byAsset.size ? { ...d, assets } : d, updated: byAsset.size, changes, failed: outcomes.filter((o) => o.error) };
}
