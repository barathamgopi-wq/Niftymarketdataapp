
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// SETTINGS
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const UNDERLYING = "NSE_INDEX|Nifty 50";
const TARGET_PERCENT = 20;
const STOP_PERCENT = 10;
const POLL_MS = 15000;
const STORAGE_DIR = process.env.DATA_DIR || "/data";
const STORAGE_FILE = path.join(STORAGE_DIR, "demo-trades.json");
const DASHBOARD_FILE = path.join(
  __dirname,
  "NIFTY_Demo_Live_Price_Ready-2.html"
);

const ENTRY_START = 9 * 60 + 15;
const ENTRY_END = 15 * 60 + 15;
const MARKET_END = 15 * 60 + 30;

// STATE
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
let optionScanPromise = null;
const OPTION_SCAN_CACHE_MS = 30000;

let activity = [];

// STORAGE
let trades = [];
let storageReady = false;
let storageError = null;

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

function loadTrades() {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });

    if (!fs.existsSync(STORAGE_FILE)) {
      trades = [];
      saveTrades();
      return;
    }

    const data = JSON.parse(
      fs.readFileSync(STORAGE_FILE, "utf8")
    );

    if (!Array.isArray(data)) {
      throw new Error("Trade history is not an array");
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
    log("ERROR", "Trade history load failed", {
      error: error.message
    });
  }
}

function saveTrades() {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });

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

// UPSTOX API
async function apiGet(url) {
  if (!TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing");
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
      `Upstox returned invalid JSON: HTTP ${response.status}`
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
    throw new Error(body.message || "Upstox API error");
  }

  return body;
}

function enc(value) {
  return encodeURIComponent(value);
}

// INDIA DATE
function istDateOffset(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type =>
    parts.find(x => x.type === type).value;

  const date = new Date(
    `${get("year")}-${get("month")}-${get("day")}T00:00:00Z`
  );

  date.setUTCDate(date.getUTCDate() - daysAgo);

  return date.toISOString().slice(0, 10);
}

function istTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  }).formatToParts(new Date());

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

// INDICATORS
function ema(values, period) {
  if (!values || values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    values.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function rsi(values, period = 14) {
  if (!values || values.length <= period) return null;

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

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) /
      period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) /
      period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// COMPLETED 5-MINUTE CANDLES
function parseCandles(rows) {
  const now = Date.now();
  const map = new Map();

  for (const c of rows || []) {
    const time = new Date(c[0]).getTime();

    if (
      !Number.isFinite(time) ||
      time + 300000 > now
    ) continue;

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
    ) continue;

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

  const [historical, intraday] = await Promise.all([
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
    "?query=Nifty%2050" +
    "&exchanges=NSE" +
    "&segments=FO" +
    "&instrument_types=FUT" +
    "&page_number=1" +
    "&records=30"
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
    return {
      value: null,
      volume: 0,
      candles: 0,
      reason: "NIFTY Futures volume candles unavailable"
    };
  }

  let totalPV = 0;
  let totalVolume = 0;

  for (const c of rows) {
    const typical =
      (c.high + c.low + c.close) / 3;

    totalPV += typical * c.volume;
    totalVolume += c.volume;
  }

  return {
    value: totalVolume
      ? totalPV / totalVolume
      : null,
    volume: totalVolume,
    candles: rows.length,
    reason: "NIFTY Futures 5-minute session VWAP"
  };
}

// NIFTY LIVE QUOTE
async function getNiftyLTP() {
  const result = await apiGet(
    "https://api.upstox.com/v3/market-quote/ltp" +
    "?instrument_key=" + enc(UNDERLYING)
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

  const checks = [];

  function add(name, pass, actual, rule) {
    checks.push({
      name,
      status: pass === true
        ? "PASS"
        : pass === false
          ? "FAIL"
          : "WAIT",
      actual,
      rule
    });
  }

  add(
    "Completed 5-minute candle",
    !!latest,
    latest ? new Date(latest.time).toISOString() : null,
    "Use only completed candle"
  );

  add("EMA 9", e9 !== null, e9, "EMA 9 available");
  add("EMA 21", e21 !== null, e21, "EMA 21 available");
  add("RSI 14", rv !== null, rv, "RSI 14 available");
  add(
    "Futures VWAP",
    vw.value !== null,
    vw.value,
    "NIFTY Futures volume VWAP required"
  );

  let signal = "WAIT";
  let reason = "Strategy conditions not satisfied";

  if (
    latest &&
    e9 !== null &&
    e21 !== null &&
    rv !== null &&
    vw.value !== null
  ) {
    if (
      latest.close > e9 &&
      e9 > e21 &&
      latest.close > vw.value &&
      rv >= 55 &&
      rv < 70
    ) {
      signal = "BUY CE";
      reason = "Bullish strategy conditions passed";
    } else if (
      latest.close < e9 &&
      e9 < e21 &&
      latest.close < vw.value &&
      rv >= 30 &&
      rv <= 45
    ) {
      signal = "BUY PE";
      reason = "Bearish strategy conditions passed";
    }
  }

  indicatorsCache = {
    status: "ok",
    signal,
    reason,
    nifty,
    candleClose: latest?.close ?? null,
    candleTime: latest
      ? new Date(latest.time).toISOString()
      : null,
    ema9: e9,
    ema21: e21,
    rsi: rv,
    vwap: vw.value,
    vwapSource: future.trading_symbol ||
      future.instrument_key,
    vwapVolume: vw.volume,
    vwapCandles: vw.candles,
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
    "&expiry_date=" +
    enc(expiry)
  );

  return result.data || [];
}

// SELECT NEAREST EXPIRY
async function getNearestExpiry() {
  const contracts = await getOptionContracts();
  const today = istDateOffset(0);

  const expiries = [
    ...new Set(
      contracts
        .map(x => x.expiry)
        .filter(x =>
          typeof x === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(x) &&
          x >= today
        )
    )
  ].sort();

  if (!expiries.length) {
    throw new Error("Upcoming option expiry not found");
  }

  return {
    expiry: expiries[0],
    contracts
  };
}

// GET OPTION LIVE PRICE
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

// REFRESH OPTION SCANNER INDEPENDENTLY
async function refreshOptionScanner() {
  if (
    optionScanCache.length &&
    Date.now() - optionScanUpdatedAt < OPTION_SCAN_CACHE_MS
  ) {
    return optionScanCache;
  }

  // Prevent duplicate simultaneous Upstox requests.
  if (optionScanPromise) {
    return optionScanPromise;
  }

  optionScanPromise = (async () => {
    try {
      const { expiry } = await getNearestExpiry();

      const [chain, spot] = await Promise.all([
        getOptionChain(expiry),
        getNiftyLTP()
      ]);

      if (!Array.isArray(chain) || !chain.length) {
        throw new Error("Upstox option chain is empty");
      }

      const nearest = chain
        .filter(row =>
          Number.isFinite(Number(row.strike_price))
        )
        .sort((a, b) =>
          Math.abs(Number(a.strike_price) - spot) -
          Math.abs(Number(b.strike_price) - spot)
        )
        .slice(0, 21)
        .sort((a, b) =>
          Number(a.strike_price) - Number(b.strike_price)
        );

      if (!nearest.length) {
        throw new Error("No valid option strikes returned");
      }

      const newCache = nearest.map(row => ({
        strike: Number(row.strike_price),

        ce: row.call_options ? {
          instrumentKey: row.call_options.instrument_key || null,
          ltp: row.call_options.market_data?.ltp ?? null,
          volume: row.call_options.market_data?.volume ?? null,
          oi: row.call_options.market_data?.oi ?? null,
          delta: row.call_options.option_greeks?.delta ?? null
        } : null,

        pe: row.put_options ? {
          instrumentKey: row.put_options.instrument_key || null,
          ltp: row.put_options.market_data?.ltp ?? null,
          volume: row.put_options.market_data?.volume ?? null,
          oi: row.put_options.market_data?.oi ?? null,
          delta: row.put_options.option_greeks?.delta ?? null
        } : null,

        pcr: row.pcr ?? null
      }));

      // Replace cache only after a successful complete scan.
      optionScanCache = newCache;
      optionScanUpdatedAt = Date.now();
      optionScanError = null;

      log("SCAN", "Option scanner refreshed", {
        expiry,
        spot,
        strikes: optionScanCache.length
      });

      return optionScanCache;

    } catch (error) {
      optionScanError = error.message;

      log("ERROR", "Option scanner refresh failed", {
        error: error.message
      });

      throw error;

    } finally {
      optionScanPromise = null;
    }
  })();

  return optionScanPromise;
}

// SCAN ATM OPTION FOR VIRTUAL ENTRY
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

  if (!rows.length) {
    throw new Error("No valid option strikes");
  }

  const atm = rows[0];
  const side = signal === "BUY CE"
    ? "call_options"
    : "put_options";

  const option = atm[side];

  if (!option?.instrument_key) {
    throw new Error("ATM option instrument key missing");
  }

  const contract = contracts.find(
    x => x.instrument_key === option.instrument_key
  );

  if (!contract) {
    throw new Error("Option contract details not found");
  }

  const premium = await getOptionQuote(
    option.instrument_key
  );

  const lotSize = Number(contract.lot_size);

  if (!(lotSize > 0)) {
    throw new Error("Valid option lot size unavailable");
  }

  const result = {
    type: signal === "BUY CE" ? "CE" : "PE",
    symbol: contract.trading_symbol || "NIFTY OPTION",
    instrumentKey: option.instrument_key,
    expiry,
    strike: Number(atm.strike_price),
    lotSize,
    ltp: premium,
    volume: Number(option.market_data?.volume || 0),
    oi: Number(option.market_data?.oi || 0),
    bid: Number(option.market_data?.bid_price || 0),
    ask: Number(option.market_data?.ask_price || 0),
    delta: option.option_greeks?.delta ?? null,
    theta: option.option_greeks?.theta ?? null,
    gamma: option.option_greeks?.gamma ?? null,
    vega: option.option_greeks?.vega ?? null,
    iv: option.option_greeks?.iv ?? null,
    pcr: atm.pcr ?? null
  };

  log("SCAN", "ATM option selected", {
    symbol: result.symbol,
    expiry,
    strike: result.strike,
    premium,
    lotSize
  });

  return result;
}

// OPEN VIRTUAL TRADE
function openTrade(option) {
  if (!storageReady) {
    throw new Error("Storage unavailable. Entry blocked");
  }

  if (trades.some(t => t.status === "OPEN")) {
    throw new Error("An open virtual trade already exists");
  }

  if (
    !option.instrumentKey ||
    !(option.ltp > 0) ||
    !(option.lotSize > 0)
  ) {
    throw new Error("Invalid option details. Entry blocked");
  }

  const trade = {
    id: "VT-" + Date.now(),
    engineVersion: "2.0",
    status: "OPEN",
    type: option.type,
    symbol: option.symbol,
    instrumentKey: option.instrumentKey,
    expiry: option.expiry,
    strike: option.strike,
    lotSize: option.lotSize,
    quantity: option.lotSize,
    entryPrice: option.ltp,
    targetPrice: Number(
      (option.ltp * 1.20).toFixed(2)
    ),
    stopPrice: Number(
      (option.ltp * 0.90).toFixed(2)
    ),
    exitPrice: null,
    pnl: 0,
    entryTime: new Date().toISOString(),
    exitTime: null,
    exitReason: null,
    source: "VIRTUAL_ONLY",
    optionSnapshot: option
  };

  trades.push(trade);

  try {
    saveTrades();
  } catch (error) {
    trades.pop();
    throw error;
  }

  log("ENTRY", "Virtual trade opened", {
    id: trade.id,
    symbol: trade.symbol,
    entry: trade.entryPrice,
    target: trade.targetPrice,
    stop: trade.stopPrice,
    quantity: trade.quantity
  });

  return trade;
}

// CHECK VIRTUAL EXIT
async function checkOpenTrade() {
  const trade = trades.find(t => t.status === "OPEN");

  if (!trade) return;

  if (!trade.instrumentKey) {
    throw new Error("Open trade instrument key missing");
  }

  const ltp = await getOptionQuote(trade.instrumentKey);

  let exitReason = null;

  if (ltp >= trade.tar