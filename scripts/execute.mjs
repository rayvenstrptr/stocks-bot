#!/usr/bin/env node
// execute.mjs — local "day trading" step. Reads the cloud-written day plan + the local quotes (from
// feed.mjs) and drives the deterministic engine (paper.mjs) to honor stops/TP and fill planned orders.
// Runs on the device; replaces the old cloud `*-open` / `*-midday` routines. No LLM, no network of its
// own (feed already fetched prices). Idempotent on dayKey+decision_id.
//
//   node scripts/execute.mjs --market us --phase open            # fill today's plan + mark
//   node scripts/execute.mjs --market idx --phase midday          # re-mark + fill any new plan rows
//   node scripts/execute.mjs --market us --phase open --git        # also commit/push state
//   node scripts/execute.mjs --market idx --phase open --dry-run --quotes /tmp/q.json --portfolio /tmp/pf.json --trades /tmp/tr.ndjson --decisions /tmp/dec.ndjson
//
// Phase mapping: `open` snapshots day_start_equity; both phases mark --auto-exit and fill unexecuted
// plan rows. Equity snapshots are owned by review.mjs (one authoritative row/day), not here.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function parseArgs(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; } } } return o; }
const o = parseArgs(process.argv.slice(2));
const MARKET = o.market, PHASE = o.phase || 'open', DRY = !!o['dry-run'];
if (!MARKET || !['open', 'midday'].includes(PHASE)) { console.error('ERROR: execute needs --market us|idx and --phase open|midday'); process.exit(1); }
const MROOT = path.join(ROOT, 'markets', MARKET);

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const dayKey = () => ET_DATE.format(new Date());
const nowISO = () => new Date().toISOString();
const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const readND = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

const QUOTES = o.quotes || path.join(MROOT, 'state', 'quotes.json');
const DECISIONS = o.decisions || path.join(MROOT, 'decisions', 'decisions.ndjson');
const TRADES = o.trades || path.join(MROOT, 'logs', 'trades.ndjson');
const BOTLOG = path.join(MROOT, 'logs', 'bot.log');

// passthrough overrides so paper.mjs hits the same (possibly /tmp) files + honors --dry-run
const PASS = ['--market', MARKET];
for (const k of ['config', 'portfolio', 'trades', 'equity-file']) if (o[k]) PASS.push('--' + k, o[k]);
if (DRY) PASS.push('--dry-run');

function paper(args) {
  try { const stdout = execFileSync('node', [path.join('scripts', 'paper.mjs'), ...args, ...PASS], { cwd: ROOT, encoding: 'utf8' }); let json; try { json = JSON.parse(stdout); } catch { json = null; } return { ok: true, json }; }
  catch (e) { return { ok: false, err: String(e.stderr || e.message || '').trim() }; }
}
function git(args) { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (e) { return null; } }

// ---------- load ----------
const today = dayKey();
const q = readJSON(QUOTES, null);
if (!q || !q.prices) { console.error(`ERROR: no quotes at ${path.relative(ROOT, QUOTES)} — run feed.mjs first`); process.exit(1); }
if (q.date !== today) console.error(`WARN: quotes dated ${q.date}, today is ${today} (stale feed?)`);
const prices = q.prices;

const planRows = readND(DECISIONS).filter((r) => r.date === today && r.event === 'plan');
const filledIds = new Set(readND(TRADES).filter((r) => r.date === today && r.decision_id).map((r) => r.decision_id));

const log = [];
const note = (s) => { log.push(s); console.log(s); };
note(`execute ${MARKET} ${PHASE} ${today}: ${planRows.length} plan rows, quotes via ${q.provider || '?'}`);

// ---------- 1. start-day (open only) ----------
if (PHASE === 'open') { const r = paper(['start-day']); note(r.ok ? `  start-day: day_start_equity=${r.json?.day_start_equity}` : `  start-day FAILED: ${r.err}`); }

// ---------- 2. mark to current prices + honor stops/TP ----------
{ const r = paper(['mark', '--prices', JSON.stringify(prices), '--auto-exit']); if (r.ok) { const ex = r.json?.auto_exits || []; note(`  mark: ${r.json?.marked} priced, ${ex.length} auto-exit${ex.length === 1 ? '' : 's'}${ex.length ? ' → ' + ex.map((e) => `${e.symbol}@${e.at}(${e.reason})`).join(', ') : ''}, equity=${r.json?.equity}`); } else note(`  mark FAILED: ${r.err}`); }

// ---------- 3. fill unexecuted plan orders ----------
let filled = 0, blocked = 0, skipped = 0;
const linkRows = [];
for (const p of planRows) {
  if (p.decision_id && filledIds.has(p.decision_id)) { skipped++; continue; } // idempotent: already filled today
  const sym = p.symbol; const px = prices[sym];
  if (p.side === 'flat') { skipped++; continue; }
  if (px == null) { note(`  ${sym}: no quote — skipped`); skipped++; continue; }

  let res;
  if (p.side === 'buy') {
    const args = ['buy', '--symbol', sym, '--price', String(px), '--phase', PHASE];
    if (p.stop != null) args.push('--stop', String(p.stop)); else if (p.notional_usd) args.push('--usd', String(p.notional_usd));
    if (p.take_profit != null) args.push('--tp', String(p.take_profit));
    if (p.conviction != null) args.push('--conviction', String(p.conviction));
    if (p.decision_id) args.push('--decision-id', p.decision_id);
    res = paper(args);
  } else if (p.side === 'sell') {
    res = paper(['sell', '--symbol', sym, '--price', String(px), '--all', '--phase', PHASE, '--reason', p.reason || 'plan exit']);
    if (!res.ok && /no open position/.test(res.err)) { skipped++; continue; } // nothing to sell
  } else { skipped++; continue; }

  if (res.ok && res.json) {
    filled++;
    const j = res.json;
    note(`  ${j.action.toUpperCase()} ${sym}: ${j.qty} @ ${j.fill_price}${j.stop ? ` stop ${j.stop}` : ''}${j.take_profit ? ` tp ${j.take_profit}` : ''}${j.pnl_usd != null ? ` pnl ${j.pnl_usd}` : ''}`);
    linkRows.push({ t: Date.now(), iso: nowISO(), date: today, phase: PHASE, decision_id: p.decision_id || null, event: j.action, symbol: sym, side: j.side, fill_price: j.fill_price, qty: j.qty, notional_usd: j.notional_usd ?? null, proceeds_usd: j.proceeds_usd ?? null, fees_usd: j.fees_usd, conviction: p.conviction ?? null });
  } else { blocked++; note(`  ${sym}: BLOCKED — ${res.err}`); }
}
// append the plan→fill link rows into decisions.ndjson (the ML pipeline)
if (!DRY && linkRows.length) for (const r of linkRows) fs.appendFileSync(DECISIONS, JSON.stringify(r) + '\n');

note(`  result: ${filled} filled, ${blocked} blocked, ${skipped} skipped`);

// ---------- 4. dashboard + breadcrumb (skipped in test mode: --portfolio override present) ----------
if (!DRY && !o.portfolio) {
  try { execFileSync('node', [path.join('scripts', 'dashboard.mjs'), '--market', MARKET], { cwd: ROOT }); } catch { /* non-fatal */ }
  fs.appendFileSync(BOTLOG, `${nowISO()} execute ${PHASE}: filled=${filled} blocked=${blocked} skipped=${skipped}\n`);
}

// ---------- 5. persist to git (daemon passes --git in production) ----------
if (o.git && !DRY) {
  git(['add', '-A']);
  const committed = git(['commit', '-m', `${MARKET} execute ${PHASE} ${today}`]);
  if (committed != null) { git(['pull', '--rebase', 'origin', 'main']); const pushed = git(['push', 'origin', 'HEAD']); note(pushed != null ? '  git: committed + pushed' : '  git: committed (push failed — check remote)'); }
  else note('  git: nothing to commit');
}
process.exit(0);
