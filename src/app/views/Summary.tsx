import { useMemo } from 'preact/hooks';
import { addDays, daysBetween } from '../../domain/dates.ts';
import { analyze } from '../analysis.ts';
import type { Report } from '../analysis.ts';
import { contextOf, coverage } from '../context.ts';
import { Filters, useFilters } from '../components/Filters.tsx';
import { Glossary } from '../components/Glossary.tsx';
import { date, money, moneyShort, monthLabel, pct, ratio, today } from '../format.ts';
import { useDataset } from '../store.ts';
import { LineChart } from '../components/LineChart.tsx';
import { BarList, StackedBar, byClassOrder, classColor } from '../components/Bars.tsx';
import type { BarItem, Part } from '../components/Bars.tsx';
import { dec } from '../../domain/money.ts';
import type { Dataset } from '../../data/json.ts';

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
  const rep = useMemo(() => analyze(contextOf(data), f.ccy, f.asOf, f.window), [data, f.ccy, f.asOf, f.window]);
  const t = rep.total;
  const gain = t.perf ? t.perf.endValue.minus(t.perf.startValue).minus(t.perf.netFlows) : undefined;
  const income = rep.buckets.reduce((a, b) => a.plus(b.income), dec(0));
  const compact = (v: number) => moneyShort(dec(v), f.ccy);
  const history = t.history;
  const parts: Part[] = [...rep.buckets]
    .sort((a, b) => byClassOrder(a.bucket, b.bucket))
    .map((b) => ({ id: b.bucket, label: b.label, value: b.value.toNumber(), color: classColor(b.bucket), detail: <>{moneyShort(b.value, f.ccy)}<small>{pct(b.weight)}</small></> }));
  if (rep.cash.gt(0)) parts.push({ id: 'cash', label: 'Efectivo en cuentas', value: rep.cash.toNumber(), color: 'var(--context)', detail: <>{moneyShort(rep.cash, f.ccy)}<small>{pct(t.value.isZero() ? 0 : rep.cash.div(t.value).toNumber())}</small></> });
  return (
    <>
      <Filters state={f} set={set} />
      <DataAlerts rep={rep} data={data} />
      <CloseNudge data={data} />

      <section class="card hero" aria-label="Valor del portafolio">
        <div>
          <div class="kicker">Valor del portafolio</div>
          <div class="figure">{moneyShort(t.value, f.ccy)}</div>
          <div class="exact">{money(t.value, f.ccy)} al {date(f.asOf)}</div>
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
                { id: 'value', name: 'Valor del portafolio', color: 'var(--s1)', values: history.map((h) => h.value) },
                { id: 'invested', name: 'Lo que pusiste (aportes netos)', color: 'var(--context)', values: history.map((h) => h.invested) },
              ]}
              area="value"
              reference={0}
              height={230}
              compact
              format={(v) => money(dec(Math.round(v)), f.ccy, 0)}
              axisFormat={compact}
              label="Valor del portafolio frente a lo que has aportado"
            />
          )}
        </div>
      </section>

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
            <div class="sub">Aportes netos {t.perf ? moneyShort(t.perf.netFlows, f.ccy) : '—'} · efectivo en cuentas {moneyShort(rep.cash, f.ccy)}</div>
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

      <div class="card">
        <div class="card-head">
          <h2>¿Dónde está tu dinero?</h2>
          <span class="small muted">Peso de cada clase en el valor total</span>
        </div>
        <StackedBar parts={parts} label="Distribución del portafolio por clase de activo" />
      </div>

      <div class="card-head" style="margin-top:4px">
        <h2>Rendimiento por clase</h2>
        <span class="small muted">TWR anual frente a su índice de retorno total</span>
      </div>
      <div class="classes">
        {rep.buckets.map((b) => (
          <ClassCard b={b} ccy={f.ccy} />
        ))}
      </div>

      <div class="card">
        <details>
          <summary>Ver tabla detallada por clase</summary>
          <DetailTable rep={rep} ccy={f.ccy} />
        </details>
      </div>
      <Glossary />
    </>
  );
}

const chipTone = (x: number | null | undefined) => (x === undefined || x === null ? '' : x >= 0 ? 'good' : 'bad');

function ClassCard({ b, ccy }: { b: Report['buckets'][number]; ccy: string }) {
  const color = classColor(b.bucket);
  const main = b.benches.find((x) => x.ksPme !== undefined);
  const items: BarItem[] = [
    { label: 'Tú', value: b.perf?.twrAnnual ?? 0, color, text: pct(b.perf?.twrAnnual) },
    ...b.benches.filter((x) => x.annual !== undefined).map((x) => ({ label: x.name, value: x.annual!, color: 'var(--context)', text: pct(x.annual), title: x.name })),
  ];
  return (
    <article class="class-card" style={`--c:${color}`}>
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

function DetailTable({ rep, ccy }: { rep: Report; ccy: string }) {
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
                <tr key={b.bucket}>
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
