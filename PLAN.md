# Stock Trading Bot — Plan

> ⚠️ **SUPERSEDED (2026-06-15) by the routine-driven approach.** We pivoted from a single
> local Node.js bot to **two isolated, research-driven paper bots (US + IDX) run entirely by
> Claude cloud routines** (laptop can stay off), each aiming to **beat its benchmark**
> (US → S&P 500, IDX → JCI). The live system is [ROUTINES.md](ROUTINES.md) + per-market
> `markets/{us,idx}/` (each with its own `config.json`, `strategy.md`, `state/`, `logs/`,
> `dashboard.html`) + [scripts/paper.mjs](scripts/paper.mjs) + [scripts/dashboard.mjs](scripts/dashboard.mjs).
> This file is kept for the still-useful market research below (Yahoo reachability, fees, DST,
> lot rules) — not as the build plan.

**Status: PLANNING. Nothing is built yet.** This file is the living design doc — we
iterate here before writing any code.

> ⚠️ Sibling to the crypto bot in `../mining`, which has a **live paper-trading
> evaluation run in progress (ends ~2026-06-26)**. Do not touch, import from, or run
> anything in `../mining` in a way that could disturb its running bots. We *copy* its
> proven patterns into here when we build; we never reach across at runtime.

## What this is

A fully local, **paper-money** stock trading bot (no real money, no broker keys) with a
monitoring dashboard — the same idea as the crypto bot, applied to stocks. Two markets:

- **US equities** (priced in **USD**) — e.g. AAPL, MSFT…
- **Indonesian equities / IDX** (priced in **IDR**) — e.g. BBCA.JK, TLKM.JK…

…on **1-hour candles**, reusing the crypto bot's proven architecture
(feed → bot → broker → persist → dashboard → backtester) and rewriting only the parts
that are genuinely different for stocks.

## Why a separate project (decided 2026-06-14)

- The crypto bot has a **live run** that must stay stable. Mixing stock logic into it
  risks the very files (`config.js`, `bot.js`, `exchange.js`) the live bots depend on.
- The differences run deeper than the data source — **market hours** alone restructure
  the core loop (stocks aren't 24/7), so this isn't a config swap.
- Two projects = two clean mental models, two dashboards, two log sets.
- But we **don't start from scratch**: ~60% of the crypto scaffolding is asset-agnostic
  and gets copied + adapted.

## Verified facts (curl from the user's ISP — Biznet, Jakarta, 2026-06-14)

The whole thing gated on "can we reach stock data from this ISP?" — answer: **yes, from a
single source.**

- **Yahoo Finance is reachable for BOTH markets**, via two hosts
  (`query1` + `query2.finance.yahoo.com`):
  - US: `AAPL` → HTTP 200, JSON, **currency USD**, NasdaqGS, **intraday 1h** candles ✅
  - IDX: `BBCA.JK`, `TLKM.JK` → HTTP 200, JSON, **currency IDR**, exchange "Jakarta", 1h ✅
  - Metadata confirms US is currently on daylight time (gmtoffset −4h) — see DST note below.
- **CoinGecko control** returned 200, so the path is genuinely open (not a fluke).
- **Stooq** (a backup idea) sits behind a JavaScript bot-wall — unusable by plain HTTP.
  We don't need it; Yahoo's two hosts give built-in failover.
- ⚠️ Yahoo's chart API is **unofficial** — no SLA, can rate-limit (429) or change shape.
  Mitigation: a **single feed process** polls Yahoo and writes a file; all bots read the
  file (exactly the crypto `feed.js` pattern), plus retry/backoff. Fine for paper; a real
  broker feed would replace it for go-live.

**Consequence:** one data adapter, two ticker formats (`AAPL` vs `BBCA.JK`). The data
integration we feared doubling is actually single.

## Architecture decisions

1. **Market-adapter layer.** A `markets/` folder where each market declares its own rules:
   - `markets/us.js` and `markets/idx.js`
   - Each exposes: trading **hours** + **holiday calendar**, **lot rule**, **fee model**,
     **currency**, **ticker format**, and how to **fetch candles** from Yahoo.
   - The bot loop stays market-agnostic: it asks the adapter "is the market open now?" and
     "how do I size/cost an order here?"
2. **Two currency-isolated bots**, mirroring the crypto multi-bot design
   (`DATA_DIR`/`PORT`/`SYMBOLS` per bot):
   - a **USD** bot for US, an **IDR** bot for IDX.
   - **No FX conversion, no merged portfolio** — each account lives entirely in its own
     currency. Cleaner, and avoids inventing currency risk in a paper test.
3. **Sequencing:** build the adapter so both markets work, but go live **US first**, then
   switch on IDX once the first is stable. (Debugging two integrations at once hides bugs.)

## What's genuinely different from crypto (the new code)

| Area | Crypto (today) | Stocks (to build) |
|---|---|---|
| **Hours** | 24/7, always open | US ~9:30–16:00 ET; IDX ~09:00–15:00 WIB w/ midday break. Loop must check "is market open?" |
| **Overnight gaps** | none (continuous) | price can **gap through a stop** while closed → strategy must expect gap fills |
| **Lot size** | any fraction | IDX = **round 100-share lots**; US = whole (or fractional) shares |
| **Fees** | ~0.3% round trip | US ~0 (tiny SEC fees); IDX **~0.4–0.5% round trip** (sell-side tax) → heavier drag |
| **DST** | n/a | US session shifts ±1h twice a year; IDX never does |
| **Currency** | USDT | USD vs **IDR** (big numbers, ~16,000/USD) → per-market formatting |
| **Corporate actions** | none | splits/dividends adjust history → backtest must use adjusted data |

In WIB: **IDX trades your daytime (~9am–3pm)**, **US trades your night
(~8:30pm–3:00am right now)** — they barely overlap, so only one market is "active" at a
time even though both bot processes run. The Mac must stay awake overnight for US
(`caffeinate`, same as crypto).

## What we reuse from ../mining (copy + adapt, don't import at runtime)

- `strategy.js` — EMA 9/21 + RSI + ATR, signal logic, ML feature derivation. Pure math, mostly as-is.
- `broker.js` — paper fills/fees/slippage/sizing/risk caps **skeleton**; retune fees + add lot rounding per market.
- `persist.js` — atomic state writes + NDJSON logs, unchanged.
- The **decision-log schema** (`decisions.ndjson`) — the user's planned ML training data; keep the same shape.
- `dashboard.js` + `compare.js` — monitoring UI, light adaptation for currency display.
- `backtest.js` — replay harness; must share the strategy code path with live, same as crypto.
- `feed.js` / `run-feed.sh` / `run-bot.sh` — the supervised shared-feed pattern.

## Open questions (let's decide together)

1. **US universe** — which tickers to start with? (Liquid large-caps: AAPL, MSFT, NVDA, AMZN, GOOGL…?)
2. **IDX universe** — which tickers? (Blue chips: BBCA, BBRI, TLKM, BMRI, ASII…?)
3. **Starting capital per bot** — crypto uses 100 USDT. Proposed: **US = 100 USD**,
   **IDX = ~10,000,000 IDR (~$625)** so a 100-share lot isn't an absurd fraction of the account.
4. **Strategy gap-handling** — add an overnight-gap guard (e.g. don't enter right at the open),
   or run the crypto strategy as-is first and measure the damage?
5. **Backtest history depth** — verify how far back Yahoo serves 1h candles (likely ~2 years) —
   enough for the 90/180-day backtests you run on crypto.

## Build roadmap (when we finish planning)

1. **Data adapter + feed** — Yahoo → `market.json` (tickers + 1h candles), one feed process, retry/backoff.
2. **Market-hours/session layer** — `markets/us.js`, `markets/idx.js`: open/closed, holidays, DST.
3. **Broker per-market rules** — lot rounding (IDX 100), fee models, currency.
4. **Wire the loop** — reuse `bot.js`/`strategy.js`/`persist.js`; bot skips cycles when its market is closed.
5. **Backtest validation** — confirm the strategy behaves on stock data (gaps!), compare to buy & hold.
6. **Go live (paper)** — US first on its own feed/account, then IDX.
