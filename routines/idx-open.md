---
name: idx-open
description: Execute the IDX day plan on paper at the 09:00 WIB open in whole 100-share lots. Runs ~09:05 WIB.
---

Execution phase of Ray's **IDX** paper bot (beat the JCI). Files live under `markets/idx/`; every `scripts/*.mjs` call takes `--market idx`. Paper fills are simulated by `scripts/paper.mjs`.

## 0. Setup
- You run in a fresh clone of the `stocks-bot` repo (working dir = repo root; Node available; no local-machine access). **End every run by persisting state: `git add -A && git commit -m "idx routine" && git pull --rebase origin main && git push`** — you only touch `markets/idx/`, so it merges cleanly. Read `markets/idx/strategy.md`, `markets/idx/config.json`, `markets/idx/state/portfolio.json`, and today's `markets/idx/decisions/<date>.md` (the plan). If the plan file is missing, append a note to `markets/idx/logs/bot.log` and STOP.
- Confirm the IDX is open today (WebSearch). IDEMPOTENCY: if `markets/idx/logs/trades.ndjson` already has today's `"phase":"open"` fills, report status and STOP.

## 1. Prices
WebFetch the current/open price for every plan symbol and every open position (Yahoo `{SYMBOL}`, `.JK`), plus `^JKSE` (`%5EJKSE`). Assemble `{"BBCA.JK":5925,...}`. Fallback WebSearch.

## 2. Execute (money math via paper.mjs — whole lots enforced)
1. `node scripts/paper.mjs mark --market idx --prices '<json>'` (add `--auto-exit` only if an overnight gap already breached a stop/TP).
2. `node scripts/paper.mjs start-day --market idx`.
3. Each BUY: `node scripts/paper.mjs buy --market idx --symbol S.JK --price <open> [--usd N | --stop X] --stop X --tp Y --conviction C --decision-id <plan id> --phase open` (omit `--usd` to risk-size from `--stop`; the script rounds DOWN to whole 100-lots and refuses if a cap/halt blocks — record that).
4. Each SELL/CLOSE/TRIM: `node scripts/paper.mjs sell --market idx --symbol S.JK --price <px> (--all | --qty <lots×100>) --reason "<plan reason>" --phase open`.

## 3. Link + snapshot
APPEND a `markets/idx/decisions/decisions.ndjson` row per fill (`event:"open"|"add"|"close"|"trim"`, plan `decision_id`, actual fill/qty/fees). `node scripts/paper.mjs equity --market idx --bench <^JKSE level>` (writes today's equity row; sets inception on day one).

## 4. Close out
`node scripts/dashboard.mjs --market idx`. Append to `markets/idx/logs/bot.log`. Chat: what filled (symbol, lots, fill, stop, TP), blocked orders, cash left, positions, equity vs JCI alpha. "No action needed yet" is a valid outcome.
