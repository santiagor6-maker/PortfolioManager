import { useMemo, useState } from 'preact/hooks';
import { analyzeScope, bucketLabel } from '../analysis.ts';
import { contextOf } from '../context.ts';
import { Filters, useFilters } from '../components/Filters.tsx';
import { LineChart } from '../components/LineChart.tsx';
import { date, monthLabel, pct, ratio } from '../format.ts';
import { levelSeriesRisk } from '../insights.ts';
import type { LevelRisk } from '../insights.ts';
import { useDataset } from '../store.ts';

const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];
const sign = (x: number | undefined) => (x === undefined ? '' : x >= 0 ? 'pos' : 'neg');
const pp = (x: number) => `${x >= 0 ? '+' : '−'}${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.abs(x * 100))} pp`;

export function Compare() {
  const { data } = useDataset();
  const [f, set] = useFilters();
  const ctx = contextOf(data);
  const buckets = [...new Set(data.assets.map((a) => a.bucket))].filter((b) => data.benchmarks.some((x) => x.buckets.includes(b)));
  const [scope, setScope] = useState<string>(buckets[0] ?? 'total');
  const res = useMemo(() => {
    const benches = ctx.benchmarks.filter((b) => b.buckets.includes(scope)).slice(0, 3);
    return analyzeScope(ctx, scope === 'total' ? { kind: 'total' } : { kind: 'bucket', bucket: scope }, f.ccy, f.asOf, f.window, benches);
  }, [data, scope, f.ccy, f.asOf, f.window]);
  const dates = res.growth.map((g) => g.date);
  const series = [
    { id: 'portfolio', name: scope === 'total' ? 'Mi portafolio' : `Mi portafolio: ${bucketLabel(scope)}`, color: COLORS[0]!, values: res.growth.map((g) => g.portfolio) },
    ...res.benches
      .filter((b) => !b.missing)
      .map((b, i) => ({ id: b.symbol, name: b.name, color: COLORS[i + 1]!, values: res.growth.map((g) => g.benches[b.symbol] ?? null) })),
  ];
  const main = res.benches.find((b) => b.annual !== undefined);
  const risks = series.map((s) => ({ s, r: levelSeriesRisk(dates, s.values) }));
  // Property bought on a payment plan: its TWR is on a small leveraged base, not comparable (as in Resumen).
  const leveraged = scope !== 'total' && data.ledger.some((t) => t.type === 'COMMITMENT' && t.asset !== undefined && ctx.book.assets.get(t.asset)?.bucket === scope);
  return (
    <>
      <Filters state={f} set={set}>
        <label>
          Comparar
          <select value={scope} onChange={(e) => setScope((e.target as HTMLSelectElement).value)}>
            {buckets.map((b) => (
              <option value={b}>{bucketLabel(b)}</option>
            ))}
            <option value="total">Portafolio total (sin índice)</option>
          </select>
        </label>
      </Filters>
      {res.error && <div class="notice err">{res.error}</div>}
      {main && res.perf && (
        <div class="tiles">
          <div class="tile">
            <div>
              <div class="label">Tu TWR anual</div>
              <div class={`value ${sign(res.perf.twrAnnual)}`}>{pct(res.perf.twrAnnual)}</div>
              <div class="sub">{series[0]!.name}</div>
            </div>
          </div>
          <div class="tile">
            <div>
              <div class="label">Índice, mismo periodo</div>
              <div class={`value ${sign(main.annual)}`}>{pct(main.annual)}</div>
              <div class="sub">{main.name}</div>
            </div>
          </div>
          <div class="tile">
            <div>
              <div class="label">Diferencia por año</div>
              <div class={`value ${sign(res.perf.twrAnnual - main.annual!)}`}>{pp(res.perf.twrAnnual - main.annual!)}</div>
              <div class={`verdict ${res.perf.twrAnnual >= main.annual! ? 'good' : 'bad'}`}>
                <span class="icon" aria-hidden="true">{res.perf.twrAnnual >= main.annual! ? '✓' : '✗'}</span>
                {res.perf.twrAnnual >= main.annual! ? 'Por encima del índice' : 'Por debajo del índice'}
              </div>
            </div>
          </div>
          <div class="tile">
            <div>
              <div class="label">KS-PME (tus mismas fechas)</div>
              <div class={`value ${main.ksPme === undefined ? '' : main.ksPme >= 1 ? 'pos' : 'neg'}`}>{ratio(main.ksPme)}</div>
              <div class="sub">Mayor que 1: le ganaste con tus aportes y retiros</div>
            </div>
          </div>
        </div>
      )}
      <div class="card">
        <h2>Crecimiento de 100 invertidos (TWR, {f.ccy})</h2>
        <p class="small muted">
          Desde {date(res.perf?.since)}. La línea del portafolio usa la rentabilidad ponderada por tiempo, así tus aportes y retiros no la mueven; los índices son de retorno total
          (dividendos reinvertidos).
        </p>
        <LineChart dates={dates} series={series} format={(v) => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(v)} reference={100} area="portfolio" label="Crecimiento de 100 del portafolio frente a los índices" />
      </div>
      {dates.length > 2 && leveraged && (
        <div class="card">
          <h2>Riesgo: cuánto se mueve y cuánto ha caído</h2>
          <p class="muted small">n. c.: un inmueble pagado a plazos sobre una base pequeña no tiene una rentabilidad ponderada por tiempo comparable, así que su volatilidad y sus caídas tampoco lo son.</p>
        </div>
      )}
      {dates.length > 2 && !leveraged && (
        <div class="card">
          <div class="card-head">
            <h2>Riesgo: cuánto se mueve y cuánto ha caído</h2>
            <span class="small muted">Mismo periodo y misma rentabilidad ponderada por tiempo que la gráfica de arriba</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th class="n">Volatilidad anual</th>
                  <th class="n">Máxima caída</th>
                  <th>Cuándo</th>
                  <th class="n">Hoy frente al máximo</th>
                </tr>
              </thead>
              <tbody>
                {risks.map(({ s, r }) => (
                  <tr>
                    <td>
                      <span class="key-dot" style={`background:${s.color}`} />
                      {s.name}
                    </td>
                    <td class="n">{pct(r.volatility)}</td>
                    <td class="n neg">{r.maxDrawdown ? pct(r.maxDrawdown.depth) : '—'}</td>
                    <td class="small">{when(r)}</td>
                    <td class={`n ${r.current < 0 ? 'neg' : ''}`}>{r.current < 0 ? pct(r.current) : 'en máximo'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 style="margin-top:14px">Caída desde el máximo anterior</h3>
          <LineChart
            dates={dates}
            series={risks.map(({ s, r }) => {
              const by = new Map(r.underwater.map((u) => [u.date, u.drawdown]));
              return { ...s, values: dates.map((d) => by.get(d) ?? null) };
            })}
            area="portfolio"
            reference={0}
            height={200}
            format={(v) => pct(v)}
            axisFormat={(v) => pct(v, 0)}
            label="Caída del portafolio y de los índices desde su máximo anterior"
          />
          <p class="small muted" style="margin-top:8px">
            Volatilidad: desviación estándar de las rentabilidades mensuales, llevada a un año (× √12). Máxima caída: la mayor baja desde un máximo hasta el punto más bajo siguiente.
          </p>
        </div>
      )}
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th class="n">TWR anual</th>
                <th class="n">XIRR anual</th>
                <th class="n">KS-PME</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{series[0]!.name}</td>
                <td class="n">{pct(res.perf?.twrAnnual)}</td>
                <td class="n">{pct(res.perf?.xirr)}</td>
                <td class="n"></td>
              </tr>
              {res.benches.map((b) => (
                <tr>
                  <td>{b.name}</td>
                  <td class="n">{b.missing ? <span class="badge warn" title={b.missing}>sin datos</span> : pct(b.annual)}</td>
                  <td class="n"></td>
                  <td class={`n ${b.ksPme === undefined ? '' : b.ksPme >= 1 ? 'pos' : 'neg'}`}>{ratio(b.ksPme)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="small muted" style="margin-top:8px">KS-PME mayor que 1: le ganaste al índice con tus mismas fechas de aportes y retiros.</p>
      </div>
    </>
  );
}

function when(r: LevelRisk): string {
  const d = r.maxDrawdown;
  if (!d) return 'nunca bajó de un máximo';
  return `${monthLabel(d.peak)} → ${monthLabel(d.trough)}${d.recovered ? `, recuperada en ${monthLabel(d.recovered)}` : ', sin recuperar'}`;
}
