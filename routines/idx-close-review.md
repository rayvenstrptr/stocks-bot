---
name: idx-close-review
description: IDX after-close daily review (~16:15 WIB). Mark-to-close, P&L, grade decisions, alpha vs JCI, lessons for tomorrow.
---

Daily review of Ray's **IDX** paper bot. The headline metric is **alpha vs the JCI**. Files under `markets/idx/`; every `scripts/*.mjs` call takes `--market idx`. Be brutally honest.

## 0. Setup
- Work in `/Users/rayvenstrptr/Something/stocks` (request access if unmounted). Read `markets/idx/strategy.md`, `markets/idx/config.json`, `markets/idx/state/portfolio.json`, today's `markets/idx/decisions/<date>.md` + `decisions/decisions.ndjson` + `logs/trades.ndjson`.
- Confirm today was an IDX trading day; else log and STOP. IDEMPOTENCY: if `markets/idx/reviews/daily/<date>.md` exists, recompute for display but do NOT append a second `equity.ndjson` row or duplicate lessons.

## 1. Closing prices → mark → snapshot
- WebFetch closing prices for every open position and `^JKSE` (`%5EJKSE`); fallback WebSearch.
- `node scripts/paper.mjs mark --market idx --prices '<json>' --auto-exit` (capture close-triggered stops/TP; do NOT force-liquidate positions you intend to hold).
- `node scripts/paper.mjs equity --market idx --bench <close>` → writes today's equity row with bot return, JCI return, and **alpha**.

## 2. Grade every decision
For each decision made today (and earlier open calls that resolved), APPEND a `decisions.ndjson` `event:"grade"` row referencing `decision_id` (outcome HIT/MISS/UNCLEAR + `exit_reason`, `pnl_usd`, `pnl_pct`, `r_multiple`, `hold_days`). A miss is a miss.

## 3. Write `markets/idx/reviews/daily/<date>.md`
- **Scoreboard (lead):** today P&L Rp / %, equity, cash, open positions; cumulative bot vs JCI and **ALPHA**.
- **Trades:** count, wins/losses, avg R, best & worst, and *why*.
- **What worked / didn't:** research leg vs tech leg; stops/sizing (IDX gaps — were stops right?).
- **1–3 lessons for tomorrow:** concrete, actionable.

## 4. Lessons + close out
- APPEND each lesson to `markets/idx/reviews/lessons.ndjson`: `{"date":"<wib>","scope":"daily","lesson":"..","category":"sizing|timing|sector|risk|research|technical","action":"do|stop|continue","evidence":"..","weight":1-5}`.
- `node scripts/dashboard.mjs --market idx`. Append `markets/idx/logs/bot.log`. Chat: scoreboard + alpha + lessons. Concise.
