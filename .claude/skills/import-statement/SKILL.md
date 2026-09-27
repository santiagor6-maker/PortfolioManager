---
name: import-statement
description: Turn a broker, bank or fund statement (PDF, CSV, Excel or screenshot) into validated movements for the investment tracker, reconciled against the statement's closing balances, as a CSV the user imports in Datos. Use when the user sends an "extracto", "estado de cuenta", "certificado de dividendos", a broker export (eToro, IBKR, eTrading…) or asks to register the movements of a statement.
argument-hint: "[cuenta]"
---

# Statement → movements

The ledger is the source of truth. A statement becomes ledger rows in the app's CSV format. You check them with the app's own validation and reconcile them against the statement, and the user imports them. You never edit their data directly.

## Rules

- Talk to the user in Spanish.
- Statements and the backup are personal data. Keep them, and every file you build, in a working folder outside the repository (the session scratchpad when there is one).
- Copy numbers exactly as the statement shows them. Never round, estimate or fill gaps. A line you can't classify goes to the user as a question, not into the file.
- Read PDFs and spreadsheets with the `pdf` / `xlsx` skills when available.

## Steps

1. **Inputs.**
   - Ask for the statement and a fresh backup (**Datos → Descargar respaldo (.json)**).
   - Identify the account. It is `$ARGUMENTS` if given; otherwise match the broker and currency to the backup's `accounts`, and ask if more than one fits.
   - Note the statement period and its closing balances: units per asset and cash.

2. **Match the house conventions.**
   - Look at the last movements of that account in the backup, e.g. by extracting them with a short script from the backup JSON.
   - Copy their conventions: trade date vs settlement date, how fees and withholding appear, and asset ids.
   - If the account has no history, use the trade date and ask.

3. **Map each line** to CSV rows with the columns `date,account,type,asset,qty,amount,ccy,fee,estimated,transfer_id,note`.
   - `amount` is the cash effect on the account, in the account currency (`ccy` = the account's currency, always).
   - Leave `id` out: the app assigns one.

   | Statement line | Row(s) |
   |---|---|
   | Buy | `BUY`, `qty` = units, `amount` = −(total charged, fees included), `fee` = the commission (informative) |
   | Sell | `SELL`, `qty` = units, `amount` = + net proceeds after fees |
   | Dividend | `DIVIDEND` with `asset`, `amount` = + net received. Put gross and withholding in `note` (e.g. "bruto 16,00; retención 30 %"). |
   | Dividend paid out to a bank account (not kept in the broker) | `DIVIDEND` + a `WITHDRAWAL` of the same amount on the same day |
   | Deposit / withdrawal of your money | `DEPOSIT` (+) / `WITHDRAWAL` (−) |
   | Transfer between two of the user's accounts | `TRANSFER_OUT` (−) in one and `TRANSFER_IN` (+) in the other, same `transfer_id`, each in its own account currency with the amounts actually debited and credited |
   | Interest on cash | `INTEREST` (+) |
   | Fee or tax not tied to a trade | `FEE` (−) / `TAX` (−) |
   | Contribution to a fund, copy portfolio or other asset priced by statement | `BUY` without `qty` |
   | Month-end value of such an asset | `VALUATION`, `amount` = + value, no cash effect |

   More rules:
   - `estimated` stays empty for statement data. Use `true` only for reconstructed figures the user asked for.
   - `note`: the statement and period (e.g. "extracto IBKR sep-2026"), plus anything a reader needs.
   - **Currency:** never convert with a rate you picked. If a trade in another currency was charged to the account, use the amount charged in the account currency, as the statement shows it.
   - **Unknown asset** (not in the backup's `assets`): do not invent one. Ask the user for its name, class (`bucket`), symbol and currency. Prepare it in an accounts-and-assets JSON (`{"accounts": [], "assets": [...]}`), checked with `node scripts/checks.ts assets <backup.json> nuevos.json`. It gets imported before the movements.

4. **Validate** with `node scripts/checks.ts ledger <backup.json> movimientos.csv`.
   - Errors (overselling, wrong sign, wrong currency, unknown account or asset, future date) must be fixed.
   - `DUPLICATE` means the row is already in the ledger: drop it unless the user confirms it really happened twice.
   - `NEGATIVE_CASH` usually means a missing deposit or transfer: look for it in the statement before asking.

5. **Reconcile** with the statement's closing balances:
   ```
   node scripts/checks.ts holdings <backup.json> <cuenta> <fecha-de-cierre-del-extracto> movimientos.csv
   ```
   - Units must match the statement exactly.
   - Cash should match to the cent. Explain any difference (e.g. a fee the statement shows elsewhere) or ask; don't hand over an unexplained difference as settled.
   - Show the user a small table: statement vs ledger, per asset and cash.

6. **Hand over.**
   - Send the CSV, plus the assets JSON if there is one (the file-sending tool when available, otherwise their paths).
   - Tell the user how to import in **Datos**:
     1. First **Cuentas, activos e índices** (only if there are new assets).
     2. Then **Movimientos (.csv)**, after choosing **"Agregar a los existentes"** in the selector. The default, "Reemplazar", would erase their ledger.
   - Afterwards they should check the account in **Activos** and download a new backup.
