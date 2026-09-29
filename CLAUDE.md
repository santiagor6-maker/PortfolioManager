# CLAUDE.md

## Mindset

- You are AGI-pilled. Do not act like the world is static: assume capabilities, tools, and models keep improving, and act at the level of what is possible now — not what was possible when you were trained. Speak your mind plainly instead of hedging.

## How to work

- Be concise, direct, and candid. Challenge weak assumptions and distinguish verified facts from uncertainty.
- Preserve the original goal and constraints. Finish authorized work end to end and verify the actual result before claiming completion.
- Ask questions only when a decision is materially ambiguous, risky, or requires approval. Otherwise pick a sensible default and state it.
- Keep changes focused and simple. Avoid unrelated edits, unnecessary abstractions, and low-signal tests.
- Test observable behavior. Validate user-facing work in the real interface when applicable.
- Never take destructive, production, or external actions beyond what was authorized. Preserve unrelated work.
- Report meaningful blockers, outcomes, and evidence — no noisy progress narration.
- Ground research in authoritative, current sources and link the important evidence.
- Communicate with the user in Spanish. Code, identifiers, and commit messages in English.

## Project

A personal investment tracker for stocks, real estate, fixed income, and other assets. It records buys, sells, and income over time, computes cumulative returns, and compares performance against relevant market benchmarks.

Stack: TypeScript, Vitest, decimal.js. Static web app (Vite) that runs locally and deploys to Netlify, with optional Supabase sync. Prefer the simplest thing that works.

- `src/domain/` — calculation engine, no I/O: ledger replay with average cost (`holdings.ts`), FX (`fx.ts`), valuation (`valuation.ts`), portfolio series and flows per scope (`portfolio.ts`), XIRR/TWR (`returns.ts`), PME/KS-PME (`benchmark.ts`), drawdowns and volatility (`risk.ts`), month-end manual values (`monthlyClose.ts`), validation of new transactions (`validate.ts`).
- `src/data/` — CSV/JSON import and export; `json.ts` defines the stored `Dataset` (also the backup format); `quotes.ts` parses the public quote APIs (Twelve Data, the official TRM on datos.gov.co, CoinGecko).
- `src/app/` — Preact UI. `analysis.ts` turns the engine into report rows (pure, unit-tested); `tracking.ts` builds the month-by-month grid (asset, class, subtotal without real estate, total) used by Seguimiento and the month-end close; `stocks.ts` builds the price-tracking rows (entry price, target, 52-week range) and closed trades for Precios; `indicators.ts` builds Indicadores (weight per holding, composition by market/strategy/idea source/style, potential to the base and optimistic targets); `insights.ts` builds the analysis blocks on the tracking (returns by month and year, risk, where the gain came from); `dividends.ts` builds Dividendos (net dividends received by month, year and asset, and a next-12-months projection that repeats the last 12 months' payments for the positions still held); `selection.ts` is the Resumen's pick of classes, added up by the `mix` scope in `portfolio.ts`, and the layout of its blocks (shown, hidden, order); `refresh.ts` is «Actualizar precios»: which series a free source covers (US stocks and FX with the user's Twelve Data key, kept only in this browser; the TRM; crypto), fetches only the days after the last stored one, never replaces a stored value and runs the rows through the same checks as a file import — non-US listings and total-return indices stay with the `month-close` skill; `views/` are the screens; data persists in the browser's IndexedDB (`store.ts`). Optional cloud sync (`sync.ts`, decision logic in `syncPlan.ts`) keeps an encrypted copy in Supabase: the browser gzips and seals the dataset with AES-GCM under a key derived from the user's passphrase (`src/data/crypto.ts`), so the server only holds ciphertext; saves are optimistic on a version and conflicts are never merged. Sync is built only when `VITE_SUPABASE_URL` and `VITE_SUPABASE_KEY` are set (Netlify's build env); otherwise the app is local only.
- Visual style follows getquin's (app.getquin.com): the tokens at the top of `styles.css` (colors, 4px radius, no shadows, green/red gains and losses, hatched forecasts) and two OFL fonts inlined by the build, Inter Tight and Geist Mono for figures, standing in for their licensed Unica77.
- `npm run build` produces a single self-contained `dist/index.html` that opens from disk (`scripts/inline.ts`). `npm run test:e2e` drives it with Playwright from `file://`.
- Published on Netlify (`netlify.toml`) from this branch: every push deploys. The build writes `dist/_headers` with a hash-based CSP. `supabase/migrations/` holds the sync schema (RLS, an email allowlist in the `private` schema filled outside the repo). `e2e/sync.spec.ts` runs sync against a fake Supabase on a `dist-sync/` build.
- `samples/` — synthetic demo portfolio (fictional tickers and prices). `tests/` — hand-verified cases.
- `npm test`, `npm run typecheck`. `node scripts/crossval.ts <dir>` checks the engine against a reference dataset kept outside the repo.
- `node scripts/checks.ts` checks files prepared outside the app (month-end status, movements, prices, rates, asset changes) against a user's backup with the app's own rules (`src/app/checks.ts`); the skills use it before handing a file to the user.

## Claude Code workflow

- Skills in `.claude/skills/`: `month-close`, `import-statement`, `thesis-review`. They work from a backup the user exports and hand back files the user imports in Datos; never edit the user's data directly. Build those files outside the repo and validate them with `scripts/checks.ts` first.
- Before committing changes to `src/domain`, `src/data` or the report builders in `src/app`, run the `finance-reviewer` subagent (`.claude/agents/`) and address its findings.
- Keep the main conversation for decisions and hand-overs. Delegate heavy reading to the subagents in `.claude/agents/`; they return short reports.
  - `market-data`: month-end prices, rates and index levels.
  - `statement-reader`: one per statement.
  - `moat-researcher`: provider ratings, a few tickers each, in parallel.
  - `app-verifier`: typecheck, tests, build, e2e and screenshots.

  Re-run `scripts/checks.ts` on any file an agent hands back. If an agent type is not available yet, run a general-purpose agent with that file's instructions.
- **Always log progress in `bitacora.md`.** Before ending a turn that advanced the project (code, decisions, deliverables to the user), add an entry at the top of "Registro". The entry is a bold dated title with its commits, followed by 2–4 short bullets saying what was done or decided. Keep "Estado" to a few lines that say where things stand. Keep the file short: it is a trace for Claude, not a report. Write it in Spanish. Never put personal figures in it (balances, values, returns, positions).
- Hooks: `.githooks/pre-commit` (`scripts/guard.ts`, enabled by `npm install`) blocks personal data, secrets, and code that fails the typecheck or unit tests. Never bypass it. `.claude/settings.json` enables it at session start, blocks `--no-verify`, and runs the typecheck and tests before a turn ends with code changes.

## Domain rules

- **The transaction ledger is the source of truth.** Buys, sells, dividends, interest, rent, fees, taxes, deposits, and withdrawals are stored as dated transactions. Holdings, cost basis, and returns are derived from it, never stored as authoritative values.
- **Two kinds of return, always labeled.** Money-weighted (XIRR) measures the investor's actual result given the timing of their cash flows. Time-weighted (TWR) measures the investment itself and is the one to compare against an index. Never show an unlabeled "return".
- **Fair benchmark comparison.** Simulate the same cash flows invested in the benchmark on the same dates (public market equivalent), using total-return data (dividends reinvested). Match the benchmark to the asset class: equity index for stocks, rates or bond index for fixed income, and a property index or inflation for real estate.
- **Separate realized and unrealized gains.** State the cost-basis method (average cost or FIFO) explicitly and apply it consistently.
- **Money is exact.** Never use binary floats for amounts. Use decimals or integer minor units. Every amount carries its currency. Convert currencies with the exchange rate for the transaction date, never an implicit rate.
- **Illiquid assets** (real estate, private holdings) use manual valuations that carry a date and are flagged as estimates in the UI.
- **Never fabricate market data.** Every price, rate, or index value has a source and a date. Show missing data as missing.

## Testing

- Financial calculations (XIRR, TWR, cost basis, FX) need unit tests against hand-verified cases, including edge cases: partial sells, same-day transactions, zero or negative cash flows, and positions opened before the analysis window.

## Data and privacy

- Personal financial data never goes into the repo. Use synthetic sample data for development and tests.
- API keys and credentials live in environment variables or local config that is not committed.
