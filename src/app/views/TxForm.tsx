import { useMemo, useState } from 'preact/hooks';
import { holdingsAt } from '../../domain/holdings.ts';
import { positionKey } from '../../domain/ledger.ts';
import { dec } from '../../domain/money.ts';
import type { Decimal } from '../../domain/money.ts';
import type { Asset, Transaction, TxType } from '../../domain/types.ts';
import { validateTransaction } from '../../domain/validate.ts';
import type { Issue } from '../../domain/validate.ts';
import { bucketLabel } from '../analysis.ts';
import { contextOf } from '../context.ts';
import { date, money, num, today } from '../format.ts';
import { TYPE_LABELS } from '../labels.ts';
import { editablePrice, field, impliedPrice, parseNum, tradeTotal } from '../trade.ts';
import { addTransactions, newId, replaceTransactions, upsertAsset } from '../mutations.ts';
import { getDataset, setDataset, useDataset } from '../store.ts';

type Kind = TxType | 'TRANSFER';
const CREATE_KINDS: Kind[] = ['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'INTEREST', 'FEE', 'TAX', 'WRITE_OFF', 'CAPITAL_CALL', 'COMMITMENT', 'VALUATION'];
const WITH_ASSET = new Set<Kind>(['BUY', 'SELL', 'DIVIDEND', 'WRITE_OFF', 'CAPITAL_CALL', 'COMMITMENT', 'VALUATION']);
const WITH_QTY = new Set<Kind>(['BUY', 'SELL', 'WRITE_OFF']);
const NEGATIVE = new Set<Kind>(['BUY', 'WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX', 'CAPITAL_CALL', 'COMMITMENT']);
const NEW = '__new__';
/** Buys and sells are entered as units × price per unit (+ or − the fee); the total can still be typed from the statement. */
const PRICED = new Set<Kind>(['BUY', 'SELL']);

const AMOUNT_LABEL: Partial<Record<Kind, string>> = {
  BUY: 'Total pagado (incluye comisión)',
  SELL: 'Total recibido (neto de comisión)',
  DIVIDEND: 'Dividendo neto recibido',
  VALUATION: 'Valor de mercado a la fecha',
  COMMITMENT: 'Precio total del contrato',
  CAPITAL_CALL: 'Valor pagado',
  TRANSFER: 'Monto que sale',
};

interface Draft {
  kind: Kind;
  date: string;
  account: string;
  asset: string;
  qty: string;
  /** Price per unit in the account's currency, before the fee. */
  price: string;
  /** `unit`: the total is units × price ± fee; `total`: the total is typed (statement figure, or an asset without units). */
  mode: 'unit' | 'total';
  amount: string;
  fee: string;
  note: string;
  estimated: boolean;
  toBank: boolean;
  external: boolean;
  toAccount: string;
  amountIn: string;
  newAsset: Asset;
}

export function TxForm({ editing, onDone }: { editing?: Transaction; onDone: () => void }) {
  const { data } = useDataset();
  const ctx = contextOf(data);
  const accounts = data.accounts;
  const [d, setD] = useState<Draft>(() => {
    // An edited buy or sale opens as units × price only when that gives back its stored total to the cent.
    const price = editing ? editablePrice(editing) : undefined;
    return {
    kind: editing?.type ?? 'BUY',
    date: editing?.date ?? today(),
    account: editing?.account ?? accounts[0]?.id ?? '',
    asset: editing?.asset ?? '',
    qty: editing?.qty ? field(editing.qty) : '',
    price: price ? field(price) : '',
    mode: editing && !price ? 'total' : 'unit',
    amount: editing ? field(editing.amount.abs()) : '',
    fee: editing?.fee ? field(editing.fee) : '',
    note: editing?.note ?? '',
    estimated: editing?.estimated ?? false,
    toBank: true,
    external: true,
    toAccount: accounts[1]?.id ?? '',
    amountIn: '',
    newAsset: { id: '', name: '', ccy: 'USD', bucket: 'acciones_usd', pricing: 'market', symbol: '' },
    };
  });
  const [issues, setIssues] = useState<Issue[]>([]);
  const [confirmWarnings, setConfirmWarnings] = useState(false);
  const up = (p: Partial<Draft>) => {
    setD({ ...d, ...p });
    setIssues([]);
    setConfirmWarnings(false);
  };

  const account = data.accounts.find((a) => a.id === d.account);
  const buckets = [...new Set(['acciones_cop', 'acciones_usd', 'cripto', 'fondos', 'inmobiliario', 'renta_fija', ...data.assets.map((a) => a.bucket)])];
  const held = useMemo(() => {
    try {
      return holdingsAt(ctx.ledger.filter((t) => t.id !== editing?.id), d.date);
    } catch {
      return undefined;
    }
  }, [ctx, d.date, editing?.id]);
  const inAccount = (openOnly: boolean) =>
    data.assets.filter((a) => {
      const p = held?.positions.get(positionKey(d.account, a.id));
      return p && (!openOnly || p.open);
    });
  const assetChoices = editing || d.kind === 'BUY' || d.kind === 'COMMITMENT' ? data.assets : inAccount(d.kind !== 'DIVIDEND');
  const pos = d.asset && held ? held.positions.get(positionKey(d.account, d.asset)) : undefined;
  const ccy = account?.ccy ?? '';
  const qtyN = parseNum(d.qty, ccy);
  const priceN = parseNum(d.price, ccy);
  const feeN = parseNum(d.fee, ccy);
  const amountN = parseNum(d.amount, ccy);
  const computed = PRICED.has(d.kind) && qtyN && priceN ? tradeTotal(d.kind, qtyN, priceN, feeN) : undefined;
  const assetOf = (id: string) => (id === NEW ? d.newAsset : data.assets.find((a) => a.id === id));
  const chosen = d.asset ? assetOf(d.asset) : undefined;
  // The stored close of that day, as a check on the price typed (only when it is quoted in the account's currency).
  const stored = chosen?.pricing === 'market' && chosen.symbol ? ctx.book.prices.close(chosen.symbol, d.date) : undefined;
  const close = stored && stored.ccy === ccy ? stored : undefined;
  const defaultEstimated = (assetId: string) => data.assets.find((a) => a.id === assetId)?.bucket === 'inmobiliario';

  function build(): { txs: Transaction[]; asset?: Asset } | string {
    if (!account) return 'Elige una cuenta';
    const byUnit = PRICED.has(d.kind) && d.mode === 'unit';
    const amount = byUnit ? computed : parseNum(d.amount, ccy);
    if (byUnit && !parseNum(d.qty, ccy)) return 'Escribe la cantidad';
    if (byUnit && !parseNum(d.price, ccy)) return 'Escribe el precio por unidad';
    if (byUnit && !computed!.gt(0)) return 'El total resulta negativo o cero: revisa el precio y la comisión';
    if (amount === undefined) return 'Escribe el monto';
    const signed = NEGATIVE.has(d.kind) ? amount.abs().neg() : d.kind === 'WRITE_OFF' ? dec(0) : amount.abs();
    let asset: Asset | undefined;
    let assetId = d.asset || undefined;
    if (WITH_ASSET.has(d.kind)) {
      if (d.asset === NEW) {
        const a = d.newAsset;
        if (!a.id.trim() || !a.name.trim()) return 'Escribe código y nombre del activo nuevo';
        if (data.assets.some((x) => x.id === a.id.trim())) return `Ya existe un activo con código ${a.id}`;
        asset = { ...a, id: a.id.trim(), name: a.name.trim(), symbol: a.pricing === 'market' ? a.symbol?.trim() || a.id.trim() : undefined };
        assetId = asset.id;
      }
      if (!assetId) return 'Elige el activo';
    }
    const qty = WITH_QTY.has(d.kind) ? parseNum(d.qty, ccy) : undefined;
    const fee = parseNum(d.fee, ccy);
    const base = { date: d.date, account: d.account, ccy, note: d.note.trim() || undefined, estimated: d.estimated || undefined };
    if (d.kind === 'TRANSFER') {
      const to = data.accounts.find((a) => a.id === d.toAccount);
      const amountIn = parseNum(d.amountIn, to?.ccy);
      if (!to || to.id === account.id) return 'Elige una cuenta de destino distinta';
      if (amountIn === undefined) return 'Escribe el monto que llega a la cuenta destino';
      const transferId = newId();
      return {
        txs: [
          { ...base, type: 'TRANSFER_OUT', amount: amount.abs().neg(), transferId },
          { ...base, account: to.id, ccy: to.ccy, type: 'TRANSFER_IN', amount: amountIn.abs(), transferId },
        ],
      };
    }
    const tx: Transaction = { ...base, id: editing?.id, type: d.kind, amount: signed, asset: assetId, ...(qty ? { qty } : {}), ...(fee ? { fee } : {}) };
    const txs = [tx];
    if (!editing && d.kind === 'DIVIDEND' && d.toBank) {
      txs.push({ ...base, type: 'WITHDRAWAL', amount: amount.abs().neg(), note: 'dividendo pagado a la cuenta bancaria' });
    }
    if (!editing && d.kind === 'CAPITAL_CALL' && d.external) {
      txs.unshift({ ...base, type: 'DEPOSIT', amount: amount.abs(), note: 'aporte para cuota del inmueble' });
    }
    return { txs, asset };
  }

  async function submit(e: Event) {
    e.preventDefault();
    const b = build();
    if (typeof b === 'string') {
      setIssues([{ level: 'error', code: 'FORM', message: b }]);
      return;
    }
    const assets = new Map(ctx.book.assets);
    if (b.asset) assets.set(b.asset.id, b.asset);
    const ref = { assets, accounts: ctx.book.accounts, today: today() };
    let ledger = ctx.ledger.filter((t) => !editing || t.id !== editing.id);
    const found: Issue[] = [];
    for (const tx of b.txs) {
      found.push(...validateTransaction(ledger, tx, ref));
      ledger = [...ledger, tx];
    }
    const errors = found.filter((i) => i.level === 'error');
    if (errors.length || (found.length && !confirmWarnings)) {
      setIssues(found);
      setConfirmWarnings(!errors.length);
      return;
    }
    let next = getDataset();
    if (b.asset) next = upsertAsset(next, b.asset);
    next = editing?.id ? replaceTransactions(next, [editing.id], b.txs) : addTransactions(next, b.txs);
    await setDataset(next);
    onDone();
  }

  const kinds: Kind[] = editing ? [editing.type] : CREATE_KINDS;
  return (
    <form class="card" onSubmit={submit} aria-label={editing ? 'Editar movimiento' : 'Nuevo movimiento'}>
      <h2>{editing ? 'Editar movimiento' : 'Nuevo movimiento'}</h2>
      <div class="form-grid">
        <label class="field">
          Tipo
          <select value={d.kind} disabled={!!editing} onChange={(e) => up({ kind: (e.target as HTMLSelectElement).value as Kind, asset: '' })}>
            {kinds.map((k) => (
              <option value={k}>{k === 'TRANSFER' ? 'Transferencia entre cuentas' : TYPE_LABELS[k]}</option>
            ))}
          </select>
        </label>
        <label class="field">
          Fecha
          <input type="date" required value={d.date} max={today()} onInput={(e) => up({ date: (e.target as HTMLInputElement).value })} />
        </label>
        <label class="field">
          {d.kind === 'TRANSFER' ? 'Cuenta origen' : 'Cuenta'}
          <select value={d.account} onChange={(e) => up({ account: (e.target as HTMLSelectElement).value, asset: '' })}>
            {accounts.map((a) => (
              <option value={a.id}>
                {a.name} ({a.ccy})
              </option>
            ))}
          </select>
        </label>
        {WITH_ASSET.has(d.kind) && (
          <label class="field">
            Activo
            <select
              value={d.asset}
              required
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                // An asset valued by hand (a fund, a copy portfolio) usually has no units: its buys go by total.
                const manual = v !== NEW && data.assets.find((a) => a.id === v)?.pricing === 'manual';
                up({ asset: v, estimated: d.kind === 'VALUATION' ? defaultEstimated(v) : d.estimated, mode: manual || d.mode === 'total' ? 'total' : 'unit' });
              }}
            >
              <option value="">— elige —</option>
              {assetChoices.map((a) => (
                <option value={a.id}>
                  {a.name} ({a.id})
                </option>
              ))}
              {d.kind === 'BUY' && <option value={NEW}>+ Activo nuevo…</option>}
            </select>
          </label>
        )}
      </div>

      {d.asset === NEW && (
        <fieldset class="card" style="background:var(--surface-2)">
          <legend>Activo nuevo</legend>
          <div class="form-grid">
            <label class="field">
              Código
              <input value={d.newAsset.id} placeholder="p. ej. MSFT" onInput={(e) => up({ newAsset: { ...d.newAsset, id: (e.target as HTMLInputElement).value.toUpperCase() } })} />
            </label>
            <label class="field">
              Nombre
              <input value={d.newAsset.name} placeholder="Microsoft" onInput={(e) => up({ newAsset: { ...d.newAsset, name: (e.target as HTMLInputElement).value } })} />
            </label>
            <label class="field">
              Clase
              <select value={d.newAsset.bucket} onChange={(e) => up({ newAsset: { ...d.newAsset, bucket: (e.target as HTMLSelectElement).value } })}>
                {buckets.map((b) => (
                  <option value={b}>{bucketLabel(b)}</option>
                ))}
              </select>
            </label>
            <label class="field">
              Moneda de cotización
              <input value={d.newAsset.ccy} maxLength={4} onInput={(e) => up({ newAsset: { ...d.newAsset, ccy: (e.target as HTMLInputElement).value.toUpperCase() } })} />
            </label>
            <label class="field">
              Precio
              <select value={d.newAsset.pricing} onChange={(e) => up({ newAsset: { ...d.newAsset, pricing: (e.target as HTMLSelectElement).value as Asset['pricing'] } })}>
                <option value="market">De mercado (cotiza en bolsa)</option>
                <option value="manual">Manual en cada cierre (copy portfolio, fondo, inmueble)</option>
              </select>
            </label>
            {d.newAsset.pricing === 'market' && (
              <label class="field">
                Símbolo de cotización
                <input value={d.newAsset.symbol ?? ''} placeholder="p. ej. AAPL, IWDA.AS, ECOPETROL.CL" onInput={(e) => up({ newAsset: { ...d.newAsset, symbol: (e.target as HTMLInputElement).value.toUpperCase() } })} />
              </label>
            )}
          </div>
        </fieldset>
      )}

      <div class="form-grid">
        {WITH_QTY.has(d.kind) && (
          <label class="field">
            Cantidad (acciones o unidades){PRICED.has(d.kind) && d.mode === 'total' ? ', si aplica' : ''}
            <input inputMode="decimal" value={d.qty} onInput={(e) => up({ qty: (e.target as HTMLInputElement).value })} />
            {pos?.open && d.kind !== 'BUY' && <span class="small muted">Tienes {num(pos.qty)} a esa fecha</span>}
          </label>
        )}
        {PRICED.has(d.kind) && d.mode === 'unit' && (
          <label class="field">
            Precio de {d.kind === 'BUY' ? 'compra' : 'venta'} por unidad ({ccy})
            <input inputMode="decimal" value={d.price} onInput={(e) => up({ price: (e.target as HTMLInputElement).value })} />
            {close && (
              <span class="small muted">
                Cierre del {date(close.date)}: {money(close.close, ccy, 2)}
              </span>
            )}
            {d.kind === 'SELL' && pos?.open && !pos.qty.isZero() && <span class="small muted">Costo promedio: {money(pos.cost.div(pos.qty), ccy, 4)} por unidad</span>}
          </label>
        )}
        {PRICED.has(d.kind) && (
          <label class="field">
            Comisión{d.mode === 'total' ? ' incluida en el total' : ''} ({ccy}, opcional)
            <input inputMode="decimal" value={d.fee} onInput={(e) => up({ fee: (e.target as HTMLInputElement).value })} />
          </label>
        )}
        {d.kind !== 'WRITE_OFF' && !(PRICED.has(d.kind) && d.mode === 'unit') && (
          <label class="field">
            {AMOUNT_LABEL[d.kind] ?? 'Monto'} ({ccy})
            <input inputMode="decimal" required value={d.amount} onInput={(e) => up({ amount: (e.target as HTMLInputElement).value })} />
            {PRICED.has(d.kind) && qtyN && !qtyN.isZero() && amountN && (
              <span class="small muted">
                Equivale a {money(impliedPrice(d.kind, amountN, qtyN, feeN), ccy, 4)} por unidad{feeN ? ' sin la comisión' : ''}
              </span>
            )}
            {d.kind === 'SELL' && pos?.open && !pos.qty.isZero() && <span class="small muted">Costo promedio: {money(pos.cost.div(pos.qty), ccy, 4)} por unidad</span>}
          </label>
        )}
        {PRICED.has(d.kind) && (
          <div class="field trade-total" style="grid-column: 1 / -1">
            {d.mode === 'unit' ? (
              <>
                <span>
                  {d.kind === 'BUY' ? 'Total que sale de la cuenta' : 'Total que entra a la cuenta'}:{' '}
                  <strong class="num">{computed ? money(computed, ccy, 2) : '—'}</strong>
                  {computed && (
                    <span class="small muted">
                      {' '}
                      = {num(qtyN!)} × {num(priceN!)}{feeN && !feeN.isZero() ? ` ${d.kind === 'BUY' ? '+' : '−'} comisión ${num(feeN)}` : ''}
                    </span>
                  )}
                </span>
                <button type="button" class="link" onClick={() => up({ mode: 'total', amount: computed ? field(computed) : d.amount })}>
                  El extracto dice otro total: escribirlo
                </button>
              </>
            ) : (
              <button type="button" class="link" onClick={() => up({ mode: 'unit' })}>
                Calcular el total con cantidad y precio por unidad
              </button>
            )}
          </div>
        )}
        {d.kind === 'TRANSFER' && (
          <>
            <label class="field">
              Cuenta destino
              <select value={d.toAccount} onChange={(e) => up({ toAccount: (e.target as HTMLSelectElement).value })}>
                {accounts.map((a) => (
                  <option value={a.id}>
                    {a.name} ({a.ccy})
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              Monto que llega ({data.accounts.find((a) => a.id === d.toAccount)?.ccy})
              <input inputMode="decimal" value={d.amountIn} onInput={(e) => up({ amountIn: (e.target as HTMLInputElement).value })} />
            </label>
          </>
        )}
        <label class="field" style="grid-column: 1 / -1">
          Nota (opcional)
          <input value={d.note} onInput={(e) => up({ note: (e.target as HTMLInputElement).value })} />
        </label>
      </div>
      <div class="actions" style="margin-bottom:12px">
        {!editing && d.kind === 'DIVIDEND' && (
          <label style="display:flex;gap:6px;align-items:center">
            <input type="checkbox" checked={d.toBank} onChange={(e) => up({ toBank: (e.target as HTMLInputElement).checked })} />
            Se pagó a mi cuenta bancaria (sale del portafolio)
          </label>
        )}
        {!editing && d.kind === 'CAPITAL_CALL' && (
          <label style="display:flex;gap:6px;align-items:center">
            <input type="checkbox" checked={d.external} onChange={(e) => up({ external: (e.target as HTMLInputElement).checked })} />
            El dinero vino de fuera del portafolio (registrar el aporte)
          </label>
        )}
        <label style="display:flex;gap:6px;align-items:center">
          <input type="checkbox" checked={d.estimated} onChange={(e) => up({ estimated: (e.target as HTMLInputElement).checked })} />
          Es un dato estimado
        </label>
      </div>
      {issues.length > 0 && (
        <div class={`notice ${issues.some((i) => i.level === 'error') ? 'err' : 'warn'}`} role="alert">
          <ul>
            {issues.map((i) => (
              <li>{i.message}</li>
            ))}
          </ul>
          {confirmWarnings && <p style="margin:6px 0 0">Revisa las advertencias y vuelve a guardar para confirmar.</p>}
        </div>
      )}
      <div class="actions">
        <button type="submit" class="primary">
          {confirmWarnings ? 'Guardar de todos modos' : 'Guardar'}
        </button>
        <button type="button" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
