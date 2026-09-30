/**
 * GET /api/fundamentals?t=TICKER&t=…  → for each ticker, the reported figures the app uses from SEC EDGAR's
 * companyfacts (only the concepts in src/data/secConcepts.ts, from annual and quarterly reports).
 *
 * data.sec.gov has no CORS and asks every client to identify itself with a contact in the User-Agent, so
 * the app asks this function. The contact comes from the SEC_USER_AGENT environment variable (Netlify),
 * never from the repository. A few tickers per call (the Netlify time limit), one request at a time, well
 * under the SEC's 10 requests per second. Ratios and periods are worked out by the app (src/data/sec.ts).
 */
import { SEC_CONCEPTS, SEC_FORMS } from '../../src/data/secConcepts.ts';
import type { RawFact, SecFactsReply } from '../../src/data/sec.ts';

const MAX_TICKERS = 3;
const TICKER = /^[A-Z][A-Z0-9-]{0,9}$/;
/** Enough history for five-year growth plus the year before. */
const YEARS = 7;

export type Reply = Record<string, SecFactsReply | { error: string }>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

let tickers: Map<string, number> | undefined;
/** For tests: the ticker list is read again on the next call. */
export const forgetTickers = () => (tickers = undefined);

async function cikOf(ticker: string, get: (url: string) => Promise<Response>): Promise<number | undefined> {
  if (!tickers) {
    const res = await get('https://www.sec.gov/files/company_tickers.json');
    if (!res.ok) throw new Error(`La SEC respondió ${res.status} a la lista de empresas.`);
    const body = (await res.json()) as Record<string, { cik_str: number; ticker: string }>;
    tickers = new Map(Object.values(body).map((x) => [x.ticker.toUpperCase(), x.cik_str]));
  }
  return tickers.get(ticker);
}

interface CompanyFacts {
  cik?: number;
  entityName?: string;
  facts?: Record<string, Record<string, { units?: Record<string, RawFact[]> }>>;
}

/** Only the concepts, forms and years the app reads, and only the fields it uses. */
function reduce(body: CompanyFacts, cik: number, since: string): SecFactsReply {
  const facts: SecFactsReply['facts'] = {};
  for (const tax of ['us-gaap', 'ifrs-full'] as const) {
    const wanted = new Set<string>(Object.values(SEC_CONCEPTS[tax]).flat());
    for (const [concept, data] of Object.entries(body.facts?.[tax] ?? {})) {
      if (!wanted.has(concept)) continue;
      for (const [unit, list] of Object.entries(data.units ?? {})) {
        const kept = list
          .filter((f) => SEC_FORMS.test(f.form) && f.end >= since)
          .map(({ start, end, val, form, filed, accn }) => ({ ...(start ? { start } : {}), end, val, form, filed, accn }));
        if (kept.length) ((facts[tax] ??= {})[concept] ??= {})[unit] = kept;
      }
    }
  }
  return { cik, entity: body.entityName ?? '', facts };
}

async function one(ticker: string, get: (url: string) => Promise<Response>, since: string): Promise<SecFactsReply | { error: string }> {
  let cik: number | undefined;
  try {
    cik = await cikOf(ticker, get);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'No se pudo leer la lista de empresas de la SEC.' };
  }
  if (!cik) return { error: `La SEC no tiene una empresa con el símbolo ${ticker} (los ETF y las acciones que no cotizan en EE. UU. no están).` };
  let res: Response;
  try {
    res = await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`);
  } catch {
    return { error: 'No se pudo conectar con la SEC.' };
  }
  if (res.status === 404) return { cik, entity: '', facts: {} };
  if (!res.ok) return { error: `La SEC respondió ${res.status}.` };
  try {
    return reduce((await res.json()) as CompanyFacts, cik, since);
  } catch {
    return { error: 'La SEC respondió algo que no son estados financieros.' };
  }
}

export async function handle(
  req: Request,
  doFetch: typeof fetch = fetch,
  wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  agent = process.env.SEC_USER_AGENT,
): Promise<Response> {
  if (req.method !== 'GET') return json(405, { error: 'Solo GET' });
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return json(403, { error: 'Solo para la app' });
  if (!agent?.includes('@')) return json(500, { error: 'Falta la variable SEC_USER_AGENT en Netlify (un nombre y un correo de contacto, como pide la SEC).' });
  const asked = new URL(req.url).searchParams.getAll('t');
  if (asked.length === 0 || asked.length > MAX_TICKERS) return json(400, { error: `Pide entre 1 y ${MAX_TICKERS} símbolos` });
  const get = (url: string) => doFetch(url, { headers: { 'user-agent': agent, accept: 'application/json' } });
  const since = `${new Date().getUTCFullYear() - YEARS}-01-01`;
  const out: Reply = {};
  let calls = 0;
  for (const t of asked) {
    if (!TICKER.test(t)) {
      out[t] = { error: `Símbolo inválido: ${t}` };
      continue;
    }
    if (calls++ > 0) await wait(200);
    out[t] = await one(t, get, since);
  }
  return json(200, out);
}

export default (req: Request) => handle(req);

export const config = { path: '/api/fundamentals' };
