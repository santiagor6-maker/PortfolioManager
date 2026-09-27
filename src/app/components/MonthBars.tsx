import { useEffect, useRef, useState } from 'preact/hooks';
import { monthLabel } from '../format.ts';

export interface MonthBar {
  date: string;
  value: number | null;
}

/**
 * One column per month from a zero baseline: blue above, red below (diverging pair). Months without
 * a value stay empty. Year starts are labeled on the axis; hover shows the exact figure.
 */
export function MonthBars({ items, format, label }: { items: MonthBar[]; format: (v: number) => string; label: string }) {
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
  const H = 170;
  const L = 52;
  const T = 10;
  const B = 22;
  const vals = items.map((i) => i.value ?? 0);
  const hi = Math.max(0, ...vals);
  const lo = Math.min(0, ...vals);
  const span = hi - lo || 1;
  const y = (v: number) => T + ((hi - v) / span) * (H - T - B);
  const step = (W - L) / Math.max(items.length, 1);
  const bw = Math.max(1, Math.min(18, step - 2));
  const ticks = [hi, 0, lo].filter((v, i, a) => a.indexOf(v) === i);
  const h = hover !== undefined ? items[hover] : undefined;
  return (
    <div class="chart" ref={box} onMouseLeave={() => setHover(undefined)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
        {ticks.map((v) => (
          <g>
            <line x1={L} x2={W} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--axis)' : 'var(--grid)'} />
            <text x={L - 6} y={y(v) + 4} text-anchor="end" font-size="11" fill="var(--muted)">
              {format(v)}
            </text>
          </g>
        ))}
        {items.map((it, i) => {
          const x = L + i * step + (step - bw) / 2;
          const v = it.value;
          const newYear = it.date.slice(5, 7) === '01' || i === 0;
          return (
            <g onMouseEnter={() => setHover(i)}>
              <rect x={L + i * step} y={T} width={step} height={H - T - B} fill="transparent" />
              {v !== null && <rect x={x} y={Math.min(y(v), y(0))} width={bw} height={Math.max(1, Math.abs(y(v) - y(0)))} rx={Math.min(3, bw / 3)} fill={v >= 0 ? 'var(--dv-pos)' : 'var(--dv-neg)'} opacity={hover === undefined || hover === i ? 1 : 0.45} />}
              {newYear && (items.length <= 36 || it.date.slice(5, 7) === '01') && (
                <text x={L + i * step + 2} y={H - 6} font-size="11" fill="var(--muted)">
                  {items.length <= 14 ? monthLabel(it.date) : it.date.slice(0, 4)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {h && hover !== undefined && (
        <div class="tip" style={`left:min(calc(${((L + hover * step) / W) * 100}% + 8px), calc(100% - 180px));top:4px`}>
          <strong>{monthLabel(h.date)}</strong>
          <div>{h.value === null ? 'sin dato' : format(h.value)}</div>
        </div>
      )}
    </div>
  );
}
