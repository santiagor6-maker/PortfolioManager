import type { YearReturns } from '../insights.ts';
import { monthLabel, pct } from '../format.ts';

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
/** |monthly return| thresholds of the diverging steps 1–4; below the first the month reads as flat. */
const BINS = [0.005, 0.02, 0.04, 0.07];
/** Data-quality marks, as in Seguimiento (the worst one of the month). */
const FLAG: Record<string, string> = { cost: '*', stale: '†', estimated: 'ᵉ' };
const FLAG_TEXT: Record<string, string> = { cost: 'algún activo al costo (falta precio)', stale: 'algún precio o valor de una fecha anterior', estimated: 'incluye valores estimados' };

/** Diverging step of a monthly return: 0 is flat, ±1…±4 grow with the size of the gain (p) or loss (n). */
export function heatStep(r: number): string {
  const k = BINS.filter((b) => Math.abs(r) >= b).length;
  return k === 0 ? 'z' : `${r > 0 ? 'p' : 'n'}${k}`;
}

const fmt = (r: number) => new Intl.NumberFormat('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(r * 100);

/**
 * Calendar of monthly returns: one row per year, one cell per month on a blue (gain) / red (loss) diverging
 * scale with a gray midpoint, and the year's chained return at the end. The numbers are in every cell, so
 * the table is its own table view.
 */
export function ReturnsHeatmap({ years, label }: { years: YearReturns[]; label: string }) {
  if (!years.length) return <p class="muted">No hay meses cerrados para mostrar.</p>;
  return (
    <div>
      <div class="table-wrap">
        <table class="heatmap" aria-label={label}>
          <thead>
            <tr>
              <th scope="col">Año</th>
              {MONTHS.map((m) => (
                <th scope="col" class="n">
                  {m}
                </th>
              ))}
              <th scope="col" class="n">
                Total año
              </th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr>
                <th scope="row">{y.year}</th>
                {y.months.map((c) =>
                  !c ? (
                    <td class="hm na" />
                  ) : c.r === null ? (
                    <td class="hm na" title={`${monthLabel(c.date)}: sin base para calcular`}>
                      —
                    </td>
                  ) : (
                    <td
                      class={`hm ${c.approx ? 'approx' : heatStep(c.r)}`}
                      title={`${monthLabel(c.date)}: ${pct(c.r)}${c.approx ? ' · aproximada: flujos grandes frente al capital del mes' : ''}${c.flag ? ` · ${FLAG_TEXT[c.flag]}` : ''}`}
                    >
                      {c.approx && '≈'}
                      {fmt(c.r)}
                      {c.flag && <sup>{FLAG[c.flag]}</sup>}
                    </td>
                  ),
                )}
                <td class={`n year ${y.total === null ? '' : y.total >= 0 ? 'pos' : 'neg'}`}>{y.total === null ? '—' : `${y.approx ? '≈' : ''}${fmt(y.total)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="hm-legend" aria-label="Escala de colores">
        <span class="small muted">Pérdida</span>
        {['n4', 'n3', 'n2', 'n1', 'z', 'p1', 'p2', 'p3', 'p4'].map((s) => (
          <span class={`hm-key hm ${s}`} />
        ))}
        <span class="small muted">Ganancia</span>
        <span class="small muted sep">
          Cortes: 0,5 · 2 · 4 · 7 %. Cifras en %. ≈ aproximada, en gris: ese mes entró o salió mucho dinero frente al capital y la fórmula mensual (Modified Dietz) pierde precisión. {Object.entries(FLAG).map(([k, v]) => `${v} ${FLAG_TEXT[k]}`).join(' · ')}.
        </span>
      </div>
    </div>
  );
}
