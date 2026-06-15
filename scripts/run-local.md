# Running the bot locally (proving phase)

The bot now runs in two places. **Cloud = judgment, device = mechanics.**

| Where | What | When |
|---|---|---|
| **Cloud** (2 routines) | `idx-premarket`, `us-premarket` — research + commit the day plan | before each open |
| **Device** (`daemon.mjs`) | `feed` → `execute` (open/midday) → `review` (daily/weekly), then commit/push | session phases |

Data flows by git: the device pushes `technicals-<date>.json` → cloud premarket reads it and pushes the
plan → the device's `execute` reads the plan. Only 2 git hand-offs/day/bot.

## Price sources

- **US → Alpaca** (`config.data.provider: "alpaca"`). Needs a **free paper account** at alpaca.markets →
  *Paper* API keys. Used **read-only for data, never for orders.** Reliable + batch; no `^GSPC` index, so
  the benchmark uses the **SPY** proxy.
- **IDX → Yahoo** (`config.data.provider: "yahoo"`). Alpaca has no `.JK` coverage. Yahoo rate-limits
  shared/datacenter IPs (you'll see HTTP 429), but generally works from a home ISP. If your ISP also 429s,
  switch IDX to a keyed provider (e.g. Twelve Data) — only `feed.mjs` changes.

## One-time setup

```bash
which node                                   # note the full path for the plist
# 1) Alpaca paper keys (US):
export ALPACA_API_KEY_ID=...                  # for a manual run; the daemon gets them from the plist
export ALPACA_API_SECRET_KEY=...
# 2) sanity-check the feed on YOUR network:
node scripts/feed.mjs --market us             # expect a table of prices (Alpaca)
node scripts/feed.mjs --market idx            # expect .JK prices (Yahoo) — if 429, see note above
node scripts/feed.mjs --selftest              # offline indicator-math check
# 3) install the daemon (fill in node path + keys in your copy first):
cp ops/com.stocksbot.daemon.plist ~/Library/LaunchAgents/
#    edit ~/Library/LaunchAgents/com.stocksbot.daemon.plist  → REPLACE_WITH_* values
launchctl load ~/Library/LaunchAgents/com.stocksbot.daemon.plist
```

## Caffeinate / sleep (US runs during your WIB night)

The daemon runs `caffeinate -i` automatically during the US session (≈09:25–16:40 ET) to **prevent**
sleep. It **cannot wake** a sleeping Mac — so leave the Mac on through the US night (lid open, or clamshell
on power). Optional backstop to *wake* it before the open:

```bash
sudo pmset repeat wake MTWRF 20:25:00          # 20:25 WIB ≈ a few min before the US open (EDT)
```

IDX needs nothing special — it trades in your daytime.

## Manual commands

```bash
node scripts/daemon.mjs --schedule                         # show clocks + what's due, run nothing
node scripts/daemon.mjs --once-now --market us --phase open # run feed→execute now (add --no-git to skip push)
node scripts/daemon.mjs --once-now --market idx --scope daily
node scripts/feed.mjs    --market idx                       # just refresh quotes + technicals
node scripts/execute.mjs --market us --phase open --git     # fill today's plan + push
node scripts/review.mjs  --market us --scope daily --git    # close, alpha, grade, push
node scripts/paper.mjs   status --market us                 # cash / positions / equity
node scripts/dashboard.mjs --market us --serve --port 9001  # live dashboard
tail -f markets/daemon.log                                  # watch the daemon
```

## What's deterministic vs human

`feed` / `execute` / `review` are pure deterministic Node (no LLM). The **qualitative** parts — rich
lessons, and editing `strategy.md` / `config.json` from the weekly suggestions — you do **on demand** by
running a local Claude session. The daemon never calls an LLM (keeps it zero-dependency).

## Caveats (proving phase)

- Stops are checked when the daemon ticks a phase (open/midday/close), not continuously — price can gap
  through a stop between runs (worse for IDX).
- If the Mac is asleep at a phase time, that phase is skipped; the next phase (`execute` is idempotent and
  fills any not-yet-executed plan orders) catches up.
- Paper only. Alpaca keys are paper keys, used for data; no real orders, ever.
