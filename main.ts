// DIP-CATCHER v2 — a BTC dip-buying bot for make.fun btc-race-24h-20261115-0828.
//
// Idea: on a 1-minute cbBTC replay, one-minute noise dominates, but a price that has
// fallen far below its 6-hour mean reliably bounces back within the hour. The bot
// therefore buys only deep drops against the 6-hour anchor (or a sharp one-hour
// plunge), banks the reversion quickly, and otherwise sits in cash. A momentum leg
// keeps it alive in an uptrend on race day.
//
// What the offline replay showed on the frozen dev window (1,440 bars, -4.0%):
//   - the 1-hour z-score / RSI dip signals in the first design LOSE (-$34..-$63):
//     z < -2 predicts a NEGATIVE next hour (-0.22% mean) and RSI < 30 the same.
//   - the 6-hour anchor predicts: price >= 3% below its 6h mean -> +3.73% mean
//     forward 60-min return (9/9 bars beat the ~42 bps round trip); a 1-hour
//     drop >= 2% -> +2.90% (34/35 beat it). Those are the entry signals.
//   - locked parameters (flat plateau: TP/SL/dip-threshold neighbours agree):
//     dip vs 6h mean >= 2.5% OR trailing 1h return <= -2%; exits TP +1.5%,
//     reversion to the 1h mean at +0.3% profit, stop -2.5%, time stops 180/360
//     bars, kill-switch at 8% drawdown. Replay: +$13.58, 5 trades, 5 wins,
//     max drawdown 1.89%; both halves positive (+$5.82 / +$3.27); at 2x fees
//     still +$11.67. A 0.6% reversion threshold looked better (+$22.77) but
//     collapsed to -$11.19 at 2x fees (one threshold-miss flips a win into a
//     stop-loss) — rejected as a sharp peak.
//
// Costs, verified against the harness source: a full-size $1,000 round trip pays
// ~42 bps (4 bps fee + 2 bps slippage + ~15 bps impact per leg at the ~$666k
// depths the dev bars actually carry), NOT the ~26 bps the rules quote.
//
// Runtime: Node 22, stdlib only (the vendored shim), no clock, no randomness,
// no network. One reply per batch, sells before buys (never both — one position).

import {
  runBars,
  type BarsState,
  type Batch,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

// --- locked parameters (from the offline replay; see the header) ---
const DIP_6H = 0.025; // buy when the close sits >= 2.5% under the 6h mean
const PLUNGE_1H = -0.02; // ... or the last hour fell >= 2%
const TAKE_PROFIT = 0.015; // exit at +1.5% over cost
const STOP_LOSS = 0.025; // exit at -2.5% under cost
const REVERSION_PROFIT = 0.003; // reversion exit needs +0.3% profit
const COOLDOWN_BARS = 10; // bars to wait after an exit before re-entering
const SOFT_HOLD_BARS = 180; // exit after this long if the profit is there
const HARD_HOLD_BARS = 360; // exit after this long, whatever the profit
const KILL_SWITCH = 0.92; // equity under 92% of its peak -> flatten + halt
const MIN_BARS = 60; // no trades before 60 closes have been seen
const MOMENTUM_RET15 = 0.004; // momentum leg: 15-min return above +0.4%

const RSI_BARS = 14;
const EMA_FAST = 8;
const EMA_SLOW = 21;

interface DipState {
  closes: number[];
  // Wilder RSI: first averages are the means of the first 14 changes.
  rsiChanges: number[];
  rsiGain: number | null;
  rsiLoss: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  prevEmaFast: number | null;
  prevEmaSlow: number | null;
  // position bookkeeping, from the account the harness sends us.
  entrySeq: number;
  lastExitSeq: number;
  peakEquity: number;
  halted: boolean;
  trades: number;
}

const st: DipState = {
  closes: [],
  rsiChanges: [],
  rsiGain: null,
  rsiLoss: null,
  emaFast: null,
  emaSlow: null,
  prevEmaFast: null,
  prevEmaSlow: null,
  entrySeq: -1,
  lastExitSeq: -1e9,
  peakEquity: 1_000_000_000,
  halted: false,
  trades: 0,
};

function meanOf(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function meanLast(window: number): number {
  return meanOf(st.closes.slice(-window));
}

function rsiNow(): number | null {
  if (st.rsiGain === null || st.rsiLoss === null) return null;
  const total = st.rsiGain + st.rsiLoss;
  if (total === 0) return 50;
  return (100 * st.rsiGain) / total;
}

function noteClose(close: number): void {
  const prev = st.closes.length > 0 ? st.closes[st.closes.length - 1] : null;
  st.closes.push(close);
  // Wilder RSI on the change from the previous close.
  if (prev !== null) {
    const change = close - prev;
    if (st.rsiGain === null) {
      st.rsiChanges.push(change);
      if (st.rsiChanges.length === RSI_BARS) {
        let gains = 0;
        let losses = 0;
        for (const c of st.rsiChanges) {
          if (c > 0) gains += c;
          else losses -= c;
        }
        st.rsiGain = gains / RSI_BARS;
        st.rsiLoss = losses / RSI_BARS;
      }
    } else {
      st.rsiGain = (st.rsiGain * (RSI_BARS - 1) + Math.max(change, 0)) / RSI_BARS;
      st.rsiLoss = (st.rsiLoss * (RSI_BARS - 1) + Math.max(-change, 0)) / RSI_BARS;
    }
  }
  // EMAs, seeded with the SMA of their first N closes.
  if (st.emaFast === null) {
    if (st.closes.length >= EMA_FAST) st.emaFast = meanLast(EMA_FAST);
  } else {
    st.prevEmaFast = st.emaFast;
    st.emaFast = close * (2 / (EMA_FAST + 1)) + st.emaFast * (1 - 2 / (EMA_FAST + 1));
  }
  if (st.emaSlow === null) {
    if (st.closes.length >= EMA_SLOW) st.emaSlow = meanLast(EMA_SLOW);
  } else {
    st.prevEmaSlow = st.emaSlow;
    st.emaSlow = close * (2 / (EMA_SLOW + 1)) + st.emaSlow * (1 - 2 / (EMA_SLOW + 1));
  }
}

function decide(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
  const closeBig = state.close(SYMBOL);
  if (closeBig === null) return [];
  const close = Number(closeBig);
  noteClose(close);

  const equity = Number(state.equity);
  if (equity > st.peakEquity) st.peakEquity = equity;

  const pos = state.positions.get(SYMBOL);
  // The position appeared: this batch is the bar whose open filled our buy.
  if (pos !== undefined && st.entrySeq === -1) st.entrySeq = state.seq;
  // The position vanished: this batch is the bar whose open filled our sell.
  if (pos === undefined && st.entrySeq !== -1) {
    st.lastExitSeq = state.seq;
    st.entrySeq = -1;
  }

  // Kill-switch: flatten once and stop for the rest of the window.
  if (equity < KILL_SWITCH * st.peakEquity) {
    st.halted = true;
    if (pos !== undefined) {
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }
  if (st.halted) return [];

  if (pos !== undefined) {
    const worth = Number(state.value(SYMBOL, pos.qty));
    const cost = Number(pos.cost);
    const profit = (worth - cost) / cost;
    const held = state.seq - st.entrySeq;
    const sma60 = meanLast(60);
    if (worth >= cost * (1 + TAKE_PROFIT)) {
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (close >= sma60 && profit >= REVERSION_PROFIT) {
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (worth <= cost * (1 - STOP_LOSS)) {
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (held > SOFT_HOLD_BARS && profit >= REVERSION_PROFIT) {
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (held > HARD_HOLD_BARS) {
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: entries need 60 closes and the post-exit cooldown.
  if (st.closes.length < MIN_BARS) return [];
  if (state.seq - st.lastExitSeq < COOLDOWN_BARS) return [];
  if (state.cash < 1_000_000n) return [];

  const sma60 = meanLast(60);
  const sma360 = meanLast(360);
  const rsi = rsiNow();
  if (rsi === null) return [];

  // Primary: a deep drop against the 6-hour mean, or a sharp one-hour plunge.
  const dip6h = (sma360 - close) / close;
  const trail1h = close / st.closes[st.closes.length - 61] - 1;
  if (dip6h >= DIP_6H || trail1h <= PLUNGE_1H) {
    st.trades++;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  // Momentum leg: only in a genuine intraday uptrend, so the bot is not idle
  // on race day if the fresh window rises instead of falling.
  const ret15 = st.closes.length >= 16 ? close / st.closes[st.closes.length - 16] - 1 : null;
  const crossed =
    st.prevEmaFast !== null &&
    st.prevEmaSlow !== null &&
    st.emaFast !== null &&
    st.emaSlow !== null &&
    st.prevEmaFast <= st.prevEmaSlow &&
    st.emaFast > st.emaSlow;
  if (
    ret15 !== null &&
    ret15 > MOMENTUM_RET15 &&
    crossed &&
    rsi >= 50 &&
    rsi <= 70 &&
    close > sma60
  ) {
    st.trades++;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  return [];
}

const { state, done } = await runBars({
  onBatch: (s, b) => decide(s, b),
  onDone: (s, d) => {
    console.error(
      `dip-catcher done: batches=${d.seq} buys=${st.trades} final equity=${s.equity} ` +
        `pnl_usd=${(Number(s.equity) - 1_000_000_000) / 1e6}`,
    );
  },
});
