---
name: us-pipeline-test
description: One-time end-to-end test of the stock-bot pipeline against THROWAWAY *_TEST files. Validates cloud dir-mount, Yahoo WebFetch, and the paper engine. Touches no live state.
---

ONE-TIME PIPELINE TEST — prove the whole US stock-bot pipeline runs in this (cloud) environment TODAY, writing ONLY to throwaway files. **Do NOT modify any live file**: not `state/portfolio.json`, not the `*.ndjson` logs, not `decisions/`, `research/`, or `reviews/`.

## 0. Setup
- Work in `/Users/rayvenstrptr/Something/stocks`. If unmounted, request access to that folder. Report whether the mount succeeded — that is finding #1.
- Run `node --version`. If Node is missing, record it (production routines have a hand-math fallback) and continue with the research/file checks.
- **US bot — work against `markets/us/` (do NOT touch `markets/idx/`); pass `--market us` to every `scripts/paper.mjs` call.**

## 1. Data access check (critical)
WebFetch the Yahoo chart JSON from `config.json.data.quote_primary` for **AAPL, NVDA, SPY**, and the index **`%5EGSPC`**. Confirm you can parse `chart.result[0].meta.regularMarketPrice` and `.previousClose`. If WebFetch is blocked in this environment, fall back to WebSearch quotes and **clearly record that the fallback was needed** — that materially affects the live routines.

## 2. Paper engine on throwaway copies
Use the real prices you just fetched. Never touch live state — use the path overrides:
```
cp state/portfolio.json /tmp/pf_TEST.json
: > /tmp/trades_TEST.ndjson ; : > /tmp/equity_TEST.ndjson
A="--portfolio /tmp/pf_TEST.json --trades /tmp/trades_TEST.ndjson --equity-file /tmp/equity_TEST.ndjson"
node scripts/paper.mjs buy  --symbol AAPL --price <aapl> --usd 150 --stop <~6% below> --tp <~9% above> --conviction 55 --decision-id TEST-AAPL-1 $A
node scripts/paper.mjs buy  --symbol NVDA --price <nvda> --stop <~8% below> --tp <~12% above> --conviction 60 --decision-id TEST-NVDA-1 $A
node scripts/paper.mjs start-day $A
node scripts/paper.mjs mark   --prices '{"AAPL":<aapl>,"NVDA":<nvda>}' --auto-exit $A
node scripts/paper.mjs equity --spx <gspc> $A
node scripts/paper.mjs sell   --symbol AAPL --price <aapl> --all --reason test $A
node scripts/paper.mjs status $A
```
Confirm cash, equity, and the alpha-vs-SPX numbers look arithmetically sane.

## 3. Schema check
Write one sample row to `/tmp/research_TEST.ndjson` (the `research.ndjson` schema from `stocks-premarket`) and one to `/tmp/decisions_TEST.ndjson` (the `decisions.ndjson` schema). Confirm both parse as valid JSON.

## 4. Report (then clean up)
Start your chat message with exactly: **"✅ ONE-TIME pipeline test — no live stock-bot file was touched."** Then report:
1. Did the `stocks` folder mount?
2. Did Yahoo WebFetch work, or was the WebSearch fallback needed? (include one fetched price)
3. Did `node` + `scripts/paper.mjs` run? Paste the final `status` JSON.
4. The mock equity/alpha output.
5. Anything that would break the live routines (mount, network, Node, schema) — and the fix.

Finally `rm -f /tmp/*_TEST*` to clean up. Do not schedule anything; this is a manual one-shot.
