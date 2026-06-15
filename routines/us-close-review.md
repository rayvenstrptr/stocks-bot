---
name: us-close-review
description: After-close daily review (~16:15 ET ≈ 03:15 WIB next day). Mark-to-close, realize P&L, grade decisions, record alpha vs S&P 500, write lessons for tomorrow.
---

You run the daily review of Ray's US stock **paper** bot. The mission metric is **alpha vs the S&P 500** — every review leads with it. Be brutally honest; the logs are only useful if they're true.

## 0. Setup
- You run in a fresh clone of the `stocks-bot` repo (working dir = repo root; Node available; no local-machine access). **End every run by persisting state: `git add -A && git commit -m "us routine" && git pull --rebase origin main && git push`** — you only touch `markets/us/`, so it merges cleanly. **US bot — every data path below is under `markets/us/`; every `scripts/*.mjs` call takes `--market us`.**
- Read `strategy.md`, `config.json`, `state/portfolio.json`, today's `decisions/<ET-date>.md` + `decisions/decisions.ndjson`, and today's `logs/trades.ndjson`.
- Confirm today was a US trading day (WebSearch); if not, log and STOP.
- IDEMPOTENCY: if `reviews/daily/<ET-date>.md` already exists, recompute for display but do NOT append a second `equity.ndjson` row or duplicate `lessons.ndjson` rows for today.

## 1. Closing prices → mark → snapshot
- WebFetch closing prices for every open position and `^GSPC` (`%5EGSPC`); fallback WebSearch.
- `node scripts/paper.mjs mark --prices '<json>' --auto-exit` — capture any close-triggered stops/TP. Do NOT force-liquidate positions you intend to hold overnight; just mark them.
- `node scripts/paper.mjs equity --spx <close>` — writes today's `equity.ndjson` row: equity, cash, `bot_ret_since_incept`, `spx_ret_since_incept`, and **alpha**.

## 2. Grade every decision (learn)
For each decision made today, and any earlier open call that resolved today, set `outcome` HIT / MISS / UNCLEAR and fill the outcome fields by APPENDING a `decisions.ndjson` row with `event:"grade"` referencing the `decision_id` (`exit_reason`, `pnl_usd`, `pnl_pct`, `r_multiple`, `hold_days`, `outcome`). A miss is a miss — say so.

## 3. Write `reviews/daily/<ET-date>.md`
- **Scoreboard (lead with this):** today P&L $ / %, equity, cash, open positions; cumulative bot return vs SPX and **ALPHA**.
- **Trades:** count, wins/losses, avg R, best & worst, and *why* each worked or didn't (thesis vs outcome).
- **What worked / what didn't:** did the research leg or the tech leg call it right? Were stops/sizing appropriate?
- **1–3 lessons for tomorrow:** concrete and actionable (e.g. "stop tighter than 1.5·ATR on earnings days — gapped through twice").

## 4. Persist lessons + close out
- APPEND each lesson to `reviews/lessons.ndjson`: `{"date":"<ET>","scope":"daily","lesson":"..","category":"sizing|timing|sector|risk|research|technical","action":"do|stop|continue","evidence":"..","weight":1-5}`. The premarket routine reads these tomorrow.
- Regenerate the dashboard: `node scripts/dashboard.mjs` (refreshes `dashboard.html` — the equity curve, P&L, decisions, and lessons you review in the browser).
- Append to `logs/bot.log`: "<iso> review: pnl=<$>, equity=<$>, alpha=<%>, lessons=<n>".
- Chat: the scoreboard + alpha + the lessons. Concise.
