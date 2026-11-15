# DIP-CATCHER — btc-race-24h-20261115-0828

A BTC dip-buying bot for make.fun's "Race a BTC trading bot live for 24 hours"
($250, top 10 paid). One symbol (cbBTC), 1-minute bars, long only, one position,
100% of cash per trade.

## Strategy

On 1-minute bars the noise dominates, but a price that has fallen far below its
6-hour mean reliably bounces back within the hour. The bot buys only deep drops
against the 6-hour anchor (or a sharp one-hour plunge), banks the reversion
quickly, and otherwise sits in cash:

- **Entry (primary):** close >= 2.5% below the 6h mean (SMA360), OR the trailing
  1-hour return <= -2%. 10-bar cooldown after an exit. No trades before 60 closes.
- **Entry (momentum leg):** 15-min return > +0.4% AND EMA8 crosses above EMA21
  AND 50 <= RSI14 <= 70 AND close > SMA60 — so the bot can earn if the fresh
  race window rises instead of falling.
- **Exits (whole position, first trigger wins):** take profit +1.5% over cost;
  reversion to the 1h mean once profit >= +0.3%; stop-loss -2.5%; time stops
  (180 bars if profitable, 360 bars hard); kill-switch — equity under 92% of
  its running peak flattens the position and halts trading.
- **Costs:** a full-size round trip pays ~42 bps at the depths the dev bars
  actually carry (4 bps fee + 2 bps slippage + ~15 bps impact per leg).

## Why this, and not the first design

The first design (1-hour z-score + RSI dips) loses on the frozen dev window
(-$34 to -$63 across a 108-config grid): a z-score below -2 predicts a
*negative* next hour (-0.22% mean) and RSI below 30 the same. The 6-hour
anchor is the predictive one: price >= 3% below its 6h mean gave a +3.73%
mean forward 60-min return (9/9 bars beat the round-trip cost); a 1-hour drop
>= 2% gave +2.90% (34/35). RSI was dropped from the entry entirely.

## Verification (offline replay, exact harness fill model)

- Full dev window: **+$13.58, 5 trades, 5 wins, max drawdown 1.89%**
- Split halves independently positive: +$5.82 (bars 0-719), +$3.27 (720-1439)
- At 2x fees: +$11.67 — the parameters sit in the middle of a flat plateau
  (TP 1.5%/2.5%, SL 2.0%/2.5%, dip 2.5%/3.0% all agree). A 0.6% reversion
  threshold looked better (+$22.77) but collapsed to -$11.19 at 2x fees and
  was rejected as a sharp peak.
- The kit's own rsi-bollinger baseline scores -$57.37 on the same window.

## Run it

```
node /path/to/kit/cli/makefun.mjs grade-local --kit /path/to/kit --bot . --driver process
```

`main.ts` is the entrypoint (Node 22, erasable TypeScript, stdlib only via the
vendored shim in `vendor/`). It reads one JSON line per batch on stdin and
answers with exactly one reply per batch. No clock, no randomness, no network,
no environment reads — two runs on the same data give byte-identical replies.
