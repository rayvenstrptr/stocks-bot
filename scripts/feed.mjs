#!/usr/bin/env node
// feed.mjs — fetch daily candles from a pluggable provider, compute indicators, write quotes + technicals.
// This is the LOCAL price source (the device reaches data the cloud can't). It NEVER calls paper.mjs —
// pure fetch + math. Providers (per market, via config.data.provider):
//   'alpaca' — US equities, keyed + reliable + batch. Needs env ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY
//              (free paper account at alpaca.markets; used READ-ONLY for data, never for orders).
//   'yahoo'  — US + IDX (.JK / ^JKSE). No key, but rate-limits shared IPs; fine on a home ISP.
//
//   node scripts/feed.mjs --market us               # provider from config
//   node scripts/feed.mjs --market idx --dry-run
//   node scripts/feed.mjs --selftest                # verify indicator math offline (no network)
//
// Writes (unless --dry-run):
//   markets/<m>/state/quotes.json                  { asof, date, bench_symbol, bench_level, prices:{SYM:last} }
//   markets/<m>/research/technicals-<dayKey>.json   { asof, date, bench:{...}, names:{SYM:{ema9,ema21,ema200,rsi14,atr_pct,...}} }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; } } }
  return o;
}
const o = parseArgs(process.argv.slice(2));
const DRY = !!o['dry-run'];

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const dayKey = (d = new Date()) => ET_DATE.format(d); // trading day = ET date (matches paper.mjs)
const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => (x == null || Number.isNaN(x) ? null : Math.round((x + Number.EPSILON) * 100) / 100);
const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
function writeJSONAtomic(p, obj) { const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, p); }

// ---------- indicators (computed from a price series, provider-agnostic) ----------
function ema(vals, p) { if (!vals || vals.length < p) return null; const k = 2 / (p + 1); let e = vals.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < vals.length; i++) e = vals[i] * k + e * (1 - k); return e; }
function rsi(vals, p = 14) {
  if (!vals || vals.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = vals[i] - vals[i - 1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < vals.length; i++) { const d = vals[i] - vals[i - 1]; ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p; al = (al * (p - 1) + (d < 0 ? -d : 0)) / p; }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function atr(highs, lows, closes, p = 14) {
  const n = closes.length; if (n < p + 1) return null;
  const tr = [];
  for (let i = 1; i < n; i++) { const h = highs[i], l = lows[i], pc = closes[i - 1]; if (h == null || l == null || pc == null) continue; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
  if (tr.length < p) return null;
  let a = tr.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
  return a;
}
function tech(s) {
  const { closes, highs, lows, last, prev_close } = s;
  const e200 = ema(closes, 200), a = atr(highs, lows, closes, 14);
  return {
    last: r2(last), prev_close: r2(prev_close),
    gap_pct: prev_close ? r2(((last - prev_close) / prev_close) * 100) : null,
    ema9: r2(ema(closes, 9)), ema21: r2(ema(closes, 21)), ema200: r2(e200),
    rsi14: r2(rsi(closes, 14)), atr_pct: a != null && last ? r2((a / last) * 100) : null,
    above_ema200: e200 != null ? last > e200 : null, candles: closes.length,
  };
}

// ---------- provider: yahoo (US + IDX) ----------
let YSESSION;
async function yahooSession() {
  if (YSESSION) return YSESSION;
  let cookie = '', crumb = '';
  try {
    const r1 = await fetch('https://finance.yahoo.com/quote/AAPL', { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    cookie = (r1.headers.getSetCookie ? r1.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
    if (cookie) { const rc = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } }); if (rc.ok) { const c = (await rc.text()).trim(); if (c && !/too many|<!doctype/i.test(c)) crumb = c; } }
  } catch { /* try plain */ }
  return (YSESSION = { cookie, crumb });
}
function yahooUrl(tmpl, sym) {
  let u = tmpl.replace('{SYMBOL}', encodeURIComponent(sym));
  u = /range=/.test(u) ? u.replace(/range=[^&]*/, 'range=1y') : u + (u.includes('?') ? '&' : '?') + 'range=1y';
  u = /interval=/.test(u) ? u.replace(/interval=[^&]*/, 'interval=1d') : u + '&interval=1d';
  return u;
}
async function yahooOne(cfg, sym) {
  const { cookie, crumb } = await yahooSession();
  const tmpls = [cfg.data?.quote_primary, cfg.data?.quote_secondary].filter(Boolean);
  let lastErr;
  for (const t of tmpls) for (let a = 0; a < 3; a++) {
    try {
      let url = yahooUrl(t, sym); if (crumb) url += (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(crumb);
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) } });
      if (res.status === 429) throw new Error('HTTP 429 (rate-limited)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = (await res.json())?.chart?.result?.[0]; if (!r) throw new Error('no chart.result');
      const meta = r.meta || {}, q = r.indicators?.quote?.[0] || {}, ts = r.timestamp || [];
      const closes = [], highs = [], lows = [];
      for (let i = 0; i < ts.length; i++) { const c = q.close?.[i]; if (c == null) continue; closes.push(c); highs.push(q.high?.[i]); lows.push(q.low?.[i]); }
      return { closes, highs, lows, last: meta.regularMarketPrice ?? closes.at(-1), prev_close: meta.chartPreviousClose ?? closes.at(-2) ?? null, currency: meta.currency };
    } catch (e) { lastErr = e; await sleep(700 * (a + 1) + Math.random() * 500); }
  }
  throw lastErr || new Error('fetch failed');
}
async function yahooProvider(cfg, syms) {
  const out = {};
  for (const s of syms) { try { out[s] = await yahooOne(cfg, s); } catch (e) { out[s] = { error: String(e.message || e) }; } await sleep(250 + Math.random() * 200); }
  return out;
}

// ---------- provider: alpaca (US only, keyed, batch) ----------
async function alpacaProvider(cfg, syms) {
  const id = process.env.ALPACA_API_KEY_ID, secret = process.env.ALPACA_API_SECRET_KEY;
  if (!id || !secret) throw new Error('alpaca provider needs env ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY (free paper account at alpaca.markets)');
  const feed = cfg.data?.feed || 'iex';
  const H = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': secret, Accept: 'application/json' };
  const start = new Date(Date.now() - 400 * 86400e3).toISOString().slice(0, 10);
  const barsBySym = {};
  let token = null;
  do { // daily bars, paginated
    const u = new URL('https://data.alpaca.markets/v2/stocks/bars');
    u.searchParams.set('symbols', syms.join(',')); u.searchParams.set('timeframe', '1Day');
    u.searchParams.set('start', start); u.searchParams.set('limit', '10000');
    u.searchParams.set('adjustment', 'split'); u.searchParams.set('feed', feed);
    if (token) u.searchParams.set('page_token', token);
    const res = await fetch(u, { headers: H });
    if (!res.ok) throw new Error(`alpaca bars HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
    const j = await res.json();
    for (const [s, arr] of Object.entries(j.bars || {})) (barsBySym[s] ||= []).push(...arr);
    token = j.next_page_token || null;
  } while (token);
  let snaps = {};
  try { const su = new URL('https://data.alpaca.markets/v2/stocks/snapshots'); su.searchParams.set('symbols', syms.join(',')); su.searchParams.set('feed', feed); const sr = await fetch(su, { headers: H }); if (sr.ok) snaps = await sr.json(); } catch { /* snapshot optional */ }
  const out = {};
  for (const s of syms) {
    const bars = barsBySym[s] || [];
    if (!bars.length) { out[s] = { error: 'no bars (unsupported symbol on this feed?)' }; continue; }
    const snap = snaps[s] || {};
    out[s] = { closes: bars.map((b) => b.c), highs: bars.map((b) => b.h), lows: bars.map((b) => b.l), last: snap.latestTrade?.p ?? snap.dailyBar?.c ?? bars.at(-1).c, prev_close: snap.prevDailyBar?.c ?? bars.at(-2)?.c ?? null, currency: 'USD' };
  }
  return out;
}

async function getSeries(cfg, syms) {
  const provider = cfg.data?.provider || 'yahoo';
  if (provider === 'alpaca') return alpacaProvider(cfg, syms);
  if (provider === 'yahoo') return yahooProvider(cfg, syms);
  throw new Error(`unknown provider "${provider}" (use alpaca|yahoo)`);
}

// ---------- offline self-test of the math ----------
function selftest() {
  const flat = Array(60).fill(100);
  const up = Array.from({ length: 60 }, (_, i) => 100 + i);
  const assert = (name, cond) => console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  assert('ema(flat,9)==100', Math.abs(ema(flat, 9) - 100) < 1e-9);
  assert('ema(up,9) within band', ema(up, 9) > 150 && ema(up, 9) < 159);
  assert('rsi(up)==100 (all gains)', rsi(up, 14) === 100);
  assert('rsi(flat)==100 (no losses → guarded)', rsi(flat, 14) === 100);
  assert('atr(flat)==0', atr(flat, flat, flat, 14) === 0);
  const t = tech({ closes: up, highs: up.map((c) => c + 1), lows: up.map((c) => c - 1), last: 159, prev_close: 158 });
  assert('tech.above_ema200 null when <200 candles', t.above_ema200 === null);
  assert('tech.gap_pct computed', t.gap_pct === r2((159 - 158) / 158 * 100));
  console.log('\nselftest done.');
}

// ---------- main ----------
if (o.selftest) { selftest(); process.exit(0); }

const MARKET = o.market; if (!MARKET) { console.error('ERROR: feed needs --market us|idx (or --selftest)'); process.exit(1); }
const MROOT = path.join(ROOT, 'markets', MARKET);
const cfg = readJSON(path.join(MROOT, 'config.json'));
if (!cfg) { console.error(`ERROR: cannot read ${MROOT}/config.json`); process.exit(1); }

const provider = cfg.data?.provider || 'yahoo';
// Alpaca can't serve the ^GSPC index → use the ETF proxy (SPY) as the benchmark level.
const benchSym = provider === 'alpaca' ? (cfg.benchmark?.proxy || cfg.benchmark?.symbol) : cfg.benchmark?.symbol;
const watch = (cfg.watchlist || []).map((w) => w.symbol);
const sectors = Object.fromEntries((cfg.watchlist || []).map((w) => [w.symbol, w.sector]));
const held = (readJSON(path.join(MROOT, 'state', 'portfolio.json'), { positions: [] }).positions || []).map((p) => p.symbol);
const names = [...new Set([...watch, ...held])];
const all = [...new Set([...names, benchSym].filter(Boolean))];

console.log(`feed ${MARKET} via ${provider} — ${names.length} names + bench ${benchSym}`);
let seriesMap;
try { seriesMap = await getSeries(cfg, all); } catch (e) { console.error(`ERROR: ${e.message || e}`); process.exit(1); }

const prices = {}, technicals = {}, failures = [];
let benchLevel = null, benchTech = null;
for (const sym of all) {
  const s = seriesMap[sym];
  if (!s || s.error) { failures.push({ sym, err: s?.error || 'missing' }); console.log(`  ${sym.padEnd(9)} FAILED: ${s?.error || 'missing'}`); continue; }
  const t = tech(s);
  if (sym === benchSym) { benchLevel = t.last; benchTech = t; }
  if (names.includes(sym)) { prices[sym] = t.last; technicals[sym] = { sector: sectors[sym] || null, ...t }; }
  console.log(`  ${sym.padEnd(9)} ${String(t.last).padStart(12)}  rsi ${String(t.rsi14 ?? '–').padStart(5)}  ema200 ${t.above_ema200 == null ? 'n/a' : t.above_ema200 ? 'above' : 'below'}  (${t.candles}c)`);
}

if (benchSym && benchLevel == null) { console.error(`ERROR: benchmark ${benchSym} failed — need its level for equity/alpha. Aborting.`); process.exit(1); }

const date = dayKey();
const quotesPath = path.join(MROOT, 'state', 'quotes.json');
const techPath = path.join(MROOT, 'research', `technicals-${date}.json`);
if (!DRY) {
  writeJSONAtomic(quotesPath, { asof: nowISO(), date, market: MARKET, provider, bench_symbol: benchSym, bench_level: benchLevel, currency: cfg.currency, prices });
  writeJSONAtomic(techPath, { asof: nowISO(), date, market: MARKET, provider, bench: { symbol: benchSym, level: benchLevel, ...(benchTech || {}) }, names: technicals });
}
console.log(`\nfeed ${MARKET}: ${Object.keys(prices).length}/${names.length} names ok, bench ${benchSym}=${benchLevel}${failures.length ? `, ${failures.length} failed` : ''}${DRY ? ' [dry-run]' : `\n  → ${path.relative(ROOT, quotesPath)}\n  → ${path.relative(ROOT, techPath)}`}`);
process.exit(0);
