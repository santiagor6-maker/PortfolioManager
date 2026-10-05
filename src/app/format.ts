import { Decimal } from '../domain/money.ts';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function money(x: Decimal | undefined, ccy: string, digits?: number): string {
  if (!x) return '—';
  const d = digits ?? (ccy === 'COP' ? 0 : 2);
  const n = new Intl.NumberFormat('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }).format(x.toNumber());
  // A non-breaking space keeps the sign with its figure when a line wraps.
  return ccy === 'COP' ? `$\u00a0${n}` : ccy === 'USD' ? `US$\u00a0${n}` : `${n}\u00a0${ccy}`;
}

/** Compact money for tiles: "$ 399,3 M" / "US$ 116 mil". */
export function moneyShort(x: Decimal, ccy: string): string {
  const n = x.toNumber();
  const a = Math.abs(n);
  const prefix = ccy === 'COP' ? '$' : ccy === 'USD' ? 'US$' : ccy;
  const f = (v: number, unit: string) => `${prefix}\u00a0${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(v)}\u00a0${unit}`;
  if (a >= 1e9) return f(n / 1e9, 'mil M');
  if (a >= 1e6) return f(n / 1e6, 'M');
  if (a >= 1e4) return f(n / 1e3, 'mil');
  return money(x, ccy);
}

export function num(x: Decimal | undefined, maxDigits = 6): string {
  if (!x) return '—';
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: maxDigits }).format(x.toNumber());
}

export function pct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${new Intl.NumberFormat('es-CO', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x * 100)} %`;
}

export function ratio(x: number | undefined): string {
  return x === undefined ? '—' : new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
}

export function date(d: string | undefined): string {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function monthLabel(d: string): string {
  const [y, m] = d.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

export function today(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** A price in its own currency, with enough decimals for cheap shares. */
export function price(x: Decimal | number | undefined, ccy: string): string {
  if (x === undefined) return '—';
  const d = x instanceof Decimal ? x : new Decimal(x);
  const abs = d.abs().toNumber();
  return money(d, ccy, abs >= 1000 ? 0 : abs >= 1 ? 2 : 4);
}

/** Reads a number typed either way: "1.234,5" or "1,234.5" (a trailing comma group is the decimal part). */
export function parseNumber(raw: string): Decimal | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const norm = /,\d*$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  return new Decimal(norm);
}
