# ROUTINES — two isolated paper bots

> **Proving-phase pivot (2026-06):** no longer 10 cloud routines. Now **2 cloud routines**
> (`idx-premarket`, `us-premarket`) + a **local daemon** (`scripts/daemon.mjs`) on the Mac doing
> feed→execute→review. The 8 open/midday/review cloud triggers are **disabled**. Live operating guide:
> **[scripts/run-local.md](scripts/run-local.md)**; current architecture: CLAUDE.md "What this is". The
> cron tables below now describe the *old* cloud phases (kept for reference) and the premarket times the
> daemon aligns its `feed` push to.

This repo runs **two completely separate paper-trading bots**, each driven by scheduled cloud
routines (no laptop needed — they run in Anthropic's cloud, mount this folder, update their own
files, post a chat summary). The bots share **nothing** at runtime: separate equity, watchlist,
logs, and dashboard.

| Bot | Dir | Capital | Benchmark | Session (local) | Dashboard |
|---|---|---|---|---|---|
| **IDX** (Indonesia) | `markets/idx/` | **Rp 10,000,000** | JCI (`^JKSE`) | WIB daytime, **no DST** | http://localhost:9000 |
| **US** | `markets/us/` | **$1,000** | S&P 500 (`^GSPC`) | ET (your night), US DST | http://localhost:9001 |

- Shared code: [scripts/paper.mjs](scripts/paper.mjs) (deterministic accounting) and
  [scripts/dashboard.mjs](scripts/dashboard.mjs) — both take **`--market idx`** or **`--market us`**
  to resolve `markets/<m>/`.
- Each bot's playbook + knobs: `markets/<m>/strategy.md` + `markets/<m>/config.json`.
- Routine prompt sources: [routines/idx-*.md](routines/) and [routines/us-*.md](routines/). Live
  copies land at `~/Claude/Scheduled/<name>/SKILL.md` once registered.

## IDX bot — schedule (cron in WIB; Mon–Fri; **no DST ever**)

IDX session: **Sesi I 09:00–12:00**, lunch **12:00–13:30**, **Sesi II 13:30–16:00 WIB**. All
phases run in your own daytime, same WIB day — no cross-midnight, no DST headaches.

| Routine | Phase | WIB | Cron |
|---|---|---|---|
| `idx-premarket` | research + commit the day plan | 07:45 | `45 7 * * 1-5` |
| `idx-open` | execute at the open (whole 100-lots) | 09:05 | `5 9 * * 1-5` |
| `idx-midday` | re-check after lunch, adapt | 13:35 | `35 13 * * 1-5` |
| `idx-close-review` | mark-to-close, P&L, alpha vs JCI, lessons | 16:15 | `15 16 * * 1-5` |
| `idx-weekly-review` | week vs JCI, edit the strategy | Fri 16:40 | `40 16 * * 5` |

## US bot — schedule (cron in WIB; the US session is your night)

US session 09:30–16:00 ET. Under **EDT** (now) that's ~20:30–03:00 WIB; the review crons fire
after WIB midnight so their day-of-week is shifted (`2-6` / `6`). Under **EST** (Nov–Mar) add
+1h to every WIB time. Optional `us-midday` (`32 23 * * 1-5`) — add later.

| Routine | Phase | WIB (EDT) | Cron |
|---|---|---|---|
| `us-premarket` | research + day plan | 18:05 | `5 18 * * 1-5` |
| `us-open` | execute at the open | 20:33 | `33 20 * * 1-5` |
| `us-close-review` | review + alpha vs SPX | 03:15 (Tue–Sat) | `15 3 * * 2-6` |
| `us-weekly-review` | weekly | Sat 03:30 | `30 3 * * 6` |

> Belt-and-suspenders: every routine checks "is my market open today?" at runtime, so a mistimed
> fire (e.g. a holiday, or US DST drift) just logs "market closed, no action".

## Registering — you do this via `/schedule`

Routines run through the **desktop Scheduled-tasks** mechanism (same one your `daily-markets-brief`
uses — mounts this local folder, runs in the cloud). It's driven by **you** typing `/schedule`; a
coding session can't call it for you (the claude.ai "Code on the web" trigger API needs a
GitHub-backed cloud environment, which this repo doesn't have).

**Per bot, in the desktop app:**
1. **Test once first** — `/schedule` → "Run `routines/idx-pipeline-test.md` once now, body verbatim."
   It validates cloud mount + Yahoo `.JK` fetch + whole-lot sizing against `/tmp` (touches no live
   file). When it's ✅ green, continue.
2. **Go live** — `/schedule` once per row in the IDX table above (use the routine file's body
   verbatim, on its WIB cron). Repeat with `routines/us-*.md` if you also want the US bot.
- **List / pause / reschedule:** `/schedule` → "list my scheduled tasks", "pause idx-open".
- **After a circuit breaker:** it sets `halted:true` in `markets/<m>/state/portfolio.json`; the
  weekly review (or you) flips it back to `false` with a reason.

## Dashboards

Each bot renders its own self-contained `markets/<m>/dashboard.html` (data inlined, SVG charts,
no server, phone-friendly). The `premarket`, `open`, and `close-review` routines run
`node scripts/dashboard.mjs --market <m>` so the cloud keeps it fresh.

```bash
node scripts/dashboard.mjs --market idx --serve --port 9000   # IDX live (this is running)
node scripts/dashboard.mjs --market us  --serve --port 9001   # US live
node scripts/dashboard.mjs --market idx                       # regenerate markets/idx/dashboard.html
node scripts/dashboard.mjs --market idx --demo                # markets/idx/dashboard-demo.html (sample data)
```

## What this CAN'T do (by design)
- **React in real time** — routines fire a few times/session, not continuously. News mid-session
  is handled at the next phase, never sub-minute. Add intraday "tick" routines for more reactivity.
- **Honor stops between runs** — paper stops are only checked when a routine fires; price can gap
  through a stop between runs (worse for IDX, which gaps on foreign flows).
- **Trade real money** — paper only, no broker keys.

## Manual ops (need the laptop)
```bash
cd /Users/rayvenstrptr/Something/stocks
node scripts/paper.mjs status --market idx          # IDX cash / positions / equity
node scripts/paper.mjs status --market us           # US
tail -n 5 markets/idx/state/equity.ndjson           # equity curve + alpha vs JCI
```
