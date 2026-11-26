
"use strict";

// STRATEGY A — CLOSED 5 MINUTE CANDLE
// PAPER TRADING ONLY — NO REAL ORDERS

const CONFIG = {
  strategy: "A",
  timeframe: "5m",
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  capital: 100000,
  lots: 1,
  stopLossPercent: 10,
  targetPercent: 20,
  realOrdersEnabled: false
};

const state = {
  signal: "WAIT",
  reason: "Waiting for completed candles",
  indicators: null,
  openTrade: null,
  trades: [],
  realizedPnl: 0,
  lastCandleTime: null
};

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain = (avgGain * 13 + gain) / 14;
    avgLoss = (avgLoss * 13 + loss) / 14;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateVWAP(candles) {
  let totalPV = 0;
  let totalVolume = 0;

  for (const candle of candles) {
    const volume = Number(candle.volume) || 0;
    if (volume <= 0) continue;

    const typicalPrice =
      (Number(candle.high) +
       Number(candle.low) +
       Number(candle.close)) / 3;

    totalPV += typicalPrice * volume;
    totalVolume += volume;
  }

  return totalVolume > 0 ? totalPV / totalVolume : null;
}

function calculateIndicators(candles) {
  const closes = candles.map(c => Number(c.close));

  return {
    price: closes[closes.length - 1],
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    rsi14: rsi(closes, 14),
    vwap: calculateVWAP(candles)
  };
}

function getSignal(indicators) {
  const { price, ema9, ema21, rsi14, vwap } = indicators;

  if ([price, ema9, ema21, rsi14, vwap]
      .some(value => !Number.isFinite(value))) {
    return {
      signal: "WAIT",
      reason: "Indicator data unavailable"
    };
  }

  if (
    price > ema9 &&
    ema9 > ema21 &&
    price > vwap &&
    rsi14 >= 55 &&
    rsi14 < 70
  ) {
    return {
      signal: "BUY_CE",
      reason: "Bullish conditions confirmed"
    };
  }

  if (
    price < ema9 &&
    ema9 < ema21 &&
    price < vwap &&
    rsi14 >= 30 &&
    rsi14 <= 45
  ) {
    return {
      signal: "BUY_PE",
      reason: "Bearish conditions confirmed"
    };
  }

  return {
    signal: "WAIT",
    reason: "All entry conditions not satisfied"
  };
}

function openPaperTrade(option) {
  if (state.openTrade) return "Trade already open";

  if (
    !option ||
    !["CE", "PE"].includes(option.side) ||
    !option.symbol
  ) {
    return "Valid CE/PE option contract required";
  }

  const premium = Number(option.ltp);
  const lotSize = Number(option.lotSize);

  if (
    !Number.isFinite(premium) ||
    premium <= 0 ||
    !Number.isInteger(lotSize) ||
    lotSize <= 0
  ) {
    return "Valid option LTP and lot size required";
  }

  const quantity = lotSize * CONFIG.lots;

  if (premium * quantity > CONFIG.capital) {
    return "Insufficient demo capital";
  }

  state.openTrade = {
    id: "A-" + Date.now(),
    strategy: "A",
    status: "OPEN",
    symbol: option.symbol,
    side: option.side,
    entry: premium,
    currentPrice: premium,
    quantity,
    lotSize,
    stopLoss: Number((premium * 0.90).toFixed(2)),
    target: Number((premium * 1.20).toFixed(2)),
    pnl: 0,
    entryTime: new Date().toISOString()
  };

  return state.openTrade;
}

function updateOptionPrice(symbol, ltp) {
  const trade = state.openTrade;
  const price = Number(ltp);

  if (
    !trade ||
    trade.symbol !== symbol ||
    !Number.isFinite(price) ||
    price <= 0
  ) return null;

  trade.currentPrice = price;

  let exitReason = null;

  if (price <= trade.stopLoss) exitReason = "STOP_LOSS";
  if (price >= trade.target) exitReason = "TARGET";

  if (exitReason) {
    trade.status = "CLOSED";
    trade.exit = price;
    trade.exitReason = exitReason;
    trade.exitTime = new Date().toISOString();
    trade.pnl = Number(
      ((price - trade.entry) * trade.quantity).toFixed(2)
    );

    state.realizedPnl += trade.pnl;
    state.trades.push({ ...trade });
    state.openTrade = null;
  }

  return getState();
}

function onClosedCandles(candles, optionContract) {
  if (!Array.isArray(candles)) {
    return getState();
  }

  // Caller must provide ONLY verified completed candles.
  const completed = candles.filter(c =>
    c &&
    c.isComplete === true &&
    Number.isFinite(Number(c.close)) &&
    Number.isFinite(Number(c.high)) &&
    Number.isFinite(Number(c.low))
  );

  if (completed.length < 22) {
    state.signal = "WAIT";
    state.reason =
      `Need 22 completed candles; received ${completed.length}`;
    return getState();
  }

  const latest = completed[completed.length - 1];

  if (latest.timestamp === state.lastCandleTime) {
    return getState();
  }

  state.lastCandleTime = latest.timestamp;

  state.indicators = calculateIndicators(completed);

  const decision = getSignal(state.indicators);

  state.signal = decision.signal;
  state.reason = decision.reason;

  if (!state.openTrade && decision.signal !== "WAIT") {
    const expectedSide =
      decision.signal === "BUY_CE" ? "CE" : "PE";

    if (optionContract && optionContract.side === expectedSide) {
      const result = openPaperTrade(optionContract);
      if (typeof result === "string") {
        state.reason += "; " + result;
      }
    } else {
      state.reason += `; Waiting for ${expectedSide} option data`;
    }
  }

  return getState();
}

function getState() {
  return JSON.parse(JSON.stringify({
    config: CONFIG,
    ...state,
    mode: "PAPER_ONLY",
    realOrdersEnabled: false
  }));
}

function getTrades() {
  return JSON.parse(JSON.stringify(state.trades));
}

module.exports = {
  CONFIG,
  onClosedCandles,
  updateOptionPrice,
  getState,
  getTrades
};
