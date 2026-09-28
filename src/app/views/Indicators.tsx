import { useEffect, useMemo, useState } from 'preact/hooks';
import { Decimal } from '../../domain/money.ts';
import type { Asset, Fundamentals, MoatRating } from '../../domain/types.ts';
import { bucketLabel } from '../analysis.ts';
import { contextOf } from '../context.ts';
import { Filters, useFilters } from '../components/Filters.tsx';
import { Scatter } from '../components/Scatter.tsx';
import { date, money, moneyShort, parseNumber, pct, price } from '../format.ts';
import { breakdown, concentration, indicatorRows, weightedUpside } from '../indicators.ts';
import type { IndicatorRow, Slice } from '../indicators.ts';
import { upsertAsset } from '../mutations.ts';
import { queryParam } from '../route.ts';
import { getDataset, setDataset, useDataset, usePref } from '../store.ts';

const CAP: Record<string, string> = { large: 'Grande', mid: 'Mediana', small: 'Pequeña' };
const STYLE: Record<string, string> = { value: 'Valor', blend: 'Mixto', growth: 'Crecimiento' };
const MOAT: Record<string, string> = { wide: 'Amplio', narrow: 'Estrecho', none: 'Ninguno' };

type Dim = 'region' | 'strategy' | 'ideaSource' | 'moat' | 'box';
const keyOf: Record<Dim, (r: IndicatorRow) => string | undefined> = {
  region: (r) => r.region,
  strategy: (r) => r.strategy,
  ideaSource: (r) => r.ideaSource,
  moat: (r) => r.moat,
  box: (r) => (r.f.cap && r.f.style ? `${r.f.cap}|${r.f.style}` : undefined),
};
const DIM_LABEL: Record<Dim, string> = { region: 'Mercado', strategy: 'Estrategia', ideaSource: 'Fuente de la idea', moat: 'Foso económico', box: 'Estilo' };
const boxLabel = (k: string) => {
  const [c, s] = k.split('|');
  return `${CAP[c!]} · ${STYLE[s!]}`;
};
const keyLabel = (dim: Dim, k: string) => (!k ? 'Sin asignar' : dim === 'moat' ? MOAT[k] ?? k : dim === 'box' ? boxLabel(k) : k);

type Focus = { dim: Dim; key: string } | undefined;
type Sort = 'weight' | 'upside' | 'upsideHigh' | 'name';
type View = 'tesis' | 'fundamentales';

const sign = (x: number | undefined) => (x === undefined ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const dec = (s: string | undefined) => (s === undefined ? undefined : Number(s));
const multiple = (s: string | undefined) => (s === undefined ? '—' : `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(Number(s))}x`);
const plain = (s: string | undefined, digits = 2) => (s === undefined ? '—' : new Intl.NumberFormat('es-CO', { maximumFractionDigits: digits }).format(Number(s)));
const hasFundamentals = (f: Fundamentals) => Object.keys(f).some((k) => k !== 'asOf' && k !== 'source');

/** One dimension of the composition as weight bars; a click filters the table to that slice. */
function WeightBars({ dim, slices, focus, setFocus }: { dim: Dim; slices: Slice[]; focus: Focus; setFocus: (f: Focus) => void }) {
  const max = Math.max(...slices.map((s) => s.weight), 1e-9);
  return (
    <div class="wpanel">
      <h3>{DIM_LABEL[dim]}</h3>
      <div class="wbars">
        {slices.map((s) => {
          const active = focus?.dim === dim && focus.key === s.key;
          return (
            <button type="button" class={`wrow ${s.key ? '' : 'none'}`} aria-pressed={active} title={s.names.join(', ')} onClick={() => setFocus(active ? undefined : { dim, key: s.key })}>
              <span class="wl">{keyLabel(dim, s.key)}</span>
              <span class="wt">
                <span class="wf" style={`width:${((s.weight / max) * 100).toFixed(1)}%`} />
              </span>
              <span class="wv">{pct(s.weight)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Morningstar-style 3×3 box (size × style); darker = more weight. */
function StyleBox({ rows, focus, setFocus }: { rows: IndicatorRow[]; focus: Focus; setFocus: (f: Focus) => void }) {
  const slices = new Map(breakdown(rows, keyOf.box).map((s) => [s.key, s]));
  const max = Math.max(...[...slices.values()].filter((s) => s.key).map((s) => s.weight), 1e-9);
  const none = slices.get('');
  const cell = (key: string) => {
    const s = slices.get(key);
    const w = s?.weight ?? 0;
    const active = focus?.dim === 'box' && focus.key === key;
    const strength = w > 0 ? 14 + (72 * w) / max : 0;
    return (
      <td>
        <button
          type="button"
          class="boxcell"
          disabled={!s}
          aria-pressed={active}
          aria-label={`${boxLabel(key)}: ${pct(w)}`}
          title={s ? `${boxLabel(key)}: ${s.names.join(', ')}` : boxLabel(key)}
          style={`background:color-mix(in srgb, var(--s1) ${strength.toFixed(0)}%, var(--surface-2));color:${strength > 50 ? '#fff' : 'var(--ink)'}`}
          onClick={() => setFocus(active ? undefined : { dim: 'box', key })}
        >
          {s ? pct(w, 0) : ''}
        </button>
      </td>
    );
  };
  return (
    <div class="wpanel">
      <h3>Estilo (Morningstar)</h3>
      <table class="stylebox">
        <thead>
          <tr>
            <th />
            {Object.values(STYLE).map((s) => (
              <th scope="col">{s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.keys(CAP).map((c) => (
            <tr>
              <th scope="row">{CAP[c]}</th>
              {Object.keys(STYLE).map((s) => cell(`${c}|${s}`))}
            </tr>
          ))}
        </tbody>
      </table>
      {none && (
        <button type="button" class="link small" aria-pressed={focus?.dim === 'box' && focus.key === ''} onClick={() => setFocus(focus?.dim === 'box' && focus.key === '' ? undefined : { dim: 'box', key: '' })}>
          Sin estilo: {pct(none.weight)} ({none.names.length})
        </button>
      )}
    </div>
  );
}

function Upside({ t, u, ccy }: { t?: Decimal; u?: number; ccy: string }) {
  if (!t) return <span class="muted">—</span>;
  return (
    <>
      {price(t, ccy)}
      <div class={`small ${u !== undefined && u < 0 ? "muted" : sign(u)}`}>{u === undefined ? 'sin precio' : u >= 0 ? `+${pct(u, 0)}` : `superado (${pct(u, 0)})`}</div>
    </>
  );
}

const PCT_FIELDS = [
  ['salesGrowth5y', 'Crec. ventas 5 años'],
  ['ebitdaMargin', 'Margen EBITDA'],
  ['netMargin', 'Margen neto'],
  ['roic', 'ROIC'],
  ['roe', 'ROE'],
  ['debtToCapital', 'Deuda / capital'],
] as const;
const NUM_FIELDS = [
  ['pe', 'P/E'],
  ['evEbitda', 'EV/EBITDA'],
  ['eps', 'EPS'],
  ['netDebt', 'Deuda neta (millones)'],
] as const;
type PctKey = (typeof PCT_FIELDS)[number][0];
type NumKey = (typeof NUM_FIELDS)[number][0];

const ms = (a: Asset) => a.moats?.find((m) => m.source === 'Morningstar');
const gf = (a: Asset) => a.moats?.find((m) => m.source === 'GuruFocus');

/** Each provider's moat rating on its own line, linked to where it was published. */
function Moats({ ratings }: { ratings: MoatRating[] }) {
  if (!ratings.length) return <span class="muted small">sin calificación</span>;
  return (
    <div class="moats">
      {ratings.map((m) => (
        <div class="small" title={`${m.source}, ${date(m.asOf)}${m.note ? ` · ${m.note}` : ''}`}>
          {m.url ? (
            <a href={m.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              {m.source}
            </a>
          ) : (
            m.source
          )}{' '}
          <strong class={`moat-${m.rating ?? 'score'}`}>{m.rating ? MOAT[m.rating] : ''}{m.rating && m.score !== undefined ? ' · ' : ''}{m.score !== undefined ? `${m.score}/10` : ''}</strong>
        </div>
      ))}
    </div>
  );
}

function initial(a: Asset): Record<string, string> {
  const f = a.fundamentals ?? {};
  const s: Record<string, string> = {
    target: a.target ?? '',
    targetHigh: a.targetHigh ?? '',
    strategy: a.strategy ?? '',
    region: a.region ?? '',
    ideaSource: a.ideaSource ?? '',
    note: a.note ?? '',
    cap: f.cap ?? '',
    style: f.style ?? '',
    msRating: ms(a)?.rating ?? '',
    msAsOf: ms(a)?.asOf ?? '',
    msUrl: ms(a)?.url ?? '',
    gfScore: gf(a)?.score !== undefined ? String(gf(a)!.score) : '',
    gfAsOf: gf(a)?.asOf ?? '',
    gfUrl: gf(a)?.url ?? '',
    stars: f.stars ? String(f.stars) : '',
    asOf: f.asOf ?? '',
    source: f.source ?? '',
  };
  for (const [k] of PCT_FIELDS) s[k] = f[k] !== undefined ? new Decimal(f[k]!).times(100).toString() : '';
  for (const [k] of NUM_FIELDS) s[k] = f[k] ?? '';
  return s;
}

/** Everything the Indicadores sheet held per stock, editable in one place and saved on the asset. */
function ThesisForm({ asset, lists, onDone }: { asset: Asset; lists: Record<'strategy' | 'region' | 'ideaSource', string[]>; onDone: () => void }) {
  const [st, setSt] = useState(() => initial(asset));
  const [err, setErr] = useState<string>();
  const up = (k: string) => (e: Event) => setSt({ ...st, [k]: (e.target as HTMLInputElement).value });
  const text = (k: string, label: string, list?: string) => (
    <label>
      {label}
      <input value={st[k]} list={list} onInput={up(k)} />
    </label>
  );
  const num = (k: string, label: string) => (
    <label>
      {label}
      <input inputMode="decimal" value={st[k]} onInput={up(k)} />
    </label>
  );
  const choice = (k: string, label: string, opts: Record<string, string>) => (
    <label>
      {label}
      <select value={st[k]} onChange={up(k)}>
        <option value="">—</option>
        {Object.entries(opts).map(([v, l]) => (
          <option value={v}>{l}</option>
        ))}
      </select>
    </label>
  );

  async function save(e: Event) {
    e.preventDefault();
    const read = (k: string, label: string) => {
      try {
        return parseNumber(st[k] ?? '');
      } catch {
        throw new Error(`${label}: "${st[k]}" no es un número`);
      }
    };
    try {
      const target = read('target', 'Precio objetivo');
      const targetHigh = read('targetHigh', 'Precio optimista');
      if ((target && !target.gt(0)) || (targetHigh && !targetHigh.gt(0))) throw new Error('Los precios objetivo deben ser mayores que cero');
      if (target && targetHigh && targetHigh.lt(target)) throw new Error('El precio optimista no puede ser menor que el objetivo');
      const f: Fundamentals = {};
      for (const [k, label] of PCT_FIELDS) {
        const v = read(k, label);
        if (v) f[k as PctKey] = v.div(100).toString();
      }
      for (const [k, label] of NUM_FIELDS) {
        const v = read(k, label);
        if (v) f[k as NumKey] = v.toString();
      }
      if (st.cap) f.cap = st.cap as Fundamentals['cap'];
      if (st.style) f.style = st.style as Fundamentals['style'];
      const moats: MoatRating[] = (asset.moats ?? []).filter((m) => m.source !== 'Morningstar' && m.source !== 'GuruFocus');
      if (st.msRating) {
        if (!st.msAsOf) throw new Error('Pon la fecha de la calificación de Morningstar');
        moats.unshift({ source: 'Morningstar', rating: st.msRating as MoatRating['rating'], asOf: st.msAsOf, ...(st.msUrl?.trim() ? { url: st.msUrl.trim() } : {}) });
      }
      if (st.gfScore) {
        const score = Number(st.gfScore.replace(',', '.'));
        if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error('El Moat Score de GuruFocus va de 0 a 10');
        if (!st.gfAsOf) throw new Error('Pon la fecha del Moat Score de GuruFocus');
        moats.push({ source: 'GuruFocus', score, asOf: st.gfAsOf, ...(st.gfUrl?.trim() ? { url: st.gfUrl.trim() } : {}) });
      }
      if (st.stars) f.stars = Number(st.stars);
      if (st.asOf) f.asOf = st.asOf;
      if (st.source?.trim()) f.source = st.source.trim();
      const d = getDataset();
      const a = d.assets.find((x) => x.id === asset.id)!;
      const { target: _1, targetHigh: _2, strategy: _3, region: _4, ideaSource: _5, note: _6, fundamentals: _7, moats: _8, ...rest } = a;
      const opt = (k: string, v: string | undefined) => (v?.trim() ? { [k]: v.trim() } : {});
      await setDataset(
        upsertAsset(d, {
          ...rest,
          ...(target ? { target: target.toString() } : {}),
          ...(targetHigh ? { targetHigh: targetHigh.toString() } : {}),
          ...opt('strategy', st.strategy),
          ...opt('region', st.region),
          ...opt('ideaSource', st.ideaSource),
          ...opt('note', st.note),
          ...(Object.keys(f).length ? { fundamentals: f } : {}),
          ...(moats.length ? { moats } : {}),
        }),
      );
      onDone();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    }
  }

  return (
    <form class="thesis" onSubmit={save} aria-label={`Tesis de ${asset.name}`}>
      <fieldset>
        <legend>Tesis</legend>
        {num('target', `Precio objetivo (${asset.ccy})`)}
        {num('targetHigh', `Precio optimista (${asset.ccy})`)}
        {text('strategy', 'Estrategia', 'ind-strategy')}
        {text('region', 'Mercado', 'ind-region')}
        {text('ideaSource', 'Fuente de la idea', 'ind-ideaSource')}
        <label class="wide">
          Comentarios
          <textarea rows={3} value={st.note} onInput={up('note')} />
        </label>
      </fieldset>
      <fieldset>
        <legend>Foso económico según fuentes externas</legend>
        {choice('msRating', 'Morningstar', MOAT)}
        <label>
          Fecha (Morningstar)
          <input type="date" value={st.msAsOf} onInput={up('msAsOf')} />
        </label>
        {text('msUrl', 'Enlace (Morningstar)')}
        {num('gfScore', 'GuruFocus Moat Score (0–10)')}
        <label>
          Fecha (GuruFocus)
          <input type="date" value={st.gfAsOf} onInput={up('gfAsOf')} />
        </label>
        {text('gfUrl', 'Enlace (GuruFocus)')}
      </fieldset>
      <fieldset>
        <legend>Morningstar y fundamentales</legend>
        {choice('cap', 'Tamaño', CAP)}
        {choice('style', 'Estilo', STYLE)}
        {choice('stars', 'Estrellas', { 1: '★', 2: '★★', 3: '★★★', 4: '★★★★', 5: '★★★★★' })}
        {PCT_FIELDS.map(([k, l]) => num(k, `${l} (%)`))}
        {NUM_FIELDS.map(([k, l]) => num(k, l))}
        <label>
          Datos al
          <input type="date" value={st.asOf} onInput={up('asOf')} />
        </label>
        {text('source', 'Fuente de los datos')}
      </fieldset>
      {(['strategy', 'region', 'ideaSource'] as const).map((k) => (
        <datalist id={`ind-${k}`}>
          {lists[k].map((v) => (
            <option value={v} />
          ))}
        </datalist>
      ))}
      <div class="actions">
        <button type="submit" class="primary">
          Guardar
        </button>
        <button type="button" onClick={onDone}>
          Cancelar
        </button>
        {err && (
          <span class="small neg" role="alert">
            {err}
          </span>
        )}
      </div>
    </form>
  );
}

export function Indicators() {
  const { data } = useDataset();
  const [f, set] = useFilters();
  const ctx = contextOf(data);
  const [scope, setScope] = usePref<string>('ind:scope', 'acciones');
  const [view, setView] = usePref<View>('ind:view', 'tesis');
  const [sort, setSort] = usePref<Sort>('ind:sort', 'weight');
  const [focus, setFocus] = useState<Focus>();
  const [open, setOpen] = useState<string | undefined>(() => queryParam('accion'));

  const present = useMemo(() => [...new Set(data.assets.map((a) => a.bucket))], [data]);
  const buckets = scope === 'acciones' ? present.filter((b) => b.startsWith('acciones')) : scope === 'all' ? present : [scope];
  const rows = useMemo(() => indicatorRows(ctx, f.ccy, f.asOf, buckets), [ctx, f.ccy, f.asOf, buckets.join()]);
  const lists = useMemo(() => {
    const vals = (k: 'strategy' | 'region' | 'ideaSource') => [...new Set(data.assets.map((a) => a[k]).filter((v): v is string => !!v))].sort();
    return { strategy: vals('strategy'), region: vals('region'), ideaSource: vals('ideaSource') };
  }, [data]);

  useEffect(() => {
    const id = queryParam('accion');
    if (id) document.getElementById(`ind-${id}`)?.scrollIntoView({ block: 'center' });
  }, []);

  const total = rows.reduce((s, r) => s.plus(r.value), new Decimal(0));
  const shown = rows
    .filter((r) => !focus || (keyOf[focus.dim](r) ?? '') === focus.key)
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      const v = (r: IndicatorRow) => (sort === 'weight' ? r.weight : r[sort] ?? -Infinity);
      return v(b) - v(a) || a.name.localeCompare(b.name);
    });
  const base = weightedUpside(rows, 'upside');
  const high = weightedUpside(rows, 'upsideHigh');
  const conc = concentration(rows);
  const top = rows[0];
  const undated = rows.filter((r) => hasFundamentals(r.f) && !r.f.asOf);
  const cols = view === 'tesis' ? 12 : 13;

  return (
    <>
      <Filters state={f} set={set} showWindow={false}>
        <label>
          Portafolio
          <select value={scope} onChange={(e) => (setScope((e.target as HTMLSelectElement).value), setFocus(undefined))}>
            <option value="acciones">Acciones (COP y USD)</option>
            {present.map((b) => (
              <option value={b}>{bucketLabel(b)}</option>
            ))}
            <option value="all">Todo (sin efectivo)</option>
          </select>
        </label>
        <label>
          Ordenar por
          <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)}>
            <option value="weight">Peso</option>
            <option value="upside">Potencial al objetivo</option>
            <option value="upsideHigh">Potencial al optimista</option>
            <option value="name">Nombre</option>
          </select>
        </label>
      </Filters>

      <div class="tiles">
        <div class="tile">
          <div>
            <div class="label">Posiciones</div>
            <div class="value">{rows.length}</div>
            <div class="sub">
              {moneyShort(total, f.ccy)} al {date(f.asOf)}
            </div>
          </div>
        </div>
        <div class="tile">
          <div>
            <div class="label">Mayor posición</div>
            <div class="value">{top ? pct(top.weight) : '—'}</div>
            <div class="sub">{top ? `${top.name} · ${moneyShort(top.value, f.ccy)}` : ''}</div>
          </div>
        </div>
        <div class="tile">
          <div>
            <div class="label">Concentración</div>
            <div class="value">{pct(conc.top5, 0)}</div>
            <div class="sub" title="1 / Σ peso²: cuántas posiciones iguales darían la misma concentración">
              en las 5 mayores · equivale a {conc.effective ? Math.round(conc.effective) : '—'} posiciones iguales
            </div>
          </div>
        </div>
        <div class="tile">
          <div>
            <div class="label">Potencial ponderado</div>
            <div class={`value ${sign(base.upside)}`}>{base.upside === undefined ? '—' : `${base.upside >= 0 ? '+' : ''}${pct(base.upside, 0)}`}</div>
            <div class="sub" title="Promedio por peso de objetivo / precio − 1, solo sobre las acciones con objetivo y precio">
              al objetivo, sobre el {pct(base.coverage, 0)} del valor · optimista {high.upside === undefined ? '—' : `${high.upside >= 0 ? '+' : ''}${pct(high.upside, 0)}`} sobre el {pct(high.coverage, 0)}
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Composición</h2>
          <span class="small muted">Peso sobre el valor de {scope === 'acciones' ? 'tus acciones' : scope === 'all' ? 'tus inversiones' : bucketLabel(scope)} · clic en una barra para filtrar la tabla</span>
        </div>
        <div class="composition">
          {(['region', 'strategy', 'ideaSource', 'moat'] as const).map((d) => (
            <WeightBars dim={d} slices={breakdown(rows, keyOf[d])} focus={focus} setFocus={setFocus} />
          ))}
          <StyleBox rows={rows} focus={focus} setFocus={setFocus} />
        </div>
      </div>

      <WeightVsUpside rows={rows} ccy={f.ccy} />

      <div class="card">
        <div class="card-head">
          <h2>Indicadores por acción</h2>
          <div class="seg" role="group" aria-label="Columnas">
            <button type="button" aria-pressed={view === 'tesis'} onClick={() => setView('tesis')}>
              Tesis y potencial
            </button>
            <button type="button" aria-pressed={view === 'fundamentales'} onClick={() => setView('fundamentales')}>
              Fundamentales
            </button>
          </div>
        </div>
        {focus && (
          <div class="notice info cta">
            <span>
              Filtrado por {DIM_LABEL[focus.dim].toLowerCase()}: <strong>{keyLabel(focus.dim, focus.key)}</strong> ({shown.length} de {rows.length})
            </span>
            <button type="button" onClick={() => setFocus(undefined)}>
              Quitar filtro
            </button>
          </div>
        )}
        {undated.length > 0 && view === 'fundamentales' && (
          <div class="notice warn" role="status">
            Fundamentales sin fecha: {undated.map((r) => r.name).join(', ')}. Ábrelos y completa «Datos al» para saber qué tan vigentes son.
          </div>
        )}
        <div class="table-wrap">
          <table class="prices ind">
            <thead>
              <tr>
                <th>Acción</th>
                <th class="n">Peso</th>
                {view === 'tesis' ? (
                  <>
                    <th>Mercado</th>
                    <th>Fuente</th>
                    <th>Estrategia</th>
                    <th>Estilo</th>
                    <th>Foso económico</th>
                    <th class="n">Estrellas</th>
                    <th class="n">Precio hoy</th>
                    <th class="n">Objetivo</th>
                    <th class="n">Optimista</th>
                  </>
                ) : (
                  <>
                    <th class="n">Crec. ventas 5a</th>
                    <th class="n">Margen EBITDA</th>
                    <th class="n">Margen neto</th>
                    <th class="n">ROIC</th>
                    <th class="n">ROE</th>
                    <th class="n">P/E</th>
                    <th class="n">EV/EBITDA</th>
                    <th class="n">EPS</th>
                    <th class="n">Deuda / capital</th>
                    <th class="n">Deuda neta (M)</th>
                  </>
                )}
                <th>{view === 'tesis' ? 'Notas' : 'Datos al'}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const isOpen = open === r.asset;
                const toggle = () => setOpen(isOpen ? undefined : r.asset);
                return (
                  <>
                    <tr id={`ind-${r.asset}`} class={`stock ${isOpen ? 'open' : ''}`} key={r.asset} onClick={toggle}>
                      <td>
                        <button type="button" class="rowtoggle" aria-expanded={isOpen} onClick={(e) => (e.stopPropagation(), toggle())}>
                          <span class="caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                          <strong>{r.name}</strong>
                        </button>
                        <div class="small muted">
                          {r.symbol && r.symbol.split('.')[0] !== r.name ? `${r.symbol} · ` : ''}
                          {r.accounts.join(', ')}
                          {r.method === 'manual' && ' · valor manual'}
                        </div>
                      </td>
                      <td class="n">
                        <span class="wcell">
                          <span class="wbar" style={`width:${Math.max(2, r.weight * 160).toFixed(0)}px;background:var(--s1)`} />
                          {pct(r.weight)}
                        </span>
                        <div class="small muted">{moneyShort(r.value, f.ccy)}</div>
                      </td>
                      {view === 'tesis' ? (
                        <>
                          <td>{r.region ?? <span class="muted">—</span>}</td>
                          <td>{r.ideaSource ?? <span class="muted">—</span>}</td>
                          <td>{r.strategy ? <span class="chip tag flush">{r.strategy}</span> : <span class="muted">—</span>}</td>
                          <td>
                            {r.f.cap || r.f.style ? `${r.f.cap ? CAP[r.f.cap] : '—'} · ${r.f.style ? STYLE[r.f.style] : '—'}` : <span class="muted">—</span>}
                          </td>
                          <td>
                            <Moats ratings={r.moats} />
                          </td>
                          <td class="n stars" aria-label={r.f.stars ? `${r.f.stars} estrellas` : 'sin estrellas'}>
                            {r.f.stars ? '★'.repeat(r.f.stars) : <span class="muted">—</span>}
                          </td>
                          <td class="n">{r.price ? price(r.price.close, r.ccy) : <span class="muted">{r.method === 'manual' ? 'manual' : '—'}</span>}</td>
                          <td class="n">
                            <Upside t={r.target} u={r.upside} ccy={r.ccy} />
                          </td>
                          <td class="n">
                            <Upside t={r.targetHigh} u={r.upsideHigh} ccy={r.ccy} />
                          </td>
                          <td class="note-cell">{r.note ? <span class="small" title={r.note}>{r.note.split('\n')[0]}</span> : <span class="muted">—</span>}</td>
                        </>
                      ) : (
                        <>
                          {(['salesGrowth5y', 'ebitdaMargin', 'netMargin', 'roic', 'roe'] as const).map((k) => (
                            <td class={`n ${sign(dec(r.f[k]))}`}>{pct(dec(r.f[k]))}</td>
                          ))}
                          <td class="n">{multiple(r.f.pe)}</td>
                          <td class="n">{multiple(r.f.evEbitda)}</td>
                          <td class="n">{plain(r.f.eps)}</td>
                          <td class="n">{pct(dec(r.f.debtToCapital))}</td>
                          <td class="n">{plain(r.f.netDebt, 0)}</td>
                          <td class="small">{r.f.asOf ? date(r.f.asOf) : hasFundamentals(r.f) ? <span class="stale">sin fecha</span> : <span class="muted">—</span>}</td>
                        </>
                      )}
                    </tr>
                    {isOpen && (
                      <tr class="detail">
                        <td colSpan={cols}>
                          <ThesisForm asset={ctx.book.assets.get(r.asset)!} lists={lists} onDone={() => setOpen(undefined)} />
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
          Peso sobre el valor al {date(f.asOf)} en {f.ccy} (cada acción sumando todas sus cuentas). Potencial = objetivo / precio de hoy − 1, en la moneda de la acción. Potencial ponderado: promedio por peso de
          las acciones con objetivo y precio. Foso económico: la calificación que publica cada fuente (Morningstar: amplio, estrecho o ninguno; GuruFocus: Moat Score de 0 a 10), con su fecha y enlace; la composición usa la de Morningstar (u otra fuente con categoría si Morningstar no la califica). Estilo, estrellas y fundamentales son datos que copias a mano: guárdalos con su fecha y fuente. Valor exacto del portafolio:{' '}
          {money(total, f.ccy)}.
        </p>
      </div>
    </>
  );
}

const signedPct = (x: number, digits = 0) => `${x > 0 ? '+' : ''}${pct(x, digits)}`;

/** Each stock with a target: its weight against its potential to the base target, to spot big positions with little upside. */
function WeightVsUpside({ rows, ccy }: { rows: IndicatorRow[]; ccy: string }) {
  const withTarget = rows.filter((r) => r.upside !== undefined);
  if (withTarget.length < 2) return null;
  const named = new Set([...withTarget].sort((a, b) => b.weight - a.weight).slice(0, 6).map((r) => r.asset));
  const low = withTarget.filter((r) => r.upside! < 0.1);
  const lowWeight = low.reduce((s, r) => s + r.weight, 0);
  return (
    <div class="card">
      <div class="card-head">
        <h2>Peso frente a potencial</h2>
        <span class="small muted">{withTarget.length} acciones con objetivo y precio · arriba a la izquierda: mucho peso y poco potencial</span>
      </div>
      {low.length > 0 && (
        <p class="insight">
          El <strong>{pct(lowWeight, 0)}</strong> de este portafolio está en {low.length === 1 ? 'una acción' : `${low.length} acciones`} con menos de 10 % de potencial a su objetivo o que ya lo superaron: {low.map((r) => r.symbol ?? r.name).join(', ')}.
        </p>
      )}
      <Scatter
        points={withTarget.map((r) => ({
          id: r.asset,
          label: r.symbol ?? r.name,
          x: r.upside!,
          y: r.weight,
          named: named.has(r.asset),
          lines: [`${r.name}`, `Peso ${pct(r.weight)} · ${moneyShort(r.value, ccy)}`, `Potencial al objetivo ${signedPct(r.upside!, 1)}`, ...(r.strategy ? [`Estrategia: ${r.strategy}`] : [])],
        }))}
        xLabel="Potencial al objetivo"
        yLabel="Peso en el portafolio"
        xFormat={(v) => signedPct(v)}
        yFormat={(v) => pct(v, 0)}
        xRef={0}
        label="Peso de cada acción frente a su potencial al objetivo"
      />
    </div>
  );
}
