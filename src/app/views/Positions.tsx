import { useMemo, useState } from 'preact/hooks';
import { daysBetween } from '../../domain/dates.ts';
import { sum } from '../../domain/money.ts';
import { annualize } from '../../domain/returns.ts';
import { analyze, bucketLabel } from '../analysis.ts';
import type { PositionRow } from '../analysis.ts';
import { contextOf } from '../context.ts';
import { Filters, useFilters } from '../components/Filters.tsx';
import { date, money, moneyShort, num, pct } from '../format.ts';
import { BarList, byClassOrder, classColor } from '../components/Bars.tsx';
import { useDataset } from '../store.ts';
import { queryParam } from '../route.ts';

export function PriceBadge({ p, asOf }: { p: PositionRow; asOf: string }) {
  if (!p.open) return <span class="badge">cerrada</span>;
  if (p.method === 'cost') return <span class="badge err" title="Sin precio de mercado ni valor manual: se muestra el costo">al costo · falta dato</span>;
  const old = p.priceDate && daysBetween(p.priceDate, asOf) > (p.method === 'manual' ? 35 : 5);
  const label = p.method === 'market' ? 'mercado' : p.estimated ? 'estimado' : 'manual';
  return (
    <span class={`badge ${old ? 'warn' : p.method === 'market' ? '' : 'info'}`} title={p.method === 'manual' ? 'Valor ingresado en el cierre mensual' : 'Cierre de mercado'}>
      {label} · {date(p.priceDate)}
    </span>
  );
}

export function Positions() {
  const { data } = useDataset();
  const [f, set] = useFilters();
  const [bucket, setBucket] = useState(queryParam('clase') ?? '');
  const [closed, setClosed] = useState(false);
  const ctx = contextOf(data);
  const rep = useMemo(() => analyze(ctx, f.ccy, f.asOf, 'all'), [data, f.ccy, f.asOf]);
  const buckets = [...new Set(rep.positions.map((p) => p.bucket))];
  const rows = rep.positions
    .filter((p) => (!bucket || p.bucket === bucket) && (closed || p.open))
    .sort((a, b) => b.value.comparedTo(a.value) || a.name.localeCompare(b.name));
  const open = rows.filter((p) => p.open);

  // Off-plan property: list-price change without leverage (first vs latest valuation).
  const listPrice = [...ctx.book.assets.values()]
    .filter((a) => (!bucket || a.bucket === bucket) && ctx.ledger.some((t) => t.type === 'COMMITMENT' && t.asset === a.id))
    .map((a) => {
      const vals = ctx.ledger.filter((t) => t.type === 'VALUATION' && t.asset === a.id && t.date <= f.asOf).sort((x, y) => (x.date < y.date ? -1 : 1));
      const first = vals[0];
      const last = vals[vals.length - 1];
      if (!first || !last || first === last) return undefined;
      const cum = last.amount.div(first.amount).minus(1).toNumber();
      return { name: a.name, ccy: last.ccy, first, last, cum, annual: annualize(cum, first.date, last.date) };
    })
    .filter((x) => x !== undefined);

  return (
    <>
      <Filters state={f} set={set} showWindow={false}>
        <label>
          Clase
          <select value={bucket} onChange={(e) => setBucket((e.target as HTMLSelectElement).value)}>
            <option value="">Todas</option>
            {buckets.map((b) => (
              <option value={b}>{bucketLabel(b)}</option>
            ))}
          </select>
        </label>
        <label style="flex-direction:row;align-items:center;gap:6px">
          <input type="checkbox" checked={closed} onChange={(e) => setClosed((e.target as HTMLInputElement).checked)} /> Mostrar posiciones cerradas
        </label>
      </Filters>
      {listPrice.map((l) => (
        <div class="notice info">
          <strong>{l.name}</strong>: precio de lista {money(l.first.amount, l.ccy)} ({date(l.first.date)}) → {money(l.last.amount, l.ccy)} ({date(l.last.date)}) ={' '}
          {pct(l.cum)} total, {pct(l.annual)} anual sin apalancamiento. Valor estimado (precio de lista), no un avalúo.
        </div>
      ))}
      {open.length > 1 && (
        <div class="grid2">
          <div class="card">
            <div class="card-head">
              <h2>Mayores posiciones</h2>
              <span class="small muted">Valor al {date(f.asOf)}</span>
            </div>
            <BarList
              label="Mayores posiciones por valor"
              items={open.slice(0, 10).map((p) => ({ label: p.name, value: p.value.toNumber(), color: classColor(p.bucket), text: moneyShort(p.value, f.ccy), title: `${p.name} · ${bucketLabel(p.bucket)}` }))}
            />
            <div class="legend" style="margin-top:12px">
              {[...new Set(open.slice(0, 10).map((p) => p.bucket))].sort(byClassOrder).map((b) => (
                <span>
                  <span class="key" style={`background:${classColor(b)};height:8px;width:8px;border-radius:2px`} />
                  {bucketLabel(b)}
                </span>
              ))}
            </div>
          </div>
          <div class="card">
            <div class="card-head">
              <h2>Ganancia o pérdida sin realizar</h2>
              <span class="small muted">Las 5 mejores y las 5 peores</span>
            </div>
            <BarList label="Ganancia o pérdida no realizada por activo" items={movers(open).map((p) => ({ label: p.name, value: p.unrealized.toNumber(), color: p.unrealized.isNeg() ? 'var(--dv-neg)' : 'var(--dv-pos)', text: moneyShort(p.unrealized, f.ccy) }))} />
          </div>
        </div>
      )}
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Activo</th>
                <th class="n">Cantidad</th>
                <th>Precio / fuente</th>
                <th class="n">Valor</th>
                <th class="n">Costo</th>
                <th class="n">No realizada</th>
                <th class="n">%</th>
                <th class="n">Realizada</th>
                <th class="n">Dividendos</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const upct = p.cost.isZero() ? undefined : p.unrealized.div(p.cost).toNumber();
                return (
                  <tr key={p.account + p.asset}>
                    <td style="min-width:200px">
                      <span class="wbar" style={`width:8px;height:8px;border-radius:2px;background:${classColor(p.bucket)}`} />
                      {p.name}
                      <div class="small muted">
                        {p.accountName} · {bucketLabel(p.bucket)}
                        {p.asset !== p.name && ` · ${p.asset}`}
                      </div>
                    </td>
                    <td class="n">{p.open && !p.qty.isZero() && ctx.book.assets.get(p.asset)?.pricing === 'market' ? num(p.qty) : '—'}</td>
                    <td>
                      <PriceBadge p={p} asOf={f.asOf} />
                    </td>
                    <td class="n">{p.open ? money(p.value, f.ccy) : '—'}</td>
                    <td class="n">{p.open ? money(p.cost, f.ccy) : '—'}</td>
                    <td class={`n ${p.unrealized.isNeg() ? 'neg' : p.unrealized.isZero() ? '' : 'pos'}`}>{p.open ? money(p.unrealized, f.ccy) : '—'}</td>
                    <td class="n">{p.open ? pct(upct) : '—'}</td>
                    <td class={`n ${p.realized.isNeg() ? 'neg' : p.realized.isZero() ? '' : 'pos'}`}>{p.realized.isZero() ? '—' : money(p.realized, f.ccy)}</td>
                    <td class="n">{p.income.isZero() ? '—' : money(p.income, f.ccy)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Total {bucket ? bucketLabel(bucket) : 'invertido'} ({open.length} posiciones abiertas)</td>
                <td class="n">{money(sum(open.map((p) => p.value)), f.ccy)}</td>
                <td class="n">{money(sum(open.map((p) => p.cost)), f.ccy)}</td>
                <td class="n">{money(sum(open.map((p) => p.unrealized)), f.ccy)}</td>
                <td></td>
                <td class="n">{money(sum(rows.map((p) => p.realized)), f.ccy)}</td>
                <td class="n">{money(sum(rows.map((p) => p.income)), f.ccy)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p class="small muted" style="margin-top:8px">
          Costo: promedio ponderado. Valor de inmuebles sobre planos = precio de lista − saldo por pagar. Costo y no realizada de activos en otra moneda se convierten a la tasa del {date(f.asOf)}.
        </p>
      </div>
    </>
  );
}

/** The five largest unrealized gains and the five largest losses, best first. */
function movers(open: PositionRow[]): PositionRow[] {
  const byGain = [...open].sort((a, b) => b.unrealized.comparedTo(a.unrealized));
  const top = byGain.filter((p) => p.unrealized.gt(0)).slice(0, 5);
  const bottom = byGain.filter((p) => p.unrealized.lt(0)).slice(-5);
  return [...top, ...bottom];
}
