import { useEffect, useRef, useState } from 'preact/hooks';
import { niceTicks } from './LineChart.tsx';

export interface Point {
  id: string;
  label: string;
  x: number;
  y: number;
  /** Tooltip lines after the label. */
  lines: string[];
  /** Direct label beside the dot (keep it to a few points). */
  named?: boolean;
}

const M = { l: 52, r: 18, t: 30, b: 40 };

/**
 * One-series scatter on a single pair of axes: 8 px dots with a 2 px surface ring, a 24 px hit area,
 * a tooltip on hover or keyboard focus, direct labels only for the named points, and a table view.
 */
export function Scatter({ points, xLabel, yLabel, xFormat, yFormat, label, xRef }: { points: Point[]; xLabel: string; yLabel: string; xFormat: (v: number) => string; yFormat: (v: number) => string; label: string; xRef?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  const [hover, setHover] = useState<number>();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(300, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!points.length) return <p class="muted">No hay datos para graficar.</p>;
  const H = 320;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  // A little air past the extreme points so no dot sits on the plot edge.
  const xlo = Math.min(xRef ?? Infinity, ...xs);
  const xhi = Math.max(xRef ?? -Infinity, ...xs);
  const xpad = (xhi - xlo) * 0.05 || 0.01;
  const xt = niceTicks(xlo - xpad, xhi + xpad, W < 560 ? 4 : 6);
  const yt = niceTicks(0, Math.max(...ys) * 1.1, 4);
  const [x0, x1] = [Math.min(xt[0]!, xlo - xpad), Math.max(xt[xt.length - 1]!, xhi + xpad)];
  const y1 = Math.max(yt[yt.length - 1]!, Math.max(...ys) * 1.1);
  const X = (v: number) => M.l + ((v - x0) / (x1 - x0 || 1)) * (W - M.l - M.r);
  const Y = (v: number) => M.t + (1 - v / (y1 || 1)) * (H - M.t - M.b);
  const h = hover === undefined ? undefined : points[hover];
  return (
    <div>
      <div class="chart" ref={box} onPointerLeave={() => setHover(undefined)}>
        <svg viewBox={`0 0 ${W} ${H}`} style={`height:${H}px`} role="img" aria-label={label}>
          {yt.map((v) => (
            <g>
              <line x1={M.l} x2={W - M.r} y1={Y(v)} y2={Y(v)} stroke={v === 0 ? 'var(--axis)' : 'var(--grid)'} />
              <text x={M.l - 8} y={Y(v) + 4} text-anchor="end" font-size="11" fill="var(--muted)">
                {yFormat(v)}
              </text>
            </g>
          ))}
          {xt.map((v) => (
            <text x={X(v)} y={H - M.b + 16} text-anchor="middle" font-size="11" fill="var(--muted)">
              {xFormat(v)}
            </text>
          ))}
          {xRef !== undefined && <line x1={X(xRef)} x2={X(xRef)} y1={M.t} y2={H - M.b} stroke="var(--axis)" />}
          <text x={W - M.r} y={H - 4} text-anchor="end" font-size="11.5" fill="var(--ink-2)">
            {xLabel} →
          </text>
          <text x={M.l - 40} y={14} font-size="11.5" fill="var(--ink-2)">
            ↑ {yLabel}
          </text>
          {points.map((p, i) => (
            <g
              class={`pt ${hover === i ? 'on' : ''}`}
              tabIndex={0}
              aria-label={`${p.label}: ${yLabel} ${yFormat(p.y)}, ${xLabel} ${xFormat(p.x)}`}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(undefined)}
            >
              <circle cx={X(p.x)} cy={Y(p.y)} r={12} fill="transparent" />
              <circle cx={X(p.x)} cy={Y(p.y)} r={hover === i ? 6 : 5} fill="var(--s1)" stroke="var(--surface)" stroke-width={2} />
              {p.named && (
                <text x={X(p.x) + (X(p.x) > W - 90 ? -9 : 9)} y={Y(p.y) + 4} text-anchor={X(p.x) > W - 90 ? 'end' : 'start'} font-size="11.5" fill="var(--ink-2)">
                  {p.label}
                </text>
              )}
            </g>
          ))}
        </svg>
        {h && (
          <div class="tip" style={`top:${Math.max(0, Y(h.y) - 70)}px;${X(h.x) > W / 2 ? `right:${W - X(h.x) + 14}px` : `left:${X(h.x) + 14}px`}`}>
            <strong>{h.label}</strong>
            {h.lines.map((l) => (
              <div class="small">{l}</div>
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
                <th></th>
                <th class="n">{yLabel}</th>
                <th class="n">{xLabel}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr>
                  <td>{p.label}</td>
                  <td class="n">{yFormat(p.y)}</td>
                  <td class="n">{xFormat(p.x)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
