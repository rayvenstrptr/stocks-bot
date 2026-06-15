---
name: idx-pipeline-test
description: One-time end-to-end test of the IDX bot pipeline against THROWAWAY /tmp files. Validates cloud mount, Yahoo .JK fetch, whole-lot sizing. Touches no live state.
---

ONE-TIME IDX PIPELINE TEST — prove the IDX bot runs end-to-end in this (cloud) environment TODAY, writing ONLY to throwaway files. **Do NOT modify any live file under `markets/idx/`.**

## 0. Setup
- Work in `/Users/rayvenstrptr/Something/stocks` (request access if unmounted; report whether it mounted — finding #1). Run `node --version`.

## 1. Data access check (critical)
WebFetch the Yahoo chart JSON for **BBCA.JK, BBRI.JK, ASII.JK** and the index **`%5EJKSE`** (from `markets/idx/config.json` `data.quote_primary`). Confirm `chart.result[0].meta.regularMarketPrice` + `.previousClose` parse and currency is **IDR**. If WebFetch is blocked, fall back to WebSearch and RECORD that the fallback was needed.

## 2. Engine on throwaway copies (whole-lot sizing)
```
cp markets/idx/state/portfolio.json /tmp/idx_pf_TEST.json
: > /tmp/idx_tr_TEST.ndjson ; : > /tmp/idx_eq_TEST.ndjson
A="--config markets/idx/config.json --portfolio /tmp/idx_pf_TEST.json --trades /tmp/idx_tr_TEST.ndjson --equity-file /tmp/idx_eq_TEST.ndjson"
node scripts/paper.mjs buy --symbol BBCA.JK --price <bbca> --stop <~6% below> --tp <~9% above> --conviction 60 $A
node scripts/paper.mjs buy --symbol BBRI.JK --price <bbri> --stop <~7% below> --tp <~10% above> --conviction 55 $A
node scripts/paper.mjs start-day $A
node scripts/paper.mjs mark --prices '{"BBCA.JK":<bbca>,"BBRI.JK":<bbri>}' --auto-exit $A
node scripts/paper.mjs equity --bench <jkse> $A
node scripts/paper.mjs sell --symbol BBCA.JK --all --price <bbca> --reason test $A
node scripts/paper.mjs status $A
```
Confirm every `qty` is a **multiple of 100** (whole lots) and cash / equity / alpha-vs-JCI look sane.

## 3. Schema check
Write one sample row to `/tmp/idx_research_TEST.ndjson` and one to `/tmp/idx_decisions_TEST.ndjson` (the schemas from `idx-premarket`); confirm both parse as valid JSON.

## 4. Report (then clean up)
Start with exactly: **"✅ ONE-TIME IDX pipeline test — no live file was touched."** Then report: (1) did the folder mount? (2) did Yahoo `.JK` WebFetch work or was the fallback needed (include one fetched IDR price)? (3) did `node` + `paper.mjs` run? paste the final `status`. (4) were quantities whole 100-lots? (5) mock equity / alpha vs JCI. (6) anything that would break the live routines. Finally `rm -f /tmp/idx_*_TEST*`.
