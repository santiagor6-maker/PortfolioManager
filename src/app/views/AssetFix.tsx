import { useState } from 'preact/hooks';
import type { StoredPrice } from '../../data/json.ts';
import { YAHOO_SYMBOL } from '../../data/quotes.ts';
import type { Asset } from '../../domain/types.ts';
import { bucketLabel } from '../analysis.ts';
import { checkPriceRows } from '../checks.ts';
import type { Finding } from '../checks.ts';
import { today } from '../format.ts';
import { upsertAsset } from '../mutations.ts';
import { MANUAL_SOURCE } from '../refresh.ts';
import { getDataset, setDataset, useDataset } from '../store.ts';
import { parseNum } from '../trade.ts';


/** The last month-end on or before `d`. */
function lastMonthEnd(d: string): string {
  const [y, m] = d.split('-').map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return end <= d ? end : new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
}

/**
 * Acciones COP holds the stocks listed on the Bolsa de Valores de Colombia; everything listed abroad, ETFs of other
 * countries included, goes in Acciones USD. A hint when a market asset without the Colombian suffix is put in COP.
 */
export function ClassHint({ bucket, symbol, pricing }: { bucket: string; symbol: string; pricing: Asset['pricing'] }) {
  if (bucket !== 'acciones_cop' || pricing !== 'market' || !symbol || symbol.endsWith('.CL')) return null;
  return <span class="small warn-ink">{bucketLabel('acciones_cop')} es para las acciones de la Bolsa de Colombia (símbolo con .CL). Las del exterior, incluidos los ETF de otros países, van en {bucketLabel('acciones_usd')} aunque las compres en pesos.</span>;
}

/** Fix how an asset is quoted: Yahoo symbol, quote currency, name and class. Its movements are not touched. */
export function AssetEditor({ asset, onDone }: { asset: Asset; onDone: () => void }) {
  const { data } = useDataset();
  const [a, setA] = useState<Asset>(asset);
  const [msg, setMsg] = useState<string>();
  const buckets = [...new Set(['acciones_cop', 'acciones_usd', 'cripto', 'fondos', 'inmobiliario', 'renta_fija', ...data.assets.map((x) => x.bucket)])];
  const symbol = (a.symbol ?? '').trim();
  const stored = asset.symbol ? data.prices.filter((p) => p.symbol === asset.symbol).length : 0;

  async function save(e: Event) {
    e.preventDefault();
    if (!a.name.trim()) return setMsg('Escribe el nombre');
    if (!/^[A-Z]{3}$/.test(a.ccy)) return setMsg('La moneda de cotización es un código de 3 letras (USD, EUR, CAD, COP…)');
    if (a.pricing === 'market' && !YAHOO_SYMBOL.test(symbol)) return setMsg('Escribe el símbolo como en Yahoo Finance (p. ej. AAPL, IWDA.AS, ECOPETROL.CL)');
    // A symbol's series is in one currency: its stored closes and any other asset quoted with it must agree.
    const d = getDataset();
    const other = d.prices.find((p) => p.symbol === symbol && p.ccy !== a.ccy)?.ccy ?? d.assets.find((x) => x.id !== a.id && x.symbol === symbol && x.ccy !== a.ccy)?.ccy;
    if (a.pricing === 'market' && other)
      return setMsg(`${symbol} ya tiene precios en ${other}: no puede cotizar en ${a.ccy}. Para otra moneda usa el símbolo de la bolsa que cotiza en ella (p. ej. con su sufijo).`);
    await setDataset(upsertAsset(getDataset(), { ...a, name: a.name.trim(), symbol: a.pricing === 'market' ? symbol : undefined }));
    onDone();
  }

  return (
    <form class="asset-fix" onSubmit={save} aria-label={`Corregir ${asset.name}`}>
      <div class="form-grid">
        <label class="field">
          Nombre
          <input value={a.name} onInput={(e) => setA({ ...a, name: (e.target as HTMLInputElement).value })} />
        </label>
        <label class="field">
          Símbolo de Yahoo Finance
          <input value={a.symbol ?? ''} placeholder="p. ej. AAPL, IWDA.AS, ECOPETROL.CL" onInput={(e) => setA({ ...a, symbol: (e.target as HTMLInputElement).value.toUpperCase() })} />
          {a.ccy !== 'USD' && !symbol.includes('.') && !symbol.includes('-') && (
            <span class="small warn-ink">Fuera de EE. UU. lleva el sufijo de la bolsa: .DE Xetra, .PA París, .AS Ámsterdam, .TO Toronto, .CL Colombia.</span>
          )}
        </label>
        <label class="field">
          Moneda de cotización
          <input value={a.ccy} maxLength={3} onInput={(e) => setA({ ...a, ccy: (e.target as HTMLInputElement).value.toUpperCase() })} />
        </label>
        <label class="field">
          Clase
          <select value={a.bucket} onChange={(e) => setA({ ...a, bucket: (e.target as HTMLSelectElement).value })}>
            {buckets.map((b) => (
              <option value={b}>{bucketLabel(b)}</option>
            ))}
          </select>
          <ClassHint bucket={a.bucket} symbol={symbol} pricing={a.pricing} />
        </label>
      </div>
      {stored > 0 && symbol !== asset.symbol && (
        <p class="small warn-ink">Los {stored} precios guardados con {asset.symbol} se quedan con ese símbolo: con el nuevo, los precios empiezan de cero (desde la primera compra).</p>
      )}
      {msg && (
        <div class="notice err" role="alert">
          {msg}
        </div>
      )}
      <div class="actions">
        <button type="submit" class="primary">
          Guardar
        </button>
        <button type="button" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

/**
 * A close typed by hand, for a day the sources do not have (a new symbol, a delisted stock): stored with its date and
 * `manual (usuario)` as its source, through the same checks as an imported price. It replaces a stored one only on
 * confirmation.
 */
export function ManualPrice({ asset, onDone }: { asset: Asset; onDone: () => void }) {
  const [day, setDay] = useState(lastMonthEnd(today()));
  const [close, setClose] = useState('');
  const [found, setFound] = useState<Finding[]>([]);
  const [confirm, setConfirm] = useState(false);
  const symbol = asset.symbol ?? asset.id;

  async function save(e: Event) {
    e.preventDefault();
    const value = parseNum(close, asset.ccy);
    if (!value) {
      setFound([{ level: 'error', code: 'CLOSE', ref: '', message: 'Escribe el precio' }]);
      return;
    }
    const row: StoredPrice = { symbol, date: day, close: value.toFixed(), ccy: asset.ccy, source: MANUAL_SOURCE };
    const d = getDataset();
    // The same close already stored: nothing to do, and its source (a quote) is kept.
    if (d.prices.some((p) => p.symbol === symbol && p.date === day && value.eq(p.close))) {
      setFound([{ level: 'warning', code: 'SAME', ref: '', message: `Ese cierre ya está guardado (${d.prices.find((p) => p.symbol === symbol && p.date === day)!.source}); no se cambia nada.` }]);
      setConfirm(false);
      return;
    }
    const f = checkPriceRows(d, [row], today());
    if (f.some((x) => x.level === 'error') || (f.length && !confirm)) {
      setFound(f);
      setConfirm(!f.some((x) => x.level === 'error'));
      return;
    }
    await setDataset({ ...d, prices: [...d.prices.filter((p) => !(p.symbol === symbol && p.date === day)), row] });
    onDone();
  }

  return (
    <form class="asset-fix" onSubmit={save} aria-label={`Precio a mano de ${asset.name}`}>
      <div class="form-grid">
        <label class="field">
          Fecha del cierre
          <input type="date" value={day} max={today()} onInput={(e) => (setDay((e.target as HTMLInputElement).value), setConfirm(false), setFound([]))} />
        </label>
        <label class="field">
          Precio de cierre ({asset.ccy})
          <input inputMode="decimal" value={close} onInput={(e) => (setClose((e.target as HTMLInputElement).value), setConfirm(false), setFound([]))} />
          <span class="small muted">El del extracto o la plataforma del bróker ese día. Queda guardado como «{MANUAL_SOURCE}».</span>
        </label>
      </div>
      {found.length > 0 && (
        <div class={`notice ${found.some((x) => x.level === 'error') ? 'err' : 'warn'}`} role="alert">
          <ul>
            {found.map((x) => (
              <li>{x.message}</li>
            ))}
          </ul>
          {confirm && <p style="margin:6px 0 0">Revisa y vuelve a guardar para confirmar.</p>}
        </div>
      )}
      <div class="actions">
        <button type="submit" class="primary">
          {confirm ? 'Guardar de todos modos' : 'Guardar precio'}
        </button>
        <button type="button" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
