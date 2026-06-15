#!/usr/bin/env node
// dashboard.mjs — generate a single self-contained dashboard.html from the bot's files.
// No deps, no CDN, no server needed: data is inlined, charts are hand-rolled SVG, fonts are
// platform-native. Open dashboard.html anywhere (incl. phone via file sync).
//
//   node scripts/dashboard.mjs                 -> write ./dashboard.html from live files
//   node scripts/dashboard.mjs --out p.html    -> write to a custom path
//   node scripts/dashboard.mjs --demo          -> write ./dashboard-demo.html from synthetic data
//   node scripts/dashboard.mjs --serve [--port 3791]   -> live local server (regenerates per request)

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k) => args.includes('--' + k);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const MARKET = opt('market', null);                               // 'us' | 'idx'
const BASE = MARKET ? path.join(ROOT, 'markets', MARKET) : ROOT;   // per-market data dir

// ---------- IO ----------
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(path.join(BASE, p), 'utf8')); } catch { return d; } };
const readND = (p) => { try { return fs.readFileSync(path.join(BASE, p), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const readText = (p) => { try { return fs.readFileSync(path.join(BASE, p), 'utf8'); } catch { return ''; } };
const listMd = (dir) => { try { return fs.readdirSync(path.join(BASE, dir)).filter((f) => f.endsWith('.md')).sort().reverse(); } catch { return []; } };

// ---------- format ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let CUR = '$', DEC = 2;   // set from config in render()
const money = (x) => x == null || isNaN(x) ? '—' : CUR + Number(x).toLocaleString('en-US', { minimumFractionDigits: DEC, maximumFractionDigits: DEC });
const pct = (x, sign = true) => x == null || isNaN(x) ? '—' : (sign && x > 0 ? '+' : '') + Number(x).toFixed(2) + '%';
const sgn = (x) => x == null || isNaN(x) ? 'flat' : x > 0.0001 ? 'pos' : x < -0.0001 ? 'neg' : 'flat';
const num = (x, d = 2) => x == null || isNaN(x) ? '—' : Number(x).toFixed(d);
const shortDate = (s) => (s || '').slice(5); // MM-DD

// ---------- gather ----------
function gather() {
  const config = readJSON('config.json', {});
  const pf = readJSON('state/portfolio.json', { cash: 0, equity: 0, positions: [], starting_capital: 1000 });
  const equity = readND('state/equity.ndjson');
  const trades = readND('logs/trades.ndjson');
  const decisions = readND('decisions/decisions.ndjson');
  const research = readND('research/research.ndjson');
  const lessons = readND('reviews/lessons.ndjson');
  const daily = listMd('reviews/daily');
  const weekly = listMd('reviews/weekly');
  const botlog = readText('logs/bot.log').split('\n').filter(Boolean).slice(-40);
  return { config, pf, equity, trades, decisions, research, lessons, daily, weekly, botlog, generated: new Date().toISOString() };
}

// ---------- derive stats ----------
function stats(d) {
  const last = d.equity[d.equity.length - 1] || null;
  const startCap = d.pf.starting_capital || 1000;
  const equityNow = last ? last.equity : d.pf.equity ?? startCap;
  const botRet = last ? last.bot_ret_since_incept : (equityNow / startCap - 1) * 100;
  const benchRet = last ? last.bench_ret_since_incept : null;
  const alpha = last ? last.alpha : null;

  const exits = d.trades.filter((t) => t.side === 'sell' && t.pnl_usd != null);
  const wins = exits.filter((t) => t.pnl_usd > 0);
  const losses = exits.filter((t) => t.pnl_usd <= 0);
  const winRate = exits.length ? (wins.length / exits.length) * 100 : null;
  const rVals = exits.map((t) => t.r_multiple).filter((r) => r != null);
  const avgR = rVals.length ? rVals.reduce((a, b) => a + b, 0) / rVals.length : null;
  const grossWin = wins.reduce((a, t) => a + t.pnl_usd, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl_usd, 0));
  const expectancy = exits.length ? exits.reduce((a, t) => a + t.pnl_usd, 0) / exits.length : null;
  const profitFactor = grossLoss ? grossWin / grossLoss : null;

  const positions = (d.pf.positions || []).map((p) => {
    const lastPx = p.last_price ?? p.avg_price;
    const unreal = (lastPx - p.avg_price) * p.qty;
    const unrealPct = ((lastPx - p.avg_price) / p.avg_price) * 100;
    const value = p.qty * lastPx;
    return { ...p, lastPx, unreal, unrealPct, value };
  });
  const posValue = positions.reduce((a, p) => a + p.value, 0);
  const exposure = equityNow ? (posValue / equityNow) * 100 : 0;

  // conviction calibration: graded decisions by conviction bucket
  const graded = d.decisions.filter((x) => x.outcome && x.conviction != null);
  const buckets = [[-100, 0, '<0'], [0, 25, '0–25'], [25, 40, '25–40'], [40, 60, '40–60'], [60, 80, '60–80'], [80, 101, '80+']];
  const calib = buckets.map(([lo, hi, label]) => {
    const inb = graded.filter((x) => x.conviction >= lo && x.conviction < hi);
    const hits = inb.filter((x) => x.outcome === 'HIT').length;
    return { label, n: inb.length, hit: inb.length ? (hits / inb.length) * 100 : null };
  });

  let daysRunning = 0;
  if (d.pf.inception_date) daysRunning = Math.max(1, Math.round((Date.now() - new Date(d.pf.inception_date).getTime()) / 86400000));

  return { last, startCap, equityNow, botRet, benchRet, alpha, exits, wins, losses, winRate, avgR, expectancy, profitFactor, positions, posValue, exposure, calib, daysRunning, realized: d.pf.realized_pnl ?? 0 };
}

// ---------- SVG equity chart ----------
function equityChart(equity) {
  const W = 1000, H = 340, padL = 8, padR = 8, padT = 24, padB = 26;
  if (!equity || equity.length < 2) {
    return `<div class="empty">No equity history yet — the chart appears after the first daily review.</div>`;
  }
  const xs = equity.map((_, i) => i);
  const bot = equity.map((e) => e.bot_ret_since_incept ?? 0);
  const bench = equity.map((e) => e.bench_ret_since_incept ?? 0);
  const all = bot.concat(bench).concat([0]);
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.15 || 1; lo -= pad; hi += pad;
  const X = (i) => padL + (i / (xs.length - 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const line = (arr) => arr.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
  // alpha band between bot and spx
  const band = 'M' + bot.map((v, i) => X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' L') +
    ' L' + bench.map((v, i) => X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).reverse().join(' L') + ' Z';
  const zeroY = Y(0);
  // gridlines (4)
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = lo + (hi - lo) * (1 - f); const y = Y(v); return `<line x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="grid"/><text x="${padL + 2}" y="${(y - 3).toFixed(1)}" class="gtxt">${v.toFixed(1)}%</text>`; }).join('');
  // x labels (~6)
  const step = Math.max(1, Math.floor(xs.length / 6));
  const xlabels = equity.map((e, i) => i % step === 0 || i === xs.length - 1 ? `<text x="${X(i).toFixed(1)}" y="${H - 8}" class="gtxt" text-anchor="middle">${shortDate(e.date)}</text>` : '').join('');
  const dots = equity.map((e, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(bot[i]).toFixed(1)}" r="2.2" class="dot"/>`).join('');
  const lastBot = bot[bot.length - 1], lastBench = bench[bench.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="eq" role="img" aria-label="Equity vs S&P 500">
    <defs><linearGradient id="botg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--amber)" stop-opacity=".22"/><stop offset="1" stop-color="var(--amber)" stop-opacity="0"/></linearGradient></defs>
    ${grid}
    <line x1="${padL}" x2="${W - padR}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}" class="zero"/>
    <path d="${band}" class="band ${lastBot >= lastBench ? 'up' : 'down'}"/>
    <path d="${line(bench)}" class="spxline"/>
    <path d="${line(bot)}" class="botline"/>
    ${dots}${xlabels}
  </svg>`;
}

// ---------- tables ----------
function tradesTable(trades) {
  const rows = [...trades].reverse().slice(0, 200);
  if (!rows.length) return `<div class="empty">No trades yet.</div>`;
  const body = rows.map((t) => {
    const isSell = t.side === 'sell';
    const pnl = isSell ? t.pnl_usd : null;
    return `<tr>
      <td class="mono dim">${esc((t.iso || '').slice(5, 16).replace('T', ' '))}</td>
      <td class="sym">${esc(t.symbol)}</td>
      <td><span class="tag ${t.side}">${esc(t.event || t.side)}</span></td>
      <td class="num">${num(t.qty, 4)}</td>
      <td class="num">${money(t.fill_price)}</td>
      <td class="num">${t.notional_usd != null ? money(t.notional_usd) : t.proceeds_usd != null ? money(t.proceeds_usd) : '—'}</td>
      <td class="num ${sgn(pnl)}">${pnl != null ? money(pnl) : ''}</td>
      <td class="num ${sgn(pnl)}">${isSell && t.pnl_pct != null ? pct(t.pnl_pct) : ''}</td>
      <td class="num ${sgn(t.r_multiple)}">${t.r_multiple != null ? num(t.r_multiple) + 'R' : ''}</td>
      <td class="dim small">${esc(t.reason || '')}</td>
    </tr>`;
  }).join('');
  return `<table data-sortable><thead><tr><th>time</th><th>sym</th><th>event</th><th class="num">qty</th><th class="num">fill</th><th class="num">notional</th><th class="num">p&l $</th><th class="num">p&l %</th><th class="num">R</th><th>reason</th></tr></thead><tbody>${body}</tbody></table>`;
}

function decisionsTable(decisions) {
  const rows = [...decisions].reverse().slice(0, 300);
  if (!rows.length) return `<div class="empty">No decisions logged yet — the pre-market routine writes these.</div>`;
  const body = rows.map((x) => `<tr>
      <td class="mono dim">${esc(x.date || '')}</td>
      <td class="dim small">${esc(x.phase || '')}</td>
      <td class="sym">${esc(x.symbol)}</td>
      <td><span class="tag ${x.event === 'cancel' ? 'sell' : x.side || 'plan'}">${esc(x.event || '')}</span></td>
      <td class="num">${x.tech_score ?? ''}</td>
      <td class="num">${x.research_score ?? ''}</td>
      <td class="num strong ${sgn(x.conviction)}">${x.conviction ?? ''}</td>
      <td class="dim small wide">${esc(x.reason || '')}</td>
      <td class="dim small">${esc(x.invalidation || '')}</td>
      <td>${x.outcome ? `<span class="tag o-${x.outcome}">${x.outcome}</span>` : ''}</td>
    </tr>`).join('');
  return `<table data-sortable><thead><tr><th>date</th><th>phase</th><th>sym</th><th>event</th><th class="num">tech</th><th class="num">res</th><th class="num">conv</th><th>reason</th><th>invalidation</th><th>outcome</th></tr></thead><tbody>${body}</tbody></table>`;
}

function researchTable(research) {
  const rows = [...research].reverse().slice(0, 300);
  if (!rows.length) return `<div class="empty">No research rows yet.</div>`;
  const body = rows.map((r) => `<tr>
      <td class="mono dim">${esc(r.date || '')}</td>
      <td class="sym">${esc(r.symbol)}</td>
      <td class="dim small">${esc(r.sector || '')}</td>
      <td class="num">${money(r.price)}</td>
      <td class="num ${sgn(r.gap_pct)}">${r.gap_pct != null ? pct(r.gap_pct) : ''}</td>
      <td class="num">${r.rsi14 != null ? num(r.rsi14, 0) : ''}</td>
      <td class="num ${sgn(r.tech_score)}">${r.tech_score ?? ''}</td>
      <td class="num ${sgn(r.research_score)}">${r.research_score ?? ''}</td>
      <td class="dim small wide">${esc(r.top_catalyst || '')}</td>
    </tr>`).join('');
  return `<table data-sortable><thead><tr><th>date</th><th>sym</th><th>sector</th><th class="num">price</th><th class="num">gap</th><th class="num">rsi</th><th class="num">tech</th><th class="num">res</th><th>catalyst</th></tr></thead><tbody>${body}</tbody></table>`;
}

function positionsTable(positions) {
  if (!positions.length) return `<div class="empty">Flat — no open positions. Cash is a position too.</div>`;
  const body = positions.map((p) => `<tr>
      <td class="sym">${esc(p.symbol)}</td>
      <td class="num">${num(p.qty, 4)}</td>
      <td class="num">${money(p.avg_price)}</td>
      <td class="num">${money(p.lastPx)}</td>
      <td class="num">${money(p.value)}</td>
      <td class="num ${sgn(p.unreal)}">${money(p.unreal)}</td>
      <td class="num ${sgn(p.unrealPct)}">${pct(p.unrealPct)}</td>
      <td class="num dim">${p.stop != null ? money(p.stop) : '—'}</td>
      <td class="num dim">${p.take_profit != null ? money(p.take_profit) : '—'}</td>
      <td class="num">${p.conviction ?? ''}</td>
    </tr>`).join('');
  return `<table data-sortable><thead><tr><th>sym</th><th class="num">qty</th><th class="num">avg</th><th class="num">last</th><th class="num">value</th><th class="num">unreal $</th><th class="num">unreal %</th><th class="num">stop</th><th class="num">tp</th><th class="num">conv</th></tr></thead><tbody>${body}</tbody></table>`;
}

function calibBars(calib) {
  const max = 100;
  return `<div class="calib">${calib.map((b) => {
    const h = b.hit == null ? 0 : (b.hit / max) * 100;
    return `<div class="cbar"><div class="ctrack"><div class="cfill ${b.hit >= 50 ? 'up' : 'down'}" style="height:${h.toFixed(0)}%"></div></div><div class="clab">${b.label}</div><div class="cval">${b.hit == null ? '·' : Math.round(b.hit) + '%'}</div><div class="cn">${b.n || ''}</div></div>`;
  }).join('')}</div>`;
}

// ---------- page ----------
function render(d) {
  const s = stats(d);
  const c = d.config;
  CUR = c.currency_symbol || '$'; DEC = c.currency_decimals != null ? c.currency_decimals : 2;
  const halted = d.pf.halted;
  const regime = '';
  const statCard = (label, value, klass, sub) => `<div class="stat"><div class="slabel">${label}</div><div class="sval ${klass || ''}">${value}</div>${sub ? `<div class="ssub">${sub}</div>` : ''}</div>`;

  const reviewsList = (arr, dir) => arr.length ? `<ul class="rlist">${arr.map((f) => `<li><span class="rd">${esc(f.replace('.md', ''))}</span> <span class="dim small">${esc(dir)}/${esc(f)}</span></li>`).join('')}</ul>` : `<div class="empty">None yet.</div>`;
  const lessonsList = d.lessons.length ? `<ul class="llist">${[...d.lessons].reverse().slice(0, 40).map((l) => `<li><span class="tag o-${l.action === 'stop' ? 'MISS' : l.action === 'do' ? 'HIT' : 'UNCLEAR'}">${esc(l.action || '')}</span> <b>${esc(l.category || '')}</b> — ${esc(l.lesson || '')} <span class="dim small">(${esc(l.date || '')})</span></li>`).join('')}</ul>` : `<div class="empty">No lessons yet — daily reviews write these.</div>`;
  const botlogBlock = d.botlog.length ? `<pre class="log">${d.botlog.map(esc).join('\n')}</pre>` : `<div class="empty">Bot log is empty — routines append here as they run.</div>`;

  const watch = (c.watchlist || []).map((w) => `<span class="chip">${esc(w.symbol)}</span>`).join('');
  const wgt = c.blend?.weights ? `tech ${c.blend.weights.tech} · research ${c.blend.weights.research}` : '';
  const thr = c.blend?.thresholds ? `buy ${c.blend.thresholds.buy} · add ${c.blend.thresholds.add} · trim ${c.blend.thresholds.trim} · close ${c.blend.thresholds.close}` : '';

  const DATA = JSON.stringify({ equity: d.equity });

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.benchmark?.label ? 'Stock Bot — vs ' + c.benchmark.label : 'Stock Bot Dashboard')}</title>
<style>${CSS}</style></head>
<body>
<div class="grain"></div>
<header class="tape">
  <span class="brand">◆ STOCKS<span class="dim">·PAPER</span></span>
  <span class="t-item">EQUITY <b>${money(s.equityNow)}</b></span>
  <span class="t-item">CASH <b>${money(d.pf.cash)}</b></span>
  <span class="t-item">DAY ${s.daysRunning || '0'}</span>
  <span class="t-item ${halted ? 'halt' : 'live'}">${halted ? '■ HALTED' : '● LIVE'}</span>
  <span class="t-item dim grow">updated ${esc(d.generated.slice(0, 16).replace('T', ' '))}Z</span>
</header>

<main>
  <section class="hero">
    <div class="hero-num">
      <div class="hlabel">Alpha vs ${esc(c.benchmark?.label || 'S&P 500')}</div>
      <div class="alpha ${sgn(s.alpha)}">${s.alpha == null ? '—' : pct(s.alpha)}</div>
      <div class="hlegend"><span class="k bot">▬ bot ${pct(s.botRet)}</span><span class="k spx">▬ ${esc(c.benchmark?.label || 'benchmark')} ${pct(s.benchRet, true)}</span></div>
    </div>
    <div class="hero-stats">
      ${statCard('Equity', money(s.equityNow), '', 'of ' + money(s.startCap) + ' start')}
      ${statCard('Total return', pct(s.botRet), sgn(s.botRet))}
      ${statCard('Realized P&L', money(s.realized), sgn(s.realized))}
      ${statCard('Win rate', s.winRate == null ? '—' : Math.round(s.winRate) + '%', '', s.exits.length + ' closed')}
      ${statCard('Avg R', s.avgR == null ? '—' : num(s.avgR) + 'R', sgn(s.avgR))}
      ${statCard('Exposure', Math.round(s.exposure) + '%', '', s.positions.length + ' open')}
    </div>
  </section>

  <section class="panel chartwrap">
    <div class="phead"><span class="pix">01</span><h2>Equity vs ${esc(c.benchmark?.label || 'S&P 500')}</h2><span class="dim small">cumulative return since inception · amber band = alpha</span></div>
    ${equityChart(d.equity)}
  </section>

  <div class="cols">
    <section class="panel">
      <div class="phead"><span class="pix">02</span><h2>Open positions</h2></div>
      <div class="tscroll">${positionsTable(s.positions)}</div>
    </section>
    <section class="panel">
      <div class="phead"><span class="pix">03</span><h2>Conviction calibration</h2><span class="dim small">hit-rate by conviction bucket</span></div>
      ${calibBars(s.calib)}
      <div class="ministats">
        <div><span class="dim">Profit factor</span> <b>${s.profitFactor == null ? '—' : num(s.profitFactor)}</b></div>
        <div><span class="dim">Expectancy</span> <b class="${sgn(s.expectancy)}">${s.expectancy == null ? '—' : money(s.expectancy)}/trade</b></div>
        <div><span class="dim">Wins / Losses</span> <b>${s.wins.length} / ${s.losses.length}</b></div>
      </div>
    </section>
  </div>

  <section class="panel">
    <div class="phead"><span class="pix">04</span><h2>Ledger</h2>
      <nav class="tabs">
        <button class="tab active" data-tab="trades">Trades</button>
        <button class="tab" data-tab="decisions">Decisions</button>
        <button class="tab" data-tab="research">Research</button>
        <button class="tab" data-tab="lessons">Lessons</button>
        <button class="tab" data-tab="reviews">Reviews</button>
        <button class="tab" data-tab="log">Bot log</button>
      </nav>
    </div>
    <div class="tabpanel active" data-panel="trades"><div class="tscroll">${tradesTable(d.trades)}</div></div>
    <div class="tabpanel" data-panel="decisions"><div class="tscroll">${decisionsTable(d.decisions)}</div></div>
    <div class="tabpanel" data-panel="research"><div class="tscroll">${researchTable(d.research)}</div></div>
    <div class="tabpanel" data-panel="lessons">${lessonsList}</div>
    <div class="tabpanel" data-panel="reviews"><div class="rcols"><div><h3>Daily</h3>${reviewsList(d.daily, 'reviews/daily')}</div><div><h3>Weekly</h3>${reviewsList(d.weekly, 'reviews/weekly')}</div></div></div>
    <div class="tabpanel" data-panel="log">${botlogBlock}</div>
  </section>

  <footer class="foot">
    <div><span class="dim">Mission</span> beat ${esc(c.benchmark?.label || 'S&P 500')} · long-only · ${money(s.startCap)} paper</div>
    <div><span class="dim">Blend</span> ${esc(wgt)} <span class="dim">· thresholds</span> ${esc(thr)}</div>
    <div class="watch">${watch}</div>
  </footer>
</main>
<script>const DATA=${DATA};${CLIENT_JS}</script>
</body></html>`;
}

// ---------- CSS ----------
const CSS = `
:root{
  --ink:#0a0e13; --ink2:#0e131b; --panel:#111824; --panel2:#0d141d; --line:#1c2733; --line2:#26323f;
  --txt:#e9e6dd; --dim:#8893a3; --dim2:#5d6776; --amber:#f2b65a; --amber2:#caa15f;
  --pos:#52d39a; --neg:#f06a72; --spx:#7d8aa0;
  --serif:ui-serif,"New York",Georgia,"Times New Roman",serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:
  radial-gradient(120% 80% at 80% -10%, #15202e 0%, transparent 55%),
  radial-gradient(90% 60% at 0% 0%, #121a26 0%, transparent 50%),
  var(--ink);
  color:var(--txt);font-family:var(--mono);font-size:13px;line-height:1.5;
  background-attachment:fixed;
  -webkit-font-smoothing:antialiased;
  background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:auto,auto,auto,52px 52px,52px 52px;background-blend-mode:normal,normal,normal,soft-light,soft-light;
}
.grain{position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.05;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
main{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:0 20px 60px}
b{font-weight:600}
.dim{color:var(--dim)}.small{font-size:11px}.mono{font-family:var(--mono)}
.pos{color:var(--pos)}.neg{color:var(--neg)}.flat{color:var(--dim)}
.num,.sval,.alpha,td.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}

/* tape */
.tape{position:sticky;top:0;z-index:5;display:flex;gap:22px;align-items:center;flex-wrap:wrap;
  max-width:1180px;margin:0 auto;padding:11px 20px;border-bottom:1px solid var(--line);
  background:rgba(10,14,19,.86);backdrop-filter:blur(8px);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.brand{font-weight:700;letter-spacing:.14em;color:var(--amber)}
.t-item b{color:var(--txt);letter-spacing:0}
.t-item.live{color:var(--pos)}.t-item.halt{color:var(--neg)}
.grow{margin-left:auto;text-transform:none;letter-spacing:0}

/* hero */
.hero{display:grid;grid-template-columns:1.05fr 1.4fr;gap:24px;align-items:center;padding:40px 4px 30px}
.hlabel,.slabel,.hlegend,.phead .small{text-transform:uppercase;letter-spacing:.14em;font-size:10.5px;color:var(--dim)}
.alpha{font-family:var(--serif);font-size:clamp(64px,11vw,120px);line-height:.9;font-weight:600;letter-spacing:-.02em;margin:6px 0 12px}
.alpha.pos{color:var(--pos);text-shadow:0 0 38px rgba(82,211,154,.32)}
.alpha.neg{color:var(--neg);text-shadow:0 0 38px rgba(240,106,114,.30)}
.alpha.flat{color:var(--amber);text-shadow:0 0 38px rgba(242,182,90,.28)}
.hlegend{display:flex;gap:18px;letter-spacing:.04em}
.k.bot{color:var(--amber)}.k.spx{color:var(--spx)}
.hero-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.stat{background:linear-gradient(180deg,var(--panel),var(--panel2));padding:16px 16px 14px}
.sval{font-family:var(--serif);font-size:27px;font-weight:600;letter-spacing:-.01em;margin-top:5px}
.ssub{font-size:10.5px;color:var(--dim2);margin-top:3px}

/* panels */
.panel{background:linear-gradient(180deg,rgba(17,24,36,.92),rgba(13,20,29,.92));border:1px solid var(--line);
  border-radius:12px;padding:18px 18px 16px;margin-top:18px;box-shadow:0 1px 0 rgba(255,255,255,.02) inset,0 18px 40px -30px #000}
.phead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px;border-bottom:1px solid var(--line);padding-bottom:11px}
.phead h2{font-family:var(--serif);font-weight:600;font-size:19px;margin:0;letter-spacing:.01em}
.pix{font-family:var(--mono);font-size:11px;color:var(--amber2);border:1px solid var(--line2);border-radius:4px;padding:2px 6px;letter-spacing:.1em}
.cols{display:grid;grid-template-columns:1.5fr 1fr;gap:18px}

/* chart */
.chartwrap .eq{width:100%;height:auto;display:block}
.eq .grid{stroke:var(--line);stroke-width:1}
.eq .zero{stroke:var(--line2);stroke-width:1;stroke-dasharray:3 4}
.eq .gtxt{fill:var(--dim2);font:10px var(--mono)}
.eq .band{opacity:.16}.eq .band.up{fill:var(--amber)}.eq .band.down{fill:var(--neg)}
.eq .botline{fill:none;stroke:var(--amber);stroke-width:2.2;stroke-linejoin:round;filter:drop-shadow(0 0 6px rgba(242,182,90,.35))}
.eq .spxline{fill:none;stroke:var(--spx);stroke-width:1.6;stroke-dasharray:5 4;opacity:.8}
.eq .dot{fill:var(--amber)}

/* tables */
.tscroll{overflow-x:auto;margin:0 -4px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{position:sticky;top:0;text-align:left;font-weight:500;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;font-size:10px;
  padding:7px 9px;border-bottom:1px solid var(--line2);cursor:pointer;white-space:nowrap;background:var(--panel2)}
th.num,td.num{text-align:right}
td{padding:6px 9px;border-bottom:1px solid rgba(28,39,51,.6);white-space:nowrap}
tbody tr:hover{background:rgba(242,182,90,.04)}
td.sym{font-weight:600;color:var(--txt)}
td.wide{white-space:normal;min-width:240px;max-width:360px}
td.small,.small{font-size:11px}
.strong{font-weight:700}
.tag{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:999px;border:1px solid var(--line2)}
.tag.buy,.tag.plan{color:var(--pos);border-color:rgba(82,211,154,.4)}
.tag.sell{color:var(--neg);border-color:rgba(240,106,114,.4)}
.tag.flat{color:var(--dim)}
.o-HIT{color:var(--pos);border-color:rgba(82,211,154,.5)}
.o-MISS{color:var(--neg);border-color:rgba(240,106,114,.5)}
.o-UNCLEAR{color:var(--amber2);border-color:rgba(202,161,95,.5)}
.empty{color:var(--dim2);font-style:italic;padding:22px 6px;text-align:center;font-size:12px}

/* calibration */
.calib{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;align-items:end;height:160px;padding:6px 0 0}
.cbar{display:flex;flex-direction:column;align-items:center;gap:5px;height:100%;justify-content:flex-end}
.ctrack{width:100%;flex:1;display:flex;align-items:flex-end;background:repeating-linear-gradient(0deg,var(--line) 0 1px,transparent 1px 22px);border-radius:4px}
.cfill{width:100%;border-radius:4px 4px 0 0;min-height:2px;transition:height .3s}
.cfill.up{background:linear-gradient(180deg,var(--pos),rgba(82,211,154,.3))}
.cfill.down{background:linear-gradient(180deg,var(--neg),rgba(240,106,114,.3))}
.clab{font-size:10px;color:var(--dim)}.cval{font-size:12px;font-weight:600}.cn{font-size:9px;color:var(--dim2)}
.ministats{display:flex;gap:20px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:1px solid var(--line);font-size:12px}

/* tabs */
.tabs{display:flex;gap:5px;margin-left:auto;flex-wrap:wrap}
.tab{font-family:var(--mono);font-size:11px;letter-spacing:.04em;color:var(--dim);background:transparent;border:1px solid var(--line);
  padding:5px 12px;border-radius:999px;cursor:pointer;transition:.15s}
.tab:hover{color:var(--txt);border-color:var(--line2)}
.tab.active{color:var(--ink);background:var(--amber);border-color:var(--amber);font-weight:600}
.tabpanel{display:none}.tabpanel.active{display:block}
.rcols{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.rcols h3,.rlist,.llist{font-size:12px}.rcols h3{font-family:var(--serif);font-weight:600;color:var(--amber2);margin:0 0 8px}
.rlist,.llist{list-style:none;padding:0;margin:0}
.rlist li,.llist li{padding:6px 0;border-bottom:1px solid rgba(28,39,51,.5)}
.rd{font-weight:600}
.llist li{line-height:1.6}
.log{font-family:var(--mono);font-size:11px;color:var(--dim);background:var(--ink2);border:1px solid var(--line);border-radius:8px;
  padding:12px;overflow-x:auto;white-space:pre;margin:0;max-height:340px}

/* footer */
.foot{margin-top:22px;padding-top:16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px;font-size:11.5px;color:var(--dim)}
.watch{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.chip{font-size:10px;color:var(--amber2);border:1px solid var(--line2);border-radius:4px;padding:2px 7px;letter-spacing:.04em}

@media(max-width:880px){
  .hero{grid-template-columns:1fr;gap:18px;padding:26px 0 18px}
  .hero-stats{grid-template-columns:repeat(2,1fr)}
  .cols{grid-template-columns:1fr}
  .calib{height:130px}
  .rcols{grid-template-columns:1fr}
  .tape{gap:14px}
}
`;

// ---------- client JS (no template literals / no ${} ) ----------
const CLIENT_JS = `
document.querySelectorAll('.tab').forEach(function(b){
  b.addEventListener('click',function(){
    var t=b.getAttribute('data-tab');
    document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active',x===b)});
    document.querySelectorAll('.tabpanel').forEach(function(p){p.classList.toggle('active',p.getAttribute('data-panel')===t)});
  });
});
document.querySelectorAll('table[data-sortable] th').forEach(function(th,idx){
  th.addEventListener('click',function(){
    var tb=th.closest('table'),body=tb.tBodies[0],rows=[].slice.call(body.rows);
    var asc=th._asc=!th._asc;
    rows.sort(function(a,b){
      var x=a.cells[idx].innerText.replace(/[$,%RA-Za-z ]/g,'').trim();
      var y=b.cells[idx].innerText.replace(/[$,%RA-Za-z ]/g,'').trim();
      var nx=parseFloat(x),ny=parseFloat(y);
      if(!isNaN(nx)&&!isNaN(ny))return asc?nx-ny:ny-nx;
      return asc?a.cells[idx].innerText.localeCompare(b.cells[idx].innerText):b.cells[idx].innerText.localeCompare(a.cells[idx].innerText);
    });
    rows.forEach(function(r){body.appendChild(r)});
  });
});
`;

// ---------- demo data ----------
function demoData() {
  const base = gather();
  const today = new Date();
  const eq = []; let bot = 0, bench = 0;
  const watch = ['BBCA.JK', 'BBRI.JK', 'BMRI.JK', 'TLKM.JK', 'ASII.JK', 'UNTR.JK', 'ICBP.JK', 'AMRT.JK', 'ANTM.JK', 'GOTO.JK'];
  const px0 = { 'BBCA.JK': 5900, 'BBRI.JK': 4200, 'BMRI.JK': 6100, 'TLKM.JK': 3200, 'ASII.JK': 5050, 'UNTR.JK': 24500, 'ICBP.JK': 11200, 'AMRT.JK': 2900, 'ANTM.JK': 1750, 'GOTO.JK': 78 };
  const cap = 10000000;
  for (let i = 19; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * 86400000);
    bot += (Math.random() - 0.38) * 1.0; bench += (Math.random() - 0.42) * 0.8;
    eq.push({ date: dt.toISOString().slice(0, 10), equity: +(cap * (1 + bot / 100)).toFixed(2), cash: 2800000, bench_level: +(6000 * (1 + bench / 100)).toFixed(2), bot_ret_since_incept: +bot.toFixed(2), bench_ret_since_incept: +bench.toFixed(2), alpha: +(bot - bench).toFixed(2) });
  }
  const trades = [], decisions = [], research = [];
  const reasons = ['Iran–US peace → lower oil, net-importer tailwind', 'foreign inflows resume, banks lead', 'earnings beat + dividend bump', 'rupiah firmer post-BI hold', 'broke 20d on profit-taking', 'coal lags as oil falls'];
  for (let i = 0; i < 16; i++) {
    const sym = watch[i % watch.length]; const px = px0[sym] * (0.96 + Math.random() * 0.08);
    const qty = (1 + Math.floor(Math.random() * 6)) * 100;
    const pnl = +((Math.random() - 0.4) * px * qty * 0.05).toFixed(0); const r = +(pnl / Math.max(1, px * qty * 0.02)).toFixed(2);
    const dt = new Date(today.getTime() - (16 - i) * 86400000).toISOString();
    trades.push({ iso: dt, symbol: sym, side: i % 2 ? 'sell' : 'buy', event: i % 2 ? (pnl > 0 ? 'take-profit' : 'stop-loss') : 'open', qty, fill_price: +px.toFixed(0), notional_usd: i % 2 ? null : +(px * qty).toFixed(0), proceeds_usd: i % 2 ? +(px * qty + pnl).toFixed(0) : null, pnl_usd: i % 2 ? pnl : null, pnl_pct: i % 2 ? +(pnl / (px * qty) * 100).toFixed(2) : null, r_multiple: i % 2 ? r : null, reason: reasons[i % reasons.length] });
  }
  for (let i = 0; i < 24; i++) {
    const sym = watch[i % watch.length]; const tech = Math.round((Math.random() - 0.4) * 120); const res = Math.round((Math.random() - 0.35) * 130);
    const conv = Math.round(0.4 * Math.max(-100, Math.min(100, tech)) + 0.6 * Math.max(-100, Math.min(100, res)));
    const out = ['HIT', 'MISS', 'UNCLEAR'][Math.floor(Math.random() * 3)];
    const dt = new Date(today.getTime() - Math.floor(i / 3) * 86400000).toISOString().slice(0, 10);
    decisions.push({ date: dt, phase: ['premarket', 'midday', 'open'][i % 3], symbol: sym, event: conv >= 40 ? 'open' : conv <= -30 ? 'close' : 'hold', side: conv >= 40 ? 'buy' : conv <= -30 ? 'sell' : 'flat', tech_score: Math.max(-100, Math.min(100, tech)), research_score: Math.max(-100, Math.min(100, res)), conviction: conv, reason: reasons[i % reasons.length], invalidation: 'close below 20d MA', outcome: i < 18 ? out : null });
    research.push({ date: dt, symbol: sym, sector: 'idx', price: +px0[sym].toFixed(0), gap_pct: +((Math.random() - 0.4) * 5).toFixed(2), rsi14: Math.round(38 + Math.random() * 40), tech_score: Math.max(-100, Math.min(100, tech)), research_score: Math.max(-100, Math.min(100, res)), top_catalyst: reasons[i % reasons.length] });
  }
  const pf = { ...base.pf, cash: 2745000, equity: +(cap * (1 + bot / 100)).toFixed(2), starting_capital: cap, currency: 'IDR', inception_date: eq[0].date, realized_pnl: 184000, halted: false,
    positions: [
      { symbol: 'BBRI.JK', qty: 400, avg_price: 4080, last_price: 4290, stop: 3850, take_profit: 4700, conviction: 74 },
      { symbol: 'GOTO.JK', qty: 9000, avg_price: 76, last_price: 82, stop: 70, take_profit: 95, conviction: 63 },
      { symbol: 'ANTM.JK', qty: 800, avg_price: 1710, last_price: 1755, stop: 1600, take_profit: 1950, conviction: 48 },
    ] };
  const lessons = [
    { date: eq[18].date, scope: 'daily', category: 'sector', action: 'do', lesson: 'Peace / oil-down regime: banks + consumer lead, coal lags. Tilt the book to net-importer beneficiaries.', weight: 4 },
    { date: eq[16].date, scope: 'daily', category: 'risk', action: 'stop', lesson: 'IDX gaps hard on foreign-flow days — 1.5·ATR was too tight on ADRO. Widen stops on flow-driven names.', weight: 3 },
    { date: eq[14].date, scope: 'weekly', category: 'sizing', action: 'continue', lesson: 'Round-lot conviction sizing on BBCA improved expectancy. Keep.', weight: 5 },
  ];
  return { ...base, equity: eq, trades, decisions, research, pf, lessons, daily: [eq[19].date + '.md', eq[18].date + '.md'], weekly: ['2026-W24.md'], botlog: eq.slice(-6).map((e) => e.date + 'T09:05 open: filled 2 buys (BBRI, GOTO), cash=Rp ' + (2700000 + Math.random() * 200000).toFixed(0)) };
}

// ---------- main ----------
if (flag('serve')) {
  const port = +opt('port', 3791);
  http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(render(gather()));
  }).listen(port, () => console.log(`dashboard live → http://localhost:${port} (Ctrl-C to stop)`));
} else {
  const data = flag('demo') ? demoData() : gather();
  const out = opt('out', flag('demo') ? 'dashboard-demo.html' : 'dashboard.html');
  const dest = path.isAbsolute(out) ? out : path.join(BASE, out);
  fs.writeFileSync(dest, render(data));
  console.log('wrote ' + dest + (flag('demo') ? '  (synthetic demo data)' : ''));
}
