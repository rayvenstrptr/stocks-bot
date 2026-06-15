# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Note: `~/CLAUDE.md` (the home-directory file) describes unrelated React/merchz projects and does **not** apply here. This repo is the stock-trading bot.

## What this is

Two **completely isolated paper-money** stock-trading bots — **US** (USD, beat S&P 500) and **IDX**
(Indonesia, IDR, beat JCI) — driven by **scheduled Claude cloud routines**, not a long-running local
process. A routine fires a few times per session, does the research/judgment, calls the deterministic
accounting engine, and updates its own files. No real money, no broker keys, no laptop required.

The two bots **share nothing at runtime**: separate equity, watchlist, logs, state, and dashboard.
The only shared code is `scripts/paper.mjs` and `scripts/dashboard.mjs`, both selected per-bot with
`--market us` | `--market idx`.

- **Live design:** [ROUTINES.md](ROUTINES.md) — the bots, schedules (cron in WIB), and how to register them.
- **[PLAN.md](PLAN.md) is SUPERSEDED** as a build plan (we pivoted from a single local Node bot to the
  routine model). Keep it only for its still-useful market research (Yahoo reachability, fees, DST, lots).

## Hard constraints (read before doing anything)

- **Paper only.** Never add real broker keys or place real orders.
- **Never touch `../mining`** (the sibling crypto bot) — it has a live evaluation run. We *copied* its
  patterns; we never import from or run it. Stay inside this folder.
- **The accounting engine never touches the network.** `scripts/paper.mjs` does pure money math only.
  Routines fetch prices/news (WebFetch Yahoo / WebSearch) and **pass prices in as args** — so the math
  never depends on the model doing arithmetic in its head.
- **Idempotency is required.** Re-running a phase the same day must not double-write. Guards key on the
  ET trading-day date and `decision_id`. State writes are atomic (tmp + rename); logs are append-only NDJSON.
- Node **>= 22**, ESM (`"type": "module"`), **zero dependencies** by design (no `npm install`).

## Commands

All paths are relative to repo root `/Users/rayvenstrptr/Something/stocks`. Every command takes
`--market us` or `--market idx` to resolve its data dir `markets/<m>/`.

```bash
# Accounting engine (deterministic, no network) — markets/<m>/{state,logs}
node scripts/paper.mjs status     --market us            # cash / positions / equity / P&L
node scripts/paper.mjs start-day  --market us            # snapshot day_start_equity (for daily-loss guard)
node scripts/paper.mjs buy   --symbol AAPL --price 210 --usd 150 --stop 197 --tp 230 --conviction 55 --decision-id 20260615-AAPL-1 --market us
node scripts/paper.mjs buy   --symbol NVDA --price 120 --stop 110 --tp 140 --market us     # 1%-risk sizing from stop distance (omit --usd)
node scripts/paper.mjs sell  --symbol AAPL --price 215 --all --market us                   # or --qty N (whole lots if !fractional)
node scripts/paper.mjs mark  --prices '{"AAPL":211,"NVDA":119}' --auto-exit --market us     # update last px; fire stop/TP exits
node scripts/paper.mjs equity --bench 5400 --market us    # snapshot equity.ndjson + alpha vs benchmark (--spx is an alias)

# Dashboard (self-contained HTML, no deps/CDN/server) — markets/<m>/dashboard.html
node scripts/dashboard.mjs --market idx                   # regenerate markets/idx/dashboard.html
node scripts/dashboard.mjs --market idx --demo            # dashboard-demo.html from synthetic data
node scripts/dashboard.mjs --market idx --serve --port 9000   # live server (regenerates per request)
node scripts/dashboard.mjs --market us  --serve --port 9001
```

There is **no build, no lint, no test suite.** To validate the pipeline end-to-end against throwaway
files (touches no live state), run the routine in `routines/{us,idx}-pipeline-test.md` — it uses the
`--portfolio/--trades/--equity-file` path overrides + `--dry-run` to write only to `/tmp/*_TEST*`.

## Architecture

### Per-market data layout (the core convention)

Both scripts compute `BASE = markets/<market>/` from `--market` and resolve everything under it. A bot
is fully described by its folder:

```
markets/<m>/
  config.json     # watchlist, blend weights/thresholds, risk caps, currency, lot_size, benchmark, data URLs
  strategy.md     # the human-readable playbook (the "why"); weekly review edits this + bumps version
  state/portfolio.json   # cash, positions[], realized_pnl, halted flag — atomic-written
  state/equity.ndjson    # daily equity curve + alpha vs benchmark (append-only)
  logs/trades.ndjson     # every fill (append-only)
  logs/bot.log           # human breadcrumbs each routine appends
  decisions/decisions.ndjson   # planned + executed decisions (the ML training data — keep the schema stable)
  research/research.ndjson     # per-name scored research rows
  reviews/lessons.ndjson       # graded lessons fed back into tomorrow's plan
  dashboard.html               # generated
```

`config.json` holds the numbers the **code** reads; `strategy.md` holds the reasoning. Keep them in sync.

### The decision pipeline (data flows in one direction, with a feedback loop)

```
research.ndjson  →  decisions.ndjson (plan)  →  trades.ndjson (fills)  →  equity.ndjson (alpha)
                                    ↑                                              ↓
                              lessons.ndjson  ←──────── reviews grade outcomes ────┘
```

Each phase is a routine in `routines/<m>-<phase>.md` (front-matter `name:`/`description:`; the body is
the prompt). They map to `strategy.md`'s trading-day phases:

- **premarket** — score open decisions, research last 24h, compute conviction, commit the day plan (plan-only, no fills).
- **open** — execute the planned buys/sells on paper, set stops/TP.
- **midday** — re-check; never delete a decision, `cancel` it (linked by id) and write a new one.
- **close-review** — mark-to-close, realize P&L, grade decisions HIT/MISS/UNCLEAR, append equity + alpha, write lessons.
- **weekly-review** — week vs benchmark → **edit `strategy.md` + `config.json`** (the improvement loop).

### The blended conviction model (shared by both bots)

For each candidate: **TechScore** ∈ [−100,100] (EMA9/21, EMA200, RSI14, ATR%) and **ResearchScore** ∈
[−100,100] (cited news/catalyst/sentiment). **Conviction = round(0.4·Tech + 0.6·Research)** (weights in
`config.json.blend`). Deterministic decision rule from thresholds: buy ≥ 40, add ≥ 25, trim ≤ −15,
close ≤ −30; otherwise hold or "stay in cash *on purpose*" (a logged decision, never indecision).

### Risk & accounting (enforced in `paper.mjs`, configured in `config.json.risk`)

- 1% equity risk per trade (sized from stop distance), ≤ 25%/name, ≤ 6 open positions, ~1% cash buffer.
- **Daily loss limit −4%** pauses new entries for the day; **circuit breaker −15%** sets `halted:true`
  in `portfolio.json` (only a weekly review / human flips it back).
- Fills modeled with per-market slippage + fee rate. **US:** `fractional_shares:true`, fees ≈ 0.
  **IDX:** `fractional_shares:false`, `lot_size:100` (buys/sells round DOWN to whole 100-share lots),
  heavier ~0.4–0.5% round-trip cost. No FX, no merged portfolio — each account stays in its own currency.
- "Trading day" = the **ET calendar date** (`dayKey`), even for IDX rows, so re-run guards are consistent.

### Market sessions (why this isn't a 24/7 bot)

US ~09:30–16:00 ET (your night, US **DST** shifts the WIB cron). IDX 09:00–16:00 WIB with a lunch
break, **no DST ever**. They barely overlap. Every routine re-checks "is my market open today?" at
runtime, so a mistimed cron (holiday / DST drift) just logs "market closed, no action".

## Registering & operating routines

Routines run via the **desktop Scheduled-tasks** mechanism (`/schedule`) — they mount this local folder,
run in Anthropic's cloud, and update files here. A coding session **cannot** call `/schedule` for you
(no GitHub-backed cloud env for this repo); the user types it. Flow: test once with the `*-pipeline-test`
routine → when green, `/schedule` one entry per row in ROUTINES.md's schedule tables. See
[ROUTINES.md](ROUTINES.md) for the WIB cron tables and the "what this CAN'T do" caveats (no real-time
reaction; stops only checked when a routine fires, so price can gap through them).
