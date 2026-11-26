
"use strict";

// STRATEGY MANAGER
// Keeps Strategy A and Strategy B isolated.
// PAPER TRADING ONLY — NO REAL ORDERS.

const StrategyA = require("./strategyA");
const StrategyB = require("./strategyB");

const manager = {
  mode: "PAPER_ONLY",
  realOrdersEnabled: false,

  A: {
    name: "Strategy A",
    type: "CLOSED_CANDLE",
    enabled: true
  },

  B: {
    name: "Strategy B",
    type: "LIVE_CANDLE",
    enabled: true
  }
};

// ---------- STRATEGY A ----------

function feedStrategyA(completedCandles, optionContract) {
  if (!manager.A.enabled) {
    return getStrategyA();
  }

  return StrategyA.onClosedCandles(
    completedCandles,
    optionContract
  );
}

function updateStrategyAOption(symbol, ltp) {
  return StrategyA.updateOptionPrice(symbol, ltp);
}

function getStrategyA() {
  return StrategyA.getState();
}

function getStrategyATrades() {
  return StrategyA.getTrades();
}

// ---------- STRATEGY B ----------

function feedStrategyB(
  completedCandles,
  liveCandle,
  optionContract
) {
  if (!manager.B.enabled) {
    return getStrategyB();
  }

  return StrategyB.onLiveCandle(
    completedCandles,
    liveCandle,
    optionContract
  );
}

function updateStrategyBOption(symbol, ltp) {
  return StrategyB.updateOptionPrice(symbol, ltp);
}

function getStrategyB() {
  return StrategyB.getState();
}

function getStrategyBTrades() {
  return StrategyB.getTrades();
}

// ---------- COMBINED VIEW ----------

function getAllStates() {
  return {
    mode: "PAPER_ONLY",
    realOrdersEnabled: false,
    timestamp: new Date().toISOString(),

    strategyA: {
      enabled: manager.A.enabled,
      state: getStrategyA(),
      trades: getStrategyATrades()
    },

    strategyB: {
      enabled: manager.B.enabled,
      state: getStrategyB(),
      trades: getStrategyBTrades()
    }
  };
}

// ---------- ENABLE / DISABLE ----------

function setStrategyEnabled(strategy, enabled) {
  if (strategy !== "A" && strategy !== "B") {
    return {
      success: false,
      error: "Strategy must be A or B"
    };
  }

  if (typeof enabled !== "boolean") {
    return {
      success: false,
      error: "enabled must be true or false"
    };
  }

  manager[strategy].enabled = enabled;

  return {
    success: true,
    strategy,
    enabled,
    message: `Strategy ${strategy} ${enabled ? "enabled" : "disabled"}`
  };
}

// ---------- SEPARATE TRADE HISTORY ----------

function getHistory(strategy) {
  if (strategy === "A") {
    return getStrategyATrades();
  }

  if (strategy === "B") {
    return getStrategyBTrades();
  }

  return {
    A: getStrategyATrades(),
    B: getStrategyBTrades()
  };
}

// ---------- SUMMARY ----------

function summarizeTrades(trades) {
  const closed = trades.filter(t => t.status === "CLOSED");

  const wins = closed.filter(t => t.pnl > 0).length;
  const losses = closed.filter(t => t.pnl < 0).length;

  const pnl = closed.reduce(
    (total, t) => total + (Number(t.pnl) || 0),
    0
  );

  return {
    totalTrades: trades.length,
    closedTrades: closed.length,
    openTrades: trades.filter(t => t.status === "OPEN").length,
    wins,
    losses,
    winRate: closed.length
      ? Number((wins / closed.length * 100).toFixed(2))
      : 0,
    realizedPnl: Number(pnl.toFixed(2))
  };
}

function getPerformance() {
  const tradesA = getStrategyATrades();
  const tradesB = getStrategyBTrades();

  return {
    strategyA: summarizeTrades(tradesA),
    strategyB: summarizeTrades(tradesB),

    combined: summarizeTrades([
      ...tradesA,
      ...tradesB
    ])
  };
}

module.exports = {
  feedStrategyA,
  updateStrategyAOption,
  getStrategyA,
  getStrategyATrades,

  feedStrategyB,
  updateStrategyBOption,
  getStrategyB,
  getStrategyBTrades,

  getAllStates,
  setStrategyEnabled,
  getHistory,
  getPerformance
};
