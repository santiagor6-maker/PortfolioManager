import { useEffect, useState } from 'preact/hooks';
import { filingUrl } from '../../data/sec.ts';
import type { SecField } from '../../data/sec.ts';
import { date, today } from '../format.ts';
import { applySec, runSec, secDue, secTargets } from '../fundamentals.ts';
import type { SecApplied, SecOutcome, SecTarget } from '../fundamentals.ts';
import { getDataset, setDataset, useDataset } from '../store.ts';
import { getSyncState } from '../sync.ts';

export const SEC_LABEL: Record<SecField, string> = {
  salesGrowth5y: 'Crec. ventas 5a',
  ebitdaMargin: 'Margen EBITDA',
  netMargin: 'Margen neto',
  roic: 'ROIC',
  roe: 'ROE',
  pe: 'P/E',
  evEbitda: 'EV/EBITDA',
  eps: 'EPS',
  debtToCapital: 'Deuda / capital',
  netDebt: 'Deuda neta (M)',
};

interface Run {
  progress?: { done: number; total: number; label: string };
  done?: SecApplied & { outcomes: SecOutcome[] };
  error?: string;
}
let run: Run = {};
const subs = new Set<() => void>();
const setRun = (r: Run) => {
  run = r;
  subs.forEach((s) => s());
};
function useRun(): Run {
  const [, force] = useState(0);
  useEffect(() => {
    const s = () => force((n) => n + 1);
    subs.add(s);
    return () => {
      subs.delete(s);
    };
  }, []);
  return run;
}

async function start(targets: SecTarget[]) {
  if (run.progress || targets.length === 0) return;
  setRun({ progress: { done: 0, total: targets.length, label: '' } });
  try {
    const outcomes = await runSec(targets, { today: today(), onProgress: (done, total, label) => setRun({ progress: { done, total, label } }) });
    // Applied to the data as it is now (a sync may have brought a newer copy meanwhile).
    const applied = applySec(getDataset(), outcomes);
    if (applied.next !== getDataset()) await setDataset(applied.next);
    setRun({ done: { ...applied, outcomes } });
  } catch (e) {
    setRun({ error: e instanceof Error ? e.message : String(e) });
  }
}

const published = () => location.protocol.startsWith('http');

let autoTried = false;

/**
 * On opening the published app (and on opening Indicadores, for data loaded afterwards): once a month, after
 * the cloud copy (if any) has been checked, so a figure another device already read this month is not read
 * again. One try per session: what fails is tried again on the next visit.
 */
export async function autoSec(): Promise<void> {
  if (!published() || autoTried) return;
  for (let i = 0; i < 40 && ['starting', 'syncing'].includes(getSyncState().status); i++) await new Promise((r) => setTimeout(r, 500));
  const due = secDue(getDataset(), today());
  if (!due.length || autoTried) return;
  autoTried = true;
  await start(due);
}

const fmt = (field: SecField, v: string | undefined) => {
  if (v === undefined) return '—';
  const n = Number(v);
  if (['salesGrowth5y', 'ebitdaMargin', 'netMargin', 'roic', 'roe', 'debtToCapital'].includes(field)) return `${(n * 100).toLocaleString('es-CO', { maximumFractionDigits: 1 })} %`;
  return n.toLocaleString('es-CO', { maximumFractionDigits: 2 });
};

/** Indicadores → the SEC's figures: when they were read, the button to read them now, and what changed. */
export function SecCard() {
  const { data } = useDataset();
  const { progress, done, error } = useRun();
  const targets = secTargets(data, today());
  useEffect(() => void autoSec(), []);
  const read = data.assets.filter((a) => a.sec && targets.some((t) => t.asset === a.id));
  const last = read.reduce<string | undefined>((m, a) => (!m || a.sec!.asOf > m ? a.sec!.asOf : m), undefined);
  if (targets.length === 0) return null;

  return (
    <div class="sec-card">
      <div class="actions">
        <span class="small">
          <strong>Fundamentales de la SEC</strong> (reportes 10-K, 10-Q y 20-F de cada empresa):{' '}
          {read.length ? `${read.length} de ${targets.length} acciones, leídos el ${date(last!)}. Se actualizan solos cada mes.` : `aún no se han leído para tus ${targets.length} acciones de EE. UU.`}
        </span>
        {published() ? (
          <button type="button" disabled={progress !== undefined} onClick={() => void start(targets)}>
            {progress ? 'Leyendo…' : 'Actualizar ahora'}
          </button>
        ) : (
          <span class="small muted">Se leen en la versión publicada de la app.</span>
        )}
      </div>
      {progress && (
        <div class="refresh-progress" role="status">
          <div class="progress">
            <div class="bar">
              <span style={`width:${progress.total ? (progress.done / progress.total) * 100 : 0}%`} />
            </div>
            <span class="small">
              {progress.done} de {progress.total}
            </span>
          </div>
          <span class="small muted">{progress.label}</span>
        </div>
      )}
      {error && (
        <div class="notice err" role="alert">
          {error}
        </div>
      )}
      {done && (
        <div class={`notice ${done.failed.length ? 'warn' : 'info'}`} role="status">
          Fundamentales actualizados: {done.updated} {done.updated === 1 ? 'acción' : 'acciones'}
          {done.changes.length ? `, ${done.changes.length} ${done.changes.length === 1 ? 'cifra cambió' : 'cifras cambiaron'}` : ', sin cambios en las cifras'}.
          {done.failed.length > 0 && ` No se pudieron leer: ${done.failed.map((o) => `${o.target.name} (${o.error})`).join('; ')}. Quedan como estaban y se intentan de nuevo la próxima vez.`}
          {done.changes.length > 0 && (
            <details class="small">
              <summary>Ver los cambios</summary>
              <table class="compact">
                <thead>
                  <tr>
                    <th>Acción</th>
                    <th>Cifra</th>
                    <th class="n">Antes</th>
                    <th class="n">Ahora</th>
                  </tr>
                </thead>
                <tbody>
                  {done.changes.map((c) => (
                    <tr>
                      <td>{c.name}</td>
                      <td>{SEC_LABEL[c.field]}</td>
                      <td class="n">{fmt(c.field, c.before)}</td>
                      <td class="n">{fmt(c.field, c.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}
      {read.length > 0 && (
        <details class="small">
          <summary>De dónde sale cada cifra</summary>
          <div class="table-wrap">
            <table class="compact">
              <thead>
                <tr>
                  <th>Acción</th>
                  <th>Último reporte</th>
                  <th>Periodo</th>
                  <th>Faltan</th>
                </tr>
              </thead>
              <tbody>
                {read.map((a) => {
                  const s = a.sec!;
                  const v = s.values?.revenue;
                  return (
                    <tr>
                      <td>{a.name}</td>
                      <td>
                        {s.error ? (
                          <span class="muted">{s.error}</span>
                        ) : v ? (
                          <a href={filingUrl(s.cik!, v.accn)} target="_blank" rel="noopener noreferrer">
                            {v.form} presentado el {date(v.filed)}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {s.period ? `${s.annualOnly ? 'año' : '12 meses'} al ${date(s.period)}` : '—'}
                        {s.currency && s.currency !== a.ccy ? ` · en ${s.currency}` : ''}
                      </td>
                      <td class="small">
                        {Object.entries(s.gaps ?? {})
                          .map(([, why]) => why)
                          .filter((w, i, all) => all.indexOf(w) === i)
                          .join('; ') || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p class="muted">
            Doce meses = último reporte anual + lo corrido del año − lo mismo del año anterior. EBITDA = utilidad operativa + depreciación y amortización. Deuda = préstamos, bonos y
            papeles comerciales (sin arrendamientos); caja = efectivo e inversiones de corto plazo. ROE = utilidad neta / patrimonio promedio del último año. ROIC = utilidad
            operativa × (1 − tasa de impuesto efectiva) / (deuda + patrimonio − caja). P/E y EV/EBITDA usan el precio que tiene la app y las acciones diluidas del último
            trimestre. Las empresas extranjeras (20-F) reportan una vez al año: de ellas no se muestran cifras por acción ni con precio, y la deuda neta solo si reportan en la moneda de la acción. Si una empresa reexpresó el año (p. ej. por operaciones discontinuadas), los doce meses pueden mezclar bases hasta su siguiente reporte anual; un split entre el anual y el trimestral deja el EPS faltante hasta entonces, y uno posterior al último reporte distorsiona el P/E y el EV/EBITDA hasta el siguiente.
          </p>
        </details>
      )}
    </div>
  );
}
