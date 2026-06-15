#!/usr/bin/env node
// review.mjs — deterministic daily/weekly review (no LLM). Replaces the cloud `*-close-review` /
// `*-weekly-review` for the proving phase: it computes the numbers that prove (or disprove)
// profitability — mark-to-close, equity + alpha vs benchmark, win-rate, mechanical HIT/MISS grading,
// scoreboard. Qualitative lessons / strategy-tuning stay human/on-demand (run a local Claude session).
//
//   node scripts/review.mjs --market us --scope daily            # close → equity/alpha → grade → scoreboard
//   node scripts/review.mjs --market idx --scope weekly           # week vs JCI + suggested knob tweaks
//   node scripts/review.mjs --market us --scope daily --git        # also commit/push
//   node scripts/review.mjs ... --quotes /tmp/q.json --portfolio /tmp/pf.json --trades /tmp/tr.ndjson --equity-file /tmp/eq.ndjson --decisions /tmp/dec.ndjson  (test)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function parseArgs(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; } } } return o; }
const o = parseArgs(process.argv.slice(2));
const MARKET = o.market, SCOPE = o.scope || 'daily', DRY = !!o['dry-run'], TEST = !!o.portfolio;
if (!MARKET || !['daily', 'weekly'].includes(SCOPE)) { console.error('ERROR: review needs --market us|idx and --scope daily|weekly'); process.exit(1); }
const MROOT = path.join(ROOT, 'markets', MARKET);

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const dayKey = () => ET_DATE.format(new Date());
const nowISO = () => new Date().toISOString();
const r2 = (x) => (x == null || Number.isNaN(x) ? null : Math.round((x + Number.EPSILON) * 100) / 100);
const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const readND = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const cfg = readJSON(path.join(MROOT, 'config.json'), {});
const cur = cfg.currency === 'IDR' ? 'Rp ' : '$';
const fmt = (x) => `${cur}${x == null ? '–' : Number(x).toLocaleString('en-US', { maximumFractionDigits: cfg.currency === 'IDR' ? 0 : 2 })}`;

const QUOTES = o.quotes || path.join(MROOT, 'state', 'quotes.json');
const DECISIONS = o.decisions || path.join(MROOT, 'decisions', 'decisions.ndjson');
const TRADES = o.trades || path.join(MROOT, 'logs', 'trades.ndjson');
const EQUITY = o['equity-file'] || path.join(MROOT, 'state', 'equity.ndjson');
const REVIEWS_DIR = o['reviews-dir'] || path.join(MROOT, 'reviews');
const LESSONS = path.join(REVIEWS_DIR, 'lessons.ndjson');
const BOTLOG = path.join(MROOT, 'logs', 'bot.log');
if (!DRY) fs.mkdirSync(REVIEWS_DIR, { recursive: true });

const PASS = ['--market', MARKET];
for (const k of ['config', 'portfolio', 'trades', 'equity-file']) if (o[k]) PASS.push('--' + k, o[k]);
if (DRY) PASS.push('--dry-run');
function paper(args) { try { const s = execFileSync('node', [path.join('scripts', 'paper.mjs'), ...args, ...PASS], { cwd: ROOT, encoding: 'utf8' }); let j; try { j = JSON.parse(s); } catch { j = null; } return { ok: true, json: j }; } catch (e) { return { ok: false, err: String(e.stderr || e.message || '').trim() }; } }
function git(args) { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } }
function writeFile(p, s) { if (DRY) return; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function isoWeek(d = new Date()) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); const wk = Math.ceil(((t - ys) / 86400000 + 1) / 7); return `${t.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`; }

const today = dayKey();
const benchLabel = cfg.benchmark?.label || 'benchmark';

if (SCOPE === 'daily') daily(); else weekly();

function daily() {
  const q = readJSON(QUOTES, null);
  const out = [];
  const note = (s) => { out.push(s); console.log(s); };
  note(`review ${MARKET} daily ${today}`);

  // 1. mark-to-close (auto-exit) using latest quotes
  if (q?.prices) { const r = paper(['mark', '--prices', JSON.stringify(q.prices), '--auto-exit']); note(r.ok ? `  mark-to-close: ${r.json?.marked} priced, ${(r.json?.auto_exits || []).length} exits, equity=${r.json?.equity}` : `  mark FAILED: ${r.err}`); }
  else note('  (no quotes — skipping mark; run feed.mjs at close for accurate marks)');

  // 2. equity + alpha (one authoritative row/day; guard against a second row)
  const eqRows = readND(EQUITY);
  let eqRow = eqRows.at(-1)?.date === today ? eqRows.at(-1) : null;
  if (!eqRow) {
    const bench = q?.bench_level;
    if (bench != null) { const r = paper(['equity', '--bench', String(bench)]); if (r.ok) eqRow = r.json; note(r.ok ? `  equity row written: alpha ${r.json?.alpha}% (bot ${r.json?.bot_ret_since_incept}% / ${benchLabel} ${r.json?.bench_ret_since_incept}%)` : `  equity FAILED: ${r.err}`); }
    else note('  (no bench level — cannot compute alpha without a fresh feed)');
  } else note(`  equity row exists for today: alpha ${eqRow.alpha}%`);

  // 3. mechanical grading of decisions resolved today
  const todayTrades = readND(TRADES).filter((r) => r.date === today);
  const resolved = todayTrades.filter((r) => r.side === 'sell');
  const grades = [];
  for (const tr of resolved) {
    const grade = tr.pnl_usd > 0 ? 'HIT' : tr.pnl_usd < 0 ? 'MISS' : 'UNCLEAR';
    grades.push({ symbol: tr.symbol, decision_id: tr.decision_id, grade, pnl_usd: tr.pnl_usd, pnl_pct: tr.pnl_pct, r: tr.r_multiple, exit: tr.event });
    if (!DRY) fs.appendFileSync(DECISIONS, JSON.stringify({ t: Date.now(), iso: nowISO(), date: today, phase: 'close-review', event: 'grade', decision_id: tr.decision_id, symbol: tr.symbol, outcome: grade, exit_reason: tr.event, pnl_usd: tr.pnl_usd, pnl_pct: tr.pnl_pct, r_multiple: tr.r_multiple, hold_days: tr.hold_days }) + '\n');
  }
  const hits = grades.filter((g) => g.grade === 'HIT').length, misses = grades.filter((g) => g.grade === 'MISS').length;
  const winRate = hits + misses ? r2((hits / (hits + misses)) * 100) : null;
  note(`  graded ${grades.length} resolved decision${grades.length === 1 ? '' : 's'}: ${hits}W/${misses}L${winRate != null ? ` (${winRate}% win)` : ''}`);

  // 4. scoreboard numbers
  const st = paper(['status']).json || {};
  const prevEq = eqRows.length && eqRows.at(-1)?.date !== today ? eqRows.at(-1).equity : eqRows.at(-2)?.equity;
  const dayPnl = prevEq != null && eqRow ? r2(eqRow.equity - prevEq) : null;
  const realizedToday = r2(resolved.reduce((s, t) => s + (t.pnl_usd || 0), 0));

  // 5. rule-based lessons (light — proving phase)
  const lessons = [];
  for (const g of grades) { if (g.exit === 'stop-loss') lessons.push({ lesson: `${g.symbol} stopped out (${g.pnl_pct}%) — re-check stop width vs ATR`, category: 'risk', action: 'do', evidence: `exit ${g.exit} pnl ${g.pnl_usd}`, weight: 2 }); if (g.exit === 'take-profit') lessons.push({ lesson: `${g.symbol} hit TP (${g.pnl_pct}%) — TP placement worked`, category: 'technical', action: 'continue', evidence: `exit ${g.exit} pnl ${g.pnl_usd}`, weight: 1 }); }
  if (!DRY) for (const l of lessons) fs.appendFileSync(LESSONS, JSON.stringify({ date: today, scope: 'daily', ...l }) + '\n');

  // 6. write the daily review markdown
  const md = [
    `# ${MARKET.toUpperCase()} Daily Review — ${today}`, '',
    '## Scoreboard',
    `- **Equity:** ${fmt(st.equity)}${dayPnl != null ? `  (Δ today ${fmt(dayPnl)})` : ''}`,
    `- **Cash:** ${fmt(st.cash)}   |   **Open positions:** ${st.open_positions ?? 0}`,
    `- **Realized today:** ${fmt(realizedToday)}   |   **Cumulative realized:** ${fmt(st.realized_pnl)}`,
    eqRow ? `- **Alpha vs ${benchLabel}: ${eqRow.alpha}%**  (bot ${eqRow.bot_ret_since_incept}% / ${benchLabel} ${eqRow.bench_ret_since_incept}% since inception)` : `- Alpha: (no equity row today)`,
    '',
    '## Resolved today',
    grades.length ? '| symbol | exit | pnl | pnl% | R | grade |\n|---|---|---|---|---|---|\n' + grades.map((g) => `| ${g.symbol} | ${g.exit} | ${fmt(g.pnl_usd)} | ${g.pnl_pct}% | ${g.r ?? '–'} | ${g.grade} |`).join('\n') : '_No positions resolved today._',
    '', `Win-rate today: ${winRate != null ? winRate + '%' : '–'} (${hits}W / ${misses}L)`, '',
    '## Open positions',
    (st.positions || []).length ? '| symbol | qty | avg | last | stop | tp | unrealized |\n|---|---|---|---|---|---|---|\n' + st.positions.map((p) => `| ${p.symbol} | ${p.qty} | ${p.avg_price} | ${p.last_price ?? '–'} | ${p.stop ?? '–'} | ${p.take_profit ?? '–'} | ${fmt(p.unrealized)} |`).join('\n') : '_Flat (no open positions)._',
    '', '## Lessons (rule-based)', lessons.length ? lessons.map((l) => `- ${l.lesson}`).join('\n') : '- _(none flagged)_',
    '', `_Generated ${nowISO()} by review.mjs — deterministic. Qualitative analysis / strategy tuning: run a local Claude session on demand._`,
  ].join('\n');
  const mdPath = path.join(REVIEWS_DIR, 'daily', `${today}.md`);
  writeFile(mdPath, md);
  finish(out, `daily review → ${path.relative(ROOT, mdPath)}`);
}

function weekly() {
  const out = [];
  const note = (s) => { out.push(s); console.log(s); };
  const wk = isoWeek();
  note(`review ${MARKET} weekly ${wk}`);
  const eq = readND(EQUITY);
  const trades = readND(TRADES);
  const last5 = eq.slice(-5);
  const weekStart = last5[0], weekEnd = eq.at(-1);
  const botWk = weekStart && weekEnd ? r2(((weekEnd.equity / weekStart.equity) - 1) * 100) : null;
  const benchWk = weekStart && weekEnd ? r2(((weekEnd.bench_level / weekStart.bench_level) - 1) * 100) : null;
  const alphaWk = botWk != null && benchWk != null ? r2(botWk - benchWk) : null;
  const sells = trades.filter((t) => t.side === 'sell');
  const wins = sells.filter((t) => t.pnl_usd > 0), losses = sells.filter((t) => t.pnl_usd < 0);
  const winRate = sells.length ? r2((wins.length / sells.length) * 100) : null;
  const rs = sells.map((t) => t.r_multiple).filter((x) => x != null);
  const avgR = rs.length ? r2(rs.reduce((a, b) => a + b, 0) / rs.length) : null;
  note(`  week: bot ${botWk}% vs ${benchLabel} ${benchWk}% → alpha ${alphaWk}%; ${sells.length} exits, ${winRate}% win, avgR ${avgR}`);

  // suggested knob tweaks (NOT auto-applied — surfaced for human/LLM judgment)
  const suggest = [];
  if (winRate != null && winRate < 35 && sells.length >= 5) suggest.push('Win-rate < 35% — raise buy threshold or tighten conviction blend (config.blend.thresholds.buy).');
  if (avgR != null && avgR < 0) suggest.push('Negative avg R — stops may be too tight vs ATR (config.risk.default_stop_atr_mult).');
  if (alphaWk != null && alphaWk < 0) suggest.push(`Trailing ${benchLabel} this week — review which leg (tech vs research) drove the misses.`);

  const md = [
    `# ${MARKET.toUpperCase()} Weekly Review — ${wk}`, '',
    '## Scoreboard',
    `- **Weekly alpha vs ${benchLabel}: ${alphaWk}%**  (bot ${botWk}% / ${benchLabel} ${benchWk}%)`,
    `- Exits: ${sells.length}  |  Win-rate: ${winRate}%  |  Avg R: ${avgR}`,
    `- Latest equity: ${fmt(weekEnd?.equity)}  (cum alpha ${weekEnd ? r2(weekEnd.bot_ret_since_incept - weekEnd.bench_ret_since_incept) : '–'}%)`,
    '', '## Suggested tuning (apply on demand — not automated)',
    suggest.length ? suggest.map((s) => `- ${s}`).join('\n') : '- _No rule triggered; hold the line._',
    '', `_Generated ${nowISO()} by review.mjs. Edit strategy.md / config.json via a local Claude session when you act on these._`,
  ].join('\n');
  const mdPath = path.join(REVIEWS_DIR, 'weekly', `${wk}.md`);
  writeFile(mdPath, md);
  if (!DRY && alphaWk != null) fs.appendFileSync(LESSONS, JSON.stringify({ date: today, scope: 'weekly', lesson: `Week ${wk}: alpha ${alphaWk}% vs ${benchLabel}`, category: 'research', action: alphaWk >= 0 ? 'continue' : 'do', evidence: `bot ${botWk}% bench ${benchWk}% win ${winRate}%`, weight: 3 }) + '\n');
  finish(out, `weekly review → ${path.relative(ROOT, mdPath)}`);
}

function finish(out, summary) {
  if (!DRY && !TEST) {
    try { execFileSync('node', [path.join('scripts', 'dashboard.mjs'), '--market', MARKET], { cwd: ROOT }); } catch { /* non-fatal */ }
    fs.appendFileSync(BOTLOG, `${nowISO()} review ${SCOPE}: ${summary}\n`);
  }
  if (o.git && !DRY) { git(['add', '-A']); const c = git(['commit', '-m', `${MARKET} review ${SCOPE} ${today}`]); if (c != null) { git(['pull', '--rebase', 'origin', 'main']); git(['push', 'origin', 'HEAD']); console.log('  git: committed + pushed'); } }
  console.log(`\n${summary}`);
  process.exit(0);
}
