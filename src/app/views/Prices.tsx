import { useMemo, useState } from 'preact/hooks';
import { Decimal } from '../../domain/money.ts';
import { positionRows, bucketLabel } from '../analysis.ts';
import { contextOf } from '../context.ts';
import { Filters, useFilters } from '../components/Filters.tsx';
import { date, money, moneyShort, num, parseNumber, pct, price } from '../format.ts';
import { upsertAsset } from '../mutations.ts';
import { battingAverage, stockBook } from '../stocks.ts';
import type { StockRow } from '../stocks.ts';
import { getDataset, setDataset, useDataset, usePref } from '../store.ts';

type Sort = 'value' | 'progress' | 'toTarget' | 'ret' | 'change1m' | 'name';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'value', label: 'Valor' },
  { id: 'progress', label: 'Avance al objetivo' },
  { id: 'toTarget', label: 'Potencial al objetivo' },
  { id: 'ret', label: 'Rentabilidad' },
  { id: 'change1m', label: 'Cambio del mes' },
  { id: 'name', label: 'Nombre' },
];

const sign = (x: number | undefined) => (x === undefined ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');

/** A number with no currency sign, for tight labels. */
const bare = (x: number) => new Intl.NumberFormat('es-CO', { maximumFractionDigits: Math.abs(x) >= 1000 ? 0 : Math.abs(x) >= 1 ? 2 : 4 }).format(x);

/** Last year of closes; the dashed line is the average entry price. */
function Sparkline({ r }: { r: StockRow }) {
  const pts = r.spark;
  if (pts.length < 2) return <span class="muted small">—</span>;
  const W = 92;
  const H = 28;
  const entry = r.avgPrice.toNumber();
  const vals = pts.map((p) => p.close);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const y = (v: number) => 2 + (1 - (v - lo) / span) * (H - 4);
  const x = (i: number) => (i / (pts.length - 1)) * (W - 4);
  const last = vals[vals.length - 1]!;
  const up = last >= entry;
  return (
    <svg class="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${r.name}: último año de ${price(lo, r.ccy)} a ${price(hi, r.ccy)}`}>
      {entry >= lo && entry <= hi && <line x1={0} x2={W - 4} y1={y(entry)} y2={y(entry)} stroke="var(--axis)" stroke-dasharray="3 3" />}
      <polyline fill="none" stroke="var(--ink-2)" stroke-width={1.4} stroke-linejoin="round" points={vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
      <circle cx={x(vals.length - 1)} cy={y(last)} r={2.8} fill={up ? 'var(--dv-pos)' : 'var(--dv-neg)'} />
    </svg>
  );
}

/** 52-week low–high with the entry price (tick) and today's price (dot); an arrow when the target is beyond the range. */
function RangeBar({ r }: { r: StockRow }) {
  if (r.low52 === undefined || r.high52 === undefined || !r.price) return <span class="muted small">—</span>;
  const entry = r.avgPrice.toNumber();
  const now = r.price.close.toNumber();
  const target = r.target?.toNumber();
  const lo = Math.min(r.low52, entry);
  const hi = Math.max(r.high52, entry, target !== undefined && target <= r.high52 * 1.5 ? target : -Infinity);
  const pos = (v: number) => `${(((v - lo) / (hi - lo || 1)) * 100).toFixed(1)}%`;
  return (
    <div class="range" title={`52 semanas: ${price(r.low52, r.ccy)} – ${price(r.high52, r.ccy)} · entrada ${price(entry, r.ccy)} · hoy ${price(now, r.ccy)}${target ? ` · objetivo ${price(target, r.ccy)}` : ''}`}>
      <div class="track">
        <span class="band" style={`left:${pos(r.low52)};right:calc(100% - ${pos(r.high52)})`} />
        <span class="tick entry" style={`left:${pos(entry)}`} />
        {target !== undefined && target <= hi && <span class="tick target" style={`left:${pos(target)}`} />}
        <span class={`now ${now >= entry ? 'up' : 'down'}`} style={`left:${pos(now)}`} />
      </div>
      {target !== undefined && target > hi && <span class="beyond" aria-hidden="true">▸</span>}
      <div class="ends">
        <span>{bare(r.low52)}</span>
        <span>{bare(r.high52)}</span>
      </div>
    </div>
  );
}

function Progress({ r }: { r: StockRow }) {
  if (!r.target) return <span class="muted small">sin objetivo</span>;
  if (r.progress === undefined) return <span class="small muted" title="El objetivo está por debajo del precio de entrada">—</span>;
  if (r.progress >= 1) return <span class="badge good">✓ alcanzado</span>;
  if (r.progress < 0) return <span class="small neg nowrap">bajo la entrada</span>;
  const p = r.progress;
  return (
    <div class="progress" title={`(precio − entrada) / (objetivo − entrada) = ${pct(r.progress)}`}>
      <div class="bar">
        <span style={`width:${(p * 100).toFixed(1)}%`} />
      </div>
      <span class="small">{pct(p, 0)}</span>
    </div>
  );
}

function Edit({ r, strategies, onDone }: { r: StockRow; strategies: string[]; onDone: () => void }) {
  const [target, setTarget] = useState(r.target?.toString() ?? '');
  const [strategy, setStrategy] = useState(r.strategy ?? '');
  const [err, setErr] = useState<string>();
  async function save(e: Event) {
    e.preventDefault();
    let t: Decimal | undefined;
    try {
      t = parseNumber(target);
    } catch {
      setErr(`"${target}" no es un número`);
      return;
    }
    if (t && !t.gt(0)) {
      setErr('El objetivo debe ser mayor que cero');
      return;
    }
    const d = getDataset();
    const a = d.assets.find((x) => x.id === r.asset)!;
    const { target: _t, strategy: _s, ...rest } = a;
    await setDataset(upsertAsset(d, { ...rest, ...(t ? { target: t.toString() } : {}), ...(strategy.trim() ? { strategy: strategy.trim() } : {}) }));
    onDone();
  }
  return (
    <form class="edit-row" onSubmit={save} aria-label={`Objetivo de ${r.name}`}>
      <label>
        Precio objetivo ({r.ccy})
        <input inputMode="decimal" value={target} onInput={(e) => setTarget((e.target as HTMLInputElement).value)} placeholder="vacío = sin objetivo" />
      </label>
      <label>
        Estrategia
        <input list="strategies" value={strategy} onInput={(e) => setStrategy((e.target as HTMLInputElement).value)} placeholder="p. ej. Valor, Crecimiento" />
      </label>
      <datalist id="strategies">
        {strategies.map((s) => (
          <option value={s} />
        ))}
      </datalist>
      <button type="submit" class="primary">
        Guardar
      </button>
      {err && <span class="small neg" role="alert">{err}</span>}
    </form>
  );
}

export function Prices() {
  const { data } = useDataset();
  const [f, set] = useFilters();
  const ctx = contextOf(data);
  const [bucket, setBucket] = usePref<string>('prices:bucket', '');
  const [strategy, setStrategy] = usePref<string>('prices:strategy', '');
  const [sort, setSort] = usePref<Sort>('prices:sort', 'value');
  const [open, setOpen] = useState<string>();
  const [allTrades, setAllTrades] = useState(false);

  const { rows, trades } = useMemo(() => stockBook(ctx, f.ccy, f.asOf), [ctx, f.ccy, f.asOf]);
  const money$ = useMemo(() => new Map(positionRows(ctx, f.ccy, f.asOf).map((p) => [`${p.account}\u0000${p.asset}`, p])), [ctx, f.ccy, f.asOf]);
  const buckets = [...new Set(rows.map((r) => r.bucket))];
  const strategies = [...new Set([...ctx.book.assets.values()].map((a) => a.strategy).filter((s): s is string => !!s))].sort();
  const shown = rows
    .filter((r) => (!bucket || r.bucket === bucket) && (!strategy || (strategy === '—' ? !r.strategy : r.strategy === strategy)))
    .sort((a, b) => {
      const v = (r: StockRow) =>
        sort === 'value' ? money$.get(r.key)?.value.toNumber() ?? 0
        : sort === 'progress' ? r.progress ?? -Infinity
        : sort === 'toTarget' ? r.toTarget ?? -Infinity
        : sort === 'ret' ? r.ret ?? -Infinity
        : sort === 'change1m' ? r.change1m ?? -Infinity
        : 0;
      return sort === 'name' ? a.name.localeCompare(b.name) : v(b) - v(a) || a.name.localeCompare(b.name);
    });
  const value = shown.reduce((s, r) => s.plus(money$.get(r.key)?.value ?? 0), new Decimal(0));
  const gain = shown.reduce((s, r) => s.plus(money$.get(r.key)?.unrealized ?? 0), new Decimal(0));
  const winners = shown.filter((r) => (money$.get(r.key)?.unrealized.toNumber() ?? 0) > 0).length;
  const reached = shown.filter((r) => (r.progress ?? 0) >= 1).length;
  const near = shown.filter((r) => r.progress !== undefined && r.progress >= 0.75 && r.progress < 1).length;
  const withTarget = shown.filter((r) => r.target).length;
  const batting = battingAverage(trades);
  const stale = shown.filter((r) => r.stale || !r.price);
  const tradeRows = allTrades ? trades : trades.slice(0, 15);

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
        <label>
          Estrategia
          <select value={strategy} onChange={(e) => setStrategy((e.target as HTMLSelectElement).value)}>
            <option value="">Todas</option>
            {strategies.map((s) => (
              <option value={s}>{s}</option>
            ))}
            <option value="—">Sin estrategia</option>
          </select>
        </label>
        <label>
          Ordenar por
          <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)}>
            {SORTS.map((s) => (
              <option value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
      </Filters>

      {stale.length > 0 && (
        <div class="notice warn" role="status">
          Precio de más de 5 días o sin precio al {date(f.asOf)}: {stale.map((r) => r.name).join(', ')}. Carga precios en <a href="#/datos">Datos</a> (en la fase 4 se descargarán solos).
        </div>
      )}

      <div class="tiles">
        <div class="tile">
          <div>
            <div class="label">Acciones abiertas</div>
            <div class="value">{shown.length}</div>
            <div class="sub">Valor {moneyShort(value, f.ccy)} al {date(f.asOf)}</div>
          </div>
        </div>
        <div class="tile">
          <div>
            <div class="label">Ganando / perdiendo</div>
            <div class="value">
              <span class="pos">{winners}</span> / <span class="neg">{shown.length - winners}</span>
            </div>
            <div class="sub">
              Ganancia sin realizar <span class={sign(gain.toNumber())}>{moneyShort(gain, f.ccy)}</span>
            </div>
          </div>
        </div>
        <div class="tile">
          <div>
            <div class="label">Objetivo alcanzado</div>
            <div class="value">{reached}</div>
            <div class="sub">
              {near} a más del 75 % del camino · {withTarget} de {shown.length} con objetivo
            </div>
          </div>
        </div>
        <div class="tile">
          <div>
            <div class="label">Acierto en ventas</div>
            <div class="value">{pct(batting, 0)}</div>
            <div class="sub">{trades.filter((t) => t.ret > 0).length} de {trades.length} ventas con ganancia</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Seguimiento de precios</h2>
          <span class="small muted">Cierres al {date(f.asOf)} en la moneda de cada acción · valor y ganancia en {f.ccy} · toca una fila para ver compras y editar el objetivo</span>
        </div>
        <div class="table-wrap">
          <table class="prices">
            <thead>
              <tr>
                <th>Acción</th>
                <th class="n">Entrada (prom.)</th>
                <th class="n">Precio actual</th>
                <th>Último año</th>
                <th>Rango 52 semanas</th>
                <th class="n">Rentab.</th>
                <th class="n">Objetivo</th>
                <th>Avance</th>
                <th class="n">Valor y ganancia ({f.ccy})</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const m = money$.get(r.key);
                const isOpen = open === r.key;
                return (
                  <>
                    <tr class={`stock ${isOpen ? 'open' : ''}`} key={r.key} onClick={() => setOpen(isOpen ? undefined : r.key)}>
                      <td>
                        <button type="button" class="rowtoggle" aria-expanded={isOpen} onClick={(e) => (e.stopPropagation(), setOpen(isOpen ? undefined : r.key))}>
                          <span class="caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                          <strong>{r.name}</strong>
                        </button>
                        <div class="small muted">
                          {r.symbol.split('.')[0] !== r.name ? `${r.symbol} · ` : ''}
                          {m?.accountName}
                          {r.strategy && <span class="chip tag">{r.strategy}</span>}
                        </div>
                      </td>
                      <td class="n">
                        {price(r.avgPrice, r.ccy)}
                        <div class="small muted">
                          {num(r.qty, 4)} u · {r.days} d
                        </div>
                      </td>
                      <td class="n">
                        <strong>{price(r.price?.close, r.ccy)}</strong>
                        <div class={`small ${r.stale ? 'stale' : 'muted'}`}>
                          {!r.price ? 'sin precio' : r.stale ? date(r.price.date) : ''}
                          {r.change1d !== undefined && <span class={sign(r.change1d)}> {r.change1d > 0 ? '▲' : r.change1d < 0 ? '▼' : ''} {pct(r.change1d)}</span>}
                        </div>
                      </td>
                      <td>
                        <Sparkline r={r} />
                      </td>
                      <td>
                        <RangeBar r={r} />
                      </td>
                      <td class={`n ${sign(r.ret)}`}>
                        <strong>{pct(r.ret)}</strong>
                        <div class="small muted" title="Efectiva anual desde la fecha de entrada promedio">
                          {r.annual === undefined ? '< 90 d' : `${pct(r.annual)} EA`}
                        </div>
                      </td>
                      <td class="n">
                        {r.target ? price(r.target, r.ccy) : '—'}
                        {r.toTarget !== undefined && <div class="small muted">{r.toTarget > 0 ? `faltan ${pct(r.toTarget, 0)}` : 'superado'}</div>}
                      </td>
                      <td>
                        <Progress r={r} />
                      </td>
                      <td class="n">
                        {m ? moneyShort(m.value, f.ccy) : '—'}
                        {m && <div class={`small ${sign(m.unrealized.toNumber())}`} title={money(m.unrealized, f.ccy)}>{m.unrealized.gt(0) ? '+' : ''}{moneyShort(m.unrealized, f.ccy)}</div>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr class="detail">
                        <td colSpan={9}>
                          <div class="detail-grid">
                            <div>
                              <h3>Compras del periodo actual</h3>
                              <table class="compact">
                                <thead>
                                  <tr>
                                    <th>Fecha</th>
                                    <th class="n">Unidades</th>
                                    <th class="n">Precio</th>
                                    <th class="n">Desde la compra</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.lots.map((l) => (
                                    <tr>
                                      <td>{date(l.date)}</td>
                                      <td class="n">{num(l.qty, 4)}</td>
                                      <td class="n">{price(l.price, r.ccy)}</td>
                                      <td class={`n ${sign(l.ret)}`}>{pct(l.ret)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              <p class="small muted">Costo promedio: las ventas parciales no cambian el precio de entrada. Precios sin comisión.</p>
                            </div>
                            <div>
                              <h3>Cambio del precio</h3>
                              <div class="chips">
                                <span class="chip">
                                  Día <strong class={sign(r.change1d)}>{pct(r.change1d)}</strong>
                                </span>
                                <span class="chip">
                                  30 días <strong class={sign(r.change1m)}>{pct(r.change1m)}</strong>
                                </span>
                                <span class="chip">
                                  Año corrido <strong class={sign(r.changeYtd)}>{pct(r.changeYtd)}</strong>
                                </span>
                              </div>
                              <h3 style="margin-top:12px">Objetivo y estrategia</h3>
                              <Edit r={r} strategies={strategies} onDone={() => setOpen(undefined)} />
                              <p class="small" style="margin-top:10px">
                                <a href={`#/tesis?accion=${encodeURIComponent(r.asset)}`}>Tesis, precio optimista y fundamentales de {r.name} →</a>
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
        <p class="small muted" style="margin-top:8px">
          Avance = (precio − entrada) / (objetivo − entrada), como el «% cumplimiento real / objetivo» de tu bitácora. Rango: línea gris = mínimo y máximo de 52 semanas, raya = tu entrada, punto = hoy (azul si
          está sobre tu entrada, rojo si está debajo), raya verde = objetivo (▸ si queda por encima del rango). Precios de cierre con su fecha; los copy portfolios, fondos e inmuebles no tienen precio público y no
          aparecen aquí.
        </p>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Ventas cerradas</h2>
          <span class="small muted">
            {trades.length} ventas · acierto {pct(batting, 0)} · ganancia realizada {moneyShort(trades.reduce((s, t) => s.plus(t.realized), new Decimal(0)), f.ccy)}
          </span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Venta</th>
                <th>Acción</th>
                <th class="n">Unidades</th>
                <th class="n">Entrada</th>
                <th class="n">Salida</th>
                <th class="n">Días</th>
                <th class="n">Rentab.</th>
                <th class="n">EA</th>
                <th class="n">Ganancia ({f.ccy})</th>
              </tr>
            </thead>
            <tbody>
              {tradeRows.map((t) => (
                <tr>
                  <td>{date(t.date)}</td>
                  <td>{t.name}</td>
                  <td class="n">{num(t.qty, 4)}</td>
                  <td class="n">{price(t.entry, t.ccy)}</td>
                  <td class="n">{price(t.exit, t.ccy)}</td>
                  <td class="n">{t.days}</td>
                  <td class={`n ${sign(t.ret)}`}>{pct(t.ret)}</td>
                  <td class={`n ${sign(t.annual)}`}>{pct(t.annual)}</td>
                  <td class={`n ${sign(t.realized.toNumber())}`}>{money(t.realized, f.ccy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {trades.length > 15 && (
          <button type="button" class="link" onClick={() => setAllTrades(!allTrades)}>
            {allTrades ? 'Ver solo las últimas 15' : `Ver las ${trades.length} ventas`}
          </button>
        )}
        <p class="small muted" style="margin-top:8px">
          Rentabilidad sobre el precio de entrada promedio, en la moneda de la acción. Ganancia realizada sobre el costo promedio (con comisiones), a la TRM de la fecha de venta. EA solo desde 90 días.
        </p>
      </div>
    </>
  );
}
