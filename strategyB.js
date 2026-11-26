
"use strict";

// STRATEGY B — LIVE / FORMING 5-MINUTE CANDLE
// PAPER TRADING ONLY — NO REAL ORDERS
// Never creates a fake live candle.

const CONFIG = Object.freeze({
  strategy: "B",
  timeframe: "5m",
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  capital: 100000,
  lots: 1,
  stopLossPercent: 10,
  targetPercent: 20,
  maxOpenTrades: 1,
  realOrdersEnabled: false
});

const state = {
  signal: "WAIT",
  reason: "Waiting for genuine live candle",
  indicators: null,
  openTrade: null,
  trades: [],
  realizedPnl: 0,
  lastEntryCandle: null,
  status: "READY"
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function calculateRSI(values, period = 14) {
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
    const high = num(candle.high);
    const low = num(candle.low);
    const close = num(candle.close);
    const volume = num(candle.volume);

    if (
      high === null || low === null ||
      close === null || volume === null ||
      volume <= 0
    ) continue;

    const typicalPrice = (high + low + close) / 3;
    totalPV += typicalPrice * volume;
    totalVolume += volume;
  }

  return totalVolume > 0 ? totalPV / totalVolume : null;
}

function calculateIndicators(candles, liveCandle) {
  const closes = candles.map(c => num(c.close));
  closes.push(num(liveCandle.close));

  return {
    price: num(liveCandle.close),
    ema9: calculateEMA(closes, CONFIG.emaFast),
    ema21: calculateEMA(closes, CONFIG.emaSlow),
    rsi14: calculateRSI(closes, CONFIG.rsiPeriod),
    vwap: calculateVWAP([...candles, liveCandle]),
    candleTime: liveCandle.timestamp,
    candleStatus: "FORMING"
  };
}

function getSignal(indicators) {
  const {
    price, ema9, ema21, rsi14, vwap
  } = indicators;

  if ([price, ema9, ema21, rsi14, vwap]
      .some(v => !Number.isFinite(v))) {
    return {
      signal: "WAIT",
      reason: "Live indicator data unavailable"
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
      reason: "Live bullish conditions satisfied"
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
      reason: "Live bearish conditions satisfied"
    };
  }

  return {
    signal: "WAIT",
    reason: "Live conditions do not match entry rules"
  };
}

function openPaperTrade(option, candleTime) {
  if (state.openTrade) return "A Strategy B trade is already open";

  if (
    !option ||
    !["CE", "PE"].includes(option.side) ||
    !option.symbol
  ) {
    return "Matching CE/PE option data required";
  }

  const premium = num(option.ltp);
  const lotSize = num(option.lotSize);

  if (
    premium === null || premium <= 0 ||
    lotSize === null ||
    !Number.isInteger(lotSize) || lotSize <= 0
  ) {
    return "Valid option LTP and lot size required";
  }

  const quantity = lotSize * CONFIG.lots;

  if (premium * quantity > CONFIG.capital) {
    return "Trade skipped: demo capital limit exceeded";
  }

  state.openTrade = {
    id: "B-" + Date.now(),
    strategy: "B",
    status: "OPEN",
    symbol: option.symbol,
    instrumentKey: option.instrumentKey || null,
    side: option.side,
    entry: premium,
    currentPrice: premium,
    quantity,
    lotSize,
    stopLoss: Number(
      (premium * (1 - CONFIG.stopLossPercent / 100)).toFixed(2)
    ),
    target: Number(
      (premium * (1 + CONFIG.targetPercent / 100)).toFixed(2)
    ),
    candleTime,
    entryTime: new Date().toISOString(),
    pnl: 0
  };

  state.lastEntryCandle = candleTime;
  return state.openTrade;
}

function closePaperTrade(price, reason) {
  if (!state.openTrade) return null;

  const trade = state.openTrade;
  const exitPrice = num(price);

  if (exitPrice === null || exitPrice <= 0) return null;

  trade.currentPrice = exitPrice;
  trade.exit = exitPrice;
  trade.status = "CLOSED";
  trade.exitReason = reason;
  trade.exitTime = new Date().toISOString();

  trade.pnl = Number(
    ((exitPrice - trade.entry) * trade.quantity).toFixed(2)
  );

  state.realizedPnl = Number(
    (state.realizedPnl + trade.pnl).toFixed(2)
  );

  state.trades.push({ ...trade });
  state.openTrade = null;

  return { ...trade };
}

function updateOptionPrice(symbol, ltp) {
  const trade = state.openTrade;
  const price = num(ltp);

  if (
    !trade ||
    trade.symbol !== symbol ||
    price === null ||
    price <= 0
  ) return getState();

  trade.currentPrice = price;

  if (price <= trade.stopLoss) {
    closePaperTrade(price, "STOP_LOSS");
  } else if (price >= trade.target) {
    closePaperTrade(price, "TARGET");
  }

  return getState();
}

/**
 * candles: completed underlying candles from the current session.
 * liveCandle: genuine current forming candle from the data provider.
 *
 * Required liveCandle fields:
 * isForming: true
 * timestamp: actual candle start timestamp
 * open, high, low, close, volume
 *
 * Do not pass an LTP-only object as a candle.
 */
function onLiveCandle(candles, liveCandle, optionContract) {
  if (!Array.isArray(candles) || !liveCandle) {
    state.signal = "WAIT";
    state.reason = "Candle data missing";
    return getState();
  }

  if (liveCandle.isForming !== true) {
    state.signal = "WAIT";
    state.reason = "Provider has not confirmed a genuine forming candle";
    return getState();
  }

  const required = [
    liveCandle.timestamp,
    liveCandle.open,
    liveCandle.high,
    liveCandle.low,
    liveCandle.close,
    liveCandle.volume
  ];

  if (required.some(v => v === null || v === undefined)) {
    state.signal = "WAIT";
    state.reason = "Incomplete live candle fields";
    return getState();
  }

  const completed = candles.filter(c =>
    c &&
    c.isComplete === true &&
    num(c.close) !== null &&
    num(c.high) !== null &&
    num(c.low) !== null &&
    num(c.volume) !== null
  );

  if (completed.length < 21) {
    state.signal = "WAIT";
    state.reason =
      `Need 21 completed candles before live calculation; received ${completed.length}`;
    state.status = "WARMING_UP";
    return getState();
  }

  const live = {
    timestamp: liveCandle.timestamp,
    open: num(liveCandle.open),
    high: num(liveCandle.high),
    low: num(liveCandle.low),
    close: num(liveCandle.close),
    volume: num(liveCandle.volume)
  };

  if (
    Object.values(live).some(v => v === null) ||
    live.high < live.low ||
    live.volume < 0
  ) {
    state.signal = "WAIT";
    state.reason = "Invalid live candle values";
    return getState();
  }

  state.indicators = calculateIndicators(completed, live);

  const decision = getSignal(state.indicators);
  state.signal = decision.signal;
  state.reason = decision.reason;
  state.status = "ACTIVE";

  if (
    !state.openTrade &&
    decision.signal !== "WAIT" &&
    state.lastEntryCandle !== live.timestamp
  ) {
    const expectedSide =
      decision.signal === "BUY_CE" ? "CE" : "PE";

    if (optionContract && optionContract.side === expectedSide) {
      const result = openPaperTrade(optionContract, live.timestamp);

      if (typeof result === "string") {
        state.reason += "; " + result;
      } else {
        state.reason += "; Strategy B demo trade opened";
      }
    } else {
      state.reason += `; Waiting for matching ${expectedSide} option data`;
    }
  }

  return getState();
}

function getState() {
  return JSON.parse(JSON.stringify({
    strategy: "B",
    mode: "PAPER_ONLY",
    realOrdersEnabled: false,
    config: CONFIG,
    ...state
  }));
}

function getTrades() {
  return JSON.parse(JSON.stringify(state.trades));
}

module.exports = {
  CONFIG,
  onLiveCandle,
  updateOptionPrice,
  getState,
  getTrades
};
