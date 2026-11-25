const express = require("express");
const Upstox = require("upstox-js-sdk");
const dns = require("dns");
const fs = require("fs");
const path = require("path");

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

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const UNDERLYING = "NSE_INDEX|Nifty 50";
const TARGET_PERCENT = 20;
const STOP_PERCENT = 10;
const POLL_MS = 10000;

const STORAGE_DIR = process.env.DATA_DIR || "/data";
const STORAGE_FILE = path.join(STORAGE_DIR, "demo-trades.json");
const DASHBOARD_FILE = path.join(__dirname, "NIFTY_Demo_Live_Price_Ready-2.html");

let latestNiftyData = null;
let feedStatus = "Disconnected";
let lastUpdateTime = null;
let indicatorsCache = null;
let lastCycleTime = null;
let cycleStatus = "Starting";
let cycleError = null;
let busy = false;

function loadTrades() {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    if (!fs.existsSync(STORAGE_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("Trade history load error:", e.message);
    return [];
  }
}

let trades = loadTrades();

function saveTrades() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const temp = STORAGE_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(trades, null, 2));
  fs.renameSync(temp, STORAGE_FILE);
}

async function apiGet(url) {
  if (!TOKEN) throw new Error("UPSTOX_ACCESS_TOKEN is missing");

  const response = await fetch(url, {
    headers: {
      Authorization: "Bearer " + TOKEN,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });

  const body = await response.json();

  if (!response.ok || body.status === "error") {
    throw new Error("Upstox API error: " + response.status);
  }
  return body;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function istDateOffset(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type => parts.find(p => p.type === type)?.value;
  const today = new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() - daysAgo);
  return today.toISOString().slice(0, 10);
}

// NIFTY Futures VWAP helper
let cachedNiftyFuture = null;
let cachedNiftyFutureDate = null;
let futuresVwapCache = null;
let futuresVwapCacheAt = 0;

async function getNiftyFutureKey() {
  const today = istDateOffset(0);

  if (cachedNiftyFuture && cachedNiftyFutureDate === today) {
    return cachedNiftyFuture;
  }

  // records reduced to 30
  const payload = await apiGet(
    "https://api.upstox.com/v2/instruments/search?query=NIFTY&exchanges=NSE&segments=FO&instrument_types=FUT&page_number=1&records=30"
  );

  const contracts = (payload.data || [])
    .filter(x =>
      x.instrument_type === "FUT" &&
      x.underlying_symbol === "NIFTY" &&
      x.expiry >= today &&
      x.instrument_key
    )
    .sort((a, b) => a.expiry.localeCompare(b.expiry));

  if (!contracts.length) {
    throw new Error("Active NIFTY futures contract not found");
  }

  cachedNiftyFuture = contracts[0].instrument_key;
  cachedNiftyFutureDate = today;
  return cachedNiftyFuture;
}

async function getFuturesVwap() {
  if (futuresVwapCache && Date.now() - futuresVwapCacheAt < 30000) {
    return futuresVwapCache;
  }

  const key = await getNiftyFutureKey();
  const today = istDateOffset(0);
  const fromDate = istDateOffset(7);
  const yesterday = istDateOffset(1);

  const historicalUrl =
    "https://api.upstox.com/v3/historical-candle/" +
    encodeURIComponent(key) + "/minutes/5/" + yesterday + "/" + fromDate;

  const intradayUrl =
    "https://api.upstox.com/v3/historical-candle/intraday/" +
    encodeURIComponent(key) + "/minutes/5";

  const [historical, intraday] = await Promise.all([
    apiGet(historicalUrl),
    apiGet(intradayUrl)
  ]);

  const candles = [
    ...(historical?.data?.candles || []),
    ...(intraday?.data?.candles || [])
  ];

  const todayStart = new Date(today + "T00:00:00+05:30").getTime();
  const now = Date.now();
  let sumPriceVolume = 0;
  let sumVolume = 0;

  for (const c of candles) {
    const timestamp = new Date(c[0]).getTime();
    const high = Number(c[2]);
    const low = Number(c[3]);
    const close = Number(c[4]);
    const volume = Number(c[5] || 0);

    if (
      timestamp >= todayStart &&
      timestamp + 300000 <= now &&
      Number.isFinite(high) &&
      Number.isFinite(low) &&
      Number.isFinite(close) &&
      volume > 0
    ) {
      sumPriceVolume += ((high + low + close) / 3) * volume;
      sumVolume += volume;
    }
  }

  futuresVwapCache = sumVolume > 0
    ? { value: sumPriceVolume / sumVolume, source: "NIFTY Futures" }
    : null;

  futuresVwapCacheAt = Date.now();
  return futuresVwapCache;
}

// Indicators
async function getIndicators() {
  const today = istDateOffset(0);
  const yesterday = istDateOffset(1);
  const fromDate = istDateOffset(7);

  const historicalUrl =
    "https://api.upstox.com/v3/historical-candle/" +
    encodeURIComponent(UNDERLYING) + "/minutes/5/" + yesterday + "/" + fromDate;

  const intradayUrl =
    "https://api.upstox.com/v3/historical-candle/intraday/" +
    encodeURIComponent(UNDERLYING) + "/minutes/5";

  const [historicalPayload, intradayPayload] = await Promise.all([
    apiGet(historicalUrl),
    apiGet(intradayUrl)
  ]);

  const historicalRaw = historicalPayload?.data?.candles || [];
  const intradayRaw = intradayPayload?.data?.candles || [];

  if (!Array.isArray(historicalRaw) || !Array.isArray(intradayRaw)) {
    throw new Error("Candle data unavailable");
  }

  const now = Date.now();
  const candleMap = new Map();

  for (const c of [...historicalRaw, ...intradayRaw]) {
    const time = new Date(c[0]).getTime();
    const candle = {
      time,
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5] || 0)
    };

    if (
      Number.isFinite(candle.time) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      candle.time + 300000 <= now
    ) {
      candleMap.set(candle.time, candle);
    }
  }

  const candles = [...candleMap.values()].sort((a, b) => a.time - b.time);

  if (candles.length < 22) {
    return {
      status: "waiting",
      message: "Need at least 22 completed 5-minute candles",
      completedCandles: candles.length
    };
  }

  const closes = candles.map(c => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const r = rsi(closes, 14);

  if (e9 === null || e21 === null || r === null) {
    return {
      status: "waiting",
      message: "Indicator calculation waiting",
      completedCandles: candles.length
    };
  }

  let vwapData = null;
  try {
    vwapData = await getFuturesVwap();
  } catch (error) {
    console.error("Futures VWAP unavailable:", error.message);
  }

  const vwap = vwapData?.value ?? null;
  const latest = candles[candles.length - 1];
  let signal = "WAIT";

  if (
    vwap !== null &&
    latest.close > e9 &&
    e9 > e21 &&
    latest.close > vwap &&
    r >= 55 && r <= 70
  ) {
    signal = "CE";
  } else if (
    vwap !== null &&
    latest.close < e9 &&
    e9 < e21 &&
    latest.close < vwap &&
    r >= 30 && r <= 45
  ) {
    signal = "PE";
  }

  return {
    status: "ok",
    signal,
    nifty: latest.close,
    ema9: e9,
    ema21: e21,
    rsi: r,
    vwap,
    vwapSource: vwapData?.source || null,
    completedCandles: candles.length,
    candleTime: new Date(latest.time).toISOString()
  };
                         }
