---
name: us-midday
description: Midday re-check + adaptive adjustments (~12:30 ET ≈ 23:30 WIB). Manage stops/TP. Never delete prior decisions — cancel + replace with reasons.
---

You run the midday-management phase of Ray's US stock **paper** bot (goal: beat the S&P 500). Job: react to what changed since the open and adapt the plan — without ever erasing the morning's decisions.

## 0. Setup
- Work in `/Users/rayvenstrptr/Something/stocks` (request access if unmounted). **US bot — every data path below is under `markets/us/`; every `scripts/*.mjs` call takes `--market us`.**
- Read `strategy.md`, `config.json`, `state/portfolio.json`, today's `decisions/<ET-date>.md`, and today's rows in `decisions/decisions.ndjson` + `logs/trades.ndjson`.
- Confirm the US session is live today (WebSearch); if closed/holiday, log and STOP.
- IDEMPOTENCY: tag everything here `phase:"midday"`. If a midday block already ran today, only act on genuinely new information.

## 1. Re-check prices + news
WebFetch current prices for all open positions and any watchlist name that was near a buy threshold this morning; WebSearch for market-moving news since the open (catalysts, reversals, macro surprises). Fetch `^GSPC` too. Cite sources; drop unsourced.

## 2. Manage open risk
`node scripts/paper.mjs mark --prices '<json>' --auto-exit` — this records any stop-loss / take-profit exits hit since the open. (If Node is unavailable, evaluate stops/TP by hand and write the same `trades.ndjson` exits.)

## 3. Adapt — the core of this phase
- Re-score any name where material new info changed the picture (recompute Tech/Research/Conviction).
- **Never delete a prior decision.** If a morning decision is now wrong: APPEND a `decisions.ndjson` row with `event:"cancel"`, `cancels_decision_id:"<old id>"`, and a clear reason — THEN append the NEW decision (`event:"plan"` or directly `"open"`) with a fresh `decision_id` and reason. If it's actionable now, execute it via `paper.mjs` (`buy`/`sell`).
- Typical moves: add to a winner (`event:"add"`, only if conviction ≥ add-threshold and there's room), trim/raise-stop on a staller, or cut a thesis-broken name (`close`).
- The script enforces the daily-loss limit / circuit breaker; if an action is blocked, record that rather than overriding.

## 4. Document + snapshot
- APPEND a "## Midday amendments (<iso>)" section to today's `decisions/<ET-date>.md` (append below the morning plan — never edit the morning text). For each change, write: what was cancelled, the new decision, and WHY.
- `node scripts/paper.mjs equity --spx <^GSPC>` to refresh the equity row is optional midday; do it if positions changed materially.
- Append to `logs/bot.log`; chat summary of changes — or "held the plan, no changes warranted" with the one-line reason. Concise.
