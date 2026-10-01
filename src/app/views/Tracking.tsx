import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ZERO } from '../../domain/money.ts';
import type { Decimal } from '../../domain/money.ts';
import { contextOf } from '../context.ts';
import { byClassOrder, classColor } from '../components/Bars.tsx';
import { MonthBars } from '../components/MonthBars.tsx';
import { date, money, monthLabel, pct, today } from '../format.ts';
import { REAL_ESTATE, tracking, xirrToDate, yearToDate } from '../tracking.ts';
import type { Cell, TrackRow, Tracking as TrackingData } from '../tracking.ts';
import { useDataset, usePref } from '../store.ts';

type Metric = 'value' | 'gain' | 'fx' | 'r' | 'flow';
const METRICS: { id: Metric; label: string }[] = [
  { id: 'value', label: 'Valor' },
  { id: 'gain', label: 'Ganancia del mes' },
  { id: 'fx', label: 'Efecto cambiario' },
  { id: 'r', label: 'Rend. del mes' },
  { id: 'flow', label: 'Aportes netos' },
];

const FLAG_MARK = { cost: '*', stale: '†', estimated: 'e' } as const;
const FLAG_TEXT = {
  cost: 'sin precio ni valor manual: al costo',
  stale: 'precio o valor de una fecha anterior',
  estimated: 'valor estimado (p. ej. precio de lista)',
} as const;

/** Grid figures: COP in millions with one decimal, USD in whole dollars; the exact amount goes in the tooltip. */
export function gridNumber(x: Decimal, ccy: string): string {
  const n = x.toNumber();
  return ccy === 'COP'
    ? new Intl.NumberFormat('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n / 1e6)
    : new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n);
}

/** Heat for a monthly return: the diverging pair, stronger with size, capped at ±10 %. */
export function heat(r: number | null): string | undefined {
  if (r === null) return undefined;
  const a = Math.round(Math.min(Math.abs(r) / 0.1, 1) * 38);
  return a < 3 ? undefined : `background:color-mix(in srgb, ${r >= 0 ? 'var(--dv-pos)' : 'var(--dv-neg)'} ${a}%, transparent)`;
}

const sign = (x: number | null | undefined) => (x === null || x === undefined ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');

function cellView(metric: Metric, c: Cell, ccy: string, kind: TrackRow['kind']): { text: string; cls: string; style?: string; title: string } {
  const exact = `Valor ${money(c.value, ccy)} · aportes netos ${money(c.flow, ccy)} · ganancia ${money(c.gain, ccy)} ${c.fx ? `(inversión ${money(c.gain.minus(c.fx), ccy)}, efecto cambiario ${money(c.fx, ccy)})` : '(sin tasa para separar el efecto cambiario)'} · rend. ${pct(c.r)}`;
  const title = c.flag ? `${exact} · ${FLAG_TEXT[c.flag]}` : exact;
  const held = !c.value.isZero() || !c.flow.isZero();
  if (!held) return { text: '', cls: 'n', title: '' };
  switch (metric) {
    case 'value':
      return { text: c.value.isZero() ? '0' : gridNumber(c.value, ccy), cls: 'n', title };
    case 'flow':
      return { text: c.flow.isZero() ? '' : gridNumber(c.flow, ccy), cls: `n ${sign(c.flow.toNumber())}`, title };
    case 'gain':
      return { text: gridNumber(c.gain, ccy), cls: `n ${sign(c.gain.toNumber())}`, title };
    case 'fx':
      if (!c.fx) return { text: '—', cls: 'n', title };
      return { text: c.fx.abs().lt(ccy === 'COP' ? 0.5 : 0.005) ? '' : gridNumber(c.fx, ccy), cls: `n ${sign(c.fx.toNumber())}`, title };
    case 'r':
      return kind === 'cash' ? { text: '', cls: 'n', title } : { text: pct(c.r), cls: 'n', style: heat(c.r), title };
  }
}

/** Display order: classes (fixed order) with their assets, cash, subtotal without real estate, real estate, total. */
export function orderedRows(t: TrackingData, from: number, to: number, collapsed: ReadonlySet<string> = new Set()): (TrackRow & { depth: number })[] {
  const live = (r: TrackRow) => r.cells.slice(from, to + 1).some((c) => !c.value.isZero() || !c.flow.isZero());
  const classes = t.classes.filter(live).sort((a, b) => byClassOrder(a.bucket!, b.bucket!));
  const withAssets = (c: TrackRow) => [
    { ...c, depth: 0 },
    ...(collapsed.has(c.bucket!)
      ? []
      : t.assets
          .filter((a) => a.bucket === c.bucket && live(a))
          .sort((a, b) => b.cells[to]!.value.comparedTo(a.cells[to]!.value) || a.label.localeCompare(b.label))
          .map((a) => ({ ...a, depth: 1 }))),
  ];
  const re = classes.find((c) => c.bucket === REAL_ESTATE);
  return [
    ...classes.filter((c) => c !== re).flatMap(withAssets),
    ...(live(t.cash) ? [{ ...t.cash, depth: 0 }] : []),
    ...(re ? [{ ...t.exRealEstate, depth: 0 }, ...withAssets(re)] : []),
    { ...t.total, depth: 0 },
  ];
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Semicolon-separated with decimal commas, so a Spanish-locale Excel opens it as numbers. */
function toCsv(rows: TrackRow[], months: string[], from: number, metric: Metric): string {
  const n = (x: number) => x.toFixed(2).replace('.', ',');
  const lines = [['Fila', 'Cuenta', ...months].join(';')];
  for (const r of rows) {
    const vals = months.map((_, i) => {
      const c = r.cells[from + i]!;
      if (metric === 'r') return c.r === null ? '' : `${n(c.r * 100)}%`;
      if (metric === 'fx') return c.fx ? n(c.fx.toNumber()) : '';
      return n((metric === 'value' ? c.value : metric === 'gain' ? c.gain :  c.flow).toNumber());
    });
    lines.push([`"${r.label.replace(/"/g, '""')}"`, `"${r.sub ?? ''}"`, ...vals].join(';'));
  }
  return lines.join('\r\n');
}

export function Tracking() {
  const { data } = useDataset();
  const ctx = contextOf(data);
  const [ccy, setCcy] = usePref<'COP' | 'USD'>('ccy', 'COP');
  const [metric, setMetric] = usePref<Metric>('track:metric', 'value');
  const [range, setRange] = usePref<string>('track:range', '12');
  const [scope, setScope] = usePref<string>('track:scope', 'total');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const t = useMemo(() => tracking(ctx, ccy, today()), [ctx, ccy]);
  const closed = useMemo(() => new Set((data.closes ?? []).map((c) => c.month)), [data]);
  const wrap = useRef<HTMLDivElement>(null);

  const years = [...new Set(t.months.map((m) => m.slice(0, 4)))].reverse();
  const last = t.months.length - 1;
  let from = 0;
  let to = last;
  if (range === '12' || range === '24') from = Math.max(0, last - Number(range) + 1);
  else if (range.startsWith('y')) {
    from = t.months.findIndex((m) => m.startsWith(range.slice(1)));
    to = t.months.findLastIndex((m) => m.startsWith(range.slice(1)));
    if (from < 0) [from, to] = [Math.max(0, last - 11), last];
  }
  const months = t.months.slice(from, to + 1);
  const rows = useMemo(() => (last < 0 ? [] : orderedRows(t, from, to, collapsed)), [t, from, to, collapsed, last]);

  // Spreadsheet habit: the latest month is on the right, so start scrolled to it.
  useEffect(() => {
    if (wrap.current) wrap.current.scrollLeft = wrap.current.scrollWidth;
  }, [t, from, to, metric]);

  if (last < 0) {
    return (
      <div class="card">
        <h2>Seguimiento mensual</h2>
        <p class="muted">{t.error ?? 'Todavía no hay un cierre de mes con datos.'}</p>
      </div>
    );
  }

  const scopes = [t.total, t.exRealEstate, ...t.classes.filter((c) => c.cells.some((x) => !x.value.isZero())).sort((a, b) => byClassOrder(a.bucket!, b.bucket!))];
  const sel = scopes.find((s) => s.id === scope) ?? t.total;
  const toggle = (b: string) => {
    const next = new Set(collapsed);
    if (next.has(b)) next.delete(b);
    else next.add(b);
    setCollapsed(next);
  };
  const flagsShown = rows.some((r) => r.cells.slice(from, to + 1).some((c) => c.flag));

  return (
    <>
      <div class="toolbar">
        <div class="filters">
          <label>
            Meses
            <select value={range} onChange={(e) => setRange((e.target as HTMLSelectElement).value)}>
              <option value="12">Últimos 12</option>
              <option value="24">Últimos 24</option>
              {years.map((y) => (
                <option value={`y${y}`}>Año {y}</option>
              ))}
              <option value="all">Todo ({t.months.length})</option>
            </select>
          </label>
          <div class="field">
            Ver
            <div class="seg" role="group" aria-label="Qué mostrar en cada mes">
              {METRICS.map((m) => (
                <button type="button" aria-pressed={metric === m.id} onClick={() => setMetric(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
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
        </div>
      </div>
      {t.error && (
        <div class="notice warn" role="status">
          El seguimiento llega hasta {monthLabel(t.months[last]!)}. {t.error}. Cárgalo en <a href="#/datos">Datos</a> para ver el mes siguiente.
        </div>
      )}

      <div class="card">
        <div class="card-head">
          <h2>Seguimiento mes a mes</h2>
          <span class="small muted">
            {metric === 'r' ? 'Rentabilidad de cada mes (TWR, Modified Dietz)' : ccy === 'COP' ? 'Cifras en millones de pesos' : 'Cifras en dólares'} · pasa el cursor por una celda para ver el detalle
          </span>
        </div>
        <div class="table-wrap track-wrap" ref={wrap}>
          <table class="track">
            <thead>
              <tr>
                <th class="rowh">Activo</th>
                {months.map((m) => (
                  <th class="n">
                    <a href={`#/cierre?mes=${m}`} title={closed.has(m) ? `Mes cerrado · ver el cierre` : 'Ver o hacer el cierre de este mes'}>
                      {monthLabel(m).split(' ')[0]}
                      <small>
                        {m.slice(0, 4)}
                        {closed.has(m) && <span class="ok"> ✓</span>}
                      </small>
                    </a>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr class={`k-${r.kind}`} key={r.id}>
                  <th class="rowh" scope="row" style={r.bucket && r.kind === 'class' ? `--c:${classColor(r.bucket)}` : undefined}>
                    {r.kind === 'class' ? (
                      <button type="button" class="rowtoggle" aria-expanded={!collapsed.has(r.bucket!)} onClick={() => toggle(r.bucket!)}>
                        <span class="caret" aria-hidden="true">{collapsed.has(r.bucket!) ? '▸' : '▾'}</span>
                        {r.label}
                      </button>
                    ) : (
                      <span class="lbl">
                        {r.label}
                        {r.sub && <small>{r.sub}</small>}
                      </span>
                    )}
                  </th>
                  {r.cells.slice(from, to + 1).map((c) => {
                    const v = cellView(metric, c, ccy, r.kind);
                    return (
                      <td class={v.cls} style={v.style} title={v.title}>
                        {v.text}
                        {c.flag && r.kind === 'asset' && v.text && <sup class={`flag f-${c.flag}`}>{FLAG_MARK[c.flag]}</sup>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="actions" style="margin-top:10px;justify-content:space-between">
          <span class="small muted">
            {flagsShown && (
              <>
                <sup class="flag f-cost">*</sup> al costo, falta precio · <sup class="flag f-stale">†</sup> precio o valor de una fecha anterior · <sup class="flag f-estimated">e</sup> estimado ·{' '}
              </>
            )}
            Ganancia del mes = valor al cierre − valor al cierre anterior − aportes netos (incluye dividendos y efecto cambiario). ✓ = mes cerrado.
          </span>
          <button type="button" onClick={() => download(`seguimiento-${METRICS.find((m) => m.id === metric)!.label.toLowerCase().replace(/[^a-z]+/g, '-')}-${ccy}.csv`, toCsv(rows, months, from, metric))}>
            Descargar para Excel
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Resumen mensual</h2>
          <div class="seg scopes" role="group" aria-label="Portafolio">
            {scopes.map((s) => (
              <button type="button" aria-pressed={sel.id === s.id} onClick={() => setScope(s.id)}>
                {s.kind === 'subtotal' ? 'Sin inmobiliario' : s.label}
              </button>
            ))}
          </div>
        </div>
        <p class="small muted">Rentabilidad de cada mes de {sel.kind === 'total' ? 'todo el portafolio' : sel.kind === 'subtotal' ? 'todo menos el inmobiliario' : sel.label}, como en tu hoja de consolidado.</p>
        <MonthBars items={months.map((m, i) => ({ date: m, value: sel.cells[from + i]!.r }))} format={(v) => pct(v, 1)} label={`Rentabilidad mensual de ${sel.label}`} />
        <div class="table-wrap" style="margin-top:8px">
          <table>
            <thead>
              <tr>
                <th>Mes</th>
                <th class="n">Valor inicial</th>
                <th class="n">Aportes netos</th>
                <th class="n">Ganancia del mes</th>
                <th class="n">Rend. del mes</th>
                <th class="n">Rend. año corrido</th>
                <th class="n">XIRR a la fecha</th>
                <th class="n">Valor al cierre</th>
              </tr>
            </thead>
            <tbody>
              {months
                .map((m, i) => ({ m, k: from + i }))
                .reverse()
                .map(({ m, k }) => {
                  const c = sel.cells[k]!;
                  const x = xirrToDate(sel, t.months, k);
                  const y = yearToDate(sel, t.months, k);
                  return (
                    <tr>
                      <td>
                        <a href={`#/cierre?mes=${m}`}>{monthLabel(m)}</a>
                        {closed.has(m) && <span class="badge info" style="margin-left:6px">cerrado</span>}
                      </td>
                      <td class="n">{money(k > 0 ? sel.cells[k - 1]!.value : ZERO, ccy)}</td>
                      <td class="n">{money(c.flow, ccy)}</td>
                      <td class={`n ${sign(c.gain.toNumber())}`}>{money(c.gain, ccy)}</td>
                      <td class={`n ${sign(c.r)}`}>{pct(c.r)}</td>
                      <td class={`n ${sign(y)}`}>{pct(y)}</td>
                      <td class={`n ${sign(x)}`}>{pct(x)}</td>
                      <td class="n">{money(c.value, ccy)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <p class="small muted" style="margin-top:8px">
          Rend. del mes: ponderado por tiempo (Modified Dietz), el que se compara con un índice. XIRR a la fecha: ponderada por dinero, desde el primer aporte hasta ese cierre. Montos en {ccy}, cada aporte a la tasa de su fecha y cada
          cierre a la TRM de fin de mes. Último cierre calculado: {date(t.months[last])}.
        </p>
      </div>
    </>
  );
}
