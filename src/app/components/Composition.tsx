import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { bucketLabel } from '../analysis.ts';
import { CASH_ID, classBase, composition, shareOf } from '../composition.ts';
import type { Composition, Slice } from '../composition.ts';
import { money, moneyShort, monthLabel, pct } from '../format.ts';
import type { Tracking } from '../tracking.ts';
import { REAL_ESTATE } from '../tracking.ts';
import { byClassOrder, classColor } from './Bars.tsx';
import { usePref } from '../store.ts';

const TOP = 12;
const FLAG_NOTE: Record<string, string> = { estimated: 'estimado', cost: 'al costo, falta precio', stale: 'valor de una fecha anterior' };
const colorOf = (bucket: string) => (bucket === CASH_ID ? 'var(--s7)' : classColor(bucket));
const classOrder = (a: string, b: string) => (a === CASH_ID ? 1 : b === CASH_ID ? -1 : byClassOrder(a, b));
const short = (v: number) => pct(v, v < 0.1 ? 1 : 0);

/**
 * How the portfolio is split, at any month-end of the range: share of each class over time (100 % columns, click a
 * month to inspect it), the classes of that month, and its holdings (all, or those of the class picked).
 */
export function CompositionCard({ t, from, to }: { t: Tracking; from: number; to: number }) {
  const hasRealEstate = t.classes.some((c) => c.bucket === REAL_ESTATE && c.cells.slice(from, to + 1).some((x) => x.value.gt(0)));
  const [reMode, setReMode] = usePref<'con' | 'sin'>('track:comp-re', 'con');
  const re = reMode === 'con' && hasRealEstate;
  const [picked, setPicked] = useState<number>();
  const k = picked !== undefined && picked >= from && picked <= to ? picked : to;
  const [cls, setCls] = useState<string>();
  const series = useMemo(() => Array.from({ length: to - from + 1 }, (_, i) => composition(t, from + i, re)), [t, from, to, re]);
  const now = series[k - from]!;
  const buckets = useMemo(() => [...new Set(series.flatMap((c) => c.classes.map((x) => x.bucket)))].sort(classOrder), [series]);
  const inClass = cls && now.classes.some((c) => c.bucket === cls) ? cls : undefined;
  const classValue = inClass ? classBase(now, inClass) : now.total;

  return (
    <div class="card comp-card" aria-label="Composición del portafolio" role="region">
      <div class="card-head">
        <h2>Composición del portafolio</h2>
        {hasRealEstate && (
          <div class="seg" role="group" aria-label="Inmobiliario">
            <button type="button" aria-pressed={re} onClick={() => setReMode('con')}>
              Con inmobiliario
            </button>
            <button type="button" aria-pressed={!re} onClick={() => setReMode('sin')}>
              Sin inmobiliario
            </button>
          </div>
        )}
      </div>
      <p class="small muted">
        Participación de cada clase al cierre de cada mes, sobre {re || !hasRealEstate ? 'todo el portafolio' : 'el portafolio sin el inmobiliario'}. Toca un mes para ver su detalle; toca una clase para ver sus posiciones.
      </p>
      <ShareColumns series={series} buckets={buckets} selected={k - from} onPick={(i) => setPicked(from + i)} />

      <div class="comp-grid">
        <section aria-label={`Clases al cierre de ${monthLabel(now.month)}`}>
          <h3>
            Por clase · {monthLabel(now.month)} <span class="muted">{money(now.total, t.ccy)}</span>
          </h3>
          <div class="comp-rows">
            {now.classes.map((c) => (
              <ShareRow
                slice={c}
                label={c.label}
                share={c.share}
                text={`${pct(c.share, 1)} · ${moneyShort(c.value, t.ccy)}`}
                pressed={inClass === c.bucket}
                onClick={c.bucket === CASH_ID ? undefined : () => setCls(inClass === c.bucket ? undefined : c.bucket)}
              />
            ))}
          </div>
          {now.negativeCash && <p class="small muted">Efectivo negativo de {money(now.negativeCash, t.ccy)} (debido al bróker): no entra en los porcentajes.</p>}
        </section>
        <section aria-label="Posiciones">
          <h3>
            {inClass ? `Dentro de ${bucketLabel(inClass)}` : 'Posiciones'} <span class="muted">{inClass ? `% de la clase · % del total` : '% del total'}</span>
            {inClass && (
              <button type="button" class="link push" onClick={() => setCls(undefined)}>
                ver todas
              </button>
            )}
          </h3>
          <Holdings now={now} inClass={inClass} classValue={classValue} ccy={t.ccy} />
          {now.negativeHoldings
            .filter((h) => !inClass || h.bucket === inClass)
            .map((h) => (
              <p class="small muted">
                {h.label} vale {money(h.value, t.ccy)} a ese cierre: no entra en los porcentajes.
              </p>
            ))}
        </section>
      </div>
    </div>
  );
}

function Holdings({ now, inClass, classValue, ccy }: { now: Composition; inClass?: string; classValue: Composition['total']; ccy: string }) {
  const [all, setAll] = useState(false);
  const list = now.holdings.filter((h) => !inClass || h.bucket === inClass);
  const shown = all ? list : list.slice(0, TOP);
  const rest = list.slice(shown.length);
  const restShare = rest.reduce((s, h) => s + h.share, 0);
  if (!list.length) return <p class="small muted">Sin posiciones con valor a ese cierre.</p>;
  return (
    <div class="comp-rows">
      {shown.map((h) => {
        const ofClass = shareOf(h.value, classValue);
        return (
          <ShareRow
            slice={h}
            label={h.label}
            sub={[h.sub, h.flag && FLAG_NOTE[h.flag]].filter(Boolean).join(' · ')}
            share={inClass ? ofClass : h.share}
            text={inClass ? `${pct(ofClass, 1)} · ${short(h.share)} · ${moneyShort(h.value, ccy)}` : `${pct(h.share, 1)} · ${moneyShort(h.value, ccy)}`}
          />
        );
      })}
      {rest.length > 0 && (
        <button type="button" class="link" onClick={() => setAll(true)}>
          Otras {rest.length} posiciones ({pct(restShare, 1)} del total)
        </button>
      )}
    </div>
  );
}

function ShareRow({ slice, label, sub, share, text, pressed, onClick }: { slice: Slice; label: string; sub?: string; share: number; text: string; pressed?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <span class="comp-label">
        <span class="dot" style={`background:${colorOf(slice.bucket)}`} />
        {label}
        {sub && <small>{sub}</small>}
      </span>
      <span class="comp-track">
        <span class={`comp-fill ${slice.flag === 'estimated' ? 'est' : ''}`} style={`width:${Math.max(0.5, share * 100)}%;background:${colorOf(slice.bucket)}`} />
      </span>
      <span class="comp-val">{text}</span>
    </>
  );
  return onClick ? (
    <button type="button" class="comp-row pick" aria-pressed={!!pressed} onClick={onClick} title={pressed ? 'Ver todas las posiciones' : `Ver las posiciones de ${label}`}>
      {body}
    </button>
  ) : (
    <div class="comp-row">{body}</div>
  );
}

/** 100 % stacked columns, one per month-end, classes in their fixed slot order (cash last). */
function ShareColumns({ series, buckets, selected, onPick }: { series: Composition[]; buckets: string[]; selected: number; onPick: (i: number) => void }) {
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
  const H = 190;
  const L = 36;
  const T = 6;
  const B = 22;
  const plot = H - T - B;
  const step = (W - L) / Math.max(series.length, 1);
  const bw = Math.max(3, Math.min(28, step - 3));
  const y = (s: number) => T + (1 - s) * plot;
  const shown = hover ?? selected;
  const c = series[shown];
  return (
    <div class="chart comp-chart" ref={box} onMouseLeave={() => setHover(undefined)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Participación de cada clase al cierre de cada mes">
        {[0, 0.5, 1].map((v) => (
          <g>
            <line x1={L} x2={W} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--axis)' : 'var(--grid)'} />
            <text x={L - 6} y={y(v) + 4} text-anchor="end" font-size="11" fill="var(--muted)">
              {v * 100} %
            </text>
          </g>
        ))}
        {series.map((s, i) => {
          const x = L + i * step + (step - bw) / 2;
          let acc = 0;
          const segs = buckets
            .map((b) => s.classes.find((c) => c.bucket === b))
            .filter((p): p is Slice => !!p)
            .map((p) => {
              const y0 = y(acc);
              acc += p.share;
              const y1 = y(acc);
              // 2px surface gap between stacked segments.
              return <rect x={x} y={y1 + 1} width={bw} height={Math.max(0, y0 - y1 - 2)} fill={colorOf(p.bucket)} />;
            });
          const m = s.month.slice(5, 7);
          const label = series.length <= 14 ? monthLabel(s.month).split(' ')[0] : m === '01' || i === 0 ? s.month.slice(0, 4) : '';
          return (
            <g class="col" onMouseEnter={() => setHover(i)} onClick={() => onPick(i)}>
              <rect x={L + i * step} y={0} width={step} height={H} fill="transparent" />
              <g>{segs}</g>
              {i === selected && <rect x={x - 2} y={T - 2} width={bw + 4} height={plot + 4} fill="none" stroke="var(--ink)" stroke-width="1.5" rx="3" />}
              {label && (
                <text x={L + i * step + step / 2} y={H - 6} text-anchor="middle" font-size="11" fill={i === selected ? 'var(--ink)' : 'var(--muted)'}>
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {c && hover !== undefined && (
        <div class="tip" style={`left:min(calc(${((L + shown * step + step) / W) * 100}% + 8px), calc(100% - 210px));top:4px`}>
          <strong>{monthLabel(c.month)}</strong>
          {c.classes
            .slice()
            .sort((a, b) => classOrder(a.bucket, b.bucket))
            .reverse()
            .map((p) => (
              <div class="tip-row">
                <span class="dot" style={`background:${colorOf(p.bucket)}`} />
                <span>{p.label}</span>
                <span class="num">{pct(p.share, 1)}</span>
              </div>
            ))}
          <div class="small muted">Clic para ver este mes</div>
        </div>
      )}
      <div class="alloc-legend comp-legend">
        {buckets.map((b) => (
          <div class="item">
            <span class="dot" style={`background:${colorOf(b)}`} />
            <span class="name">{b === CASH_ID ? 'Efectivo' : bucketLabel(b)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
