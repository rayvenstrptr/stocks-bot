---
name: us-weekly-review
description: Friday after-close weekly review (~16:30 ET ≈ 03:30 WIB Sat). Week vs S&P 500, what worked, and EDIT strategy.md / config.json — the improvement loop.
---

You run the weekly review of Ray's US stock **paper** bot. This is where the strategy actually improves: you diagnose the week and EDIT the playbook. Mission metric: **alpha vs the S&P 500**.

## 0. Setup
- Work in `/Users/rayvenstrptr/Something/stocks` (request access if unmounted).
- **US bot — every data path below is under `markets/us/`; every `scripts/*.mjs` call takes `--market us`.**
- Only meaningful on the week's last trading day after the close. Read the last 5 `reviews/daily/*.md`, plus `state/equity.ndjson`, `logs/trades.ndjson`, `decisions/decisions.ndjson`, `reviews/lessons.ndjson`, `strategy.md`, `config.json`.
- IDEMPOTENCY: if `reviews/weekly/<YYYY-Www>.md` exists, recompute for display but don't double-write lessons.

## 1. Compute the week
- Weekly bot return vs SPX (equity Monday open → Friday close from `equity.ndjson`); **weekly alpha** and cumulative alpha.
- Win-rate, avg R, expectancy, average cash exposure, worst intraweek drawdown.
- **Does the blend work?** Hit-rate by conviction bucket (do ≥60-conviction calls actually win more than 40–60?) and by which leg dominated (research-led vs tech-led outcomes), and by sector. This is the evidence for tuning the weights/thresholds.

## 2. Diagnose
Which decisions/themes drove P&L? Is the research leg or the tech leg adding value? Stops too tight or too loose? Sizing right? Watchlist names that never trade or always lose?

## 3. Improve (the point of this routine)
- EDIT `strategy.md`: bump the version, add a changelog entry, and revise the prose to reflect what you learned.
- If the data justifies it, EDIT `config.json` knobs — `blend.weights`, `blend.thresholds`, `risk.*`, or `watchlist` (add/drop a name). Make **small, evidence-backed** changes only, and record the rationale in the `strategy.md` changelog.
- APPEND durable lessons to `reviews/lessons.ndjson` with `scope:"weekly"`.

## 4. Write + close out
- Write `reviews/weekly/<YYYY-Www>.md`: the weekly scoreboard (lead with alpha), the diagnosis, and exactly what you changed and why.
- Append to `logs/bot.log`: "<iso> weekly: alpha_wk=<%>, cum_alpha=<%>, changed=<what>".
- Chat: weekly scoreboard, the single biggest finding, and the strategy change you made. Concise.
