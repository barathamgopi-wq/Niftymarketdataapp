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

// SETTINGS
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const UNDERLYING = "NSE_INDEX|Nifty 50";

const TARGET_PERCENT = 20;
const STOP_PERCENT = 10;
const POLL_MS = 10000;

const STORAGE_DIR = process.env.DATA_DIR || "/data";
const STORAGE_FILE = path.join(STORAGE_DIR, "demo-trades.json");
const DASHBOARD_FILE = path.join(
  __dirname,
  "NIFTY_Demo_Live_Price_Ready-2.html"
);

// LIVE STATUS
let latestNiftyData = null;
let feedStatus = "Disconnected";
let lastUpdateTime = null;

let indicatorsCache = null;
let lastCycleTime = null;
let cycleStatus = "Starting";
let cycleError = null;
let busy = false;

let streamer = null;

// LOAD TRADE HISTORY
function loadTrades() {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });

    if (!fs.existsSync(STORAGE_FILE)) {
      return [];
    }

    const data = JSON.parse(
      fs.readFileSync(STORAGE_FILE, "utf8")
    );

    if (!Array.isArray(data)) {
      throw new Error("Trade history format is invalid");
    }

    return data;
  } catch (error) {
    console.error("Trade history load error:", error.message);
    return [];
  }
}

let trades = loadTrades();

// SAVE TRADE HISTORY
function saveTrades() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const tempFile = STORAGE_FILE + ".tmp";

  fs.writeFileSync(
    tempFile,
    JSON.stringify(trades, null, 2),
    "utf8"
  );

  fs.renameSync(tempFile, STORAGE_FILE);
}

// UPSTOX API REQUEST
async function apiGet(url) {
  if (!TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing");
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + TOKEN,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });

  let body;

  try {
    body = await response.json();
  } catch {
    throw new Error("Invalid response received from Upstox");
  }

  if (!response.ok || body.status === "error") {
    throw new Error(
      "Upstox API error: HTTP " + response.status
    );
  }

  return body;
}

// EMA
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let value =
    values.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    value =
      values[i] * multiplier +
      value * (1 - multiplier);
  }

  return value;
}

// RSI
function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
      gain += change;
    } else {
      loss -= change;
    }
  }

  let averageGain = gain / period;
  let averageLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    averageGain =
      (averageGain * (period - 1) + Math.max(change, 0)) /
      period;

    averageLoss =
      (averageLoss * (period - 1) + Math.max(-change, 0)) /
      period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

// INDIA DATE
function istDateOffset(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type =>
    parts.find(part => part.type === type)?.value;

  const date = new Date(
    `${get("year")}-${get("month")}-${get("day")}T00:00:00Z`
  );

  date.setUTCDate(date.getUTCDate() - daysAgo);

  return date.toISOString().slice(0, 10);
}

// MARKET TIME
function marketTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const get = type =>
    parts.find(part => part.type === type)?.value;

  return {
    day: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute"))
  };
}

function marketOpen() {
  const time = marketTime();
  const minutes = time.hour * 60 + time.minute;

  return (
    !["Sat", "Sun"].includes(time.day) &&
    minutes >= 555 &&
    minutes <= 930
  );
}

// ENTRY WINDOW
function entryAllowed() {
  const time = marketTime();
  const minutes = time.hour * 60 + time.minute;

  return (
    !["Sat", "Sun"].includes(time.day) &&
    minutes >= 555 &&
    minutes <= 915
  );
}

// FUTURES VWAP CACHE
let cachedNiftyFuture = null;
let cachedNiftyFutureDate = null;
let futuresVwapCache = null;
let futuresVwapCacheAt = 0;

// FIND NIFTY FUTURES CONTRACT
async function getNiftyFutureKey() {
  const today = istDateOffset(0);

  if (
    cachedNiftyFuture &&
    cachedNiftyFutureDate === today
  ) {
    return cachedNiftyFuture;
  }

  const payload = await apiGet(
    "https://api.upstox.com/v2/instruments/search?query=NIFTY&exchanges=NSE&segments=FO&instrument_types=FUT&page_number=1&records=30"
  );

  const contracts = (payload.data || [])
    .filter(item =>
      item.instrument_type === "FUT" &&
      item.underlying_symbol === "NIFTY" &&
      item.expiry >= today &&
      item.instrument_key
    )
    .sort((a, b) =>
      a.expiry.localeCompare(b.expiry)
    );

  if (!contracts.length) {
    throw new Error("Active NIFTY futures contract not found");
  }

  cachedNiftyFuture = contracts[0].instrument_key;
  cachedNiftyFutureDate = today;

  return cachedNiftyFuture;
}

// FUTURES VWAP
async function getFuturesVwap() {
  if (
    futuresVwapCache &&
    Date.now() - futuresVwapCacheAt < 30000
  ) {
    return futuresVwapCache;
  }

  const key = await getNiftyFutureKey();

  const today = istDateOffset(0);
  const yesterday = istDateOffset(1);
  const fromDate = istDateOffset(7);

  const historicalUrl =
    "https://api.upstox.com/v3/historical-candle/" +
    encodeURIComponent(key) +
    "/minutes/5/" +
    yesterday +
    "/" +
    fromDate;

  const intradayUrl =
    "https://api.upstox.com/v3/historical-candle/intraday/" +
    encodeURIComponent(key) +
    "/minutes/5";

  const [historical, intraday] = await Promise.all([
    apiGet(historicalUrl),
    apiGet(intradayUrl)
  ]);

  const candles = [
    ...(historical?.data?.candles || []),
    ...(intraday?.data?.candles || [])
  ];

  const todayStart = new Date(
    today + "T00:00:00+05:30"
  ).getTime();

  const now = Date.now();

  let priceVolume = 0;
  let totalVolume = 0;

  for (const candle of candles) {
    const timestamp = new Date(candle[0]).getTime();

    const high = Number(candle[2]);
    const low = Number(candle[3]);
    const close = Number(candle[4]);
    const volume = Number(candle[5] || 0);

    if (
      timestamp >= todayStart &&
      timestamp + 300000 <= now &&
      Number.isFinite(high) &&
      Number.isFinite(low) &&
      Number.isFinite(close) &&
      volume > 0
    ) {
      const typicalPrice = (high + low + close) / 3;

      priceVolume += typicalPrice * volume;
      totalVolume += volume;
    }
  }

  futuresVwapCache =
    totalVolume > 0
      ? {
          value: priceVolume / totalVolume,
          source: "NIFTY Futures"
        }
      : null;

  futuresVwapCacheAt = Date.now();

  return futuresVwapCache;
}

// NIFTY INDICATORS
async function getIndicators() {
  const yesterday = istDateOffset(1);
  const fromDate = istDateOffset(7);

  const historicalUrl =
    "https://api.upstox.com/v3/historical-candle/" +
    encodeURIComponent(UNDERLYING) +
    "/minutes/5/" +
    yesterday +
    "/" +
    fromDate;

  const intradayUrl =
    "https://api.upstox.com/v3/historical-candle/intraday/" +
    encodeURIComponent(UNDERLYING) +
    "/minutes/5";

  const [historicalPayload, intradayPayload] =
    await Promise.all([
      apiGet(historicalUrl),
      apiGet(intradayUrl)
    ]);

  const historical =
    historicalPayload?.data?.candles || [];

  const intraday =
    intradayPayload?.data?.candles || [];

  const now = Date.now();
  const candleMap = new Map();

  for (const candle of [...historical, ...intraday]) {
    const timestamp = new Date(candle[0]).getTime();

    const item = {
      time: timestamp,
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
      volume: Number(candle[5] || 0)
    };

    if (
      Number.isFinite(item.time) &&
      Number.isFinite(item.high) &&
      Number.isFinite(item.low) &&
      Number.isFinite(item.close) &&
      item.time + 300000 <= now
    ) {
      candleMap.set(item.time, item);
    }
  }

  const candles = [...candleMap.values()]
    .sort((a, b) => a.time - b.time);

  if (candles.length < 22) {
    return {
      status: "waiting",
      signal: "WAIT",
      message: "Need at least 22 completed 5-minute candles",
      completedCandles: candles.length
    };
  }

  const closes = candles.map(item => item.close);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsiValue = rsi(closes, 14);

  if (
    ema9 === null ||
    ema21 === null ||
    rsiValue === null
  ) {
    return {
      status: "waiting",
      signal: "WAIT",
      message: "Indicator calculation waiting"
    };
  }

  let vwapData = null;

  try {
    vwapData = await getFuturesVwap();
  } catch (error) {
    console.error("VWAP error:", error.message);
  }

  const vwap = vwapData?.value ?? null;
  const latest = candles[candles.length - 1];

  let signal = "WAIT";

  if (
    vwap !== null &&
    latest.close > ema9 &&
    ema9 > ema21 &&
    latest.close > vwap &&
    rsiValue >= 55 &&
    rsiValue <= 70
  ) {
    signal = "CE";
  } else if (
    vwap !== null &&
    latest.close < ema9 &&
    ema9 < ema21 &&
    latest.close < vwap &&
    rsiValue >= 30 &&
    rsiValue <= 45
  ) {
    signal = "PE";
  }

  return {
    status: "ok",
    signal,
    nifty: latest.close,
    ema9,
    ema21,
    rsi: rsiValue,
    vwap,
    vwapSource: vwapData?.source || null,
    completedCandles: candles.length,
    candleTime: new Date(latest.time).toISOString()
  };
}

// NEAREST EXPIRY
async function getNearestExpiry() {
  const payload = await apiGet(
    "https://api.upstox.com/v2/option/contract?instrument_key=" +
    encodeURIComponent(UNDERLYING)
  );

  const contracts = payload.data || [];
  const today = istDateOffset(0);

  const expiries = [
    ...new Set(
      contracts
        .map(item => item.expiry)
        .filter(date => date >= today)
    )
  ].sort();

  if (!expiries.length) {
    throw new Error("No active NIFTY expiry found");
  }

  return {
    expiry: expiries[0],
    contracts: contracts.filter(
      item => item.expiry === expiries[0]
    )
  };
}

// ATM OPTIONS
async function getAtmOptions() {
  const indicators = await getIndicators();

  if (indicators.status !== "ok") {
    throw new Error(indicators.message);
  }

  const expiryData = await getNearestExpiry();

  const chainPayload = await apiGet(
    "https://api.upstox.com/v2/option/chain?instrument_key=" +
    encodeURIComponent(UNDERLYING) +
    "&expiry_date=" +
    encodeURIComponent(expiryData.expiry)
  );

  const rows = chainPayload.data || [];

  if (!rows.length) {
    throw new Error("Option chain unavailable");
  }

  const spot = Number(
    rows[0].underlying_spot_price || indicators.nifty
  );

  if (!Number.isFinite(spot)) {
    throw new Error("NIFTY spot price unavailable");
  }

  const atm = rows.reduce((best, row) => {
    return (
      Math.abs(Number(row.strike_price) - spot) <
      Math.abs(Number(best.strike_price) - spot)
    ) ? row : best;
  });

  function makeOption(type) {
    const side =
      type === "CE"
        ? atm.call_options
        : atm.put_options;

    if (!side?.instrument_key) return null;

    const contract = expiryData.contracts.find(
      item =>
        item.instrument_key === side.instrument_key
    );

    const ltp = Number(side.market_data?.ltp);

    if (
      !contract ||
      !Number.isFinite(ltp) ||
      ltp <= 0
    ) {
      return null;
    }

    return {
      type,
      instrumentKey: contract.instrument_key,
      symbol: contract.trading_symbol,
      expiry: contract.expiry,
      strike: Number(contract.strike_price),
      lotSize: Number(contract.lot_size),
      ltp
    };
  }

  return {
    indicators,
    spot,
    ce: makeOption("CE"),
    pe: makeOption("PE")
  };
}

// OPEN VIRTUAL TRADE
function openTrade(option) {
  if (!option || !option.instrumentKey) return;

  const alreadyOpen = trades.some(
    trade => trade.status === "OPEN"
  );

  if (alreadyOpen) return;

  const trade = {
    id: Date.now().toString(),
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
      (
        option.ltp *
        (1 + TARGET_PERCENT / 100)
      ).toFixed(2)
    ),

    stopPrice: Number(
      (
        option.ltp *
        (1 - STOP_PERCENT / 100)
      ).toFixed(2)
    ),

    exitPrice: null,
    pnl: 0,

    entryTime: new Date().toISOString(),
    exitTime: null,
    exitReason: null
  };

  trades.push(trade);
  saveTrades();

  console.log(
    "VIRTUAL DEMO ENTRY:",
    trade.symbol,
    trade.entryPrice
  );
}

// EXIT VIRTUAL TRADE
function checkExit(option) {
  const trade = trades.find(item =>
    item.status === "OPEN" &&
    item.instrumentKey === option.instrumentKey
  );

  if (!trade) return;

  const ltp = Number(option.ltp);

  if (!Number.isFinite(ltp) || ltp <= 0) return;

  let reason = null;

  if (ltp >= trade.targetPrice) {
    reason = "TARGET";
  } else if (ltp <= trade.stopPrice) {
    reason = "STOP LOSS";
  }

  if (!reason) return;

  trade.status = "CLOSED";
  trade.exitPrice = ltp;
  trade.exitTime = new Date().toISOString();
  trade.exitReason = reason;

  trade.pnl = Number(
    (
      (ltp - trade.entryPrice) *
      trade.quantity
    ).toFixed(2)
  );

  saveTrades();

  console.log(
    "VIRTUAL DEMO EXIT:",
    reason,
    "P/L:",
    trade.pnl
  );
}

// DEMO TRADING CYCLE
async function tradingCycle() {
  if (busy) return;

  busy = true;
  lastCycleTime = new Date().toISOString();

  try {
    if (!TOKEN) {
      throw new Error("Upstox token missing");
    }

    if (!marketOpen()) {
      cycleStatus = "Market closed";
      cycleError = null;
      return;
    }

    const data = await getAtmOptions();

    indicatorsCache = data.indicators;

    const openTradeNow = trades.find(
      trade => trade.status === "OPEN"
    );

    if (openTradeNow) {
      const currentOption =
        openTradeNow.type === "CE"
          ? data.ce
          : data.pe;

      if (
        currentOption &&
        currentOption.instrumentKey ===
          openTradeNow.instrumentKey
      ) {
        checkExit(currentOption);
      } else {
        const payload = await apiGet(
          "https://api.upstox.com/v2/option/chain?instrument_key=" +
          encodeURIComponent(UNDERLYING) +
          "&expiry_date=" +
          encodeURIComponent(openTradeNow.expiry)
        );

        const row = (payload.data || []).find(
          item =>
            Number(item.strike_price) ===
            openTradeNow.strike
        );

        const side =
          openTradeNow.type === "CE"
            ? row?.call_options
            : row?.put_options;

        const ltp = Number(side?.market_data?.ltp);

        if (
          Number.isFinite(ltp) &&
          ltp > 0
        ) {
          checkExit({
            instrumentKey: openTradeNow.instrumentKey,
            ltp
          });
        }
      }
    } else if (entryAllowed()) {
      if (
        data.indicators.signal === "CE" &&
        data.ce
      ) {
        openTrade(data.ce);
      } else if (
        data.indicators.signal === "PE" &&
        data.pe
      ) {
        openTrade(data.pe);
      }
    }

    cycleStatus = "Running";
    cycleError = null;

  } catch (error) {
    cycleStatus = "Error";
    cycleError = error.message;

    console.error(
      "Demo trading cycle error:",
      error.message
    );

  } finally {
    busy = false;
  }
}

// DASHBOARD
app.get("/", (req, res) => {
  res.sendFile(DASHBOARD_FILE, error => {
    if (error) {
      console.error(
        "Dashboard file error:",
        error.message
      );

      if (!res.headersSent) {
        res.status(500).send(
          "Dashboard HTML file not found. Check the project root."
        );
      }
    }
  });
});

// STATUS
app.get("/status", (req, res) => {
  res.json({
    app: "NIFTY Live Demo Trading Backend",
    status: "Running",
    feed: feedStatus,
    demoTrading: cycleStatus,
    realOrders: false
  });
});

// HEALTH
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    feed: feedStatus,
    lastUpdateTime,
    demoTrading: cycleStatus,
    lastCycleTime,
    cycleError
  });
});

// CONFIG
app.get("/config", (req, res) => {
  res.json({
    tokenConfigured: Boolean(TOKEN),
    demoTrading: true,
    realOrders: false,
    targetPercent: TARGET_PERCENT,
    stopPercent: STOP_PERCENT,
    pollMilliseconds: POLL_MS
  });
});

// NIFTY LIVE DATA
app.get("/nifty", (req, res) => {
  res.json({
    status: feedStatus,
    lastUpdateTime,
    data: latestNiftyData
  });
});

// INDICATORS
app.get("/indicators", async (req, res) => {
  try {
    const data = await getIndicators();
    res.json(data);
  } catch (error) {
    res.status(502).json({
      status: "waiting",
      signal: "WAIT",
      message: error.message
    });
  }
});

// TRADE HISTORY
app.get("/demo-trades", (req, res) => {
  const closedTrades = trades.filter(
    trade => trade.status === "CLOSED"
  );

  const openTrades = trades.filter(
    trade => trade.status === "OPEN"
  );

  const totalPnl = closedTrades.reduce(
    (sum, trade) => sum + Number(trade.pnl || 0),
    0
  );

  res.json({
    trades,
    openTrades,
    closedTrades,
    totalPnl: Number(totalPnl.toFixed(2)),
    totalTrades: trades.length
  });
});

// DEMO STATUS
app.get("/demo-status", (req, res) => {
  res.json({
    status: cycleStatus,
    lastCycleTime,
    cycleError,
    indicators: indicatorsCache,
    openTrades: trades.filter(
      trade => trade.status === "OPEN"
    ),
    realOrders: false
  });
});

// SERVER START
app.listen(PORT, () => {
  console.log(
    "NIFTY Demo backend running on port " + PORT
  );

  if (!TOKEN) {
    feedStatus = "Error";
    cycleStatus = "Error";

    console.error(
      "UPSTOX_ACCESS_TOKEN is missing"
    );

    return;
  }

  try {
    Upstox.ApiClient.instance
      .authentications["OAUTH2"].accessToken = TOKEN;

    streamer = new Upstox.MarketDataStreamerV3();

    streamer.autoReconnect(true, 10, 3);

    streamer.on("open", () => {
      feedStatus = "Connected";

      console.log("Upstox WebSocket connected");

      try {
        streamer.subscribe(
          [UNDERLYING],
          "ltpc"
        );
      } catch (error) {
        console.error(
          "NIFTY subscription error:",
          error.message
        );
      }
    });

    streamer.on("message", data => {
      try {
        let message = data;

        if (Buffer.isBuffer(data)) {
          message = data.toString("utf8");
       
