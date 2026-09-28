import { useMemo, useState } from 'preact/hooks';
import { addDays, daysBetween } from '../../domain/dates.ts';
import { analyze, analyzeMix, windowStart } from '../analysis.ts';
import type { Report, ScopeResult } from '../analysis.ts';
import { contextOf, coverage } from '../context.ts';
import { Filters, useFilters } from '../components/Filters.tsx';
import { Glossary } from '../components/Glossary.tsx';
import { date, money, moneyShort, monthLabel, pct, ratio, today } from '../format.ts';
import { useDataset, usePref } from '../store.ts';
import { CASH, moveSlot, parseLayout, parseSelection, pick, saveLayout } from '../selection.ts';
import type { Selection, Slot } from '../selection.ts';
import { combineRows, tracking } from '../tracking.ts';
import type { TrackRow, Tracking } from '../tracking.ts';
import { gainBridge, gainOver, returnsByYear, riskOf } from '../insights.ts';
import { ReturnsHeatmap } from '../components/Heatmap.tsx';
import { Bridge } from '../components/Bridge.tsx';
import type { BridgeStep } from '../components/Bridge.tsx';
import { LineChart } from '../components/LineChart.tsx';
import { BarList, StackedBar, byClassOrder, classColor } from '../components/Bars.tsx';
import type { BarItem, Part } from '../components/Bars.tsx';
import { dec } from '../../domain/money.ts';
import type { Dataset } from '../../data/json.ts';

/** The Resumen's blocks, in their default order. The user can hide them and change the order. */
const MODULES = [
  { id: 'valor', label: 'Valor y evolución' },
  { id: 'kpis', label: 'Rentabilidad y ganancia' },
  { id: 'mix', label: '¿Dónde está tu dinero?' },
  { id: 'bridge', label: '¿De dónde viene tu ganancia?' },
  { id: 'heatmap', label: 'Rentabilidad mes a mes' },
  { id: 'risk', label: 'Riesgo y caídas' },
  { id: 'classes', label: 'Rendimiento por clase' },
  { id: 'table', label: 'Tabla detallada por clase' },
] as const;
const MODULE_IDS = MODULES.map((m) => m.id);
/** Blocks built on the month-by-month tracking (computed only when one of them is shown). */
const MONTHLY = new Set(['bridge', 'heatmap', 'risk']);

const sign = (x: number | undefined | null) => (x === undefined || x === null ? '' : x >= 0 ? 'pos' : 'neg');

const ICONS = {
  xirr: 'M3 17l5-5 4 4 8-8M14 8h6v6',
  twr: 'M4 19V9M10 19V5M16 19v-7M22 19H2',
  gain: 'M12 3v18M17 7.5C17 5.6 14.8 4.5 12 4.5S7 5.6 7 7.5s2 2.7 5 3.3 5 1.6 5 3.6-2.2 3.1-5 3.1-5-1.1-5-3',
  income: 'M4 7h16v12H4zM4 11h16M9 3h6v4H9z',
};
function Icon({ d }: { d: string }) {
  return (
    <span class="ico" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2} stroke-linecap="round" stroke-linejoin="round">
        <path d={d} />
      </svg>
    </span>
  );
}

export function Summary() {
  const { data } = useDataset();
  const [f, set] = useFilters();
  const ctx = contextOf(data);
  const rep = useMemo(() => analyze(ctx, f.ccy, f.asOf, f.window), [ctx, f.ccy, f.asOf, f.window]);
  const ordered = [...rep.buckets].sort((a, b) => byClassOrder(a.bucket, b.bucket));
  const all = [...ordered.map((b) => b.bucket), ...(rep.cash.isZero() ? [] : [CASH])];
  const [saved, setSaved] = usePref<string>('summary:selection', '');
  const [multi, setMulti] = useState(false);
  const sel = parseSelection(saved, all);
  const on = (id: string) => !sel || sel.includes(id);
  const choose = (id: string, e: MouseEvent) => setSaved((pick(sel, id, all, multi || e.ctrlKey || e.metaKey) ?? []).join(','));
  const mix = useMemo(
    () => (sel ? analyzeMix(ctx, sel.filter((x) => x !== CASH), sel.includes(CASH), f.ccy, f.asOf, f.window) : undefined),
    [ctx, saved, f.ccy, f.asOf, f.window],
  );
  const [layoutPref, setLayoutPref] = usePref<string>('summary:layout', '');
  const layout = parseLayout(layoutPref, MODULE_IDS);
  const needMonthly = layout.some((s) => s.on && MONTHLY.has(s.id));
  const trk = useMemo(() => (needMonthly ? tracking(ctx, f.ccy, f.asOf) : undefined), [ctx, f.ccy, f.asOf, needMonthly]);
  const monthly = useMemo(() => {
    if (!trk) return undefined;
    const rows = [...trk.classes.filter((c) => on(c.bucket!)).sort((a, b) => byClassOrder(a.bucket!, b.bucket!)), ...(on(CASH) ? [trk.cash] : [])];
    // Adding up the rows gives the total's figures plus the data-quality flags of the months.
    const row = combineRows(rows, 'mix', sel ? 'Selección' : 'Todo');
    const assets = trk.assets.filter((a) => on(a.bucket!));
    // A class bought on a payment plan (property off-plan) has a TWR on a small leveraged base: not comparable,
    // as its class card says. Its monthly returns and risk are not shown when the selection is only that.
    const picked = rep.buckets.filter((b) => on(b.bucket));
    const leveraged = picked.length > 0 && picked.every((b) => b.leveraged);
    return { trk, rows, row, assets, leveraged };
  }, [trk, saved, rep]);
  const t = mix ?? rep.total;
  const withCash = on(CASH);
  const gain = t.perf ? t.perf.endValue.minus(t.perf.startValue).minus(t.perf.netFlows) : undefined;
  const income = rep.buckets.filter((b) => on(b.bucket)).reduce((a, b) => a.plus(b.income), dec(0));
  const compact = (v: number) => moneyShort(dec(v), f.ccy);
  const history = t.history;
  const share = (v: typeof t.value) => (t.value.isZero() ? 0 : v.div(t.value).toNumber());
  const labelOf = (id: string) => (id === CASH ? 'Efectivo en cuentas' : ordered.find((b) => b.bucket === id)?.label ?? id);
  const parts: Part[] = ordered.map((b) => ({ id: b.bucket, label: b.label, value: b.value.toNumber(), color: classColor(b.bucket), detail: on(b.bucket) ? <>{moneyShort(b.value, f.ccy)}<small>{pct(share(b.value))}</small></> : <small>fuera de la selección</small> }));
  if (!rep.cash.isZero()) parts.push({ id: CASH, label: 'Efectivo en cuentas', value: rep.cash.toNumber(), color: 'var(--context)', detail: withCash ? <>{moneyShort(rep.cash, f.ccy)}<small>{pct(share(rep.cash))}</small></> : <small>fuera de la selección</small> });
  return (
    <>
      <Filters state={f} set={set} />
      <DataAlerts rep={rep} data={data} />
      <CloseNudge data={data} />
      <Picker all={all} sel={sel} labelOf={labelOf} choose={choose} reset={() => setSaved('')} multi={multi} setMulti={setMulti} />
      {mix?.error && <div class="notice err">{mix.error}</div>}

      <Customize layout={layout} set={(l) => setLayoutPref(l.length ? saveLayout(l) : '')} />
      {layout
        .filter((m) => m.on)
        .map((m) => {
          switch (m.id) {
            case 'valor':
              return (
                <section class="card hero" aria-label={sel ? 'Valor de la selección' : 'Valor del portafolio'}>
                  <div>
                    <div class="kicker">{sel ? 'Valor de la selección' : 'Valor del portafolio'}</div>
                    <div class="figure">{moneyShort(t.value, f.ccy)}</div>
                    <div class="exact">{money(t.value, f.ccy)} al {date(f.asOf)}</div>
                    {sel && (
                      <div class="exact">
                        {sel.map(labelOf).join(' + ')} · {pct(rep.total.value.isZero() ? 0 : t.value.div(rep.total.value).toNumber())} del total
                      </div>
                    )}
                    {gain && (
                      <div class="gain">
                        Ganaste <strong class={sign(gain.toNumber())}>{moneyShort(gain, f.ccy)}</strong> sobre {t.perf ? moneyShort(t.perf.startValue.plus(t.perf.netFlows), f.ccy) : '—'} que pusiste
                      </div>
                    )}
                    <div class="chips">
                      <span class={`chip ${chipTone(t.perf?.xirr)}`}>
                        XIRR <strong>{pct(t.perf?.xirr)}</strong>
                      </span>
                      <span class={`chip ${chipTone(t.perf?.twrAnnual)}`}>
                        TWR <strong>{pct(t.perf?.twrAnnual)}</strong>
                      </span>
                      <span class="chip">desde {date(t.perf?.since)}</span>
                    </div>
                  </div>
                  <div>
                    {history.length >= 2 && (
                      <LineChart
                        dates={history.map((h) => h.date)}
                        series={[
                          { id: 'value', name: sel ? 'Valor de la selección' : 'Valor del portafolio', color: 'var(--s1)', values: history.map((h) => h.value) },
                          { id: 'invested', name: 'Lo que pusiste (aportes netos)', color: 'var(--context)', values: history.map((h) => h.invested) },
                        ]}
                        area="value"
                        reference={0}
                        height={230}
                        compact
                        format={(v) => money(dec(Math.round(v)), f.ccy, 0)}
                        axisFormat={compact}
                        label={`${sel ? 'Valor de la selección' : 'Valor del portafolio'} frente a lo que has aportado`}
                      />
                    )}
                  </div>
                </section>
              );
            case 'kpis':
              return (
                <div class="tiles">
                  <div class="tile">
                    <Icon d={ICONS.xirr} />
                    <div>
                      <div class="label">Tu rentabilidad (XIRR, anual)</div>
                      <div class={`value ${sign(t.perf?.xirr)}`}>{pct(t.perf?.xirr)}</div>
                      <div class="sub">Ponderada por dinero: incluye cuándo aportaste y retiraste</div>
                    </div>
                  </div>
                  <div class="tile">
                    <Icon d={ICONS.twr} />
                    <div>
                      <div class="label">Rentabilidad de la inversión (TWR, anual)</div>
                      <div class={`value ${sign(t.perf?.twrAnnual)}`}>{pct(t.perf?.twrAnnual)}</div>
                      <div class="sub">Ponderada por tiempo · acumulada {pct(t.perf?.twr)} desde {date(t.perf?.since)}</div>
                    </div>
                  </div>
                  <div class="tile">
                    <Icon d={ICONS.gain} />
                    <div>
                      <div class="label">Ganancia en el periodo</div>
                      <div class={`value ${sign(gain?.toNumber())}`}>{gain ? moneyShort(gain, f.ccy) : '—'}</div>
                      <div class="sub">
                        Aportes netos {t.perf ? moneyShort(t.perf.netFlows, f.ccy) : '—'}
                        {withCash && ` · efectivo en cuentas ${moneyShort(rep.cash, f.ccy)}`}
                      </div>
                    </div>
                  </div>
                  <div class="tile">
                    <Icon d={ICONS.income} />
                    <div>
                      <div class="label">Dividendos e intereses</div>
                      <div class="value">{moneyShort(income, f.ccy)}</div>
                      <div class="sub">Acumulados hasta la fecha de corte, a la tasa de cada pago</div>
                    </div>
                  </div>
                </div>
              );
            case 'mix':
              return (
                <div class="card">
                  <div class="card-head">
                    <h2>¿Dónde está tu dinero?</h2>
                    <span class="small muted">{sel ? 'Peso de cada clase dentro de la selección' : 'Peso de cada clase en el valor total'}</span>
                  </div>
                  <StackedBar parts={parts} label="Distribución del portafolio por clase de activo" isOn={on} onPick={choose} />
                </div>
              );
            case 'bridge':
              return monthly && <BridgeCard m={monthly} from={windowStart(f.window, f.asOf)} ccy={f.ccy} />;
            case 'heatmap':
              return monthly && <HeatmapCard m={monthly} sel={sel ? sel.map(labelOf).join(' + ') : undefined} />;
            case 'risk':
              return monthly && <RiskCard m={monthly} from={windowStart(f.window, f.asOf)} />;
            case 'classes':
              return (
                <>
                  <div class="card-head" style="margin-top:4px">
                    <h2>Rendimiento por clase</h2>
                    <span class="small muted">TWR anual frente a su índice de retorno total · clic en una tarjeta para ver solo esa clase, Ctrl/⌘ + clic para sumar o quitar</span>
                  </div>
                  <div class="classes">
                    {rep.buckets.map((b) => (
                      <ClassCard b={b} ccy={f.ccy} state={!sel ? 'all' : on(b.bucket) ? 'on' : 'off'} choose={choose} />
                    ))}
                  </div>
                </>
              );
            case 'table':
              return (
                <div class="card">
                  <details>
                    <summary>Ver tabla detallada por clase</summary>
                    <DetailTable rep={rep} ccy={f.ccy} sel={sel} mix={mix} labelOf={labelOf} />
                  </details>
                </div>
              );
          }
        })}
      <Glossary />
    </>
  );
}

const chipTone = (x: number | null | undefined) => (x === undefined || x === null ? '' : x >= 0 ? 'good' : 'bad');

/** The portfolios the page adds up: a click shows only one, Ctrl/⌘-click (or "varios" on touch screens) adds or removes. */
function Picker({ all, sel, labelOf, choose, reset, multi, setMulti }: { all: string[]; sel: Selection; labelOf: (id: string) => string; choose: (id: string, e: MouseEvent) => void; reset: () => void; multi: boolean; setMulti: (v: boolean) => void }) {
  return (
    <div class="toolbar picker" role="group" aria-label="Portafolios que se suman">
      <span class="picker-label">Ver</span>
      <button type="button" class="pchip all" aria-pressed={!sel} onClick={reset}>
        Todo
      </button>
      {all.map((id) => (
        <button type="button" class="pchip" aria-pressed={!sel || sel.includes(id)} style={`--c:${id === CASH ? 'var(--context)' : classColor(id)}`} onClick={(e) => choose(id, e)}>
          <span class="dot" aria-hidden="true" />
          {labelOf(id)}
        </button>
      ))}
      <label class="multi">
        <input type="checkbox" checked={multi} onChange={(e) => setMulti((e.target as HTMLInputElement).checked)} /> Varios a la vez
      </label>
      <span class="small muted hint">Clic: solo ese · Ctrl/⌘ + clic: sumar o quitar</span>
    </div>
  );
}

function ClassCard({ b, ccy, state, choose }: { b: Report['buckets'][number]; ccy: string; state: 'all' | 'on' | 'off'; choose: (id: string, e: MouseEvent) => void }) {
  const color = classColor(b.bucket);
  const main = b.benches.find((x) => x.ksPme !== undefined);
  const items: BarItem[] = [
    { label: 'Tú', value: b.perf?.twrAnnual ?? 0, color, text: pct(b.perf?.twrAnnual) },
    ...b.benches.filter((x) => x.annual !== undefined).map((x) => ({ label: x.name, value: x.annual!, color: 'var(--context)', text: pct(x.annual), title: x.name })),
  ];
  return (
    <article
      class={`class-card pickable ${state}`}
      style={`--c:${color}`}
      title="Clic: ver solo esta clase · Ctrl/⌘ + clic: sumarla o quitarla"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('a, button, summary')) choose(b.bucket, e);
      }}
    >
      <div class="top">
        <a href={`#/activos?clase=${b.bucket}`}>{b.label}</a>
        <span class="small muted">{pct(b.weight)} del total</span>
      </div>
      <div class="big">{money(b.value, ccy)}</div>
      {b.error && <div class="badge err" title={b.error}>error de datos</div>}
      <div class="metrics">
        <div>
          <span>XIRR anual</span>
          <strong class={sign(b.perf?.xirr)}>{pct(b.perf?.xirr)}</strong>
        </div>
        <div title={b.leveraged ? 'No comparable: pagos a plazos sobre una base pequeña (apalancado)' : undefined}>
          <span>TWR anual</span>
          <strong class={b.leveraged ? '' : sign(b.perf?.twrAnnual)}>{b.leveraged ? 'n. c.*' : pct(b.perf?.twrAnnual)}</strong>
        </div>
        <div>
          <span>No realizada</span>
          <strong class={sign(b.unrealized.toNumber())}>{moneyShort(b.unrealized, ccy)}</strong>
        </div>
      </div>
      {b.leveraged ? (
        <p class="small muted">*Pagado a plazos sobre una base pequeña: su TWR no es comparable. Mira la XIRR y la valorización del precio de lista en Activos.</p>
      ) : items.length > 1 ? (
        <BarList items={items} label={`TWR anual de ${b.label} frente a sus índices`} />
      ) : (
        <p class="small muted">Sin índice de comparación configurado.</p>
      )}
      {main && !b.leveraged && (
        <div class={`verdict ${main.ksPme! >= 1 ? 'good' : 'bad'}`}>
          <span class="icon" aria-hidden="true">{main.ksPme! >= 1 ? '✓' : '✗'}</span>
          <span>
            {main.ksPme! >= 1 ? 'Le ganaste a' : 'Quedaste por debajo de'} {main.name} con tus mismas fechas (KS-PME {ratio(main.ksPme)})
          </span>
        </div>
      )}
    </article>
  );
}

function DetailTable({ rep, ccy, sel, mix, labelOf }: { rep: Report; ccy: string; sel: Selection; mix?: ScopeResult; labelOf: (id: string) => string }) {
  const t = rep.total;
  return (
    <>
      <div class="table-wrap" style="margin-top:10px">
        <table>
          <thead>
            <tr>
              <th>Clase / índice de comparación</th>
              <th class="n">Valor</th>
              <th class="n">Peso</th>
              <th class="n">XIRR anual</th>
              <th class="n">TWR anual</th>
              <th class="n">KS-PME</th>
              <th class="n">No realizada</th>
              <th class="n">Realizada</th>
              <th class="n">Dividendos</th>
            </tr>
          </thead>
          <tbody>
            {rep.buckets.map((b) => (
              <>
                <tr key={b.bucket} class={sel && !sel.includes(b.bucket) ? 'off' : ''}>
                  <td>
                    <span class="wbar" style={`width:10px;background:${classColor(b.bucket)}`} />
                    {b.label}
                  </td>
                  <td class="n">{money(b.value, ccy)}</td>
                  <td class="n">{pct(b.weight)}</td>
                  <td class={`n ${sign(b.perf?.xirr)}`}>{pct(b.perf?.xirr)}</td>
                  <td class={`n ${b.leveraged ? '' : sign(b.perf?.twrAnnual)}`}>{b.leveraged ? 'n. c.*' : pct(b.perf?.twrAnnual)}</td>
                  <td class="n"></td>
                  <td class={`n ${sign(b.unrealized.toNumber())}`}>{money(b.unrealized, ccy)}</td>
                  <td class={`n ${sign(b.realized.toNumber())}`}>{money(b.realized, ccy)}</td>
                  <td class="n">{money(b.income, ccy)}</td>
                </tr>
                {b.benches.map((x) => (
                  <tr class="sub" key={b.bucket + x.symbol}>
                    <td>vs {x.name}</td>
                    <td class="n"></td>
                    <td class="n"></td>
                    <td class="n"></td>
                    <td class="n">{x.missing ? <span class="badge warn" title={x.missing}>sin datos</span> : pct(x.annual)}</td>
                    <td class={`n ${x.ksPme === undefined ? '' : x.ksPme >= 1 ? 'pos' : 'neg'}`}>{ratio(x.ksPme)}</td>
                    <td class="n" colSpan={3}></td>
                  </tr>
                ))}
              </>
            ))}
          </tbody>
          <tfoot>
            {sel && mix && (
              <tr>
                <td>Selección: {sel.map(labelOf).join(' + ')}</td>
                <td class="n">{money(mix.value, ccy)}</td>
                <td class="n">{pct(t.value.isZero() ? 0 : mix.value.div(t.value).toNumber())}</td>
                <td class={`n ${sign(mix.perf?.xirr)}`}>{pct(mix.perf?.xirr)}</td>
                <td class={`n ${sign(mix.perf?.twrAnnual)}`}>{pct(mix.perf?.twrAnnual)}</td>
                <td colSpan={4}></td>
              </tr>
            )}
            <tr>
              <td>Total (con efectivo)</td>
              <td class="n">{money(t.value, ccy)}</td>
              <td class="n">100 %</td>
              <td class={`n ${sign(t.perf?.xirr)}`}>{pct(t.perf?.xirr)}</td>
              <td class={`n ${sign(t.perf?.twrAnnual)}`}>{pct(t.perf?.twrAnnual)}</td>
              <td colSpan={4}></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="small muted" style="margin-top:8px">
        Periodo por clase: desde su primer movimiento dentro del periodo elegido. Realizada y dividendos: acumulados hasta la fecha de corte, cada uno a la tasa de su fecha.
        {rep.buckets.some((b) => b.leveraged) && ' *n. c.: el TWR de un inmueble sobre planos no es comparable porque se paga a plazos sobre una base pequeña; mira la XIRR y la valorización del precio de lista en Activos.'}
      </p>
    </>
  );
}

/** Points to the month-end close of the last finished month until it is closed. */
function CloseNudge({ data }: { data: Dataset }) {
  const month = addDays(`${today().slice(0, 8)}01`, -1);
  if ((data.closes ?? []).some((c) => c.month === month) || !data.ledger.some((t) => t.date <= month)) return null;
  return (
    <div class="notice info cta" role="status">
      <span>
        <strong>Cierre de {monthLabel(month)} pendiente.</strong> Revisa movimientos, precios y valores de fin de mes y mira el resultado del mes.
      </span>
      <a class="btn" href={`#/cierre?mes=${month}`}>
        Hacer el cierre
      </a>
    </div>
  );
}

function DataAlerts({ rep, data }: { rep: Report; data: Dataset }) {
  const cov = coverage(data);
  const staleManual = rep.positions.filter((p) => p.open && p.method === 'manual' && p.priceDate && daysBetween(p.priceDate, rep.asOf) > 35);
  const atCost = rep.positions.filter((p) => p.open && p.method === 'cost');
  const oldPrices = rep.positions.filter((p) => p.open && p.method === 'market' && (p.priceAgeDays ?? 0) > 5);
  const lastTrm = cov.fx.get('COP');
  const errors = [rep.error, rep.total.error].filter(Boolean) as string[];
  return (
    <>
      {errors.map((e) => (
        <div class="notice err">{e}</div>
      ))}
      {(staleManual.length > 0 || atCost.length > 0 || oldPrices.length > 0 || (lastTrm && daysBetween(lastTrm, rep.asOf) > 5)) && (
        <div class="notice warn" role="status">
          <strong>Datos por actualizar</strong>
          <ul>
            {staleManual.length > 0 && (
              <li>
                Valores manuales viejos: {staleManual.map((p) => `${p.name} (${date(p.priceDate)})`).join(', ')}. <a href="#/cierre">Registrar cierre mensual</a>.
              </li>
            )}
            {atCost.length > 0 && <li>Sin precio ni valor manual, se muestran al costo: {atCost.map((p) => p.name).join(', ')}.</li>}
            {oldPrices.length > 0 && <li>Precios de mercado con más de 5 días: {oldPrices.map((p) => `${p.name} (${date(p.priceDate)})`).join(', ')}.</li>}
            {lastTrm && daysBetween(lastTrm, rep.asOf) > 5 && <li>Última TRM cargada: {date(lastTrm)}.</li>}
          </ul>
        </div>
      )}
    </>
  );
}

interface Monthly {
  trk: Tracking;
  /** The selected classes (and cash), which add up to `row`. */
  rows: TrackRow[];
  row: TrackRow;
  assets: TrackRow[];
  leveraged: boolean;
}

/** Show, hide and reorder the Resumen's blocks; remembered in this browser. */
function Customize({ layout, set }: { layout: Slot[]; set: (l: Slot[]) => void }) {
  const label = (id: string) => MODULES.find((m) => m.id === id)!.label;
  return (
    <details class="customize">
      <summary>Personalizar el resumen</summary>
      <div class="panel">
        <p class="small muted">Elige qué bloques ver y en qué orden. Se guarda en este navegador.</p>
        <ol>
          {layout.map((m, i) => (
            <li>
              <label>
                <input type="checkbox" checked={m.on} onChange={() => set(layout.map((x) => (x.id === m.id ? { ...x, on: !x.on } : x)))} /> {label(m.id)}
              </label>
              <span class="moves">
                <button type="button" aria-label={`Subir ${label(m.id)}`} disabled={i === 0} onClick={() => set(moveSlot(layout, i, -1))}>
                  ↑
                </button>
                <button type="button" aria-label={`Bajar ${label(m.id)}`} disabled={i === layout.length - 1} onClick={() => set(moveSlot(layout, i, 1))}>
                  ↓
                </button>
              </span>
            </li>
          ))}
        </ol>
        <button type="button" class="link" onClick={() => set([])}>
          Restablecer
        </button>
      </div>
    </details>
  );
}

const lastClose = (m: Monthly) => m.trk.months[m.trk.months.length - 1];

function MonthlyError({ m }: { m: Monthly }) {
  return m.trk.error ? <div class="notice warn small">Mes a mes hasta {monthLabel(lastClose(m) ?? '')}: {m.trk.error}</div> : null;
}

/** Start value, money put in, what each class earned or lost, end value; and the positions that moved it most. */
function BridgeCard({ m, from, ccy }: { m: Monthly; from?: string; ccy: string }) {
  const b = gainBridge(m.rows, m.trk.months, from);
  if (!b) return null;
  const short = (v: typeof b.flows) => moneyShort(v, ccy);
  const signed = (v: typeof b.flows) => `${v.gte(0) ? '+' : '−'}${short(v.abs())}`;
  const steps: BridgeStep[] = [
    ...(b.startValue.isZero() ? [] : [{ label: `Valor al ${date(b.start)}`, kind: 'total' as const, value: b.startValue.toNumber(), color: 'var(--ink-2)', text: short(b.startValue) }]),
    { label: 'Aportes netos', kind: 'step', value: b.flows.toNumber(), color: 'var(--context)', text: signed(b.flows), title: 'Lo que pusiste menos lo que retiraste en el periodo' },
    ...b.parts
      .filter((p) => !p.gain.isZero())
      .map((p) => ({
        label: p.id === 'cash' ? 'Efectivo e intereses' : p.label,
        kind: 'step' as const,
        value: p.gain.toNumber(),
        color: p.id === 'cash' ? 'var(--context)' : classColor(p.bucket ?? ''),
        text: signed(p.gain),
        title: p.id === 'cash' ? 'Intereses, comisiones, impuestos y efecto cambiario del efectivo' : `Ganancia de ${p.label}: valorización, dividendos y efecto cambiario`,
      })),
    { label: `Valor al ${date(b.end)}`, kind: 'total', value: b.endValue.toNumber(), color: 'var(--ink-2)', text: short(b.endValue) },
  ];
  const gain = b.parts.reduce((s, p) => s.plus(p.gain), dec(0));
  const topPart = [...b.parts].sort((x, y) => y.gain.comparedTo(x.gain))[0];
  const idx = m.trk.months.map((_, i) => i).filter((i) => !from || m.trk.months[i]! > from);
  const movers = m.assets.map((a) => ({ a, g: gainOver(a, idx) })).filter((x) => !x.g.isZero());
  const up = [...movers].sort((x, y) => y.g.comparedTo(x.g)).slice(0, 5).filter((x) => x.g.gt(0));
  const down = [...movers].sort((x, y) => x.g.comparedTo(y.g)).slice(0, 5).filter((x) => x.g.lt(0)).reverse();
  const items: BarItem[] = [...up, ...down].map(({ a, g }) => ({ label: a.label, value: g.toNumber(), color: classColor(a.bucket ?? ''), text: signed(g), title: `${a.label} · ${a.sub ?? ''}` }));
  return (
    <div class="card">
      <div class="card-head">
        <h2>¿De dónde viene tu ganancia?</h2>
        <span class="small muted">
          Del {date(b.start)} al cierre de {monthLabel(b.end)} · ganancia = valor final − valor inicial − aportes netos
        </span>
      </div>
      <MonthlyError m={m} />
      {gain.gt(0) && topPart && topPart.gain.gt(0) && (
        <p class="insight">
          Hasta el cierre de {monthLabel(b.end)} ganaste <strong>{short(gain)}</strong>. <strong>{topPart.id === 'cash' ? 'El efectivo' : topPart.label}</strong> ganó <strong>{short(topPart.gain)}</strong> de ellos.
        </p>
      )}
      {gain.lt(0) && <p class="insight">Hasta el cierre de {monthLabel(b.end)} perdiste <strong>{short(gain.abs())}</strong>.</p>}
      <div class="two">
        <div>
          <h3>Del valor inicial al final</h3>
          <Bridge steps={steps} label="Puente del valor inicial al final: aportes y ganancia de cada clase" />
        </div>
        <div>
          <h3>Posiciones que más sumaron y restaron</h3>
          {items.length ? <BarList items={items} label="Ganancia o pérdida de cada posición en el periodo" pad={76} /> : <p class="muted small">Sin cambios en el periodo.</p>}
        </div>
      </div>
    </div>
  );
}

/** Shown instead of monthly returns and risk for a class bought on a payment plan. */
function NotComparable() {
  return (
    <p class="muted small">
      n. c.: esta selección es un inmueble pagado a plazos sobre una base pequeña. Su rentabilidad mes a mes y su riesgo no son comparables; mira la XIRR y la valorización del precio de lista en Activos.
    </p>
  );
}

function HeatmapCard({ m, sel }: { m: Monthly; sel?: string }) {
  return (
    <div class="card">
      <div class="card-head">
        <h2>Rentabilidad mes a mes</h2>
        <span class="small muted">{sel ?? 'Todo el portafolio'} · TWR de cada mes (ponderada por tiempo) y del año encadenado</span>
      </div>
      <MonthlyError m={m} />
      {m.leveraged ? <NotComparable /> : <ReturnsHeatmap years={returnsByYear(m.row, m.trk.months)} label={`Rentabilidad mensual por año de ${sel ?? 'todo el portafolio'}`} />}
    </div>
  );
}

function RiskCard({ m, from }: { m: Monthly; from?: string }) {
  const r = riskOf(m.row, m.trk.months, from);
  if (m.leveraged)
    return (
      <div class="card">
        <h2>Riesgo y caídas</h2>
        <NotComparable />
      </div>
    );
  if (!r.months) return null;
  const dd = r.maxDrawdown;
  const notes = [
    r.approx.length > 0 && `${r.approx.length} ${r.approx.length === 1 ? 'mes queda' : 'meses quedan'} por fuera de las cifras y de la curva, donde cuenta como mes sin cambio (${r.approx.map(monthLabel).join(', ')}): entró o salió mucho dinero frente al capital y su rentabilidad mensual es solo aproximada.`,
    r.flagged.stale > 0 && `${r.flagged.stale} meses usan algún precio o valor manual de una fecha anterior (repetido, cuenta como mes sin cambio).`,
    r.flagged.cost > 0 && `${r.flagged.cost} meses tienen algún activo al costo por falta de precio.`,
    r.flagged.estimated > 0 && `${r.flagged.estimated} meses incluyen valores estimados (p. ej. precio de lista).`,
  ].filter((x): x is string => !!x);
  return (
    <div class="card">
      <div class="card-head">
        <h2>Riesgo y caídas</h2>
        <span class="small muted">
          Del {date(r.from)} al cierre de {monthLabel(r.to ?? '')} ({r.months} meses; el mes en curso no se incluye) · sobre la rentabilidad ponderada por tiempo (TWR)
        </span>
      </div>
      <MonthlyError m={m} />
      <div class="stats">
        <div class="stat">
          <span class="label">Volatilidad anual</span>
          <strong>{pct(r.volatility)}</strong>
          <span class="sub">Cuánto se mueve mes a mes, llevado a un año</span>
        </div>
        <div class="stat">
          <span class="label">Máxima caída</span>
          <strong class={dd ? 'neg' : ''}>{dd ? pct(dd.depth) : '—'}</strong>
          <span class="sub">{dd ? `${monthLabel(dd.peak)} → ${monthLabel(dd.trough)} · ${dd.recovered ? `recuperada en ${monthLabel(dd.recovered)}` : 'aún sin recuperar'}` : 'Nunca bajó de un máximo'}</span>
        </div>
        <div class="stat">
          <span class="label">Al cierre de {monthLabel(r.to ?? '')}, frente al máximo</span>
          <strong class={r.current < 0 ? 'neg' : 'pos'}>{r.current < 0 ? pct(r.current) : 'En máximo'}</strong>
          <span class="sub">Caída desde el valor más alto</span>
        </div>
        <div class="stat">
          <span class="label">Mejor y peor mes</span>
          <strong>
            <span class="pos">{pct(r.best?.r)}</span> / <span class="neg">{pct(r.worst?.r)}</span>
          </strong>
          <span class="sub">
            {r.best ? monthLabel(r.best.date) : ''} · {r.worst ? monthLabel(r.worst.date) : ''}
          </span>
        </div>
        <div class="stat">
          <span class="label">Meses con ganancia</span>
          <strong>{pct(r.positive, 0)}</strong>
          <span class="sub">
            {Math.round((r.positive ?? 0) * r.months)} de {r.months}
          </span>
        </div>
      </div>
      <h3 style="margin-top:14px">Caída desde el máximo anterior</h3>
      <LineChart
        dates={r.underwater.map((u) => u.date)}
        series={[{ id: 'dd', name: 'Caída desde el máximo', color: 'var(--dv-neg)', values: r.underwater.map((u) => u.drawdown) }]}
        area="dd"
        reference={0}
        height={170}
        compact
        format={(v) => pct(v)}
        axisFormat={(v) => pct(v, 0)}
        label="Caída del portafolio desde su máximo anterior, mes a mes"
      />
      {notes.length > 0 && (
        <ul class="small muted notes">
          {notes.map((n) => (
            <li>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
