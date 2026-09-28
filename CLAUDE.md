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

- `src/domain/` — calculation engine, no I/O: ledger replay with average cost (`holdings.ts`), FX (`fx.ts`), valuation (`valuation.ts`), portfolio series and flows per scope (`portfolio.ts`), XIRR/TWR (`returns.ts`), PME/KS-PME (`benchmark.ts`), month-end manual values (`monthlyClose.ts`), validation of new transactions (`validate.ts`).
- `src/data/` — CSV/JSON import and export; `json.ts` defines the stored `Dataset` (also the backup format).
- `src/app/` — Preact UI. `analysis.ts` turns the engine into report rows (pure, unit-tested); `tracking.ts` builds the month-by-month grid (asset, class, subtotal without real estate, total) used by Seguimiento and the month-end close; `stocks.ts` builds the price-tracking rows (entry price, target, 52-week range) and closed trades for Precios; `indicators.ts` builds Indicadores (weight per holding, composition by market/strategy/idea source/style, potential to the base and optimistic targets); `selection.ts` is the Resumen's pick of classes, added up by the `mix` scope in `portfolio.ts`; `views/` are the screens; data persists in the browser's IndexedDB (`store.ts`), never on a server.
- `npm run build` produces a single self-contained `dist/index.html` that opens from disk (`scripts/inline.ts`). `npm run test:e2e` drives it with Playwright from `file://`.
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
