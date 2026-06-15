#!/usr/bin/env node
// paper.mjs — deterministic paper-trading accounting for the US stock bot.
// No network, no deps. The routine fetches prices (WebFetch Yahoo) and passes them in.
// All money math lives here so it never depends on the model doing arithmetic in its head.
//
// Commands:
//   status                                  show cash / positions / equity
//   start-day                               mark today as the trading day; snapshot day_start_equity
//   buy   --symbol S --price P (--usd N | --stop X)  [--tp Y --conviction C --decision-id ID --reason "..." --phase open]
//   sell  --symbol S --price P (--qty Q | --all)     [--reason "..." --phase midday]
//   mark  (--prices '{"AAPL":210.1,...}' | --prices-file f.json) [--auto-exit]   update last prices; optional stop/TP exits
//   equity --spx LEVEL                       snapshot equity.ndjson with alpha vs SPX (sets inception on first call)
//
// Global overrides (used by the pipeline-test routine to avoid touching live files):
//   --portfolio <path>  --trades <path>  --equity-file <path>  --config <path>  --dry-run
//
// Conventions: qty rounded to 6dp, money to 2dp. Append-only NDJSON; atomic JSON state writes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- arg parsing ----------
function parseArgs(argv) {
  const cmd = argv[0];
  const o = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) o[key] = true;
      else { o[key] = next; i++; }
    }
  }
  return { cmd, o };
}

// ---------- helpers ----------
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const r6 = (x) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;
const num = (x) => (x === undefined || x === true ? undefined : Number(x));
const nowISO = () => new Date().toISOString();
const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
const dayKey = (d = new Date()) => ET_DATE.format(d); // trading day = market (ET) calendar date

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { if (fallback !== undefined) return fallback; throw new Error(`cannot read JSON: ${p}`); }
}
function writeJSONAtomic(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p); // atomic on POSIX — a crash mid-write can't corrupt state
}
function appendNDJSON(p, obj) {
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
}
function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }
function out(obj) { console.log(JSON.stringify(obj, null, 2)); }

// ---------- main ----------
const { cmd, o } = parseArgs(process.argv.slice(2));
const DRY = !!o['dry-run'];

const MARKET = o.market || null;                                   // 'us' | 'idx'
const MROOT = MARKET ? path.join(ROOT, 'markets', MARKET) : ROOT;   // per-market data dir
const CONFIG_PATH = o.config || path.join(MROOT, 'config.json');
const PORT_PATH   = o.portfolio || path.join(MROOT, 'state', 'portfolio.json');
const TRADES_PATH = o.trades || path.join(MROOT, 'logs', 'trades.ndjson');
const EQUITY_PATH = o['equity-file'] || path.join(MROOT, 'state', 'equity.ndjson');

const cfg = readJSON(CONFIG_PATH);
const R = cfg.risk;
const pf = readJSON(PORT_PATH);
if (!pf.positions) pf.positions = [];

const SLIP = R.slippage_pct / 100;
const FEE = R.fee_rate_pct / 100;
const LOT = cfg.lot_size || 1;            // IDX = 100; US = 1
const FRACTIONAL = cfg.fractional_shares !== false;

function markValue(pos) { return pos.qty * (pos.last_price ?? pos.avg_price); }
function positionsValue() { return pf.positions.reduce((s, p) => s + markValue(p), 0); }
function equityEstimate() { return pf.cash + positionsValue(); }
function findPos(sym) { return pf.positions.find((p) => p.symbol === sym); }

function persist(extra = {}) {
  pf.equity = r2(equityEstimate());
  pf.updated = nowISO();
  Object.assign(pf, extra);
  if (!DRY) writeJSONAtomic(PORT_PATH, pf);
}

function guardEntries() {
  if (pf.halted) die(`account halted: ${pf.halted_reason}`);
  const eq = equityEstimate();
  if (eq <= pf.starting_capital * (1 - R.circuit_breaker_pct / 100)) {
    if (!DRY) persist({ halted: true, halted_reason: `circuit breaker (-${R.circuit_breaker_pct}%)` });
    die(`circuit breaker tripped at equity ${r2(eq)} — new entries halted`);
  }
  if (pf.day_start_equity && eq <= pf.day_start_equity * (1 - R.daily_loss_limit_pct / 100)) {
    die(`daily loss limit (-${R.daily_loss_limit_pct}%) hit — new entries paused for today`);
  }
}

switch (cmd) {
  case 'status': {
    out({
      updated: pf.updated, cash: r2(pf.cash), equity: r2(equityEstimate()),
      positions_value: r2(positionsValue()), open_positions: pf.positions.length,
      realized_pnl: r2(pf.realized_pnl), total_fees: r2(pf.total_fees),
      halted: pf.halted, day_start_equity: pf.day_start_equity,
      positions: pf.positions.map((p) => ({
        symbol: p.symbol, qty: r6(p.qty), avg_price: r2(p.avg_price),
        last_price: p.last_price ?? null, stop: p.stop ?? null, take_profit: p.take_profit ?? null,
        unrealized: p.last_price ? r2((p.last_price - p.avg_price) * p.qty) : null,
      })),
    });
    break;
  }

  case 'start-day': {
    pf.day_key = dayKey();
    pf.day_start_equity = r2(equityEstimate());
    persist();
    out({ ok: true, day_key: pf.day_key, day_start_equity: pf.day_start_equity });
    break;
  }

  case 'buy': {
    const symbol = o.symbol; const price = num(o.price);
    if (!symbol || !price) die('buy needs --symbol and --price');
    guardEntries();
    const existing = findPos(symbol);
    if (!existing && pf.positions.length >= R.max_open_positions)
      die(`max_open_positions (${R.max_open_positions}) reached`);

    const fillPrice = price * (1 + SLIP);
    const eq = equityEstimate();
    const stop = num(o.stop);

    // requested notional: explicit --usd, else 1%-risk sizing from stop distance
    let reqUsd;
    if (o.usd !== undefined) reqUsd = num(o.usd);
    else if (stop !== undefined && fillPrice > stop) reqUsd = (eq * R.risk_per_trade_pct / 100) / ((fillPrice - stop) / fillPrice);
    else die('buy needs --usd N or --stop X (for 1%-risk sizing)');

    // caps: per-name max, available cash (1% buffer)
    const heldValue = existing ? markValue(existing) : 0;
    const maxPosNotional = Math.max(0, (eq * R.max_position_pct / 100) - heldValue);
    const maxCashNotional = (pf.cash * 0.99) / (1 + FEE);
    let notional = Math.min(reqUsd, maxPosNotional, maxCashNotional);
    if (notional < 1) die(`sized notional ${r2(notional)} < 1 (caps: pos ${r2(maxPosNotional)}, cash ${r2(maxCashNotional)})`);

    let qty;
    if (FRACTIONAL) qty = r6(notional / fillPrice);
    else {
      const lots = Math.floor(notional / (fillPrice * LOT));   // round DOWN to whole lots
      if (lots < 1) die(`can't afford one ${LOT}-share lot of ${symbol}: a lot costs ${r2(fillPrice * LOT)}, sized notional ${r2(notional)}`);
      qty = lots * LOT;
    }
    notional = r2(qty * fillPrice);
    const fees = r2(notional * FEE);
    const slipUsd = r2(qty * (fillPrice - price));

    const event = existing ? 'add' : 'open';
    if (existing) {
      const newQty = r6(existing.qty + qty);
      existing.avg_price = (existing.cost_basis + notional) / newQty;
      existing.qty = newQty;
      existing.cost_basis = r2(existing.cost_basis + notional);
      if (o.tp !== undefined) existing.take_profit = num(o.tp);
      if (stop !== undefined) existing.stop = stop;
      if (o.conviction !== undefined) existing.conviction = num(o.conviction);
    } else {
      pf.positions.push({
        symbol, qty, avg_price: r2(fillPrice), cost_basis: notional,
        stop: stop ?? null, initial_stop: stop ?? null, take_profit: num(o.tp) ?? null,
        opened: nowISO(), decision_id: o['decision-id'] || null,
        high_water: fillPrice, last_price: price, conviction: num(o.conviction) ?? null,
      });
    }
    pf.cash = r2(pf.cash - notional - fees);
    pf.total_fees = r2(pf.total_fees + fees);

    const rec = {
      id: `${dayKey()}-${symbol}-${Date.now()}`, t: Date.now(), iso: nowISO(), date: dayKey(),
      symbol, side: 'buy', event, qty, price, fill_price: r2(fillPrice),
      notional_usd: notional, fees_usd: fees, slippage_usd: slipUsd, cash_after: pf.cash,
      decision_id: o['decision-id'] || null, conviction: num(o.conviction) ?? null,
      stop: stop ?? null, take_profit: num(o.tp) ?? null, reason: o.reason || null,
      phase: o.phase || null,
    };
    if (!DRY) appendNDJSON(TRADES_PATH, rec);
    persist();
    out({ ok: true, dry_run: DRY, action: event, ...rec, equity: pf.equity });
    break;
  }

  case 'sell': {
    const symbol = o.symbol; const price = num(o.price);
    if (!symbol || !price) die('sell needs --symbol and --price');
    const pos = findPos(symbol);
    if (!pos) die(`no open position in ${symbol}`);
    let qty = o.all ? pos.qty : r6(num(o.qty));
    if (!FRACTIONAL && !o.all) qty = Math.floor(qty / LOT) * LOT;   // partial sells in whole lots
    if (!qty || qty <= 0) die('sell needs --qty Q (whole lots) or --all');
    if (qty > pos.qty + 1e-9) die(`qty ${qty} exceeds held ${pos.qty}`);

    const fillPrice = price * (1 - SLIP);
    const proceeds = r2(qty * fillPrice);
    const fees = r2(proceeds * FEE);
    const costPortion = r2(qty * pos.avg_price);
    const pnl = r2(proceeds - fees - costPortion);
    const pnlPct = r2(((fillPrice - pos.avg_price) / pos.avg_price) * 100);
    const rMult = pos.initial_stop && pos.avg_price > pos.initial_stop
      ? r2((fillPrice - pos.avg_price) / (pos.avg_price - pos.initial_stop)) : null;
    const holdDays = pos.opened ? r2((Date.now() - new Date(pos.opened).getTime()) / 86400000) : null;
    const slipUsd = r2(qty * (price - fillPrice));
    const full = qty >= pos.qty - 1e-9;

    pf.cash = r2(pf.cash + proceeds - fees);
    pf.total_fees = r2(pf.total_fees + fees);
    pf.realized_pnl = r2(pf.realized_pnl + pnl);
    if (full) pf.positions = pf.positions.filter((p) => p.symbol !== symbol);
    else { pos.qty = r6(pos.qty - qty); pos.cost_basis = r2(pos.cost_basis - costPortion); }

    const rec = {
      id: `${dayKey()}-${symbol}-${Date.now()}`, t: Date.now(), iso: nowISO(), date: dayKey(),
      symbol, side: 'sell', event: full ? 'close' : 'trim', qty, price, fill_price: r2(fillPrice),
      proceeds_usd: proceeds, fees_usd: fees, slippage_usd: slipUsd,
      pnl_usd: pnl, pnl_pct: pnlPct, r_multiple: rMult, hold_days: holdDays,
      cash_after: pf.cash, decision_id: pos.decision_id || null,
      reason: o.reason || null, phase: o.phase || null,
    };
    if (!DRY) appendNDJSON(TRADES_PATH, rec);
    persist();
    out({ ok: true, dry_run: DRY, action: rec.event, ...rec, equity: pf.equity });
    break;
  }

  case 'mark': {
    let prices = {};
    if (o['prices-file']) prices = readJSON(o['prices-file']);
    else if (o.prices) prices = JSON.parse(o.prices);
    else die('mark needs --prices \'{"SYM":p}\' or --prices-file f.json');
    const exits = [];
    for (const pos of pf.positions) {
      const px = prices[pos.symbol];
      if (px === undefined) continue;
      pos.last_price = px;
      pos.high_water = Math.max(pos.high_water ?? px, px);
      if (o['auto-exit'] && pos.stop != null && px <= pos.stop) exits.push({ symbol: pos.symbol, at: pos.stop, reason: 'stop-loss' });
      else if (o['auto-exit'] && pos.take_profit != null && px >= pos.take_profit) exits.push({ symbol: pos.symbol, at: pos.take_profit, reason: 'take-profit' });
    }
    persist();
    // auto-exits are executed by re-invoking the sell path so accounting stays in one place
    for (const ex of exits) {
      const pos = findPos(ex.symbol);
      if (!pos) continue;
      // stop-loss fills slip against us (gap risk); take-profit is a limit and fills at target
      const fillPrice = ex.reason === 'stop-loss' ? r2(ex.at * (1 - SLIP)) : ex.at;
      const proceeds = r2(pos.qty * fillPrice);
      const fees = r2(proceeds * FEE);
      const costPortion = r2(pos.qty * pos.avg_price);
      const pnl = r2(proceeds - fees - costPortion);
      const rMult = pos.initial_stop && pos.avg_price > pos.initial_stop
        ? r2((fillPrice - pos.avg_price) / (pos.avg_price - pos.initial_stop)) : null;
      const rec = {
        id: `${dayKey()}-${pos.symbol}-${Date.now()}`, t: Date.now(), iso: nowISO(), date: dayKey(),
        symbol: pos.symbol, side: 'sell', event: ex.reason, qty: pos.qty, price: ex.at, fill_price: fillPrice,
        proceeds_usd: proceeds, fees_usd: fees, slippage_usd: r2(pos.qty * (ex.at - fillPrice)), pnl_usd: pnl,
        pnl_pct: r2(((fillPrice - pos.avg_price) / pos.avg_price) * 100), r_multiple: rMult,
        hold_days: pos.opened ? r2((Date.now() - new Date(pos.opened).getTime()) / 86400000) : null,
        cash_after: null, decision_id: pos.decision_id || null, reason: `auto ${ex.reason}`, phase: o.phase || 'mark',
      };
      pf.cash = r2(pf.cash + proceeds - fees);
      pf.total_fees = r2(pf.total_fees + fees);
      pf.realized_pnl = r2(pf.realized_pnl + pnl);
      pf.positions = pf.positions.filter((p) => p.symbol !== pos.symbol);
      rec.cash_after = pf.cash;
      if (!DRY) appendNDJSON(TRADES_PATH, rec);
    }
    persist();
    out({ ok: true, dry_run: DRY, marked: Object.keys(prices).length, auto_exits: exits, equity: pf.equity });
    break;
  }

  case 'equity': {
    const bench = num(o.bench ?? o.spx);   // --bench (market-neutral); --spx kept as alias
    if (!bench) die('equity needs --bench LEVEL');
    if (pf.inception_bench == null) { pf.inception_bench = bench; pf.inception_date = dayKey(); }
    const eq = equityEstimate();
    const botRet = eq / pf.starting_capital - 1;
    const benchRet = bench / pf.inception_bench - 1;
    const row = {
      date: o.date || dayKey(), t: Date.now(), iso: nowISO(),
      equity: r2(eq), cash: r2(pf.cash), positions_value: r2(positionsValue()),
      open_positions: pf.positions.length, realized_pnl: r2(pf.realized_pnl),
      bench_level: bench, bot_ret_since_incept: r2(botRet * 100), bench_ret_since_incept: r2(benchRet * 100),
      alpha: r2((botRet - benchRet) * 100),
    };
    if (!DRY) appendNDJSON(EQUITY_PATH, row);
    persist();
    out({ ok: true, dry_run: DRY, ...row });
    break;
  }

  default:
    die(`unknown command "${cmd}". Try: status | start-day | buy | sell | mark | equity`);
}
