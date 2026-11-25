"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

const app = express();

app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// =====================================
// SETTINGS
// =====================================

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const UNDERLYING = "NSE_INDEX|Nifty 50";

const TARGET_PERCENT = 20;
const STOP_PERCENT = 10;

const POLL_MS = 5000;

const STORAGE_DIR = process.env.DATA_DIR || "/data";
const STORAGE_FILE = path.join(
  STORAGE_DIR,
  "demo-trades.json"
);

const DASHBOARD_FILE = path.join(
  __dirname,
  "NIFTY_Demo_Live_Price_Ready-2.html"
);

const ENTRY_START = 9 * 60 + 15;
const ENTRY_END = 15 * 60 + 15;
const MARKET_END = 15 * 60 + 30;

// Virtual trading only.
// No real orders will be placed.

const REAL_ORDERS_ENABLED = false;

// =====================================
// APPLICATION STATE
// =====================================

let feedStatus = "Disconnected";
let latestNiftyData = null;
let lastUpdateTime = null;

let indicatorsCache = null;

let lastCycleTime = null;
let cycleStatus = "Starting";
let cycleError = null;

let busy = false;

let futuresInstrument = null;
let lastFutureResolve = 0;

let optionScanCache = [];
let optionScanUpdatedAt = 0;
let optionScanError = null;

let activity = [];

let trades = [];

let storageReady = false;
let storageError = null;

// =====================================
// ACTIVITY LOG
// =====================================

function log(type, message, detail = {}) {
  const item = {
    time: new Date().toISOString(),
    type,
    message,
    detail
  };

  activity.unshift(item);
  activity = activity.slice(0, 200);

  console.log(`[${type}] ${message}`, detail);
}

// =====================================
// STORAGE
// =====================================

function loadTrades() {
  try {
    fs.mkdirSync(STORAGE_DIR, {
      recursive: true
    });

    if (!fs.existsSync(STORAGE_FILE)) {
      trades = [];
      saveTrades();
      return;
    }

    const data = JSON.parse(
      fs.readFileSync(STORAGE_FILE, "utf8")
    );

    if (!Array.isArray(data)) {
      throw new Error("Invalid trade history");
    }

    trades = data;

    storageReady = true;
    storageError = null;

    log("STORAGE", "Trade history loaded", {
      records: trades.length
    });

  } catch (error) {
    storageReady = false;
    storageError = error.message;

    log("ERROR", "Storage loading failed", {
      error: error.message
    });
  }
}

function saveTrades() {
  try {
    fs.mkdirSync(STORAGE_DIR, {
      recursive: true
    });

    const tempFile = STORAGE_FILE + ".tmp";

    fs.writeFileSync(
      tempFile,
      JSON.stringify(trades, null, 2),
      "utf8"
    );

    fs.renameSync(tempFile, STORAGE_FILE);

    storageReady = true;
    storageError = null;

  } catch (error) {
    storageReady = false;
    storageError = error.message;

    throw error;
  }
}

loadTrades();

// =====================================
// UPSTOX API
// =====================================

async function apiGet(url) {
  if (!TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is missing"
    );
  }

  const response = await fetch(url, {
    method: "GET",

    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json"
    },

    signal: AbortSignal.timeout(18000)
  });

  let body;

  try {
    body = await response.json();
  } catch {
    throw new Error(
      `Invalid API response: HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Upstox HTTP ${response.status}: ${
        body.message || "Request failed"
      }`
    );
  }

  if (body.status === "error") {
    throw new Error(
      body.message || "Upstox API error"
    );
  }

  return body;
}

function enc(value) {
  return encodeURIComponent(value);
}

// =====================================
// INDIA DATE AND TIME
// =====================================

function istDateOffset(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat(
    "en-GB",
    {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).formatToParts(new Date());

  const get = type =>
    parts.find(x => x.type === type).value;

  const date = new Date(
    `${get("year")}-${get("month")}-${get("day")}T00:00:00Z`
  );

  date.setUTCDate(
    date.getUTCDate() - daysAgo
  );

  return date.toISOString().slice(0, 10);
}

function istTime() {
  const parts = new Intl.DateTimeFormat(
    "en-GB",
    {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23"
    }
  ).formatToParts(new Date());

  const get = type =>
    parts.find(x => x.type === type).value;

  return {
    day: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute"))
  };
}

function marketMinutes() {
  const t = istTime();

  return t.hour * 60 + t.minute;
}

function marketOpen() {
  const t = istTime();
  const m = marketMinutes();

  return (
    !["Sat", "Sun"].includes(t.day) &&
    m >= ENTRY_START &&
    m <= MARKET_END
  );
}

function entryAllowed() {
  const t = istTime();
  const m = marketMinutes();

  return (
    !["Sat", "Sun"].includes(t.day) &&
    m >= ENTRY_START &&
    m <= ENTRY_END
  );
}

// =====================================
// TECHNICAL INDICATORS
// =====================================

function ema(values, period) {
  if (!values || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let result =
    values.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function rsi(values, period = 14) {
  if (!values || values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change = values[i] - values[i - 1];

    avgGain =
      (
        avgGain * (period - 1) +
        Math.max(change, 0)
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        Math.max(-change, 0)
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

// =====================================
// CANDLE PROCESSING
// =====================================

function parseCandles(rows) {
  const now = Date.now();
  const map = new Map();

  for (const c of rows || []) {
    const time = new Date(c[0]).getTime();

    if (
      !Number.isFinite(time) ||
      time + 300000 > now
    ) {
      continue;
    }

    const candle = {
      time,
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5] || 0)
    };

    if (
      ![
        candle.open,
        candle.high,
        candle.low,
        candle.close
      ].every(Number.isFinite)
    ) {
      continue;
    }

    map.set(time, candle);
  }

  return [...map.values()].sort(
    (a, b) => a.time - b.time
  );
}

async function getCandles(instrumentKey) {
  const from = istDateOffset(7);
  const to = istDateOffset(0);

  const base =
    "https://api.upstox.com/v3/historical-candle/";

  const historicalUrl =
    base +
    enc(instrumentKey) +
    "/minutes/5/" +
    to +
    "/" +
    from;

  const intradayUrl =
    base +
    "intraday/" +
    enc(instrumentKey) +
    "/minutes/5";

  const [historical, intraday] =
    await Promise.all([
      apiGet(historicalUrl),
      apiGet(intradayUrl)
    ]);

  return parseCandles([
    ...(historical.data?.candles || []),
    ...(intraday.data?.candles || [])
  ]);
}
// RESOLVE NEAREST NIFTY FUTURES
async function getNiftyFuture() {
  if (
    futuresInstrument &&
    Date.now() - lastFutureResolve < 6 * 60 * 60 * 1000
  ) {
    return futuresInstrument;
  }

  const result = await apiGet(
    "https://api.upstox.com/v2/instruments/search" +
    "?query=Nifty%2050&exchanges=NSE&segments=FO" +
    "&instrument_types=FUT&page_number=1&records=30"
  );

  const today = istDateOffset(0);

  const candidates = (result.data || [])
    .filter(x =>
      x.instrument_key &&
      x.instrument_type === "FUT" &&
      (!x.expiry || x.expiry >= today)
    )
    .sort((a, b) =>
      String(a.expiry || "9999").localeCompare(
        String(b.expiry || "9999")
      )
    );

  if (!candidates.length) {
    throw new Error("NIFTY Futures contract not found");
  }

  futuresInstrument = candidates[0];
  lastFutureResolve = Date.now();

  log("SCAN", "NIFTY Futures selected", {
    instrumentKey: futuresInstrument.instrument_key,
    expiry: futuresInstrument.expiry
  });

  return futuresInstrument;
}

// FUTURES VWAP
function calculateVWAP(candles) {
  const today = istDateOffset(0);

  const rows = candles.filter(c => {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(c.time));

    return date === today && c.volume > 0;
  });

  if (!rows.length) {
    return { value: null, volume: 0, candles: 0 };
  }

  let totalPV = 0;
  let totalVolume = 0;

  for (const c of rows) {
    const typical = (c.high + c.low + c.close) / 3;
    totalPV += typical * c.volume;
    totalVolume += c.volume;
  }

  return {
    value: totalVolume ? totalPV / totalVolume : null,
    volume: totalVolume,
    candles: rows.length
  };
}

// NIFTY LIVE QUOTE
async function getNiftyLTP() {
  const result = await apiGet(
    "https://api.upstox.com/v3/market-quote/ltp?instrument_key=" +
    enc(UNDERLYING)
  );

  const item = Object.values(result.data || {})[0];

  if (!item || !(Number(item.last_price) > 0)) {
    throw new Error("NIFTY live quote unavailable");
  }

  latestNiftyData = {
    ltp: Number(item.last_price),
    time: new Date().toISOString()
  };

  lastUpdateTime = latestNiftyData.time;
  feedStatus = "Connected";

  return latestNiftyData.ltp;
}

// STRATEGY ANALYSIS
async function getIndicators() {
  const future = await getNiftyFuture();

  const [indexCandles, futureCandles, nifty] =
    await Promise.all([
      getCandles(UNDERLYING),
      getCandles(future.instrument_key),
      getNiftyLTP()
    ]);

  const closes = indexCandles.map(c => c.close);
  const latest = indexCandles[indexCandles.length - 1];

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const rv = rsi(closes, 14);
  const vw = calculateVWAP(futureCandles);

  const recent = indexCandles.slice(-20);
  const support = recent.length
    ? Math.min(...recent.map(c => c.low))
    : null;
  const resistance = recent.length
    ? Math.max(...recent.map(c => c.high))
    : null;

  let candleStrength = "Unavailable";
  if (latest) {
    const range = latest.high - latest.low;
    const body = Math.abs(latest.close - latest.open);
    candleStrength = range > 0
      ? `${(body / range * 100).toFixed(1)}%`
      : "Doji";
  }

  let trend = "SIDEWAYS";
  if (e9 !== null && e21 !== null) {
    if (e9 > e21) trend = "BULLISH";
    if (e9 < e21) trend = "BEARISH";
  }

  const checks = [];
  function add(name, pass, actual, rule) {
    checks.push({
      name,
      status: pass === true ? "PASS" :
        pass === false ? "FAIL" : "WAIT",
      actual,
      rule
    });
  }

  add("Completed 5-minute candle", !!latest,
    latest ? new Date(latest.time).toISOString() : null,
    "Completed candle only");
  add("EMA 9", e9 !== null, e9, "EMA 9 available");
  add("EMA 21", e21 !== null, e21, "EMA 21 available");
  add("RSI 14", rv !== null, rv, "RSI 14 available");
  add("Futures VWAP", vw.value !== null, vw.value,
    "Futures VWAP required");

  let signal = "WAIT";
  let reason = "Strategy conditions not satisfied";

  if (
    latest && e9 !== null && e21 !== null &&
    rv !== null && vw.value !== null
  ) {
    if (
      latest.close > e9 && e9 > e21 &&
      latest.close > vw.value && rv >= 55 && rv < 70
    ) {
      signal = "BUY CE";
      reason = "Bullish EMA, VWAP and RSI conditions passed";
    } else if (
      latest.close < e9 && e9 < e21 &&
      latest.close < vw.value && rv >= 30 && rv <= 45
    ) {
      signal = "BUY PE";
      reason = "Bearish EMA, VWAP and RSI conditions passed";
    }
  }

  indicatorsCache = {
    status: "ok",
    signal,
    reason,
    trend,
    nifty,
    candleClose: latest?.close ?? null,
    candleTime: latest ? new Date(latest.time).toISOString() : null,
    ema9: e9,
    ema21: e21,
    rsi: rv,
    vwap: vw.value,
    vwapSource: future.trading_symbol || future.instrument_key,
    vwapVolume: vw.volume,
    vwapCandles: vw.candles,
    support,
    resistance,
    candleStrength,
    completedCandles: indexCandles.length,
    checks,
    futures: {
      instrumentKey: future.instrument_key,
      expiry: future.expiry
    }
  };

  return indicatorsCache;
}

// OPTION CONTRACTS
async function getOptionContracts() {
  const result = await apiGet(
    "https://api.upstox.com/v2/option/contract?instrument_key=" +
    enc(UNDERLYING)
  );
  return result.data || [];
}

// OPTION CHAIN
async function getOptionChain(expiry) {
  const result = await apiGet(
    "https://api.upstox.com/v2/option/chain?instrument_key=" +
    enc(UNDERLYING) +
    "&expiry_date=" + enc(expiry)
  );
  return result.data || [];
}

// NEAREST EXPIRY
async function getNearestExpiry() {
  const contracts = await getOptionContracts();
  const today = istDateOffset(0);

  const expiries = [
    ...new Set(
      contracts.map(x => x.expiry).filter(x =>
        typeof x === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(x) &&
        x >= today
      )
    )
  ].sort();

  if (!expiries.length) {
    throw new Error("Upcoming option expiry not found");
  }

  return { expiry: expiries[0], contracts };
}

// OPTION LIVE PRICE
async function getOptionQuote(instrumentKey) {
  const result = await apiGet(
    "https://api.upstox.com/v3/market-quote/ltp?instrument_key=" +
    enc(instrumentKey)
  );

  const item = Object.values(result.data || {})[0];
  const price = Number(item?.last_price);

  if (!(price > 0)) {
    throw new Error("Option live premium unavailable");
  }

  return price;
}

// SCAN ATM OPTION
async function scanATMOption(signal, spot) {
  const { expiry, contracts } = await getNearestExpiry();
  const chain = await getOptionChain(expiry);

  if (!chain.length) {
    throw new Error("Option chain is empty");
  }

  const rows = chain
    .filter(x => Number.isFinite(Number(x.strike_price)))
    .sort((a, b) =>
      Math.abs(Number(a.strike_price) - spot) -
      Math.abs(Number(b.strike_price) - spot)
    );

  const side = signal === "BUY CE" ? "call_options" : "put_options";
  const atm = rows[0];
  const option = atm?.[side];

  if (!option?.instrument_key) {
    throw new Error("ATM option instrument key missing");
  }

  const contract = contracts.find(
    x => x.instrument_key === option.instrument_key
  );

  if (!contract) {
    throw new Error("Option contract details not found");
  }

  const premium = await getOptionQuote(option.instrument_key);

  return {
    instrumentKey: option.instrument_key,
    tradingSymbol: contract.trading_symbol || option.trading_symbol,
    expiry,
    strike: Number(atm.strike_price),
    optionType: signal === "BUY CE" ? "CE" : "PE",
    premium,
    lotSize: Number(contract.lot_size || 1),
    chainData: option
  };
}
// TRADE HELPERS
function makeId() {
  return "VT-" + Date.now() + "-" +
    Math.random().toString(36).slice(2, 7).toUpperCase();
}

function getOpenTrade() {
  return trades.find(t => t.status === "OPEN") || null;
}

function calculatePnl(trade, price) {
  return (Number(price) - Number(trade.entryPrice)) *
    Number(trade.quantity);
}

// OPEN VIRTUAL TRADE
async function openTrade(signal, analysis) {
  if (getOpenTrade()) return null;

  const option = await scanATMOption(signal, analysis.nifty);
  const quantity = option.lotSize;

  const trade = {
    id: makeId(),
    status: "OPEN",
    mode: "VIRTUAL",
    realOrders: false,
    optionType: option.optionType,
    signal,
    tradingSymbol: option.tradingSymbol,
    instrumentKey: option.instrumentKey,
    strike: option.strike,
    expiry: option.expiry,
    entryPrice: option.premium,
    currentLTP: option.premium,
    quantity,
    lotSize: option.lotSize,
    investment: Number((option.premium * quantity).toFixed(2)),
    targetPrice: Number(
      (option.premium * (1 + TARGET_PERCENT / 100)).toFixed(2)
    ),
    stopPrice: Number(
      (option.premium * (1 - STOP_PERCENT / 100)).toFixed(2)
    ),
    floatingPnl: 0,
    pnl: 0,
    entryTime: new Date().toISOString(),
    analysisAtEntry: analysis
  };

  trades.unshift(trade);
  saveTrades();

  log("OPEN", "Virtual trade opened", {
    id: trade.id,
    symbol: trade.tradingSymbol,
    entry: trade.entryPrice,
    quantity: trade.quantity
  });

  return trade;
}

// CHECK OPEN TRADE AND AUTO EXIT
async function checkOpenTrade() {
  const trade = getOpenTrade();
  if (!trade) return;

  const ltp = await getOptionQuote(trade.instrumentKey);

  trade.currentLTP = ltp;
  trade.floatingPnl = Number(
    calculatePnl(trade, ltp).toFixed(2)
  );
  trade.lastCheckedAt = new Date().toISOString();

  let exitReason = null;
  if (ltp >= Number(trade.targetPrice)) {
    exitReason = "TARGET HIT";
  } else if (ltp <= Number(trade.stopPrice)) {
    exitReason = "STOP LOSS HIT";
  }

  if (exitReason) {
    trade.status = "CLOSED";
    trade.exitPrice = ltp;
    trade.actualExitPrice = ltp;
    trade.triggerPrice = exitReason === "TARGET HIT"
      ? trade.targetPrice
      : trade.stopPrice;
    trade.slippage = Number(
      (ltp - trade.triggerPrice).toFixed(2)
    );
    trade.exitReason = exitReason;
    trade.exitTime = new Date().toISOString();
    trade.pnl = Number(
      calculatePnl(trade, ltp).toFixed(2)
    );
    trade.floatingPnl = 0;

    log("CLOSE", "Virtual trade closed", {
      id: trade.id,
      reason: exitReason,
      triggerPrice: trade.triggerPrice,
      actualExitPrice: trade.actualExitPrice,
      pnl: trade.pnl
    });
  }

  saveTrades();
}

// AUTOMATIC TRADING CYCLE
async function tradingCycle() {
  if (busy) return;
  busy = true;
  cycleStatus = "Running";
  lastCycleTime = new Date().toISOString();

  try {
    // Always monitor an existing open trade first.
    if (getOpenTrade()) {
      await checkOpenTrade();
      cycleStatus = "Monitoring open trade";
      return;
    }

    if (!entryAllowed()) {
      cycleStatus = "Waiting for market entry time";
      return;
    }

    const analysis = await getIndicators();
    indicatorsCache = analysis;

    if (analysis.signal === "WAIT") {
      cycleStatus = "Waiting for confirmed signal";
      return;
    }

    await openTrade(analysis.signal, analysis);
    cycleStatus = "Trade scan completed";
  } catch (error) {
    cycleError = error.message;
    feedStatus = "Error";
    cycleStatus = "Error";
    log("ERROR", "Trading cycle failed", {
      error: error.message
    });
  } finally {
    busy = false;
  }
}

// P&L SUMMARY
function getPnlSummary() {
  const today = istDateOffset(0);

  const closed = trades.filter(t => t.status === "CLOSED");
  const todayClosed = closed.filter(t => {
    if (!t.exitTime) return false;

    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(t.exitTime));

    return date === today;
  });

  const open = trades.filter(t => t.status === "OPEN");

  const todayPnl = todayClosed.reduce(
    (sum, t) => sum + Number(t.pnl || 0), 0
  );

  const allTimePnl = closed.reduce(
    (sum, t) => sum + Number(t.pnl || 0), 0
  );

  const floatingPnl = open.reduce(
    (sum, t) => sum + Number(t.floatingPnl || 0), 0
  );

  return {
    todayPnl: Number(todayPnl.toFixed(2)),
    allTimePnl: Number(allTimePnl.toFixed(2)),
    floatingPnl: Number(floatingPnl.toFixed(2)),
    todayTradeCount: todayClosed.length,
    totalTradeCount: trades.length,
    openTradeCount: open.length,
    closedTradeCount: closed.length
  };
}

// HEALTH
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "NIFTY Virtual Trading",
    realOrders: false,
    time: new Date().toISOString()
  });
});

// STATUS
app.get("/status", (req, res) => {
  res.json({
    feedStatus,
    cycleStatus,
    cycleError,
    lastCycleTime,
    lastUpdateTime,
    marketOpen: marketOpen(),
    storageReady,
    storageError,
    pollIntervalMs: POLL_MS,
    realOrders: false
  });
});

// CONFIG
app.get("/config", (req, res) => {
  res.json({
    targetPercent: TARGET_PERCENT,
    stopPercent: STOP_PERCENT,
    pollIntervalMs: POLL_MS,
    underlying: UNDERLYING,
    realOrders: false,
    mode: "VIRTUAL DEMO ONLY"
  });
});

// NIFTY LIVE PRICE
app.get("/nifty", async (req, res) => {
  try {
    const ltp = await getNiftyLTP();
    res.json({
      status: "ok",
      ltp,
      time: lastUpdateTime
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// INDICATORS
app.get("/indicators", async (req, res) => {
  try {
    const data = await getIndicators();
    res.json(data);
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// OPTION SCAN
app.get("/option-scan", async (req, res) => {
  try {
    const analysis = indicatorsCache || await getIndicators();

    if (analysis.signal === "WAIT") {
      return res.json({
        status: "WAIT",
        message: "No confirmed CE/PE signal",
        analysis
      });
    }

    const option = await scanATMOption(
      analysis.signal,
      analysis.nifty
    );

    optionScanCache = [option];

    res.json({
      status: "ok",
      option,
      analysis
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// OPTION CHAIN
app.get("/atm-option-chain", async (req, res) => {
  try {
    const { expiry } = await getNearestExpiry();
    const chain = await getOptionChain(expiry);

    res.json({
      status: "ok",
      expiry,
      chain
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// ALL TRADES
app.get("/demo-trades", (req, res) => {
  res.json({
    status: "ok",
    trades,
    summary: getPnlSummary(),
    storageReady,
    storageError
  });
});

// DEMO STATUS
app.get("/demo-status", (req, res) => {
  res.json({
    status: "ok",
    openTrade: getOpenTrade(),
    summary: getPnlSummary(),
    realOrders: false
  });
});

// ACTIVITY LOG
app.get("/activity", (req, res) => {
  res.json({
    status: "ok",
    activity
  });
});

// EXPORT TRADE HISTORY
app.get("/export-trades", (req, res) => {
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="nifty-demo-trades.json"'
  );
  res.json({
    exportedAt: new Date().toISOString(),
    trades
  });
});

// MANUAL IMPORT / RESTORE HISTORY
app.post("/import-trades", (req, res) => {
  try {
    const incoming = req.body?.trades;

    if (!Array.isArray(incoming)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid trade backup file"
      });
    }

    // Merge by ID; never delete existing history.
    const byId = new Map(trades.map(t => [t.id, t]));

    for (const trade of incoming) {
      if (trade && trade.id && !byId.has(trade.id)) {
        byId.set(trade.id, trade);
      }
    }

    trades = [...byId.values()];
    saveTrades();

    res.json({
      status: "ok",
      imported: incoming.length,
      total: trades.length
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// ROOT DASHBOARD
app.get("/", (req, res) => {
  res.sendFile(DASHBOARD_FILE, error => {
    if (error) {
      log("ERROR", "Dashboard file could not be served", {
        error: error.message
      });
    }
  });
});

// START SERVER
app.listen(PORT, () => {
  console.log(`NIFTY Virtual Trading server running on ${PORT}`);
  console.log("REAL ORDERS DISABLED");
  log("SERVER", "Server started", { port: PORT });

  tradingCycle();

  setInterval(() => {
    tradingCycle();
  }, POLL_MS);
});