import { useEffect, useMemo, useState } from 'preact/hooks';
import { date, today } from '../format.ts';
import { PROVIDER_LABELS, applyRefresh, jobLabel, refreshPlan, runRefresh } from '../refresh.ts';
import type { Applied, JobResult, RefreshPlan } from '../refresh.ts';
import { getDataset, kvGet, kvSet, setDataset, useDataset } from '../store.ts';

/** The Twelve Data key stays in this browser only: not in the dataset, the backups or the cloud copy. */
const KEY = 'quotes:twelvedata';
const PER_MINUTE = 8;

interface Progress {
  done: number;
  total: number;
  label: string;
  waiting: boolean;
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

async function start(plan: RefreshPlan, key: string | undefined) {
  if (run.progress) return;
  setRun({ progress: { done: 0, total: plan.jobs.length, label: '', waiting: false } });
  try {
    const results = await runRefresh(plan, {
      key: key ?? '',
      today: today(),
      perMinute: PER_MINUTE,
      onProgress: (done, total, label, waiting) => setRun({ progress: { done, total, label, waiting } }),
    });
    const applied = applyRefresh(getDataset(), results, today());
    if (applied.next !== getDataset()) await setDataset(applied.next);
    setRun({ done: { results, applied } });
  } catch (e) {
    setRun({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** "Actualizar precios": downloads the missing days of every series a free source covers, and says what stays manual. */
export function RefreshCard({ compact = false }: { compact?: boolean }) {
  const { data } = useDataset();
  const [key, setKey] = useState<string>();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const { progress, done, error } = useRun();

  useEffect(() => {
    kvGet<string>(KEY)
      .then((k) => setKey(k || undefined))
      .catch(() => undefined);
  }, []);

  const plan = useMemo(() => refreshPlan(data, today(), Boolean(key)), [data, key]);
  const td = plan.jobs.filter((j) => j.provider === 'twelvedata').length;
  const minutes = Math.ceil(td / PER_MINUTE) - 1;
  const running = progress !== undefined;

  async function saveKey(e: Event) {
    e.preventDefault();
    const k = draft.trim();
    if (!k) return;
    await kvSet(KEY, k);
    setKey(k);
    setDraft('');
    setEditing(false);
  }

  async function removeKey() {
    await kvSet(KEY, undefined);
    setKey(undefined);
  }

  const byProvider = (['twelvedata', 'coingecko', 'trm'] as const)
    .map((p) => [p, plan.jobs.filter((j) => j.provider === p).length] as const)
    .filter(([, n]) => n > 0)
    .map(([p, n]) => `${n} de ${PROVIDER_LABELS[p]}`);

  const body = (
    <>
      {!key || editing ? (
        <form class="actions refresh-key" onSubmit={saveKey}>
          <label class="field">
            Clave de Twelve Data
            <input type="password" autocomplete="off" spellcheck={false} value={draft} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
          </label>
          <button disabled={!draft.trim()}>Guardar clave</button>
          {editing && (
            <button type="button" class="link" onClick={() => setEditing(false)}>
              Cancelar
            </button>
          )}
          <p class="small muted">
            Para las acciones de EE. UU. y las tasas del euro y otras monedas. Es gratis: crea una cuenta en{' '}
            <a href="https://twelvedata.com/register" target="_blank" rel="noopener noreferrer">
              twelvedata.com
            </a>{' '}
            y copia la clave de «API Keys». Se guarda solo en este navegador. Sin ella se actualizan igual la TRM y las criptomonedas.
          </p>
        </form>
      ) : (
        <p class="small muted">
          Clave de Twelve Data guardada en este navegador.{' '}
          <button type="button" class="link" onClick={() => setEditing(true)}>
            Cambiar
          </button>{' '}
          ·{' '}
          <button type="button" class="link" onClick={removeKey}>
            Quitar
          </button>
        </p>
      )}

      <div class="actions">
        <button class="primary" disabled={running || plan.jobs.length === 0} onClick={() => void start(plan, key)}>
          {running ? 'Actualizando…' : 'Actualizar precios'}
        </button>
        <span class="small muted">
          {plan.jobs.length === 0
            ? plan.current > 0
              ? 'Todo lo que se puede descargar ya está al día.'
              : 'No hay series para descargar.'
            : `Por actualizar: ${byProvider.join(', ')}.${minutes > 0 ? ` Tarda unos ${minutes + 1} minutos: el plan gratis de Twelve Data permite ${PER_MINUTE} consultas por minuto.` : ''}`}
        </span>
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
          <span class="small muted">
            {progress.waiting ? `Esperando el límite de Twelve Data (${PER_MINUTE} por minuto)… ` : 'Descargando '}
            {progress.label}
          </span>
        </div>
      )}
      {error && (
        <div class="notice err" role="alert">
          {error}
        </div>
      )}
      {done && <Result {...done} />}

      {plan.uncovered.length > 0 && (
        <details class="small" style="margin-top:10px">
          <summary>
            {plan.uncovered.length === 1 ? '1 serie sin fuente automática' : `${plan.uncovered.length} series sin fuente automática`}
          </summary>
          <ul>
            {plan.uncovered.map((u) => (
              <li>
                {u.name === u.symbol ? u.symbol : `${u.name} (${u.symbol})`}: {u.reason}
              </li>
            ))}
          </ul>
          <p class="muted">Estas siguen como hoy: pídele a Claude el cierre del mes o importa un archivo de precios en Datos.</p>
        </details>
      )}
    </>
  );

  if (compact) return <div class="refresh-card compact">{body}</div>;
  return (
    <div class="card refresh-card">
      <h2>Actualizar precios</h2>
      <p class="small muted">
        Descarga los cierres que faltan desde el último guardado: acciones y ETF de EE. UU. y tasas (Twelve Data), la TRM oficial (datos.gov.co) y criptomonedas (CoinGecko). Solo agrega días
        nuevos: nunca reemplaza un precio guardado, y cada precio queda con su fuente y su fecha.
      </p>
      {body}
    </div>
  );
}

function Result({ results, applied }: { results: JobResult[]; applied: Applied }) {
  const failed = results.filter((r) => r.error);
  return (
    <>
      <div class={`notice ${failed.length ? 'warn' : 'info'}`} role="status">
        {applied.prices + applied.fx === 0
          ? 'No había días nuevos para agregar.'
          : `Se agregaron ${applied.prices} ${applied.prices === 1 ? 'precio' : 'precios'} y ${applied.fx} ${applied.fx === 1 ? 'tasa' : 'tasas'}.`}
        {failed.length > 0 && ` ${failed.length === 1 ? '1 serie falló' : `${failed.length} series fallaron`}: quedan como estaban.`}
      </div>
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
                  {r.note && <div class="muted">{r.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
