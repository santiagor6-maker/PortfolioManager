---
name: month-close
description: Prepare the month-end close of the investment tracker — find what is missing for a month (market prices, exchange rates, manual month-end values, unrecorded movements), gather it with sources, and hand the user validated files to import. Use when the user says "cierre del mes", "cerrar septiembre", "qué falta para cerrar", "actualiza precios y TRM del mes", or sends month-end statements.
argument-hint: "[AAAA-MM]"
---

# Month-end close

The user's data lives only in their browser (IndexedDB). You work from a backup they export, prepare import files, and they import them in the app. You never edit their data directly.

## Rules (from CLAUDE.md, non-negotiable)

- Talk to the user in Spanish.
- **Personal data never enters the repo.** Keep backups, statements and the files you build in a working folder outside the repository (the session scratchpad when there is one). The pre-commit hook blocks them anyway; don't rely on it.
- **Never fabricate market data.** Every price and rate gets a `source` (name and URL) and the date it applies to. If you can't get a value from a source, it stays missing and you tell the user exactly what to look up. No interpolation, no "approximately", no carrying last month's value forward.
- Never bypass bot protection, logins or paywalls. If a site blocks you, say so and move on.
- Never hand over a file that fails `scripts/checks.ts`.

## Subagents

Keep this conversation to the status, the decisions and the hand-over. Delegate the heavy reading (`.claude/agents/`):
- **`market-data`**: fetching prices, rates and index levels (steps 4–5).
- **`statement-reader`**: one per statement the user sends (steps 3 and 6).

Give each one the backup path, the month end, the working folder and exactly what to fetch or read. Independent agents can run in parallel. When one returns, run its `checks.ts` command on its files yourself before handing them over.

## Steps

1. **Backup and month.**
   - Ask the user to download a fresh backup: **Datos → Descargar respaldo (.json)**, then attach it.
   - If they already sent one in this session, use the most recent one and name its file.
   - The month is `$ARGUMENTS` (`AAAA-MM`). Without it, use the last month that has already ended.

2. **Status.** From the repo root, run:
   ```
   node scripts/checks.ts status <backup.json> [AAAA-MM]
   ```
   It lists:
   - the exchange rates the month needs and the index levels, with an `AVISO` when one is more than 5 days old at the month-end;
   - market prices that are `FALTA` (missing: valued at cost) or `AVISO` (more than 5 days old);
   - manual month-end values still due (copy portfolios, funds, property);
   - whether the month is already closed, and whether its figures changed since.

   A `BLOQUEA` naming an earlier date means an earlier month end also lacks data: every month end since then needs its rates and prices, because the tracking grid values each one.

   Summarize it for the user in a short list.

   "La app deja cerrar, pero hay avisos" is not done: the engine still values with a rate or price up to 10 days old, so the figures would be off. Fetch every `AVISO` item too. Leave one open only when the source truly has nothing newer (e.g. a market holiday), and say so.

3. **Movements of the month.** Ask whether there were buys, sells, dividends, deposits, withdrawals or transfers not yet recorded.
   - If they send statements, hand each one to a `statement-reader` agent (the `import-statement` skill).
   - Otherwise they can enter them in **Movimientos**.
   - Movements come before prices: they change what needs a price.

Steps 4–5 go to one `market-data` agent. Give it the currencies, symbols and indices that the status flags as `FALTA` or `AVISO`. The rules below are what it follows and what you check in its report.

4. **Exchange rates** (`fx.csv`: `ccy,date,per_usd,source`).
   - **COP:** use the official TRM (Superintendencia Financiera / Banco de la República). The datos.gov.co dataset `32sa-8pi3` has `valor` and `vigenciadesde`.
     - Use the rate in force on the month-end date.
     - Its `date` is the day it takes effect (`vigenciadesde`): a Saturday month-end uses the TRM that took effect that day, or the one before.
   - **Other currencies:** give them as `EUR/USD`-style pairs (USD per unit, market convention). The app inverts them on import.
   - Run `node scripts/checks.ts fx <backup.json> fx.csv`.

5. **Market prices** (`prices.csv`: `symbol,date,close,ccy,source`).
   - For each `FALTA`/`AVISO` symbol, and each index behind in the status, get the official close of the last trading day on or before the month-end.
   - Use the asset's own symbol and currency exactly as the status prints them.
   - Index levels must be total-return series (dividends reinvested), the same series already stored.
   - Put the provider and URL in `source`.
   - If the network blocks every source for a symbol, leave it out and list it for the user.
   - Run `node scripts/checks.ts prices <backup.json> prices.csv`. Every `JUMP` warning (possible split, typo or wrong currency) must be explained or fixed before you hand the file over.

6. **Manual month-end values** (copy portfolios, funds, property).
   - These come from the user's statements or the developer's price list. Ask for them; never estimate them yourself.
   - **Simplest route:** the user types them in **Cierre del mes → paso 3**, which marks the property as an estimate by default.
   - **If they send the statements:** a `statement-reader` agent builds the `VALUATION` rows in a movements CSV:
     - Put the account and asset ids from the status, the month-end date and the value in the account currency.
     - Set `estimated=true` for list prices or appraisals, and add a note such as "valor del extracto al cierre" or "precio de lista".
     - Validate with `node scripts/checks.ts ledger <backup.json> valores.csv`.

7. **Hand over.**
   - Send the files (the file-sending tool when available, otherwise their paths).
   - Give the import order, in **Datos**:
     1. **Tasas de cambio**
     2. **Precios**
     3. **Movimientos (.csv)**, after choosing **"Agregar a los existentes"** in the selector. The default, "Reemplazar", would erase their ledger.
   - Then **Cierre del mes**: review steps 1–3 and the result, press **Cerrar**, and download a new backup.

8. **Confirm.** If they send the new backup, run `status` again until it says "Listo para cerrar" (or shows the month closed). Report what is still missing, if anything, and why.

## If the month is already closed

`status` warns when the figures changed after the close. Explain which movement or price caused it, then let the user decide whether to reclose (**Cierre del mes → Cerrar** again).
