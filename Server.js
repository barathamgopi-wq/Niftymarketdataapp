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

// STATUS
let feedStatus = "Disconnected";
let latestNiftyData = null;
let lastUpdateTime = null;
let indicatorsCache = null;
let lastCycleTime = null;
let cycleStatus = "Starting";
let cycleError = null;
let busy = false;
let streamer = null;

// TRADE STORAGE
function loadTrades() {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    if (!fs.existsSync(STORAGE_FILE)) return [];

    const data = JSON.parse(
      fs.readFileSync(STORAGE_FILE, "utf8")
    );

    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Trade history load error:", error.message);
    return [];
  }
}

let trades = loadTrades();

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

// UPSTOX REQUEST
async function apiGet(url) {
  if (!TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing");
  }

  const response = await fetch(url, {
    headers: {
      Authorization: "Bearer " + TOKEN,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error("Upstox API error: HTTP " + response.status);
  }

  return body;
}

// EMA
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

// RSI
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

// INDIA DATE
function istDateOffset(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type =>
    parts.find(item => item.type === type).value;

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
    parts.find(item => item.type === type).value;

  return {
    day: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute"))
  };
}

function marketOpen() {
  const t = marketTime();
  const minutes = t.hour * 60 + t.minute;

  return (
    !["Sat", "Sun"].includes(t.day) &&
    minutes >= 555 &&
    minutes <= 930
  );
}

function entryAllowed() {
  const t = marketTime();
  const minutes = t.hour * 60 + t.minute;

  return (
    !["Sat", "Sun"].includes(t.day) &&
    minutes >= 555 &&
    minutes <= 915
  );
}

// CANDLE DATA
async function getCandles() {
  const fromDate = istDateOffset(7);
  const toDate = istDateOffset(0);

  const historicalUrl =
    "https://api.upstox.com/v3/historical-candle/" +
    encodeURIComponent(UNDERLYING) +
    "/minutes/5/" +
    toDate +
    "/" +
    fromDate;

  const intradayUrl =
    "https://api.upstox.com/v3/historical-candle/intraday/" +
    encodeURIComponent(UNDERLYING) +
    "/minutes/5";

  const [historical, intraday] = await Promise.all([
    apiGet(historicalUrl),
    apiGet(intradayUrl)
  ]);

  const all = [
    ...(historical.data?.candles || []),
    ...(intraday.data?.candles || [])
  ];

  const now = Date.now();
  const map = new Map();

  for (const c of all) {
    const time = new Date(c[0]).getTime();

    if (
      Number.isFinite(time) &&
      time + 300000 <= now &&
      Number.isFinite(Number(c[4]))
    ) {
      map.set(time, {
        time,
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5] || 0)
      });
    }
  }

  return [...map.values()].sort((a, b) => a.time - b.time);
}

// INDICATORS
async function getIndicators() {
  const candles = await getCandles();

  if (candles.length < 22) {
    return {
      status: "waiting",
      signal: "WAIT",
      message: "Not enough completed candles",
      completedCandles: candles.length
    };
  }

  const closes = candles.map(c => c.close);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsiValue = rsi(closes, 14);

  const latest = candles[candles.length - 1];

  // Auto-entry remains disabled pending validation
  const signal = "WAIT";

  return {
    status: "ok",
    signal,
    nifty: latest.close,
    ema9,
    ema21,
    rsi: rsiValue,
    vwap: null,
    vwapSource: null,
    completedCandles: candles.length,
    candleTime: new Date(latest.time).toISOString(),
    message: "VWAP and option-chain validation pending"
  };
}

// OPTION CONTRACTS
async function getOptionContracts() {
  const result = await apiGet(
    "https://api.upstox.com/v2/option/contract?instrument_key=" +
    encodeURIComponent(UNDERLYING)
  );

  return result.data || [];
}

// UPCOMING OPTION EXPIRIES
function getUpcomingExpiries(contracts) {
  const today = istDateOffset(0);

  return [...new Set(
    (contracts || [])
      .map(item =>
        item.expiry ||
        item.expiryDate ||
        item.expiry_date
      )
      .filter(value =>
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        value >= today
      )
  )].sort();
}

// OPTION CHAIN
async function getOptionChain(expiry) {
  const url =
    "https://api.upstox.com/v2/option/chain?instrument_key=" +
    encodeURIComponent(UNDERLYING) +
    "&expiry_date=" +
    encodeURIComponent(expiry);

  const result = await apiGet(url);

  return result.data || [];
}

// OPEN VIRTUAL TRADE
function openTrade(option) {
  if (!option || !option.instrumentKey) return;

  if (trades.some(t => t.status === "OPEN")) return;

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
      (option.ltp * (1 + TARGET_PERCENT / 100)).toFixed(2)
    ),
    stopPrice: Number(
      (option.ltp * (1 - STOP_PERCENT / 100)).toFixed(2)
    ),
    exitPrice: null,
    pnl: 0,
    entryTime: new Date().toISOString(),
    exitTime: null,
    exitReason: null
  };

  trades.push(trade);
  saveTrades();

  console.log("VIRTUAL ENTRY:", trade.symbol, trade.entryPrice);
}

// EXIT VIRTUAL TRADE
function checkExit(instrumentKey, ltp) {
  const trade = trades.find(t =>
    t.status === "OPEN" &&
    t.instrumentKey === instrumentKey
  );

  if (!trade) return;

  ltp = Number(ltp);

  if (!Number.isFinite(ltp) || ltp <= 0) return;

  let reason = null;

  if (ltp >= trade.targetPrice) reason = "TARGET";
  if (ltp <= trade.stopPrice) reason = "STOP LOSS";

  if (!reason) return;

  trade.status = "CLOSED";
  trade.exitPrice = ltp;
  trade.exitTime = new Date().toISOString();
  trade.exitReason = reason;

  trade.pnl = Number(
    ((ltp - trade.entryPrice) * trade.quantity).toFixed(2)
  );

  saveTrades();

  console.log("VIRTUAL EXIT:", reason, "P/L:", trade.pnl);
}

// DEMO CYCLE
async function tradingCycle() {
  if (busy) return;

  busy = true;
  lastCycleTime = new Date().toISOString();

  try {
    if (!TOKEN) {
      throw new Error("UPSTOX_ACCESS_TOKEN is missing");
    }

    if (!marketOpen()) {
      cycleStatus = "Market closed";
      cycleError = null;
      return;
    }

    const indicators = await getIndicators();
    indicatorsCache = indicators;

    // Automatic entries are disabled until validated
    if (indicators.signal === "WAIT") {
      cycleStatus = "Waiting for verified signal";
      cycleError = null;
      return;
    }

    cycleStatus = "Waiting for option validation";

  } catch (error) {
    cycleStatus = "Error";
    cycleError = error.message;
    console.error("Trading cycle:", error.message);

  } finally {
    busy = false;
  }
}

// DASHBOARD
app.get("/", (req, res) => {
  res.sendFile(DASHBOARD_FILE, error => {
    if (error && !res.headersSent) {
      res.status(500).send("Dashboard HTML file not found");
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

// NIFTY LIVE
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

// OPTION CONTRACTS
app.get("/option-contracts", async (req, res) => {
  try {
    const data = await getOptionContracts();

    res.json({
      status: "ok",
      data
    });

  } catch (error) {
    res.status(502).json({
      status: "error",
      message: error.message
    });
  }
});

// OPTION EXPIRIES
app.get("/expiries", async (req, res) => {
  try {
    const contracts = await getOptionContracts();
    const expiries = getUpcomingExpiries(contracts);

    res.json({
      status: "ok",
      todayIST: istDateOffset(0),
      nearestExpiry: expiries[0] || null,
      expiries,
      contractCount: contracts.length
    });

  } catch (error) {
    res.status(502).json({
      status: "error",
      message: error.message
    });
  }
});

// FULL OPTION CHAIN
app.get("/option-chain", async (req, res) => {
  try {
    let expiry = req.query.expiry;

    if (!expiry) {
      const contracts = await getOptionContracts();
      const expiries = getUpcomingExpiries(contracts);

      expiry = expiries[0];

      if (!expiry) {
        return res.status(404).json({
          status: "error",
          message: "No upcoming expiry date found"
        });
      }
    }

    const data = await getOptionChain(expiry);

    res.json({
      status: "ok",
      expiry,
      data
    });

  } catch (error) {
    res.status(502).json({
      status: "error",
      message: error.message
    });
  }
});

// ATM OPTION CHAIN - 21 CLOSEST STRIKES
app.get("/atm-option-chain", async (req, res) => {
  try {
    let expiry = req.query.expiry;

    // Automatically select nearest expiry
    if (!expiry) {
      const contracts = await getOptionContracts();
      const expiries = getUpcomingExpiries(contracts);

      expiry = expiries[0];

      if (!expiry) {
        return res.status(404).json({
          status: "error",
          message: "No upcoming expiry found"
        });
      }
    }

    const chain = await getOptionChain(expiry);

    if (!chain || !chain.length) {
      return res.status(404).json({
        status: "error",
        message: "Option chain data unavailable"
      });
    }

    // Get spot price from option chain
    const spotCandidates = chain
      .map(row => Number(
        row.underlying_spot_price ??
        row.underlyingSpotPrice ??
        row.underlying_spot
      ))
      .filter(v => Number.isFinite(v) && v > 0);

    const spot = spotCandidates[0];

    if (!spot) {
      return res.status(502).json({
        status: "error",
        message: "NIFTY spot price missing from option chain response"
      });
    }

    // Find nearest 21 strikes
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

    const atmStrike = nearest.reduce((best, row) =>
      Math.abs(Number(row.strike_price) - spot) <
      Math.abs(Number(best.strike_price) - spot)
        ? row
        : best
    ).strike_price;

    res.json({
      status: "ok",
      expiry,
      spot,
      atmStrike,
      count: nearest.length,
      data: nearest
    });

  } catch (error) {
    console.error("ATM option chain error:", error.message);

    res.status(502).json({
      status: "error",
      message: error.message
    });
  }
});

// TRADE HISTORY
app.get("/demo-trades", (req, res) => {
  const openTrades = trades.filter(t => t.status === "OPEN");
  const closedTrades = trades.filter(t => t.status === "CLOSED");

  const totalPnl = closedTrades.reduce(
    (sum, t) => sum + Number(t.pnl || 0),
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
    openTrades: trades.filter(t => t.status === "OPEN"),
    realOrders: false
  });
});

// SERVER START
app.listen(PORT, () => {
  console.log("NIFTY backend running on port " + PORT);

  if (!TOKEN) {
    feedStatus = "Error";
    cycleStatus = "Error";
    cycleError = "UPSTOX_ACCESS_TOKEN is missing";
    console.error(cycleError);
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
        streamer.subscribe([UNDERLYING], "ltpc");
      } catch (error) {
        console.error("Subscribe error:", error.message);
      }
    });

    streamer.on("message", data => {
      try {
        if (Buffer.isBuffer(data)) {
          latestNiftyData = {
            raw: data.toString("base64"),
            format: "binary"
          };
        } else if (typeof data === "string") {
          latestNiftyData = JSON.parse(data);
        } else {
          latestNiftyData = data;
        }

        lastUpdateTime = new Date().toISOString();

      } catch (error) {
        console.error("Feed message error:", error.message);
      }
    });

    streamer.on("reconnecting", () => {
      feedStatus = "Reconnecting";
    });

    streamer.on("error", error => {
      feedStatus = "Error";
      console.error("WebSocket error:", error.message || error);
    });

    streamer.on("close", () => {
      feedStatus = "Disconnected";
    });

    streamer.connect();

    tradingCycle();
    setInterval(tradingCycle, POLL_MS);

  } catch (error) {
    feedStatus = "Error";
    cycleStatus = "Error";
    cycleError = error.message;

    console.error("Startup error:", error.message);
  }
});
