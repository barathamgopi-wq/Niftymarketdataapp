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
const DASHBOARD_FILE = path.join(
  __dirname,
  "NIFTY_Demo_Live_Price_Ready-2.html"
);

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

    const data = JSON.parse(
      fs.readFileSync(STORAGE_FILE, "utf8")
    );

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

  fs.writeFileSync(
    temp,
    JSON.stringify(trades, null, 2)
  );

  fs.renameSync(temp, STORAGE_FILE);
}

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

  if (!response.ok || body.status === "error") {
    throw new Error(
      "Upstox API error: " + response.status
    );
  }

  return body;
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let value = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }

  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gain += change;
    else loss -= change;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

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

  return 100 - 100 / (1 + avgGain / avgLoss);
}

// India date helper
function istDateOffset(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type =>
    parts.find(p => p.type === type)?.value;

  const today = new Date(
    `${get("year")}-${get("month")}-${get("day")}T00:00:00Z`
  );

  today.setUTCDate(today.getUTCDate() - daysAgo);

  return today.toISOString().slice(0, 10);
}

// Indicators: historical + today's intraday candles
async function getIndicators() {
  const today = istDateOffset(0);
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

  const historicalRaw =
    historicalPayload?.data?.candles || [];

  const intradayRaw =
    intradayPayload?.data?.candles || [];

  if (
    !Array.isArray(historicalRaw) ||
    !Array.isArray(intradayRaw)
  ) {
    throw new Error("Candle data unavailable");
  }

  const now = Date.now();

  const allRaw = [
    ...historicalRaw,
    ...intradayRaw
  ];

  const candleMap = new Map();

  for (const c of allRaw) {
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

  const candles = [...candleMap.values()]
    .sort((a, b) => a.time - b.time);

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

  // VWAP resets for the current Indian trading day
  const todayStart = new Date(
    today + "T00:00:00+05:30"
  ).getTime();

  const todayCandles = candles.filter(
    c => c.time >= todayStart
  );

  let pv = 0;
  let volume = 0;

  for (const c of todayCandles) {
    if (c.volume > 0) {
      pv +=
        ((c.high + c.low + c.close) / 3) *
        c.volume;

      volume += c.volume;
    }
  }

  const vwap = volume > 0 ? pv / volume : null;
  const latest = candles[candles.length - 1];

  let signal = "WAIT";

  if (
    vwap !== null &&
    latest.close > e9 &&
    e9 > e21 &&
    latest.close > vwap &&
    r >= 55 &&
    r <= 70
  ) {
    signal = "CE";
  } else if (
    vwap !== null &&
    latest.close < e9 &&
    e9 < e21 &&
    latest.close < vwap &&
    r >= 30 &&
    r <= 45
  ) {
    signal = "PE";
  }

  return {
    status: "ok",
    close: latest.close,
    ema9: Number(e9.toFixed(2)),
    ema21: Number(e21.toFixed(2)),
    rsi14: Number(r.toFixed(2)),
    vwap: vwap === null
      ? null
      : Number(vwap.toFixed(2)),
    completedCandles: candles.length,
    todayCandles: todayCandles.length,
    candleTime: new Date(latest.time).toISOString(),
    signal
  };
}

function marketOpen() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  }).formatToParts(now);

  const get = type =>
    parts.find(p => p.type === type)?.value;

  const day = get("weekday");

  const minutes =
    Number(get("hour")) * 60 +
    Number(get("minute"));

  return (
    !["Sat", "Sun"].includes(day) &&
    minutes >= 555 &&
    minutes <= 930
  );
}

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
        .map(c => c.expiry)
        .filter(d => d >= today)
    )
  ].sort();

  if (!expiries.length) {
    throw new Error("No active NIFTY expiry found");
  }

  return {
    expiry: expiries[0],
    contracts: contracts.filter(
      c => c.expiry === expiries[0]
    )
  };
}

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
    rows[0].underlying_spot_price ||
    indicators.close
  );

  if (!Number.isFinite(spot)) {
    throw new Error("NIFTY spot price unavailable");
  }

  const atm = rows.reduce((best, row) =>
    Math.abs(Number(row.strike_price) - spot) <
    Math.abs(Number(best.strike_price) - spot)
      ? row
      : best
  );

  function makeOption(type) {
    const side =
      type === "CE"
        ? atm.call_options
        : atm.put_options;

    if (!side?.instrument_key) return null;

    const contract = expiryData.contracts.find(
      c => c.instrument_key === side.instrument_key
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

function openTrade(option) {
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
    "DEMO ENTRY:",
    trade.symbol,
    trade.entryPrice
  );
}

function checkExit(option) {
  const trade = trades.find(t =>
    t.status === "OPEN" &&
    t.instrumentKey === option.instrumentKey
  );

  if (!trade) return;

  const ltp = option.ltp;
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
    "DEMO EXIT:",
    reason,
    "P/L:",
    trade.pnl
  );
}

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
      t => t.status === "OPEN"
    );

    if (openTradeNow) {
      const option =
        openTradeNow.type === "CE"
          ? data.ce
          : data.pe;

      if (
        option &&
        option.instrumentKey ===
          openTradeNow.instrumentKey
      ) {
        checkExit(option);
      } else {
        const payload = await apiGet(
          "https://api.upstox.com/v2/option/chain?instrument_key=" +
          encodeURIComponent(UNDERLYING) +
          "&expiry_date=" +
          encodeURIComponent(openTradeNow.expiry)
        );

        const row = (payload.data || []).find(
          x =>
            Number(x.strike_price) ===
            openTradeNow.strike
        );

        const side =
          openTradeNow.type === "CE"
            ? row?.call_options
            : row?.put_options;

        const ltp = Number(side?.market_data?.ltp);

        if (Number.isFinite(ltp) && ltp > 0) {
          checkExit({
            instrumentKey: openTradeNow.instrumentKey,
            ltp
          });
        }
      }
    } else if (
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

    cycleStatus = "Running";
    cycleError = null;

  } catch (error) {
    cycleStatus = "Error";
    cycleError = error.message;

    console.error(
      "Demo trading cycle:",
      error.message
    );

  } finally {
    busy = false;
  }
}

// Dashboard HTML
app.get("/", (req, res) => {
  res.sendFile(DASHBOARD_FILE, error => {
    if (error) {
      console.error("Dashboard file error:", error.message);

      if (!res.headersSent) {
        res.status(500).send(
          "Dashboard HTML file not found. Check that the HTML file is in the project root."
        );
      }
    }
  });
});

// Backend status JSON
app.get("/status", (req, res) => {
  res.json({
    app: "NIFTY Live Demo Trading Backend",
    status: "Running",
    feed: feedStatus,
    demoTrading: cycleStatus,
    realOrders: false
  });
});

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

app.get("/nifty", (req, res) => {
  res.json({
    status: feedStatus,
    lastUpdateTime,
    data: latestNiftyData
  });
});

app.get("/indicators", async (req, res) => {
  try {
    const data = await getIndicators();
    res.json(data);
  } catch (error) {
    res.status(502).json({
      status: "waiting",
      message: error.message
    });
  }
});

app.get("/demo-trades", (req, res) => {
  res.json({
    trades,
    openTrades: trades.filter(
      t => t.status === "OPEN"
    ),
    closedTrades: trades.filter(
      t => t.status === "CLOSED"
    ),
    totalPnl: Number(
      trades
        .filter(t => t.status === "CLOSED")
        .reduce((sum, t) => sum + t.pnl, 0)
        .toFixed(2)
    )
  });
});

app.get("/demo-status", (req, res) => {
  res.json({
    status: cycleStatus,
    lastCycleTime,
    cycleError,
    indicators: indicatorsCache,
    openTrades: trades.filter(
      t => t.status === "OPEN"
    )
  });
});

app.listen(PORT, () => {
  console.log(
    "NIFTY Demo backend running on port " + PORT
  );

  if (!TOKEN) {
    feedStatus = "Error";
    console.error("UPSTOX_ACCESS_TOKEN is missing");
    return;
  }

  Upstox.ApiClient.instance
    .authentications["OAUTH2"].accessToken = TOKEN;

  const streamer = new Upstox.MarketDataStreamerV3();

  streamer.autoReconnect(true, 10, 3);

  streamer.on("open", () => {
    feedStatus = "Connected";

    try {
      streamer.subscribe([UNDERLYING], "ltpc");
    } catch (error) {
      console.error(
        "NIFTY subscription error:",
        error.message
      );
    }
  });

  streamer.on("message", data => {
    try {
      const message = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : data;

      latestNiftyData =
        typeof message === "string"
          ? JSON.parse(message)
          : message;

      lastUpdateTime = new Date().toISOString();

    } catch (error) {
      console.error(
        "Market data parse error:",
        error.message
      );
    }
  });

  streamer.on("reconnecting", () => {
    feedStatus = "Reconnecting";
  });

  streamer.on("error", error => {
    feedStatus = "Error";

    console.error(
      "Upstox feed error:",
      error.message || error
    );
  });

  streamer.on("close", () => {
    feedStatus = "Disconnected";
  });

  streamer.connect();

  tradingCycle();
  setInterval(tradingCycle, POLL_MS);
});
