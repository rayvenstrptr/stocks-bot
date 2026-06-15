---
name: us-open
description: Execute the committed day plan on paper at the US open (~09:30 ET ≈ 20:30 WIB). Simulate fills, set stops/TP, log trades.
---

You operate the execution phase of Ray's US stock **paper** bot (goal: beat the S&P 500). You execute the plan written by `stocks-premarket`. Paper only — fills are simulated by `scripts/paper.mjs`.

## 0. Setup
- You run in a fresh clone of the `stocks-bot` repo (working dir = repo root; Node available; no local-machine access). **End every run by persisting state: `git add -A && git commit -m "us routine" && git pull --rebase origin main && git push`** — you only touch `markets/us/`, so it merges cleanly. **US bot — every data path below is under `markets/us/`; every `scripts/*.mjs` call takes `--market us`.**
- Read `strategy.md`, `config.json`, `state/portfolio.json`, and today's `decisions/<ET-date>.md` (the plan). If today's plan file is missing, append a note to `logs/bot.log` and STOP (nothing to execute).
- Confirm via WebSearch the US market is open today; if closed, log and STOP.
- IDEMPOTENCY: check `logs/trades.ndjson` for entries with today's ET date and `phase":"open"`. If the plan's orders are already filled, do NOT re-fill — just report current status.

## 1. Get prices
For every symbol in the plan AND every open position, WebFetch the Yahoo chart JSON (`config.json.data.quote_primary`, `{SYMBOL}`→ticker) and read `regularMarketPrice`. Also fetch `^GSPC` (`%5EGSPC`). Fallback to WebSearch quotes if blocked. Assemble a prices JSON like `{"AAPL":210.1,"NVDA":121.4,...}`.

## 2. Execute with the deterministic engine
All money math goes through `scripts/paper.mjs` (run `node --version` first; if Node is unavailable, do the arithmetic yourself exactly as `strategy.md` + the script specify, writing the same files). Run, in order:
1. `node scripts/paper.mjs mark --prices '<json>'` — value open positions at the open. Add `--auto-exit` ONLY if an overnight gap already breached a stop/TP.
2. `node scripts/paper.mjs start-day` — snapshot `day_start_equity` for the daily-loss limit.
3. For each BUY in the plan: `node scripts/paper.mjs buy --symbol S --price <open> [--usd N | --stop X] --stop X --tp Y --conviction C --decision-id <plan id> --phase open` (omit `--usd` to risk-size from `--stop`). The script enforces caps/halt and will refuse a blocked order — record that outcome rather than forcing it.
4. For each SELL/CLOSE/TRIM of an existing position: `node scripts/paper.mjs sell --symbol S --price <px> (--all | --qty Q) --reason "<plan reason>" --phase open`.

## 3. Link decisions + snapshot
- For each fill, APPEND a `decisions.ndjson` row (`event:"open"|"add"|"close"|"trim"`) carrying the plan's `decision_id` and the ACTUAL `fill_price`/`qty`/`fees_usd` (append only — never rewrite a prior row).
- `node scripts/paper.mjs equity --spx <^GSPC level>` — write today's equity row (this also sets inception SPX on day one).

## 4. Close out
- Refresh the dashboard: `node scripts/dashboard.mjs` (regenerates `dashboard.html` with the new fills/positions).
- Append to `logs/bot.log`: "<iso> open: filled <k> buys, <j> sells, cash=<$>, positions=<n>".
- Chat summary: what filled (symbol, qty, fill price, stop, TP), any orders the caps blocked, cash left, open positions, and equity vs SPX alpha. "No action needed yet" is a perfectly valid outcome — say so plainly.
