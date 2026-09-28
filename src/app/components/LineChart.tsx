import { useEffect, useRef, useState } from 'preact/hooks';
import { date as fmtDate, monthLabel } from '../format.ts';

export interface Series {
  id: string;
  name: string;
  /** CSS color (a categorical slot variable). */
  color: string;
  values: (number | null)[];
}

interface Props {
  dates: string[];
  series: Series[];
  format: (v: number) => string;
  /** Horizontal reference line (e.g. 100 for growth of 100). */
  reference?: number;
  label: string;
  /** Plot height in px (default 320). */
  height?: number;
  /** Series id drawn with a 10% area wash down to the axis floor. */
  area?: string;
  /** Axis tick format (defaults to `format`). */
  axisFormat?: (v: number) => string;
  /** No direct end labels (small charts: the legend and tooltip carry identity). */
  compact?: boolean;
}

const M = { l: 58, r: 132, t: 14, b: 28 };
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);

export function niceTicks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** Single-axis line chart: crosshair + one tooltip listing every series, direct end labels, legend, table view. */
export function LineChart({ dates, series, format, reference, label, height, area, axisFormat, compact }: Props) {
  const H = height ?? 320;
  const fmtAxis = axisFormat ?? format;
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(320, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (dates.length < 2) return <p class="muted">No hay suficientes datos para graficar este periodo.</p>;

  const narrow = w < 560;
  const mr = narrow || compact ? 12 : M.r;
  const x0 = ms(dates[0]!);
  const x1 = ms(dates[dates.length - 1]!);
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (reference !== undefined) all.push(reference);
  const lo0 = Math.min(...all);
  const hi0 = Math.max(...all);
  const pad = (hi0 - lo0) * 0.06 || 1;
  const ticks = niceTicks(lo0 - pad, hi0 + pad);
  const lo = Math.min(ticks[0]!, lo0 - pad);
  const hi = Math.max(ticks[ticks.length - 1]!, hi0 + pad);
  const X = (d: string) => M.l + ((ms(d) - x0) / (x1 - x0 || 1)) * (w - M.l - mr);
  const Y = (v: number) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);

  const years = (x1 - x0) / 3.15e10;
  // Ticks on month-ends (year-ends for long spans), dropping any label too close to the previous one.
  const candidates = dates.filter((d) => (years > 2.5 ? d.endsWith('-12-31') : years > 1 ? /-(03|06|09|12)-3[01]$/.test(d) : /-(28|29|30|31)$/.test(d)));
  const xticks: string[] = [];
  const gap = years > 2.5 ? 40 : 64;
  for (const d of candidates) if (!xticks.length || X(d) - X(xticks[xticks.length - 1]!) >= gap) xticks.push(d);

  const path = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${X(dates[i]!).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  // End labels, nudged apart vertically.
  const ends = series
    .map((s) => {
      const i = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
      const v = s.values[i];
      return v === null || v === undefined ? undefined : { s, y: Y(v), v };
    })
    .filter((e) => e !== undefined)
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 30) ends[i]!.y = ends[i - 1]!.y + 30;

  const pick = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * w;
    let best = 0;
    dates.forEach((d, i) => {
      if (Math.abs(X(d) - px) < Math.abs(X(dates[best]!) - px)) best = i;
    });
    setHover(best);
  };
  const hi_ = hover === null ? null : hover;
  const tipLeft = hi_ === null ? 0 : (X(dates[hi_]!) / w) * 100;

  return (
    <div>
      <div class="legend" aria-hidden="true">
        {series.map((s) => (
          <span>
            <span class="key" style={`background:${s.color}`} />
            {s.name}
          </span>
        ))}
      </div>
      <div
        class="chart"
        ref={box}
        tabIndex={0}
        role="img"
        aria-label={label}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setHover(Math.min(dates.length - 1, (hover ?? -1) + 1));
          else if (e.key === 'ArrowLeft') setHover(Math.max(0, (hover ?? dates.length) - 1));
          else return;
          e.preventDefault();
        }}
        onBlur={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none" style={`height:${H}px`}>
          {ticks.map((t) => (
            <g>
              <line x1={M.l} x2={w - mr} y1={Y(t)} y2={Y(t)} stroke="var(--grid)" stroke-width={1} />
              <text x={M.l - 8} y={Y(t) + 4} text-anchor="end" font-size="11" fill="var(--muted)">
                {fmtAxis(t)}
              </text>
            </g>
          ))}
          {reference !== undefined && <line x1={M.l} x2={w - mr} y1={Y(reference)} y2={Y(reference)} stroke="var(--axis)" stroke-width={1.5} />}
          {xticks.map((d) => (
            <text x={X(d)} y={H - 8} text-anchor="middle" font-size="11" fill="var(--muted)">
              {years > 2.5 ? String(Number(d.slice(0, 4)) + 1) : monthLabel(d)}
            </text>
          ))}
          {series
            .filter((s) => s.id === area)
            .map((s) => {
              const pts = s.values.map((v, i) => (v === null ? null : `${X(dates[i]!).toFixed(1)},${Y(v).toFixed(1)}`));
              const first = pts.findIndex((p) => p !== null);
              const lastI = pts.length - 1 - [...pts].reverse().findIndex((p) => p !== null);
              if (first < 0) return null;
              const floor = Y(Math.max(lo, Math.min(hi, 0)));
              const d = `M${X(dates[first]!).toFixed(1)},${floor}L${pts.slice(first, lastI + 1).filter(Boolean).join('L')}L${X(dates[lastI]!).toFixed(1)},${floor}Z`;
              return <path class="area" d={d} fill={s.color} fill-opacity={0.1} stroke="none" />;
            })}
          {series.map((s) => (
            <path class="series" d={path(s.values)} fill="none" stroke={s.color} stroke-width={s.id === 'portfolio' ? 2.5 : 2} stroke-linejoin="round" stroke-linecap="round" />
          ))}
          {!narrow && !compact &&
            ends.map((e) => (
              <text x={w - mr + 8} y={e.y + 4} font-size="12" fill="var(--ink-2)">
                <tspan font-weight="600" fill="var(--ink)">{format(e.v)}</tspan>
                <tspan x={w - mr + 8} dy="13" font-size="11">{e.s.name.length > 18 ? `${e.s.name.slice(0, 17)}…` : e.s.name}</tspan>
              </text>
            ))}
          {hi_ !== null && (
            <g>
              <line x1={X(dates[hi_]!)} x2={X(dates[hi_]!)} y1={M.t} y2={H - M.b} stroke="var(--axis)" stroke-width={1} />
              {series.map((s) => {
                const v = s.values[hi_];
                return v === null || v === undefined ? null : <circle cx={X(dates[hi_]!)} cy={Y(v)} r={4} fill={s.color} stroke="var(--surface)" stroke-width={2} />;
              })}
            </g>
          )}
        </svg>
        {hi_ !== null && (
          <div class="tip" style={`top:8px;${tipLeft > 60 ? `right:${100 - tipLeft + 2}%` : `left:${tipLeft + 2}%`}`}>
            <div class="small muted" style="margin-bottom:4px">{fmtDate(dates[hi_])}</div>
            {series
              .map((s) => ({ s, v: s.values[hi_] }))
              .filter((r) => r.v !== null && r.v !== undefined)
              .sort((a, b) => b.v! - a.v!)
              .map(({ s, v }) => (
                <div class="row">
                  <strong>{format(v!)}</strong>
                  <span class="muted small">
                    <span class="key" style={`background:${s.color};margin-right:6px`} />
                    {s.name}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
      <details style="margin-top:8px">
        <summary>Ver como tabla</summary>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                {series.map((s) => (
                  <th class="n">{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates.map((d, i) => (
                <tr>
                  <td>{fmtDate(d)}</td>
                  {series.map((s) => (
                    <td class="n">{s.values[i] === null || s.values[i] === undefined ? '—' : format(s.values[i]!)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
