import { useEffect, useMemo, useState } from 'preact/hooks';
import { date, today } from '../format.ts';
import { PROVIDER_LABELS, applyRefresh, jobLabel, refreshPlan, runRefresh } from '../refresh.ts';
import type { Applied, JobResult, RefreshPlan } from '../refresh.ts';
import { getDataset, setDataset, useDataset } from '../store.ts';

interface Progress {
  done: number;
  total: number;
  label: string;
}

/** One run for the page: the card in Datos and the one in Cierre show the same run, and a second cannot start. */
interface Run {
  progress?: Progress;
  done?: { results: JobResult[]; applied: Applied };
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

async function start(plan: RefreshPlan) {
  if (run.progress) return;
  setRun({ progress: { done: 0, total: plan.jobs.length, label: '' } });
  try {
    const results = await runRefresh(plan, { today: today(), onProgress: (done, total, label) => setRun({ progress: { done, total, label } }) });
    const applied = applyRefresh(getDataset(), results, today());
    if (applied.next !== getDataset()) await setDataset(applied.next);
    setRun({ done: { results, applied } });
  } catch (e) {
    setRun({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** The quote function lives on the published site; a copy opened from disk cannot reach it. */
const published = () => location.protocol.startsWith('http');

/** «Traer precios del cierre»: the missing closes of every series in use, from the sources of the stored history. */
export function RefreshCard({ compact = false }: { compact?: boolean }) {
  const { data } = useDataset();
  const { progress, done, error } = useRun();
  const plan = useMemo(() => refreshPlan(data, today()), [data]);
  const running = progress !== undefined;
  const n = plan.jobs.length;

  const body = published() ? (
    <>
      <div class="actions">
        <button class="primary" disabled={running || n === 0} onClick={() => void start(plan)}>
          {running ? 'Trayendo precios…' : 'Traer precios del cierre'}
        </button>
        <span class="small muted">{n === 0 ? 'Todo está al día.' : n === 1 ? 'Falta actualizar 1 serie.' : `Faltan por actualizar ${n} series.`}</span>
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
      {done && <Result {...done} />}
    </>
  ) : (
    <p class="small muted">Este botón funciona en la versión publicada de la app (portfoliomanager-sr.netlify.app), no en el archivo abierto desde el computador.</p>
  );

  const extra = plan.uncovered.length > 0 && (
    <details class="small" style="margin-top:10px">
      <summary>{plan.uncovered.length === 1 ? '1 serie no se puede traer sola' : `${plan.uncovered.length} series no se pueden traer solas`}</summary>
      <ul>
        {plan.uncovered.map((u) => (
          <li>
            {u.name === u.symbol ? u.symbol : `${u.name} (${u.symbol})`}: {u.reason}
          </li>
        ))}
      </ul>
    </details>
  );

  if (compact)
    return (
      <div class="refresh-card compact">
        {body}
        {extra}
      </div>
    );
  return (
    <div class="card refresh-card">
      <h2>Precios del cierre</h2>
      <p class="small muted">
        Trae los cierres que faltan desde el último guardado, de las mismas fuentes de tu historial: Yahoo Finance para acciones, ETF, cripto, índices y tasas, y la TRM oficial
        (datos.gov.co). Solo agrega días nuevos: nunca cambia un precio guardado.
      </p>
      {body}
      {extra}
    </div>
  );
}

function Result({ results, applied }: { results: JobResult[]; applied: Applied }) {
  const failed = results.filter((r) => r.error);
  const latest = applied.added.reduce<string | undefined>((x, a) => (a.last && (!x || a.last > x) ? a.last : x), undefined);
  return (
    <>
      <div class={`notice ${failed.length ? 'warn' : 'info'}`} role="status">
        {applied.prices + applied.fx === 0
          ? 'No había días nuevos para agregar.'
          : `Se agregaron ${applied.prices} ${applied.prices === 1 ? 'precio' : 'precios'} y ${applied.fx} ${applied.fx === 1 ? 'tasa' : 'tasas'}${latest ? `, hasta el ${date(latest)}` : ''}.`}
        {failed.length > 0 && ` ${failed.length === 1 ? '1 serie falló' : `${failed.length} series fallaron`} y queda${failed.length === 1 ? '' : 'n'} como estaba${failed.length === 1 ? '' : 'n'}: ${failed.map((r) => jobLabel(r.job)).join(', ')}.`}
      </div>
      <details class="small">
      <summary>Ver el detalle por serie</summary>
      <div class="table-wrap">
        <table class="compact">
          <thead>
            <tr>
              <th>Serie</th>
              <th>Fuente</th>
              <th class="n">Días nuevos</th>
              <th>Hasta</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr>
                <td>{jobLabel(r.job)}</td>
                <td class="small">{PROVIDER_LABELS[r.job.provider]}</td>
                <td class="n">{r.error ? '' : applied.added[i]!.count}</td>
                <td class="small">
                  {r.error ? <span class="bad">{r.error}</span> : applied.added[i]!.last ? date(applied.added[i]!.last) : 'sin días nuevos'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </details>
      {applied.rejected.length > 0 && (
        <div class="notice err small">
          No se agregaron por no pasar las revisiones:
          <ul>
            {applied.rejected.map((f) => (
              <li>
                {f.ref.replace(/^fila \d+ · /, '')}: {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {applied.warnings.length > 0 && (
        <div class="notice warn small">
          Revisa:
          <ul>
            {applied.warnings.map((f) => (
              <li>
                {f.ref.replace(/^fila \d+ · /, '')}: {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
