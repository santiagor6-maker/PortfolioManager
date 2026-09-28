import { useMemo, useState } from 'preact/hooks';
import { Decimal } from '../../domain/money.ts';
import { bucketLabel } from '../analysis.ts';
import { contextOf } from '../context.ts';
import { dividends } from '../dividends.ts';
import type { Dividends as Book, MonthTotal, Part } from '../dividends.ts';
import { BarList, classColor } from '../components/Bars.tsx';
import { Columns, Swatch } from '../components/Columns.tsx';
import type { ColumnGroup } from '../components/Columns.tsx';
import { Filters, useFilters } from '../components/Filters.tsx';
import { date, money, moneyShort, monthLabel, pct } from '../format.ts';
import { useDataset } from '../store.ts';

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const MONTHS_LONG = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const THIS = 'var(--s1)';
const PREV = 'var(--context)';

const sign = (x: number | undefined) => (x === undefined ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const change = (now: Decimal, before: Decimal) => (before.gt(0) ? now.div(before).minus(1).toNumber() : undefined);
const signed = (x: number | undefined) => (x === undefined ? '—' : `${x > 0 ? '+' : ''}${pct(x)}`);
/** " · 30 % estimado" when part of a total is estimated. */
const estShare = (p: Part) => (p.estimated.gt(0) && p.total.gt(0) ? ` · ${pct(p.estimated.div(p.total).toNumber(), 0)} estimado` : '');

/** Received (and estimated) by month for one year next to the year before; the rest of the as-of year as projected. */
function byMonth(d: Book, year: number): ColumnGroup[] {
  const month = new Map(d.months.map((m) => [m.date.slice(0, 7), m]));
  const projected = new Map(d.calendar.map((m) => [m.date.slice(0, 7), m]));
  const asOfYear = Number(d.asOf.slice(0, 4));
  return MONTHS.map((m, i) => {
    const key = (y: number) => `${y}-${String(i + 1).padStart(2, '0')}`;
    const cur = month.get(key(year));
    const prev = month.get(key(year - 1));
    const proj = year === asOfYear ? projected.get(key(year)) : undefined;
    const received = (t: MonthTotal | undefined, color: string, what: string) => [
      { label: `${what}`, value: t ? t.total.minus(t.estimated).toNumber() : 0, color },
      { label: `${what}, estimado`, value: t ? t.estimated.toNumber() : 0, color, style: 'soft' as const },
    ];
    return {
      label: m,
      title: `${MONTHS_LONG[i]}`,
      columns: [
        { label: String(year - 1), segments: received(prev, PREV, String(year - 1)) },
        { label: String(year), segments: [...received(cur, THIS, `${year}`), { label: `${year}, proyección`, value: proj?.total.toNumber() ?? 0, color: THIS, style: 'outline' as const }] },
      ],
    };
  });
}

/** One column per calendar year; the as-of year adds what the projection expects for its remaining months. */
function byYear(d: Book, short: (x: Decimal) => string): ColumnGroup[] {
  const asOfYear = d.asOf.slice(0, 4);
  const rest = d.calendar.filter((c) => c.date.startsWith(asOfYear)).reduce((s, c) => s.plus(c.total), new Decimal(0));
  return d.years.map((y) => ({
    label: String(y.year),
    title: `${y.year}${y.partial ? ' (en curso)' : ''}`,
    values: [{ text: short(y.total) }, ...(y.growth !== undefined ? [{ text: `${y.growth >= 0 ? '↗' : '↘'} ${signed(y.growth)}`, cls: sign(y.growth) }] : [])],
    columns: [
      {
        label: String(y.year),
        segments: [
          { label: 'Recibido', value: y.total.minus(y.estimated).toNumber(), color: THIS },
          { label: 'Recibido, estimado', value: y.estimated.toNumber(), color: THIS, style: 'soft' as const },
          ...(y.partial ? [{ label: 'Proyección resto del año', value: rest.toNumber(), color: THIS, style: 'outline' as const }] : []),
        ],
      },
    ],
  }));
}

function Calendar({ d }: { d: Book }) {
  const byMonth = new Map<string, Book['projected']>();
  for (const p of d.projected) {
    const k = p.date.slice(0, 7);
    byMonth.set(k, [...(byMonth.get(k) ?? []), p]);
  }
  const most = Math.max(0, ...d.calendar.map((c) => c.total.toNumber())) || 1;
  return (
    <div class="div-cal" role="list" aria-label="Calendario de dividendos proyectados">
      {d.calendar.map((c) => {
        const items = byMonth.get(c.date.slice(0, 7)) ?? [];
        return (
          <div class={`div-month ${items.length ? '' : 'empty'}`} role="listitem">
            <div class="mh">
              <span class="mname">{monthLabel(c.date)}</span>
              <strong>{items.length ? moneyShort(c.total, d.ccy) : '—'}</strong>
            </div>
            <div class="mbar" aria-hidden="true">
              <span style={`width:${((c.total.toNumber() / most) * 100).toFixed(1)}%`} />
            </div>
            <ul>
              {items.map((p) => (
                <li title={`Repite el pago del ${date(p.basis)}${p.estimated ? ' (estimado)' : ''} · ${money(p.native, p.nativeCcy)}`}>
                  <span class="dot" style={`background:${classColor(p.bucket)}`} />
                  <span class="nm">
                    {p.name}
                    {p.estimated && <sup class="flag f-estimated">ᵉ</sup>}
                  </span>
                  <span class="day">{Number(p.date.slice(8))}</span>
                  <span class="amt">{moneyShort(p.amount!, d.ccy)}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function Dividends() {
  const { data } = useDataset();
  const [f, set] = useFilters();
  const ctx = contextOf(data);
  const d = useMemo(() => dividends(ctx, f.ccy, f.asOf), [ctx, f.ccy, f.asOf]);
  const asOfYear = Number(f.asOf.slice(0, 4));
  const years = d.years.map((y) => y.year);
  const [picked, setYear] = useState<number>();
  const year = picked !== undefined && years.includes(picked) ? picked : asOfYear;
  const [all, setAll] = useState(false);
  const money$ = (v: number) => money(new Decimal(Math.round(v * 100) / 100), f.ccy);
  const axis = (v: number) => moneyShort(new Decimal(v), f.ccy);

  if (!d.payments.length && !d.missingFx.length) {
    return (
      <>
        <Filters state={f} set={set} showWindow={false} />
        <div class="card">
          <h2>Dividendos</h2>
          <p class="muted">No hay dividendos registrados hasta el {date(f.asOf)}. Regístralos en <a href="#/movimientos">Movimientos</a> o impórtalos desde un extracto en <a href="#/datos">Datos</a>.</p>
        </div>
      </>
    );
  }

  const g12 = d.prev12 ? change(d.last12.total, d.prev12.total) : undefined;
  const top = d.byAsset.filter((a) => a.last12.gt(0)).slice(0, 12);
  const payments = [...d.payments].reverse();
  const shown = all ? payments : payments.slice(0, 15);
  const yearTotal = d.years.find((y) => y.year === year);
  const best = d.byAsset.filter((a) => a.last12.gt(0))[0];
  const whole = d.years.filter((y) => !y.partial);
  const avg = whole.reduce((s, y) => s + y.total.toNumber(), 0) / (whole.length || 1);

  return (
    <>
      <Filters state={f} set={set} showWindow={false} />

      {d.missingFx.length > 0 && (
        <div class="notice warn" role="status">
          {d.missingFx.length} {d.missingFx.length === 1 ? 'dividendo queda' : 'dividendos quedan'} por fuera de las cifras porque falta la tasa de cambio de su fecha: {d.missingFx.map((p) => `${p.name} (${date(p.date)})`).join(', ')}. Carga la tasa en <a href="#/datos">Datos</a>.
        </div>
      )}

      <div class="tiles">
        <div class="tile">
          <div>
            <div class="label">Últimos 12 meses</div>
            <div class="value">{moneyShort(d.last12.total, f.ccy)}</div>
            <div class="sub">
              {!d.prev12 ? 'El registro no cubre los 12 meses anteriores' : g12 === undefined ? 'Sin pagos en los 12 meses anteriores' : <><span class={sign(g12)}>{signed(g12)}</span> frente a los 12 meses anteriores</>}
              {estShare(d.last12)}
            </div>
          </div>
        </div>
        <div class="tile">
          <div>
            <div class="label">Este año ({asOfYear})</div>
            <div class="value">{moneyShort(d.ytd.total, f.ccy)}</div>
            <div class="sub">
              Hasta el {date(f.asOf)}
              {estShare(d.ytd)}
            </div>
          </div>
        </div>
        <div class="tile">
          <div>
            <div class="label">Próximos 12 meses · proyección</div>
            <div class="value">{moneyShort(d.next12.total, f.ccy)}</div>
            <div class="sub">
              <span title="Proyección neta de retención ÷ valor (o costo) de hoy de las posiciones que pagan; no es sobre todo el portafolio">
                Rent. neta de las que pagan {d.yieldOnValue !== undefined ? pct(d.yieldOnValue, 2) : <span class="stale">sin precio de alguna</span>} · sobre costo {pct(d.yieldOnCost, 2)}
              </span>
              {estShare(d.next12)}
            </div>
          </div>
        </div>
        <div class="tile">
          <div>
            <div class="label">Desde el inicio</div>
            <div class="value">{moneyShort(d.all.total, f.ccy)}</div>
            <div class="sub">
              {d.payments.length} pagos
              {estShare(d.all)}
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Dividendos por mes</h2>
          <div class="seg" role="group" aria-label="Año">
            {years.slice(-6).map((y) => (
              <button type="button" aria-pressed={y === year} onClick={() => setYear(y)}>
                {y}
              </button>
            ))}
          </div>
        </div>
        <p class="insight">
          En {year} {year === asOfYear ? 'llevas' : 'recibiste'} <strong>{moneyShort(yearTotal?.total ?? new Decimal(0), f.ccy)}</strong>
          {yearTotal && yearTotal.estimated.gt(0) && <> ({yearTotal.estimated.eq(yearTotal.total) ? 'todo' : moneyShort(yearTotal.estimated, f.ccy)} estimado)</>}
          {yearTotal?.growth !== undefined && (
            <>
              , <strong class={sign(yearTotal.growth)}>{signed(yearTotal.growth)}</strong> frente a {year - 1}
            </>
          )}
          .{best && <> En los últimos 12 meses, quien más pagó fue <strong>{best.name}</strong> ({pct(best.last12.div(d.last12.total).toNumber(), 0)} del total).</>}
        </p>
        <Columns groups={byMonth(d, year)} format={money$} axisFormat={axis} label={`Dividendos por mes de ${year} frente a ${year - 1}`} />
        <div class="legend">
          <span>
            <Swatch color={THIS} />
            {year}
          </span>
          <span>
            <Swatch color={PREV} />
            {year - 1}
          </span>
          {d.all.estimated.gt(0) && (
            <span>
              <Swatch color={THIS} style="soft" />
              Estimado
            </span>
          )}
          {year === asOfYear && (
            <span>
              <Swatch color={THIS} style="outline" />
              Proyección
            </span>
          )}
        </div>
      </div>

      <div class="two">
        <div class="card">
          <div class="card-head">
            <h2>Por año</h2>
            <span class="small muted">Bajo cada año, el cambio frente al anterior · ⌀ promedio de los años completos</span>
          </div>
          <Columns groups={byYear(d, (x) => moneyShort(x.abs().gte(1e4) ? x.div(1e3).round().times(1e3) : x, f.ccy).replace(',0 ', ' '))} format={money$} axisFormat={axis} label="Dividendos por año" height={250} axis={false} average={whole.length ? { value: avg, label: moneyShort(new Decimal(avg), f.ccy) } : undefined} />
        </div>
        <div class="card">
          <div class="card-head">
            <h2>Quién los paga</h2>
            <span class="small muted">Últimos 12 meses</span>
          </div>
          {top.length ? (
            <BarList
              items={top.map((a) => ({ label: a.held ? a.name : `${a.name} (vendida)`, value: a.last12.toNumber(), color: classColor(a.bucket), text: `${moneyShort(a.last12, f.ccy)} · ${pct(a.last12.div(d.last12.total).toNumber(), 0)}`, title: `${a.name} (${bucketLabel(a.bucket)})` }))}
              label="Dividendos de los últimos 12 meses por activo"
              pad={110}
            />
          ) : (
            <p class="muted">Ningún pago en los últimos 12 meses.</p>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Calendario · próximos 12 meses</h2>
          <span class="badge violet">Proyección</span>
        </div>
        <p class="small muted">
          Repite cada pago de los últimos 12 meses un año después, ajustado a lo que tienes hoy (las acciones; en fondos sin unidades, el capital) y convertido con la tasa del {date(f.asOf)}. No es un dividendo anunciado por la empresa: si cambia el dividendo o la fecha, cambia el pago.
        </p>
        {d.projected.length ? <Calendar d={d} /> : <p class="muted">No hay pagos para proyectar: ninguna posición que tengas hoy pagó en los últimos 12 meses.</p>}
        {d.projectedMissingFx.length > 0 && (
          <p class="small neg">
            Sin tasa de cambio al {date(f.asOf)} para proyectar: {[...new Set(d.projectedMissingFx.map((p) => p.name))].join(', ')}.
          </p>
        )}
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Pagos recibidos</h2>
          <span class="small muted">Netos de retención, como están registrados · en {f.ccy} con la tasa de cada fecha</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Estado</th>
                <th>Fecha</th>
                <th>Activo</th>
                <th>Cuenta</th>
                <th class="n">Recibido</th>
                <th class="n">En {f.ccy}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr>
                  <td>{p.estimated ? <span class="badge warn">Estimado</span> : <span class="badge good">Pagado</span>}</td>
                  <td class="nowrap">{date(p.date)}</td>
                  <td>
                    {p.name}
                    {p.estimated && (
                      <sup class="flag f-estimated" title="Estimado: confirmar con el extracto">
                        ᵉ
                      </sup>
                    )}
                  </td>
                  <td class="muted">{ctx.book.accounts.get(p.account)?.name ?? p.account}</td>
                  <td class="n">{money(p.native, p.nativeCcy)}</td>
                  <td class="n">{money(p.amount, f.ccy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {payments.length > 15 && (
          <button type="button" class="link" onClick={() => setAll(!all)}>
            {all ? 'Ver solo los 15 más recientes' : `Ver los ${payments.length} pagos`}
          </button>
        )}
        <ul class="notes small muted">
          <li>Dividendos netos: lo que llegó a la cuenta después de la retención en la fuente. El bruto y la retención, cuando el extracto los trae, están en la nota del movimiento.</li>
          {d.all.estimated.gt(0) && <li>ᵉ Estimado: reconstruido de los dividendos públicos y las acciones que tenías; se reemplaza con el extracto.</li>}
          <li>Los intereses de la caja no cuentan como dividendos.</li>
        </ul>
      </div>
    </>
  );
}
