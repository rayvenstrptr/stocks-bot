# Trading Strategy — IDX — v1 (the evolving playbook)

> The IDX bot's policy. Every IDX routine reads this first. The **weekly review** edits it
> (bump the version, add a changelog entry). Numbers the code reads live in
> `markets/idx/config.json`; this file is the *reasoning*. This bot is **fully separate** from
> the US bot (own equity, watchlist, logs, dashboard).

## Mission

Beat the **JCI (IDX Composite, `^JKSE`)** total return on a **long-only, IDX-only,
Rp 10,000,000 paper** account. The only metric that matters is **alpha = our cumulative
return − JCI cumulative return**, recorded daily in `state/equity.ndjson`.

## Current regime (update in the weekly review)

- **2026-06: Iran–US peace deal → oil down.** Indonesia is a **net oil importer**, so lower oil
  is a tailwind: **banks** (foreign inflows, risk-on, rate relief), **consumer** (lower input
  cost), **autos/Astra** benefit; **energy/coal (ADRO, PGAS) and oil-linked** are headwinds.
  The JCI reclaimed ~6,000 on this. Tilt the book toward net-importer beneficiaries; treat
  coal/energy longs with suspicion. **This is a research input, not a hard rule** — re-verify
  every morning; regimes flip.

## The blended decision score (same engine as US)

Two legs, each in **[−100, +100]**:
- **TechScore** — EMA9/21 cross, price vs EMA200, RSI(14), ATR%, distance from prior close,
  from Yahoo daily candles for the `.JK` ticker.
- **ResearchScore** — last-24h company/sector/macro news + credible local finance sentiment.
  Indonesia-specific drivers: BI rate decisions (RDG), rupiah (USD/IDR), foreign net flows,
  commodity prices (oil, coal, nickel, CPO), government/policy. **Cite every point; drop the
  unsourced.**
- **Conviction = round(0.4·TechScore + 0.6·ResearchScore)** (weights in `config.json`).

### Decision rule (deterministic — "no coin-flip")
- `conviction ≥ 40` & room → **BUY**; `≥ 25` & already long & room → **ADD**.
- `−15 < conviction < 25` while long → **HOLD**; `≤ −15` → **TRIM**; `≤ −30` → **CLOSE**.
- No qualifying long → **stay in cash on purpose**, with a one-line reason.

## Sizing & risk (long-only, IDX rules)

- **Round 100-share lots only — no fractional shares.** `scripts/paper.mjs --market idx`
  enforces this (sizes down to whole lots).
- Risk **1% of equity** per new trade by stop distance; caps **≤25%/name**, **≤6 names**,
  keep a cash buffer. Capital is **Rp 10,000,000** — at this size round-lot pricey names
  (UNTR etc.) afford only ~1 lot, so favor lower-priced liquid names (BBRI, GOTO, ANTM, TLKM)
  to actually diversify; accept fewer, larger positions otherwise.
- Stops/targets ATR-based (`stop = entry − 1.5·ATR`, `tp = entry + 2.25·ATR`), tightened when
  conviction is lower. **Widen stops on foreign-flow-driven names — IDX gaps hard.**
- Costs: fill × (1 + 0.1% slippage) + 0.2%/side fee ≈ **~0.5% round trip** (IDX is heavier than
  US — brokerage + levy + 0.1% sell tax). This drag means marginal setups aren't worth it.
- **Daily loss limit −4%** pauses new entries; **circuit breaker −15%** halts (re-enable in the
  weekly review).

## The trading day (phases → IDX routines, all WIB)

IDX trades in the user's **own timezone, daytime** — no overnight, **no DST ever**. Session:
**Sesi I 09:00–12:00**, lunch **12:00–13:30**, **Sesi II 13:30–16:00 WIB** (close 16:00).
T+2 settlement.

1. **Pre-market** (`idx-premarket`, ~07:45 WIB): score yesterday; research last 24h; write
   `research/<date>.md` + `research.ndjson` and the committed day plan in `decisions/<date>.md`.
2. **Open** (`idx-open`, ~09:05 WIB): execute on paper in whole lots; set stops/TP.
3. **Midday** (`idx-midday`, ~13:35 WIB, post-lunch): re-check, adapt; cancel+replace (never delete).
4. **Daily review** (`idx-close-review`, ~16:15 WIB): mark-to-close, P&L, **alpha vs JCI**, lessons.
5. **Weekly review** (`idx-weekly-review`, Fri ~16:15 WIB): week vs JCI, edit this file + config.

## Operating principles

- WebSearch/WebFetch **everything**; cite per claim; drop the unsourced.
- Watch the **rupiah and foreign flows** — they move IDX more than single-name stories.
- Idempotent re-runs (guard on date + decision_id). Be brutal in scoring — a miss is a miss.

## Changelog
- **v1 (2026-06-15)** — initial IDX playbook (cloned from US engine; IDR, JCI, round-100 lots,
  IDX fees/hours, peace/oil regime note). To be revised by weekly reviews.
