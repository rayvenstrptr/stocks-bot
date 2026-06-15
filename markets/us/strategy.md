# Trading Strategy — v1 (the evolving playbook)

> This is the bot's policy. Every routine reads this file first. The **weekly review** edits
> it (bump the version, add a changelog entry). Numbers that the code reads live in
> `config.json`; this file is the *reasoning* behind them.

## Mission

Beat the **S&P 500** (total return) on a **long-only, US-only, $1000 paper** account.
The only metric that matters is **alpha = our cumulative return − SPX cumulative return**,
recorded daily in `state/equity.ndjson`. If we can't beat buy-and-hold SPY over a month,
the strategy is wrong and the weekly review must change it.

## The blended decision score

For each candidate symbol we compute two legs, each in **[−100, +100]**:

**TechScore** — price/structure, from Yahoo daily candles (and 1h when useful):
- EMA9 vs EMA21 (trend): fast above slow = positive, spread size scales magnitude.
- Price vs EMA200: above = constructive, below = headwind.
- RSI(14): 50–65 healthy momentum (positive); >75 overbought (fade positive); <35 weak.
- ATR% (volatility): informs stop distance and position size, not direction.
- Distance from prior close / 5-day move: stretched = lower add conviction.

**ResearchScore** — narrative/catalyst, from the last 24h (cite every point, drop the unsourced):
- Company news (earnings, guidance, product, legal, analyst actions).
- Sector + macro tone (rates, oil, USD, risk-on/off), and read-through to this name.
- Credible social/finance sentiment (signal vs hype — discount anonymous hype).
- "Already priced in?" — be honest; a known-good story that's fully priced is not a buy.

**Conviction = round(0.4·TechScore + 0.6·ResearchScore)** (weights in `config.json`).

### Decision rule (deterministic — this is what "no coin-flip" means)
- `conviction ≥ 40` and we have room → **BUY** (new position).
- `conviction ≥ 25` and already long and room → **ADD**.
- `−15 < conviction < 25` while long → **HOLD**.
- `conviction ≤ −15` while long → **TRIM** (take some off).
- `conviction ≤ −30` while long → **CLOSE**.
- No qualifying long today → **stay in cash** *on purpose*, with a one-line reason.

"Stay flat" is a real, logged decision — it is not the same as indecision. Never log a
wishy-washy "maybe"; every row commits to an action and a reason.

## Sizing & risk (long-only)

- Risk **1% of equity** per new trade, sized by stop distance: `qty ≈ (equity·0.01) / (entry − stop)`.
- Hard caps: **≤25% of equity per name**, **≤6 open positions**, never spend below ~1% cash buffer.
- Stops/targets default to ATR-based (`stop = entry − 1.5·ATR`, `tp = entry + 2.25·ATR`),
  tightened when conviction is lower. Fractional shares allowed so $1000 can diversify.
- **Daily loss limit −4%**: pause *new* entries for the rest of the day (manage existing only).
- **Circuit breaker −15%** from start: halt all new entries until the weekly review re-enables.
- Fills modeled at price × (1 + 0.05% slippage); US commissions ≈ 0 (tiny fee_rate only).

## The trading day (phases → routines)

1. **Pre-market** (`stocks-premarket`): score yesterday's open decisions; research last 24h;
   compute Tech/Research/Conviction for the watchlist; write `research/<date>.md` +
   `research.ndjson` and the committed **day plan** in `decisions/<date>.md` + `decisions.ndjson`.
2. **Open** (`stocks-open`): fetch open prices; execute the planned BUYs/SELLs on paper; set
   stops/TP; update `state/portfolio.json`; append `logs/trades.ndjson`. No-op is fine.
3. **Midday** (`stocks-midday`): re-check news + prices; manage stops/TP; adapt. **Never delete**
   a prior decision — `cancel` it (with reason, linked by id) and write a new one.
4. **Daily review** (`stocks-close-review`): mark-to-close, realize P&L, grade each decision
   HIT/MISS/UNCLEAR, append `equity.ndjson` (with **alpha vs SPX**), write the daily review +
   `lessons.ndjson` rows for tomorrow.
5. **Weekly review** (`stocks-weekly-review`, Fri close): week vs SPX, win-rate, R-distribution,
   what worked / what didn't → **edit this file + `config.json`** (the improvement loop).

## Operating principles

- WebSearch/WebFetch **everything** — markets change daily, never answer price/news from memory.
- Cite a source per research claim; drop anything you can't source.
- Idempotent: re-running a phase the same day must not double-write (guard on date + decision_id).
- Be brutal in scoring — a miss is a miss. The training data is only useful if it's honest.

## Changelog
- **v1 (2026-06-15)** — initial playbook. Weights tech 0.4 / research 0.6; buy≥40, close≤−30;
  1% risk, ≤25%/name, ≤6 names. To be revised by weekly reviews from live results.
