import { useState } from 'preact/hooks';
import { toLedgerCsv } from '../../data/csv.ts';
import { emptyDataset, parseDataset } from '../../data/json.ts';
import type { Dataset } from '../../data/json.ts';
import { holdingsAt } from '../../domain/holdings.ts';
import { bucketLabel } from '../analysis.ts';
import { contextOf, coverage } from '../context.ts';
import { download } from '../download.ts';
import { date, today } from '../format.ts';
import { demoDataset, importBook, importFx, importLedger, importPrices, upsertAccount } from '../mutations.ts';
import { getDataset, setDataset, useDataset } from '../store.ts';
import { syncConfigured } from '../sync.ts';
import { SyncCard } from './SyncCard.tsx';

function FileButton({ label, accept, onText }: { label: string; accept: string; onText: (text: string, name: string) => Promise<void> | void }) {
  return (
    <label class="field">
      {label}
      <input
        type="file"
        accept={accept}
        onChange={async (e) => {
          const input = e.target as HTMLInputElement;
          const f = input.files?.[0];
          if (!f) return;
          await onText(await f.text(), f.name);
          input.value = '';
        }}
      />
    </label>
  );
}

export function DataView() {
  const { data } = useDataset();
  const [msg, setMsg] = useState<{ kind: 'err' | 'info'; text: string }>();
  const [ledgerMode, setLedgerMode] = useState<'replace' | 'append'>('replace');
  const [acc, setAcc] = useState({ id: '', name: '', ccy: 'COP' });
  const empty = data.ledger.length === 0;

  const run = async (label: string, f: (d: Dataset) => Dataset) => {
    setMsg(undefined);
    try {
      const next = f(getDataset());
      contextOf(next); // parse everything once so a bad file fails here, not on another screen
      await setDataset(next);
      setMsg({ kind: 'info', text: `${label}: listo.` });
    } catch (e) {
      setMsg({ kind: 'err', text: `${label}: ${e instanceof Error ? e.message : e}` });
    }
  };

  const cov = coverage(data);
  let open: { id: string; name: string; symbol?: string; bucket: string }[] = [];
  try {
    const h = holdingsAt(contextOf(data).ledger, today());
    open = data.assets.filter((a) => a.pricing === 'market' && [...h.positions.values()].some((p) => p.open && p.asset === a.id));
  } catch {
    /* shown elsewhere */
  }

  return (
    <>
      {msg && <div class={`notice ${msg.kind}`} role="status">{msg.text}</div>}
      {syncConfigured && <SyncCard />}
      {empty && (
        <div class="card">
          <h2>Empezar</h2>
          <p>
            Tus datos se guardan solo en este navegador. Importa el respaldo (<code>.json</code>) que te entregué, o carga un portafolio de demostración con datos inventados para
            explorar la app.
          </p>
          <div class="actions">
            <FileButton label="Importar respaldo (.json)" accept=".json,application/json" onText={(t) => run('Respaldo', () => parseDataset(t))} />
            <button onClick={() => run('Demostración', () => demoDataset())}>Cargar demostración</button>
          </div>
        </div>
      )}

      <div class="card">
        <h2>Estado de los datos</h2>
        <p>
          {data.ledger.length} movimientos · {data.assets.length} activos · {data.accounts.length} cuentas · {cov.prices.size} series de precios · TRM hasta {date(cov.fx.get('COP'))}
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Serie</th>
                <th>Clase</th>
                <th>Último dato</th>
              </tr>
            </thead>
            <tbody>
              {open.map((a) => {
                const last = cov.prices.get(a.symbol ?? a.id);
                return (
                  <tr>
                    <td>
                      {a.name} <span class="muted small">{a.symbol}</span>
                    </td>
                    <td>{bucketLabel(a.bucket)}</td>
                    <td>{last ? date(last) : <span class="badge err">sin precios</span>}</td>
                  </tr>
                );
              })}
              {data.benchmarks.map((b) => (
                <tr>
                  <td>
                    Índice: {b.name} <span class="muted small">{b.symbol}</span>
                  </td>
                  <td>{b.buckets.map(bucketLabel).join(', ')}</td>
                  <td>{cov.prices.get(b.symbol) ? date(cov.prices.get(b.symbol)) : <span class="badge err">sin datos</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="small muted" style="margin-top:8px">Los precios se actualizan importando un archivo de precios. En la siguiente fase se descargarán automáticamente.</p>
      </div>

      <div class="card">
        <h2>Respaldo</h2>
        <div class="actions">
          <button class="primary" disabled={empty} onClick={() => download(`inversiones-respaldo-${today()}.json`, JSON.stringify(getDataset()), 'application/json')}>
            Descargar respaldo (.json)
          </button>
          <button disabled={empty} onClick={() => download(`movimientos-${today()}.csv`, toLedgerCsv(contextOf(getDataset()).ledger), 'text/csv')}>
            Descargar movimientos (.csv)
          </button>
        </div>
        <p class="small muted" style="margin-top:8px">
          {syncConfigured
            ? 'Descarga un respaldo cada cierre de mes: la copia en la nube depende de tu frase, y el archivo sirve aunque la olvides.'
            : 'Descarga un respaldo cada cierre de mes: los datos viven solo en este navegador y se pierden si borras sus datos.'}
        </p>
      </div>

      <div class="card">
        <h2>Importar</h2>
        <div class="form-grid">
          <FileButton
            label="Respaldo completo (.json) — reemplaza todo"
            accept=".json,application/json"
            onText={(t) => {
              if (!empty && !confirm('Esto reemplaza todos los datos actuales por los del respaldo. ¿Continuar?')) return;
              return run('Respaldo', () => parseDataset(t));
            }}
          />
          <div class="field">
            <FileButton label="Movimientos (.csv)" accept=".csv,text/csv" onText={(t) => run('Movimientos', (d) => importLedger(d, t, ledgerMode))} />
            <select value={ledgerMode} onChange={(e) => setLedgerMode((e.target as HTMLSelectElement).value as 'replace' | 'append')}>
              <option value="replace">Reemplazar los movimientos</option>
              <option value="append">Agregar a los existentes</option>
            </select>
          </div>
          <FileButton label="Cuentas, activos e índices (.json)" accept=".json,application/json" onText={(t) => run('Cuentas y activos', (d) => importBook(d, t))} />
          <FileButton label="Precios (.csv: symbol,date,close,ccy,source)" accept=".csv,text/csv" onText={(t) => run('Precios', (d) => importPrices(d, t))} />
          <FileButton label="Tasas de cambio (.csv: ccy,date,per_usd,source)" accept=".csv,text/csv" onText={(t) => run('Tasas de cambio', (d) => importFx(d, t))} />
        </div>
      </div>

      <div class="card">
        <h2>Cuentas</h2>
        <table>
          <tbody>
            {data.accounts.map((a) => (
              <tr>
                <td>{a.name}</td>
                <td class="muted">{a.id}</td>
                <td>{a.ccy}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          class="actions"
          style="margin-top:12px;align-items:end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!acc.id.trim() || !acc.name.trim()) return setMsg({ kind: 'err', text: 'Escribe código y nombre de la cuenta' });
            if (data.accounts.some((a) => a.id === acc.id.trim())) return setMsg({ kind: 'err', text: 'Ya existe una cuenta con ese código' });
            run('Cuenta nueva', (d) => upsertAccount(d, { id: acc.id.trim(), name: acc.name.trim(), ccy: acc.ccy }));
            setAcc({ id: '', name: '', ccy: 'COP' });
          }}
        >
          <label class="field">
            Código
            <input value={acc.id} onInput={(e) => setAcc({ ...acc, id: (e.target as HTMLInputElement).value.toLowerCase() })} />
          </label>
          <label class="field">
            Nombre
            <input value={acc.name} onInput={(e) => setAcc({ ...acc, name: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            Moneda
            <select value={acc.ccy} onChange={(e) => setAcc({ ...acc, ccy: (e.target as HTMLSelectElement).value })}>
              <option>COP</option>
              <option>USD</option>
            </select>
          </label>
          <button type="submit">Agregar cuenta</button>
        </form>
      </div>

      <div class="card">
        <h2>Otras acciones</h2>
        <div class="actions">
          <button
            onClick={() => {
              if (!empty && !confirm('Esto reemplaza tus datos por el portafolio de demostración. ¿Continuar?')) return;
              run('Demostración', () => demoDataset());
            }}
          >
            Cargar demostración
          </button>
          <button
            class="danger"
            disabled={empty}
            onClick={() => {
              if (confirm('¿Borrar todos los datos de este navegador? Descarga antes un respaldo.')) run('Borrado', () => emptyDataset());
            }}
          >
            Borrar todos los datos
          </button>
        </div>
      </div>
    </>
  );
}
