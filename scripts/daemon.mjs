#!/usr/bin/env node
// daemon.mjs — the local orchestrator (the only always-on process). Replaces the cloud open/midday/
// review triggers: at each market's session phases it runs feed → execute/review on the device, then
// commits/pushes. Premarket stays in the cloud (2 routines) and reads the technicals this pushes.
// DST-correct via Intl (no hard-coded UTC offsets). Caffeinates the Mac through the US night.
// Zero deps (child_process + timers).
//
//   node scripts/daemon.mjs                 # run forever (launchd starts this at login)
//   node scripts/daemon.mjs --schedule       # print the schedule + current market clocks, run nothing
//   node scripts/daemon.mjs --once-now --market us --phase open      # run one action immediately (feed→execute)
//   node scripts/daemon.mjs --once-now --market idx --scope daily     # feed→review
//   node scripts/daemon.mjs --no-git         # never commit/push (testing)

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function parseArgs(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; } } } return o; }
const o = parseArgs(process.argv.slice(2));
const NOGIT = !!o['no-git'];
const RAN_PATH = path.join(ROOT, '.daemon-state.json');
const DLOG = path.join(ROOT, 'markets', 'daemon.log');

// Per-market session schedule, in MARKET-LOCAL time. Premarket = cloud (not here). Each entry's steps
// run in order; the whole entry is committed+pushed once (so cloud premarket sees pushed technicals).
const SCHED = [
  // IDX — Asia/Jakarta (no DST). 07:30 feed→push technicals for the 07:45 cloud premarket.
  { id: 'idx-pretech', m: 'idx', tz: 'Asia/Jakarta', at: '07:30', days: [1, 2, 3, 4, 5], steps: ['feed'], label: 'feed→technicals (for premarket)' },
  { id: 'idx-open', m: 'idx', tz: 'Asia/Jakarta', at: '09:05', days: [1, 2, 3, 4, 5], steps: ['feed', 'execute:open'] },
  { id: 'idx-midday', m: 'idx', tz: 'Asia/Jakarta', at: '13:35', days: [1, 2, 3, 4, 5], steps: ['feed', 'execute:midday'] },
  { id: 'idx-close', m: 'idx', tz: 'Asia/Jakarta', at: '16:15', days: [1, 2, 3, 4, 5], steps: ['feed', 'review:daily'] },
  { id: 'idx-weekly', m: 'idx', tz: 'Asia/Jakarta', at: '16:40', days: [5], steps: ['review:weekly'] },
  // US — America/New_York (DST handled by Intl). 06:50 feed→push for the 07:05 cloud premarket.
  { id: 'us-pretech', m: 'us', tz: 'America/New_York', at: '06:50', days: [1, 2, 3, 4, 5], steps: ['feed'], label: 'feed→technicals (for premarket)' },
  { id: 'us-open', m: 'us', tz: 'America/New_York', at: '09:33', days: [1, 2, 3, 4, 5], steps: ['feed', 'execute:open'] },
  { id: 'us-midday', m: 'us', tz: 'America/New_York', at: '12:32', days: [1, 2, 3, 4, 5], steps: ['feed', 'execute:midday'] },
  { id: 'us-close', m: 'us', tz: 'America/New_York', at: '16:15', days: [1, 2, 3, 4, 5], steps: ['feed', 'review:daily'] },
  { id: 'us-weekly', m: 'us', tz: 'America/New_York', at: '16:30', days: [5], steps: ['review:weekly'] },
];
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function nowParts(tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const hh = (+p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, hh, mm: +p.minute, dow: DOW[p.weekday], mins: hh * 60 + (+p.minute) };
}
const dueMins = (e) => { const [H, M] = e.at.split(':').map(Number); return H * 60 + M; };

function log(s) { const line = `${new Date().toISOString()} ${s}`; console.log(line); try { fs.mkdirSync(path.dirname(DLOG), { recursive: true }); fs.appendFileSync(DLOG, line + '\n'); } catch { /* ignore */ } }
function loadRan() { try { return new Set(JSON.parse(fs.readFileSync(RAN_PATH, 'utf8'))); } catch { return new Set(); } }
function saveRan(set) { try { fs.writeFileSync(RAN_PATH, JSON.stringify([...set].slice(-200))); } catch { /* ignore */ } }

function runNode(args, label) {
  log(`  · ${label}`);
  const r = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.stdout) r.stdout.trim().split('\n').forEach((l) => log(`    ${l}`));
  if (r.status !== 0) { log(`    ✗ exit ${r.status}${r.stderr ? ': ' + r.stderr.trim().split('\n').slice(-1)[0] : ''}`); return false; }
  return true;
}
function gitPush(m, id) {
  if (NOGIT) { log('    (git skipped: --no-git)'); return; }
  const g = (a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  g(['add', '-A']);
  if (g(['commit', '-m', `${m} daemon ${id}`]).status !== 0) { log('    git: nothing to commit'); return; }
  g(['pull', '--rebase', 'origin', 'main']);
  const p = g(['push', 'origin', 'HEAD']);
  log(p.status === 0 ? '    git: pushed' : '    git: push failed (check remote/branch)');
}
function runEntry(e) {
  log(`▶ ${e.id}${e.label ? ' — ' + e.label : ''}`);
  for (const step of e.steps) {
    const [kind, arg] = step.split(':');
    if (kind === 'feed') runNode([path.join('scripts', 'feed.mjs'), '--market', e.m], `feed ${e.m}`);
    else if (kind === 'execute') runNode([path.join('scripts', 'execute.mjs'), '--market', e.m, '--phase', arg], `execute ${e.m} ${arg}`);
    else if (kind === 'review') runNode([path.join('scripts', 'review.mjs'), '--market', e.m, '--scope', arg], `review ${e.m} ${arg}`);
  }
  gitPush(e.m, e.id);
  log(`◀ ${e.id} done`);
}

// ---------- caffeinate the Mac through the US session (≈09:25–16:40 ET, weekdays) ----------
let caf = null;
function manageCaffeine() {
  const n = nowParts('America/New_York');
  const inSession = [1, 2, 3, 4, 5].includes(n.dow) && n.mins >= 565 && n.mins <= 1000;
  if (inSession && !caf) { try { caf = spawn('caffeinate', ['-i'], { stdio: 'ignore' }); caf.on('exit', () => { caf = null; }); log('☕ caffeinate ON (US session)'); } catch { /* not macOS */ } }
  else if (!inSession && caf) { caf.kill(); caf = null; log('caffeinate OFF (US session over)'); }
}

// ---------- modes ----------
if (o.schedule) {
  console.log('Market clocks now:');
  for (const tz of ['Asia/Jakarta', 'America/New_York']) { const n = nowParts(tz); console.log(`  ${tz.padEnd(20)} ${String(n.hh).padStart(2, '0')}:${String(n.mm).padStart(2, '0')} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][n.dow]}`); }
  console.log('\nSchedule (market-local; premarket runs in the CLOUD, not here):');
  for (const e of SCHED) { const n = nowParts(e.tz); const due = dueMins(e); const today = e.days.includes(n.dow); const status = today ? (n.mins < due ? `in ${due - n.mins}m` : n.mins < due + 30 ? 'DUE now' : 'passed') : 'not today'; console.log(`  ${e.at} ${e.tz.split('/')[1].padEnd(9)} ${e.id.padEnd(12)} ${e.steps.join('+').padEnd(20)} ${status}`); }
  process.exit(0);
}
if (o['once-now']) {
  const m = o.market; if (!m) { console.error('--once-now needs --market us|idx [--phase open|midday | --scope daily|weekly]'); process.exit(1); }
  const steps = ['feed']; if (o.phase) steps.push('execute:' + o.phase); else if (o.scope) steps.push('review:' + o.scope);
  runEntry({ id: `once-${m}`, m, steps, label: 'manual --once-now' });
  process.exit(0);
}

// ---------- main loop ----------
log(`daemon up (pid ${process.pid})${NOGIT ? ' [no-git]' : ''} — ${SCHED.length} scheduled actions; premarket is cloud`);
const ran = loadRan();
function tick() {
  try {
    manageCaffeine();
    for (const e of SCHED) {
      const n = nowParts(e.tz);
      if (!e.days.includes(n.dow)) continue;
      const due = dueMins(e);
      const key = `${n.date}:${e.id}`;
      if (n.mins >= due && n.mins < due + 30 && !ran.has(key)) { ran.add(key); saveRan(ran); runEntry(e); }
    }
  } catch (err) { log(`tick error: ${err.message}`); }
}
tick();
setInterval(tick, 60_000);
