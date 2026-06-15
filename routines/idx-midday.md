---
name: idx-midday
description: IDX midday re-check + adaptive adjustments after the lunch break (~13:35 WIB). Never delete prior decisions — cancel + replace with reasons.
---

Midday-management phase of Ray's **IDX** paper bot (beat the JCI). Files under `markets/idx/`; every `scripts/*.mjs` call takes `--market idx`.

## 0. Setup
- Work in `/Users/rayvenstrptr/Something/stocks` (request access if unmounted). Read `markets/idx/strategy.md`, `markets/idx/config.json`, `markets/idx/state/portfolio.json`, today's `markets/idx/decisions/<date>.md`, and today's rows in `markets/idx/decisions/decisions.ndjson` + `markets/idx/logs/trades.ndjson`.
- Confirm the afternoon session is live (IDX reopens 13:30 WIB after lunch). If closed/holiday, log and STOP. IDEMPOTENCY: tag everything `"phase":"midday"`; if a midday block already ran, act only on genuinely new info.

## 1. Re-check
WebFetch current prices for open positions + watchlist names that were near a buy threshold this morning; WebSearch for market-moving news since the open (rupiah, foreign flows, commodities, policy). Fetch `^JKSE`. Cite; drop unsourced.

## 2. Manage open risk
`node scripts/paper.mjs mark --market idx --prices '<json>' --auto-exit` (records any stop/TP hit since the open).

## 3. Adapt — never delete a prior decision
If a morning decision is now wrong: APPEND a `decisions.ndjson` row `event:"cancel"` with `cancels_decision_id` + a reason, THEN append the NEW decision (fresh `decision_id`). If actionable now, execute via `node scripts/paper.mjs buy|sell --market idx ...` (whole lots). Typical: add to a winner (if conviction ≥ add and room), trim/raise-stop a staller, cut a thesis-broken name. The script enforces loss-limit/breaker; if blocked, record it.

## 4. Document + snapshot
APPEND a `## Midday amendments (<iso>)` section to `markets/idx/decisions/<date>.md` (append below the morning plan — never edit it), documenting each cancel + replacement and WHY. Optionally `node scripts/paper.mjs equity --market idx --bench <^JKSE>`. Then `node scripts/dashboard.mjs --market idx`. Append `markets/idx/logs/bot.log`. Chat: the changes, or "held the plan, no change warranted" + the one-line reason.
