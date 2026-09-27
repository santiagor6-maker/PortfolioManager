/**
 * Checks files prepared outside the app against a backup, with the app's own rules, before the user imports them in Datos.
 * Used by the month-close, import-statement and thesis skills (.claude/skills). Personal files stay outside the repo.
 *
 *   node scripts/checks.ts status <backup.json> [YYYY-MM]    what the month-end close still needs (default: last month)
 *   node scripts/checks.ts ledger <backup.json> <movs.csv>   new movements (Datos → Movimientos → Agregar)
 *   node scripts/checks.ts prices <backup.json> <prices.csv> quotes (Datos → Precios)
 *   node scripts/checks.ts fx     <backup.json> <fx.csv>     exchange rates (Datos → Tasas de cambio)
 *   node scripts/checks.ts assets <backup.json> <book.json>  accounts/assets changes (Datos → Cuentas, activos e índices)
 *   node scripts/checks.ts holdings <backup.json> <account> <YYYY-MM-DD> [movs.csv]
 *                                                            units and cash of one account, to reconcile with a statement
 *
 * Options: --today=YYYY-MM-DD (default: the system date). Exit code 0 = ready to import / to close, 1 = errors or
 * pending items, 2 = bad usage or unreadable file.
 */
import { readFileSync } from 'node:fs';
import { parseLedgerCsv } from '../src/data/csv.ts';
import { parseDataset } from '../src/data/json.ts';
import type { Dataset } from '../src/data/json.ts';
import { readFxRows, readPriceRows } from '../src/data/load.ts';
import { daysBetween, isIsoDate } from '../src/domain/dates.ts';
import { LedgerError } from '../src/domain/holdings.ts';
import { dec } from '../src/domain/money.ts';
import { STALE_DAYS, accountSnapshot, checkAssetPatch, checkFxRows, checkLedgerRows, checkPriceRows, closeStatus, lastClosableMonth } from '../src/app/checks.ts';
import type { Finding } from '../src/app/checks.ts';
import { contextOf } from '../src/app/context.ts';
import { date, money, num, today as systemToday } from '../src/app/format.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const todayOpt = process.argv.find((a) => a.startsWith('--today='))?.slice(8);
const [cmd, backupPath, file] = args;

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error('Uso: node scripts/checks.ts <status|ledger|prices|fx|assets|holdings> <respaldo.json> [archivo | AAAA-MM | cuenta fecha] [--today=AAAA-MM-DD]');
  process.exit(2);
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    usage(`No se pudo leer ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

if (!cmd || !backupPath) usage();
if (todayOpt !== undefined && !isIsoDate(todayOpt)) usage(`--today inválido: ${todayOpt}`);
const today = todayOpt ?? systemToday();

let d: Dataset;
try {
  d = parseDataset(read(backupPath));
} catch (e) {
  usage(`${backupPath}: ${e instanceof Error ? e.message : e}`);
}
const ctx = contextOf(d);

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function report(findings: Finding[], rows: number, what: [string, string]): never {
  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warning');
  for (const f of [...errors, ...warnings]) console.log(`${f.level === 'error' ? 'ERROR ' : 'AVISO '} [${f.code}] ${f.ref}: ${f.message}`);
  console.log(`\n${count(rows, ...what)}: ${count(errors.length, 'error', 'errores')}, ${count(warnings.length, 'aviso')}.`);
  console.log(errors.length ? 'No importes este archivo hasta corregir los errores.' : warnings.length ? 'Se puede importar; revisa los avisos con el usuario.' : 'Listo para importar.');
  process.exit(errors.length ? 1 : 0);
}

function parse<T>(what: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    usage(`${what}: ${e instanceof Error ? e.message : e}`);
  }
}

switch (cmd) {
  case 'status': {
    const month = file ? (/^\d{4}-\d{2}$/.test(file) ? `${file}-01` : file) : lastClosableMonth(today);
    if (!isIsoDate(month)) usage(`Mes inválido: ${file} (usa AAAA-MM)`);
    const s = closeStatus(d, ctx, month, today);
    console.log(`Cierre de ${date(s.month)}: ${s.closed ? `cerrado el ${date(s.closed.closedAt)}` : 'sin cerrar'}`);
    if (s.error) console.log(`BLOQUEA  ${s.error}`);
    let warnings = s.stale.length;
    for (const r of s.fx) {
      if (r.stale) warnings++;
      const age = r.last ? daysBetween(r.last, s.month) : undefined;
      console.log(`${r.stale ? 'AVISO    ' : ''}Tasa ${r.ccy}/USD: último dato ${r.last ? date(r.last) : 'ninguno'}${r.stale && age !== undefined ? ` (${age} días antes del cierre; falta la del cierre)` : ''}`);
    }
    for (const b of s.benchmarks) {
      // The comparison uses an index level up to 10 days old (SeriesPriceSource default).
      const age = b.last ? daysBetween(b.last, s.month) : undefined;
      const flag = age === undefined || age > STALE_DAYS;
      if (flag) warnings++;
      const why = age === undefined || age > 10 ? ' — la Comparación de ese mes quedaría sin índice' : flag ? ` (${age} días antes del cierre)` : '';
      console.log(`${flag ? 'AVISO    ' : ''}Índice ${b.symbol} (${b.name}): último dato ${b.last ? date(b.last) : 'ninguno'}${why}`);
    }
    console.log(`Precios de mercado al cierre: ${s.priced} con precio`);
    for (const q of s.missing) console.log(`FALTA    precio ${q.symbol ?? q.asset} (${q.name}, ${q.ccy}); último guardado: ${q.last ? date(q.last) : 'ninguno'}`);
    for (const q of s.stale) console.log(`AVISO    precio de ${q.symbol ?? q.asset} (${q.name}) con más de 5 días al cierre; último: ${q.last ? date(q.last) : 'ninguno'}`);
    for (const v of s.due) {
      const ccy = d.accounts.find((a) => a.id === v.account)?.ccy ?? '';
      const prev = v.previous ? `${money(v.previous.value, ccy)} al ${date(v.previous.date)}` : 'sin valor anterior';
      console.log(`FALTA    valor de fin de mes: ${v.name} (asset ${v.asset}, cuenta ${v.account}, ${ccy}); anterior ${prev}`);
    }
    if (s.total) console.log(`Valor total al cierre: ${money(s.total, 'COP')} · sin inmobiliario ${money(s.exRealEstate, 'COP')}`);
    // Same threshold as the Cierre screen: a change of $ 1 or more since the month was closed.
    if (s.closed && s.total && !s.total.minus(dec(s.closed.total)).abs().lt(1)) {
      console.log(`AVISO    Las cifras cambiaron desde el cierre: el total era ${money(dec(s.closed.total), 'COP')} y ahora es ${money(s.total, 'COP')}`);
    }
    const blocked = !!s.error || s.missing.length > 0 || s.due.length > 0;
    console.log(
      blocked ? '\nFaltan datos para cerrar el mes.'
      : warnings ? '\nLa app deja cerrar, pero hay avisos: busca los datos del cierre antes de cerrar (con datos viejos las cifras quedan imprecisas).'
      : '\nListo para cerrar en la app (Cierre del mes → Cerrar).',
    );
    process.exit(blocked ? 1 : 0);
  }
  case 'ledger': {
    if (!file) usage();
    const txs = parse(file, () => parseLedgerCsv(read(file)));
    report(checkLedgerRows(ctx, txs, today), txs.length, ['movimiento', 'movimientos']);
  }
  case 'prices': {
    if (!file) usage();
    const rows = parse(file, () => readPriceRows(read(file)));
    report(checkPriceRows(d, rows, today), rows.length, ['precio', 'precios']);
  }
  case 'fx': {
    if (!file) usage();
    const rows = parse(file, () => readFxRows(read(file)));
    report(checkFxRows(d, rows, today), rows.length, ['tasa', 'tasas']);
  }
  case 'assets': {
    if (!file) usage();
    const { findings, changes } = checkAssetPatch(d, read(file), today);
    for (const c of changes) console.log(`CAMBIO   ${c.asset}.${c.field}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
    const added = findings.filter((f) => f.code === 'NEW_ASSET' || f.code === 'NEW_ACCOUNT').length;
    if (added) console.log(`NUEVOS   ${count(added, 'activo o cuenta nueva', 'activos o cuentas nuevas')}`);
    report(findings, changes.length, ['campo cambiado', 'campos cambiados']);
  }
  case 'holdings': {
    // holdings <backup.json> <account> <YYYY-MM-DD> [movs.csv]: units and cash of one account, to compare with a statement.
    const [, , account, on, extra] = args;
    if (!account || !on || !isIsoDate(on)) usage('Uso: node scripts/checks.ts holdings <respaldo.json> <cuenta> <AAAA-MM-DD> [movimientos.csv]');
    const acc = d.accounts.find((a) => a.id === account);
    if (!acc) usage(`Cuenta desconocida: ${account}. Cuentas: ${d.accounts.map((a) => a.id).join(', ')}`);
    const txs = extra ? parse(extra, () => parseLedgerCsv(read(extra))) : [];
    // Reconcile only rows the app would accept.
    const invalid = checkLedgerRows(ctx, txs, today).filter((f) => f.level === 'error');
    if (invalid.length) {
      for (const f of invalid) console.log(`ERROR  [${f.code}] ${f.ref}: ${f.message}`);
      console.log(`\nCorrige los movimientos (node scripts/checks.ts ledger …) antes de cuadrar la cuenta.`);
      process.exit(1);
    }
    try {
      const snap = accountSnapshot(ctx, account, on, txs);
      console.log(`${acc.name} (${account}) al ${date(on)}${extra ? `, con ${count(txs.length, 'movimiento nuevo', 'movimientos nuevos')}` : ''}`);
      for (const p of snap.positions) {
        const v = p.valuation ? ` · último valor ${money(p.valuation.value, acc.ccy)} al ${date(p.valuation.date)}` : '';
        console.log(`  ${p.asset.padEnd(20)} ${p.qty.isZero() ? '(sin unidades)' : `${num(p.qty, 8)} u.`} · costo ${money(p.cost, acc.ccy)}${v}`);
      }
      console.log(`  Efectivo calculado: ${money(snap.cash, acc.ccy)}`);
      process.exit(0);
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      console.log(`ERROR    ${e.message}`);
      process.exit(1);
    }
  }
  default:
    usage(`Comando desconocido: ${cmd}`);
}
