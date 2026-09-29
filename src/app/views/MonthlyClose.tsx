import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { monthEnds } from '../../domain/dates.ts';
import { holdingsAt } from '../../domain/holdings.ts';
import { dec } from '../../domain/money.ts';
import { sortLedger } from '../../domain/ledger.ts';
import { valuationTx, valuationsDue } from '../../domain/monthlyClose.ts';
import type { Transaction } from '../../domain/types.ts';
import { validateTransaction } from '../../domain/validate.ts';
import type { Context } from '../analysis.ts';
import { bucketLabel } from '../analysis.ts';
import { fxStatus, marketStatus } from '../checks.ts';
import { BarList, classColor } from '../components/Bars.tsx';
import type { BarItem } from '../components/Bars.tsx';
import { contextOf } from '../context.ts';
import { date, money, moneyShort, monthLabel, pct, today } from '../format.ts';
import { TYPE_LABELS } from '../labels.ts';
import { addTransactions, closeMonth, deleteTransactions, reopenMonth } from '../mutations.ts';
import { queryParam } from '../route.ts';
import { getDataset, setDataset, useDataset, usePref } from '../store.ts';
import { indexReturn, tracking, xirrToDate, yearToDate } from '../tracking.ts';
import type { Tracking } from '../tracking.ts';
import { RefreshCard } from './RefreshCard.tsx';
import { orderedRows } from './Tracking.tsx';

type Status = 'ok' | 'warn' | 'block' | 'info';

function Step({ n, title, status, note, children }: { n: number; title: string; status: Status; note: ComponentChildren; children?: ComponentChildren }) {
  const icon = { ok: '✓', warn: '!', block: '✗', info: String(n) }[status];
  return (
    <li class={`step s-${status}`}>
      <span class="dot" aria-hidden="true">{icon}</span>
      <div class="body">
        <div class="step-head">
          <h3>
            <span class="sr">Paso {n}: </span>
            {title}
          </h3>
          <span class="small step-note">{note}</span>
        </div>
        {children}
      </div>
    </li>
  );
}

const sign = (x: number | null | undefined) => (x === null || x === undefined ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');

interface ManualRow {
  account: string;
  asset: string;
  name: string;
  bucket: string;
  ccy: string;
  previous?: { date: string; value: string };
  existing?: Transaction[];
}

function manualRows(ctx: Context, month: string): ManualRow[] {
  const start = `${month.slice(0, 8)}01`;
  const h = holdingsAt(ctx.ledger.filter((t) => !(t.type === 'VALUATION' && t.date >= start && t.date <= month)), month);
  const out: ManualRow[] = [];
  for (const p of h.positions.values()) {
    const a = ctx.book.assets.get(p.asset);
    if (!p.open || a?.pricing !== 'manual') continue;
    const existing = ctx.ledger.filter((t) => t.type === 'VALUATION' && t.account === p.account && t.asset === p.asset && t.date >= start && t.date <= month);
    out.push({
      account: p.account,
      asset: p.asset,
      name: a.name,
      bucket: a.bucket,
      ccy: ctx.book.accounts.get(p.account)!.ccy,
      previous: p.valuation && { date: p.valuation.date, value: p.valuation.value.toString() },
      existing: existing.length ? existing : undefined,
    });
  }
  return out.sort((x, y) => x.bucket.localeCompare(y.bucket) || x.name.localeCompare(y.name));
}

export function MonthlyClose() {
  const { data } = useDataset();
  const ctx = contextOf(data);
  const [ccy, setCcy] = usePref<'COP' | 'USD'>('ccy', 'COP');
  const months = useMemo(() => {
    const first = ctx.ledger.reduce((m, t) => (t.date < m ? t.date : m), today());
    return monthEnds(first, today()).reverse();
  }, [ctx]);
  const pick = () => {
    const q = queryParam('mes');
    return q && months.includes(q) ? q : (months[0] ?? '');
  };
  const [month, setMonthRaw] = useState(pick);
  const [values, setValues] = useState<Record<string, string>>({});
  const [estimated, setEstimated] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<{ kind: 'err' | 'info'; text: string }>();
  const setMonth = (m: string) => {
    setMonthRaw(m);
    setValues({});
    setEstimated({});
    setMsg(undefined);
  };
  useEffect(() => {
    const on = () => {
      const q = queryParam('mes');
      if (q && months.includes(q)) setMonth(q);
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, [months]);

  const t = useMemo(() => tracking(ctx, ccy, today()), [ctx, ccy]);
  const tCop = useMemo(() => (ccy === 'COP' ? t : tracking(ctx, 'COP', today())), [ctx, ccy, t]);
  const m = t.months.indexOf(month);
  const mc = tCop.months.indexOf(month);
  const closes = data.closes ?? [];
  const closed = closes.find((c) => c.month === month);
  const pendingClose = months.filter((x) => t.months.includes(x) && !closes.some((c) => c.month === x)).slice(0, 3);

  // Step 1: what was recorded this month.
  const start = `${month.slice(0, 8)}01`;
  const txs = useMemo(() => sortLedger(ctx.ledger).filter((x) => x.date >= start && x.date <= month && x.type !== 'VALUATION'), [ctx, month]);
  // Step 2: market prices and exchange rate at the month-end.
  const { rows: marketRows, missing, stale } = marketStatus(ctx, t, m);
  const oldFx = useMemo(() => (m < 0 ? [] : fxStatus(data, ctx, month).filter((r) => r.stale)), [data, ctx, month, m]);
  // Step 3: manual values.
  const rows = useMemo(() => (month ? manualRows(ctx, month) : []), [ctx, month]);
  const due = useMemo(() => (month ? valuationsDue(ctx.ledger, ctx.book.assets, month) : []), [ctx, month]);
  const key = (r: ManualRow) => `${r.account}|${r.asset}`;
  const isEstimated = (r: ManualRow) => estimated[key(r)] ?? r.existing?.[0]?.estimated ?? r.bucket === 'inmobiliario';

  const blockers = [
    ...(m < 0 ? [t.error ? `${t.error}.` : 'El mes todavía no termina.'] : []),
    ...(missing.length ? [`Faltan precios de mercado: ${missing.map((r) => r.label).join(', ')}.`] : []),
    ...(due.length ? [due.length === 1 ? `Falta 1 valor de fin de mes (${due[0]!.name}).` : `Faltan ${due.length} valores de fin de mes.`] : []),
  ];

  async function save(e: Event) {
    e.preventDefault();
    setMsg(undefined);
    const add: Transaction[] = [];
    const remove: string[] = [];
    for (const r of rows) {
      const raw = (values[key(r)] ?? '').trim();
      if (!raw) continue;
      const norm = /,\d*$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
      let v;
      try {
        v = dec(norm);
      } catch {
        setMsg({ kind: 'err', text: `${r.name}: "${raw}" no es un número` });
        return;
      }
      const tx = valuationTx({ account: r.account, asset: r.asset, name: r.name, date: month }, v, r.ccy, {
        estimated: isEstimated(r),
        note: r.bucket === 'inmobiliario' ? 'precio de lista' : 'valor del extracto al cierre',
      });
      const issues = validateTransaction([], tx, { assets: ctx.book.assets, accounts: ctx.book.accounts, today: today() }).filter((i) => i.level === 'error');
      if (issues.length) {
        setMsg({ kind: 'err', text: `${r.name}: ${issues.map((i) => i.message).join('; ')}` });
        return;
      }
      add.push(tx);
      remove.push(...(r.existing ?? []).map((x) => x.id!).filter(Boolean));
    }
    if (!add.length) {
      setMsg({ kind: 'err', text: 'No escribiste ningún valor' });
      return;
    }
    await setDataset(addTransactions(deleteTransactions(getDataset(), remove), add));
    setValues({});
    setEstimated({});
    setMsg({ kind: 'info', text: `${add.length === 1 ? 'Guardado 1 valor' : `Guardados ${add.length} valores`} al ${date(month)}.` });
  }

  async function doClose() {
    if (mc < 0) return;
    const c = tCop.total.cells[mc]!;
    await setDataset(
      closeMonth(getDataset(), { month, closedAt: today(), total: c.value.toFixed(2), exRealEstate: tCop.exRealEstate.cells[mc]!.value.toFixed(2), gain: c.gain.toFixed(2) }),
    );
  }

  const drift = closed && mc >= 0 ? tCop.total.cells[mc]!.value.minus(dec(closed.total)) : undefined;

  return (
    <>
      <div class="toolbar">
        <div class="filters">
          <label>
            Mes
            <select value={month} onChange={(e) => setMonth((e.target as HTMLSelectElement).value)}>
              {months.map((x) => (
                <option value={x}>
                  {monthLabel(x)}
                  {closes.some((c) => c.month === x) ? ' ✓' : ''}
                </option>
              ))}
            </select>
          </label>
          <div class="field">
            Moneda
            <div class="seg" role="group" aria-label="Moneda">
              {(['COP', 'USD'] as const).map((c) => (
                <button type="button" aria-pressed={ccy === c} onClick={() => setCcy(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          {pendingClose.length > 0 && (
            <div class="field">
              Sin cerrar
              <div class="actions">
                {pendingClose.map((x) => (
                  <button type="button" class="link" onClick={() => setMonth(x)}>
                    {monthLabel(x)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <section class="card close-head">
        <div>
          <div class="kicker">Cierre del mes</div>
          <h2 class="close-title">{monthLabel(month)}</h2>
          {closed ? (
            <span class="badge info">Cerrado el {date(closed.closedAt)}</span>
          ) : (
            <span class="badge warn">Sin cerrar</span>
          )}
        </div>
        <p class="small muted">
          Para cerrar un mes: revisa que estén todos los movimientos, que haya precios y TRM al último día y escribe los valores de los activos sin precio público. Luego mira el resultado y
          pulsa «Cerrar». El cierre guarda las cifras del mes para avisarte si algo las cambia después.
        </p>
      </section>

      <ol class="steps">
        <Step n={1} title="Movimientos del mes" status={txs.length ? 'ok' : 'info'} note={txs.length ? `${txs.length} registrados` : 'Ninguno registrado'}>
          {txs.length > 0 && (
            <div class="table-wrap">
              <table class="compact">
                <tbody>
                  {txs.slice(0, 10).map((x) => (
                    <tr>
                      <td>{date(x.date)}</td>
                      <td>{TYPE_LABELS[x.type]}</td>
                      <td>{x.asset ? ctx.book.assets.get(x.asset)?.name ?? x.asset : ctx.book.accounts.get(x.account)?.name}</td>
                      <td class={`n ${sign(x.amount.toNumber())}`}>{money(x.amount, x.ccy)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p class="small muted">
            {txs.length > 10 && `…y ${txs.length - 10} más. `}¿Falta una compra, venta, dividendo o aporte? <a href="#/movimientos">Regístralo en Movimientos</a> y vuelve aquí.
          </p>
        </Step>

        <Step
          n={2}
          title="Precios de mercado y TRM"
          status={m < 0 || missing.length ? 'block' : stale.length || oldFx.length ? 'warn' : 'ok'}
          note={m < 0 ? 'Faltan datos' : missing.length ? `${missing.length} sin precio` : `${marketRows.length} activos con precio al ${date(month)}`}
        >
          {m < 0 && (
            <p class="small">
              {t.error ?? 'El mes todavía no termina.'} Actualiza precios y TRM aquí abajo, o impórtalos en <a href="#/datos">Datos</a>.
            </p>
          )}
          {missing.length > 0 && <p class="small">Sin precio, se valorarían al costo: {missing.map((r) => r.label).join(', ')}. Cárgalos en <a href="#/datos">Datos</a>.</p>}
          {stale.length > 0 && <p class="small">Con un precio de más de 5 días antes del cierre: {stale.map((r) => r.label).join(', ')}.</p>}
          {oldFx.length > 0 && (
            <p class="small">
              Tasa de cambio de más de 5 días antes del cierre: {oldFx.map((r) => `${r.ccy}/USD del ${date(r.last)}`).join(', ')}. Importa la del cierre en <a href="#/datos">Datos</a>.
            </p>
          )}
          {(m < 0 || missing.length > 0 || stale.length > 0 || oldFx.length > 0) && <RefreshCard compact />}
        </Step>

        <Step
          n={3}
          title="Valores de fin de mes (sin precio público)"
          status={due.length ? 'block' : rows.length ? 'ok' : 'info'}
          note={due.length ? `Faltan ${due.length} de ${rows.length}` : rows.length ? 'Completos' : 'No aplica'}
        >
          {msg && (
            <div class={`notice ${msg.kind}`} role="status">
              {msg.text}
            </div>
          )}
          {rows.length > 0 && (
            <form onSubmit={save}>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Activo</th>
                      <th>Valor anterior</th>
                      <th>Valor al {date(month)}</th>
                      <th>¿Estimado?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={key(r)}>
                        <td>
                          {r.name}
                          <div class="small muted">
                            {bucketLabel(r.bucket)} · {ctx.book.accounts.get(r.account)?.name}
                          </div>
                        </td>
                        <td class="small">{r.previous ? `${money(dec(r.previous.value), r.ccy)} (${date(r.previous.date)})` : '—'}</td>
                        <td>
                          <input
                            inputMode="decimal"
                            aria-label={`Valor de ${r.name} al ${month}`}
                            placeholder={r.existing ? r.existing[0]!.amount.toString() : r.ccy}
                            value={values[key(r)] ?? ''}
                            onInput={(e) => setValues({ ...values, [key(r)]: (e.target as HTMLInputElement).value })}
                          />
                          {r.existing ? (
                            <div class="small muted">Ya registrado: {money(r.existing[0]!.amount, r.ccy)} — si escribes otro, lo reemplaza</div>
                          ) : (
                            <div class="small pending">Pendiente</div>
                          )}
                        </td>
                        <td>
                          <label style="display:flex;gap:6px;align-items:center" class="small">
                            <input type="checkbox" checked={isEstimated(r)} onChange={(e) => setEstimated({ ...estimated, [key(r)]: (e.target as HTMLInputElement).checked })} />
                            {r.bucket === 'inmobiliario' ? 'precio de lista' : 'estimado'}
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div class="actions" style="margin-top:12px">
                <button type="submit" class="primary">
                  Guardar valores de {monthLabel(month)}
                </button>
                <span class="small muted">Marca «estimado» si no es el valor de un extracto (p. ej. precio de lista del inmueble).</span>
              </div>
            </form>
          )}
          {rows.length === 0 && <p class="small muted">No hay activos de valor manual abiertos al {date(month)}.</p>}
        </Step>

        <Step n={4} title="Resultado del mes" status={m < 0 ? 'block' : blockers.length ? 'warn' : 'ok'} note={m < 0 ? 'Sin datos' : blockers.length ? 'Preliminar: faltan datos' : 'Listo para cerrar'}>
          {m >= 0 && <MonthResult t={t} m={m} ctx={ctx} />}
        </Step>

        <Step n={5} title="Cerrar el mes" status={closed ? 'ok' : blockers.length ? 'block' : 'info'} note={closed ? `Cerrado el ${date(closed.closedAt)}` : blockers.length ? 'Completa los pasos anteriores' : 'Todo listo'}>
          {closed && drift && !drift.abs().lt(1) && (
            <div class="notice warn" role="status">
              Las cifras cambiaron desde que cerraste: el total era {money(dec(closed.total), 'COP')} y ahora es {money(tCop.total.cells[mc]!.value, 'COP')} ({drift.gt(0) ? '+' : ''}
              {money(drift, 'COP')}). Suele ser un movimiento o un precio registrado después del cierre.
            </div>
          )}
          {blockers.length > 0 && !closed && (
            <ul class="small blockers">
              {blockers.map((b) => (
                <li>{b}</li>
              ))}
            </ul>
          )}
          <div class="actions">
            {!closed && (
              <button type="button" class="primary big" disabled={blockers.length > 0} onClick={doClose}>
                Cerrar {monthLabel(month)}
              </button>
            )}
            {closed && drift && !drift.abs().lt(1) && (
              <button type="button" class="primary" disabled={blockers.length > 0} onClick={doClose}>
                Actualizar el cierre con las cifras de hoy
              </button>
            )}
            {closed && (
              <button type="button" onClick={() => setDataset(reopenMonth(getDataset(), month))}>
                Reabrir el mes
              </button>
            )}
            <a href="#/seguimiento" class="small">
              Ver el seguimiento mes a mes
            </a>
          </div>
        </Step>
      </ol>
    </>
  );
}

function MonthResult({ t, m, ctx }: { t: Tracking; m: number; ctx: Context }) {
  const ccy = t.ccy;
  const total = t.total.cells[m]!;
  const ex = t.exRealEstate.cells[m]!;
  const hasRe = t.classes.some((c) => c.bucket === 'inmobiliario' && !c.cells[m]!.value.isZero());
  const ytd = yearToDate(t.total, t.months, m);
  const x = xirrToDate(t.total, t.months, m);
  const rows = orderedRows(t, m, m, new Set(t.classes.map((c) => c.bucket!)));
  const prev = m > 0 ? t.months[m - 1] : undefined;
  const bench = (bucket: string | undefined) => {
    const b = bucket ? ctx.benchmarks.find((x) => x.buckets.includes(bucket)) : undefined;
    return b && prev ? { name: b.name, r: indexReturn(ctx, b.symbol, ccy, prev, t.months[m]!) } : undefined;
  };
  const movers = t.assets.filter((a) => !a.cells[m]!.gain.isZero()).sort((a, b) => b.cells[m]!.gain.comparedTo(a.cells[m]!.gain));
  const shown = movers.length <= 10 ? movers : [...movers.slice(0, 5), ...movers.slice(-5)];
  const items: BarItem[] = shown.map((a) => ({
    label: a.label,
    value: a.cells[m]!.gain.toNumber(),
    color: a.cells[m]!.gain.gte(0) ? 'var(--dv-pos)' : 'var(--dv-neg)',
    text: `${moneyShort(a.cells[m]!.gain, ccy)} (${pct(a.cells[m]!.r)})`,
    title: `${a.label} · ${a.sub ?? ''}`,
  }));
  const carried = t.assets.filter((a) => a.cells[m]!.flag === 'stale' || a.cells[m]!.flag === 'cost');
  return (
    <>
      {carried.length > 0 && (
        <p class="small pending">Preliminar: {carried.map((a) => a.label).join(', ')} todavía usan un valor o precio de una fecha anterior.</p>
      )}
      <div class="result-hero">
        <div>
          <div class="small muted">Ganancia del mes (todo el portafolio)</div>
          <div class={`figure ${sign(total.gain.toNumber())}`}>
            {total.gain.gt(0) ? '+' : ''}
            {moneyShort(total.gain, ccy)}
          </div>
          <div class="small muted">
            {money(prev ? t.total.cells[m - 1]!.value : dec(0), ccy)} → {money(total.value, ccy)} · aportes netos {money(total.flow, ccy)}
          </div>
        </div>
        <div class="chips">
          <span class={`chip ${sign(total.r) === 'pos' ? 'good' : sign(total.r) === 'neg' ? 'bad' : ''}`}>
            Rend. del mes <strong>{pct(total.r)}</strong>
          </span>
          {hasRe && (
            <span class={`chip ${sign(ex.r) === 'pos' ? 'good' : sign(ex.r) === 'neg' ? 'bad' : ''}`}>
              Sin inmobiliario <strong>{pct(ex.r)}</strong> · {moneyShort(ex.gain, ccy)}
            </span>
          )}
          <span class={`chip ${sign(ytd) === 'pos' ? 'good' : sign(ytd) === 'neg' ? 'bad' : ''}`}>
            Año corrido <strong>{pct(ytd)}</strong>
          </span>
          <span class={`chip ${sign(x) === 'pos' ? 'good' : sign(x) === 'neg' ? 'bad' : ''}`}>
            XIRR a la fecha <strong>{pct(x)}</strong>
          </span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="result">
          <thead>
            <tr>
              <th>Portafolio</th>
              <th class="n">Valor inicial</th>
              <th class="n">Aportes netos</th>
              <th class="n">Ganancia</th>
              <th class="n">Rend. del mes</th>
              <th class="n">Índice del mes</th>
              <th class="n">Valor al cierre</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const c = r.cells[m]!;
              const b = r.kind === 'class' ? bench(r.bucket) : undefined;
              return (
                <tr class={`k-${r.kind}`}>
                  <td>
                    {r.bucket && <span class="wbar" style={`width:10px;background:${classColor(r.bucket)}`} />}
                    {r.label}
                  </td>
                  <td class="n">{money(m > 0 ? r.cells[m - 1]!.value : dec(0), ccy)}</td>
                  <td class="n">{money(c.flow, ccy)}</td>
                  <td class={`n ${sign(c.gain.toNumber())}`}>{money(c.gain, ccy)}</td>
                  <td class={`n ${r.kind === 'cash' ? '' : sign(c.r)}`}>{r.kind === 'cash' ? '' : pct(c.r)}</td>
                  <td class={`n ${sign(b?.r)}`} title={b?.name}>
                    {b ? (
                      <>
                        {pct(b.r)}
                        <small class="muted"> {b.name}</small>
                      </>
                    ) : (
                      ''
                    )}
                  </td>
                  <td class="n">{money(c.value, ccy)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {items.length > 0 && (
        <>
          <h3 style="margin-top:14px">{movers.length > 10 ? 'Los que más ganaron y perdieron en el mes' : 'Ganancia de cada activo en el mes'}</h3>
          <BarList items={items} label="Ganancia del mes por activo" pad={128} />
        </>
      )}
      <p class="small muted" style="margin-top:8px">
        Ganancia = valor al cierre − valor al cierre anterior − aportes netos; incluye dividendos y el efecto de la TRM. Efectivo: caja de los brókers, intereses, comisiones y efecto cambiario sobre la caja.
      </p>
    </>
  );
}
