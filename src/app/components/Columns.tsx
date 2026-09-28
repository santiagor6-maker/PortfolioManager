import { useEffect, useRef, useState } from 'preact/hooks';
import { niceTicks } from './LineChart.tsx';

/** `solid`: received. `soft`: received but estimated. `outline`: projected, not received. */
export type SegmentStyle = 'solid' | 'soft' | 'outline';

export interface Segment {
  label: string;
  value: number;
  color: string;
  style?: SegmentStyle;
}

/** One column: its segments stacked from the baseline in the order given. */
export interface Column {
  label: string;
  segments: Segment[];
}

export interface ColumnGroup {
  /** Axis label. */
  label: string;
  /** Tooltip heading. */
  title: string;
  columns: Column[];
  /** Short text above the group (e.g. the change on the year before). */
  top?: string;
}

/**
 * Vertical columns from a zero baseline, grouped side by side (e.g. this year and last year per month) and
 * stacked within a column (received, estimated, projected). One axis; hover a group for every figure.
 */
export function Columns({ groups, format, axisFormat, label, height = 200 }: { groups: ColumnGroup[]; format: (v: number) => string; axisFormat?: (v: number) => string; label: string; height?: number }) {
  const [hover, setHover] = useState<number>();
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(300, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const T = 18;
  const B = 22;
  const total = (c: Column) => c.segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const hi = Math.max(0, ...groups.flatMap((g) => g.columns.map(total)));
  const ticks = hi > 0 ? niceTicks(0, hi, 4) : [0];
  // One more gridline when the tallest column passes the last one, so no column ends above the axis.
  if (ticks.length > 1 && ticks[ticks.length - 1]! < hi) ticks.push(Number((2 * ticks[ticks.length - 1]! - ticks[ticks.length - 2]!).toPrecision(12)));
  const top = Math.max(hi, ticks[ticks.length - 1]!) || 1;
  const fmtAxis = axisFormat ?? format;
  const L = Math.min(72, 12 + 7 * Math.max(...ticks.map((t) => fmtAxis(t).length)));
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const gw = (W - L) / Math.max(groups.length, 1);
  const n = Math.max(1, ...groups.map((g) => g.columns.length));
  const bw = Math.max(3, Math.min(26, (gw - 6) / n - 2));
  const every = gw < 30 ? Math.ceil(30 / gw) : 1;
  const h = hover !== undefined ? groups[hover] : undefined;
  return (
    <div class="chart" ref={box} onMouseLeave={() => setHover(undefined)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
        {ticks.map((v) => (
          <g>
            <line x1={L} x2={W} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--axis)' : 'var(--grid)'} />
            <text x={L - 6} y={y(v) + 4} text-anchor="end" font-size="11" fill="var(--muted)">
              {fmtAxis(v)}
            </text>
          </g>
        ))}
        {groups.map((g, i) => {
          const x0 = L + i * gw + (gw - (bw + 2) * g.columns.length + 2) / 2;
          const highest = Math.max(0, ...g.columns.map(total));
          return (
            <g onMouseEnter={() => setHover(i)} class="col-group">
              <rect x={L + i * gw} y={T} width={gw} height={H - T - B} fill={hover === i ? 'var(--surface-2)' : 'transparent'} />
              {g.columns.map((c, j) => {
                let acc = 0;
                const x = x0 + j * (bw + 2);
                return c.segments.map((s) => {
                  if (s.value <= 0) return null;
                  const y1 = y(acc + s.value);
                  const y0 = y(acc);
                  acc += s.value;
                  // 1px surface gap between stacked segments.
                  const hgt = Math.max(1, y0 - y1 - (acc > s.value ? 1 : 0));
                  return s.style === 'outline' ? (
                    <rect x={x + 0.75} y={y1 + 0.75} width={bw - 1.5} height={Math.max(0.5, hgt - 1.5)} rx={2} fill={s.color} fill-opacity={0.12} stroke={s.color} stroke-width={1.5} stroke-dasharray="3 2" />
                  ) : (
                    <rect x={x} y={y1} width={bw} height={hgt} rx={2} fill={s.color} fill-opacity={s.style === 'soft' ? 0.45 : 1} />
                  );
                });
              })}
              {g.top && (
                <text x={L + i * gw + gw / 2} y={y(highest) - 5} text-anchor="middle" font-size="11" fill="var(--ink-2)">
                  {g.top}
                </text>
              )}
              {i % every === 0 && (
                <text x={L + i * gw + gw / 2} y={H - 6} text-anchor="middle" font-size="11" fill="var(--muted)">
                  {g.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {h && hover !== undefined && (
        <div class="tip" style={`top:4px;${(L + (hover + 0.5) * gw) / W > 0.6 ? `right:${((W - L - hover * gw) / W) * 100}%` : `left:${((L + (hover + 1) * gw) / W) * 100}%`}`}>
          <strong>{h.title}</strong>
          {h.columns.map((c) => (
            <>
              {h.columns.length > 1 && <div class="tip-sub">{c.label}</div>}
              {c.segments.filter((s) => s.value > 0).length === 0 ? (
                <div class="row muted">
                  <span>{h.columns.length > 1 ? 'Nada' : c.label}</span>
                  <span>{format(0)}</span>
                </div>
              ) : (
                c.segments
                  .filter((s) => s.value > 0)
                  .map((s) => (
                    <div class="row">
                      <span>
                        <span class={`key-sw ${s.style ?? 'solid'}`} style={`--c:${s.color}`} />
                        {s.label}
                      </span>
                      <span>{format(s.value)}</span>
                    </div>
                  ))
              )}
            </>
          ))}
        </div>
      )}
    </div>
  );
}

/** Legend swatch matching a segment style. */
export function Swatch({ color, style = 'solid' }: { color: string; style?: SegmentStyle }) {
  return <span class={`key-sw ${style}`} style={`--c:${color}`} />;
}
