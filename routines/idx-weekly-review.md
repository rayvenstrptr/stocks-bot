---
name: idx-weekly-review
description: IDX Friday weekly review (~16:15 WIB). Week vs JCI, then EDIT markets/idx/strategy.md + config.json — the improvement loop.
---

Weekly review of Ray's **IDX** paper bot — where the strategy actually improves. Mission metric: **alpha vs the JCI**. Files under `markets/idx/`; every `scripts/*.mjs` call takes `--market idx`.

## 0. Setup
- You run in a fresh clone of the `stocks-bot` repo (working dir = repo root; Node available; no local-machine access). **End every run by persisting state: `git add -A && git commit -m "idx routine" && git pull --rebase origin main && git push`** — you only touch `markets/idx/`, so it merges cleanly. On the week's last IDX trading day after the close, read the last 5 `markets/idx/reviews/daily/*.md`, plus `markets/idx/state/equity.ndjson`, `logs/trades.ndjson`, `decisions/decisions.ndjson`, `reviews/lessons.ndjson`, `strategy.md`, `config.json`.
- IDEMPOTENCY: if `markets/idx/reviews/weekly/<YYYY-Www>.md` exists, recompute for display, don't double-write lessons.

## 1. Compute the week
Weekly bot return vs JCI (Mon open → Fri close from `equity.ndjson`); **weekly + cumulative alpha**; win-rate, avg R, expectancy, average cash exposure, worst drawdown; hit-rate by conviction bucket, by dominant leg (research vs tech), by sector. Did the rupiah / foreign-flow / commodity regime call pay off?

## 2. Diagnose
What drove P&L? Is research or tech adding value? Stops too tight for IDX gaps? Sizing / lot granularity right? Watchlist names that never trade or always lose?

## 3. Improve (the point)
- EDIT `markets/idx/strategy.md`: bump version, add a changelog entry, revise the prose and the **regime note**.
- If justified, EDIT `markets/idx/config.json` (`blend.weights`, `blend.thresholds`, `risk.*`, `watchlist`) — small, evidence-backed changes only; record the rationale in the strategy.md changelog.
- APPEND durable lessons to `markets/idx/reviews/lessons.ndjson` with `scope:"weekly"`.

## 4. Write + close out
Write `markets/idx/reviews/weekly/<YYYY-Www>.md` (scoreboard lead with alpha, diagnosis, exactly what you changed and why). `node scripts/dashboard.mjs --market idx`. Append `markets/idx/logs/bot.log`. Chat: weekly scoreboard, the biggest finding, the change you made. Concise.
