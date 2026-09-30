---
name: thesis-review
description: Research the economic-moat ratings and fundamentals that providers publish for the user's stocks (Morningstar, GuruFocus, company filings…), each with its source, date and link, and hand the user a validated file for the Indicadores tab. Use when the user asks to update or review the "foso económico", moat ratings, fundamentals, the "tesis" of one or more holdings, or "revisa mis acciones".
argument-hint: "[TICKER ... | todas]"
---

# Thesis review: moats and fundamentals from providers

Indicadores shows what research providers say about each holding (`Asset.moats`) and dated fundamentals (`Asset.fundamentals`). The user's own calls are not yours to change:
- target (`target`)
- optimistic target (`targetHigh`)
- strategy (`strategy`)
- market (`region`)
- idea source (`ideaSource`)
- notes (`note`)

## Rules

- Talk to the user in Spanish.
- The backup is personal data. Keep it, and the file you build, in a working folder outside the repository (the session scratchpad when there is one).
- **Only what a provider actually published, read on its own page or filing.** Never:
  - infer a rating;
  - take one from a search snippet, an aggregator or a forum;
  - carry a rating from another company.
- Every rating has three things:
  - `source`: the provider, e.g. "Morningstar" or "GuruFocus";
  - `asOf`: the date the page shows, or else the day you checked it, with `note: "fecha de consulta"`;
  - `url`.
- **Never bypass bot protection, logins or paywalls** (no headless browsers, no alternate mirrors, no cached copies). If a provider blocks you or keeps the data premium, record nothing for it and tell the user.
- If a provider does not rate the company, say "sin calificación" in the chat. Do not add an empty entry.

## Steps

1. **Backup and scope.**
   - Ask for a fresh backup: **Datos → Descargar respaldo (.json)**.
   - Scope is `$ARGUMENTS`: the tickers, or every market-priced stock (buckets `acciones_*`) with an open position when it says "todas" or is empty.
   - List the assets with their current `moats` and `fundamentals`, so you know what is already there and how old it is.

2. **Research each asset** with the `moat-researcher` agent (`.claude/agents/`).
   - For more than about five tickers, run several in parallel, with a few tickers each.
   - Give each agent the tickers with the company name and exchange, the stored `moats` and `fundamentals` with their dates, and whether fundamentals are wanted.
   - Each agent returns records with source, date, URL and the exact wording seen. Check them against the rules below before they go into the file.
   - **Morningstar Economic Moat:** `wide` / `narrow` / `none` → `rating`.
   - **GuruFocus Moat Score:** 0–10 → `score`.
   - Other providers only if the user asks.
   - When providers disagree, keep both: the app shows each one.
   - Keep ratings from providers you didn't check this time. Replace a provider's rating only with a newer one.

3. **Fundamentals** (only if the user asked).
   - US stocks that file 10-K/10-Q get their ratios from the SEC automatically every month (`Asset.sec`, written by the app): don't copy those by hand. Copy only what the SEC figures lack (their `gaps`, e.g. a company without operating income) and the stocks it doesn't cover (non-US listings; for 20-F filers, per-share and price-based figures).
   - Take them from a source that states them: the company's annual report, a SEC filing (EDGAR), or a provider page you can read without logging in.
   - `fundamentals` needs `asOf` (the period end or publication date) and `source`.
   - If you compute a ratio from filed figures, name the filing and the formula in `source`. Example: "SEC 10-K FY2025; netMargin = NetIncomeLoss / Revenues".
   - Ratios are decimal strings as fractions ("0.134" = 13,4 %). `stars` is an integer from 1 to 5; `cap` is large, mid or small; `style` is value, blend or growth.
   - Leave out what you can't source. Missing is better than wrong.

4. **Build the file** `tesis-AAAA-MM-DD.json`:
   ```json
   { "accounts": [], "assets": [ <asset objects> ] }
   ```
   - Copy each asset object **complete** from the backup (including `sec`) and change only `moats` and, if asked, `fundamentals`. The import replaces the whole asset, so a missing field would be erased.
   - Include only the assets you changed.

5. **Validate:** `node scripts/checks.ts assets <backup.json> tesis-….json`.
   - It lists every changed field. There must be no errors.
   - There must be no `DROPS_FIELD`, `USER_FIELD` or `MOAT_DROPPED` unless the user explicitly asked for that change.
   - `MOAT_NO_URL` on a rating you added means find the link. Ratings kept as they were are not re-checked.

6. **Hand over.**
   - Send the file (the file-sending tool when available, otherwise its path).
   - The user imports it in **Datos → Cuentas, activos e índices (.json)**; the result shows in **Indicadores → Foso económico**.
   - In the chat, give a table per asset: provider, rating, date, link, and what changed since the previous rating.
   - Then give what you couldn't get and why (not rated, blocked, premium).

## Proposals about the user's own calls

If what you found bears on a target or strategy, mention it in the chat with its source. For example: a provider cut the moat to "none" while the thesis is "Valor por foso".

Don't write it into the file unless the user asks. When they do, the `USER_FIELD` warning is expected: show them the before and after.
