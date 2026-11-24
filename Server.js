const express = require("express");
const Upstox = require("upstox-js-sdk");
const dns = require("dns");
const fs = require("fs");
const path = require("path");

dns.setDefaultResultOrder("ipv4first");

const app = express();
app.use(express.json({ limit: "32kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const UNDERLYING = "NSE_INDEX|Nifty 50";

const TARGET_PERCENT = 20;
const STOP_PERCENT = 10;
const POLL_MS = 10000;

const MAX_DAILY_LOSS = Number(process.env.MAX_DAILY_LOSS || 1000);
const MAX_CONSECUTIVE_LOSSES = Number(
  process.env.MAX_CONSECUTIVE_LOSSES || 3
);

const COOLDOWN_MS =
  Number(process.env.COOLDOWN_MINUTES || 30) * 60000;

const MAX_FEED_AGE_MS = 30000;
const STORAGE_DIR = process.env.DATA_DIR || "/data";
const STORAGE_FILE = path.join(STORAGE_DIR, "demo-trades.json");

const DASHBOARD_FILE = path.join(
  __dirname,
  "NIFTY_Demo_Live_Price_Ready-2.html"
);

let latestNiftyData = null;
let latestNiftyLtp = null;
let feedStatus = "Disconnected";
let lastUpdateTime = null;

let indicatorsCache = null;
let lastCycleTime = null;
let cycleStatus = "Starting";
let cycleError = null;

let busy = false;
let streamer = null;
let reconnectTimer = null;
let reconnectDelayMs = 15000;
let lastEntryTime = 0;
let pausedForRisk = false;
let riskPauseDate = null;

function loadTrades() {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });

    if (!fs.existsSync(STORAGE_FILE)) return [];

    const x = JSON.parse(
      fs.readFileSync(STORAGE_FILE, "utf8")
    );

    return Array.isArray(x) ? x : [];
  } catch (e) {
    console.error("Trade history load error:", e.message);
    return [];
  }
}

let trades = loadTrades();

function saveTrades() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const tmp = STORAGE_FILE + ".tmp";

  fs.writeFileSync(
    tmp,
    JSON.stringify(trades, null, 2),
    "utf8"
  );

  fs.renameSync(tmp, STORAGE_FILE);
}

function indiaDate(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const v = Object.fromEntries(
    p.map(x => [x.type, x.value])
  );

  return `${v.year}-${v.month}-${v.day}`;
}

function todayPnl() {
  return trades
    .filter(t =>
      t.status === "CLOSED" &&
      t.exitTime &&
      indiaDate(new Date(t.exitTime)) === indiaDate()
    )
    .reduce((s, t) => s + Number(t.pnl || 0), 0);
}

function lossStreak() {
  const a = trades
    .filter(t => t.status === "CLOSED")
    .sort(
      (x, y) =>
        new Date(y.exitTime) - new Date(x.exitTime)
    );

  let n = 0;

  for (const t of a) {
    if (Number(t.pnl) < 0) n++;
    else break;
  }

  return n;
}

async function apiGet(url) {
  if (!TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing");
  }

  const r = await fetch(url, {
    headers: {
      Authorization: "Bearer " + TOKEN,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });

  const b = await r.json().catch(() => ({}));

  if (!r.ok || b.status === "error") {
    throw new Error(
      `Upstox API error: HTTP ${r.status}` +
      (b.errors?.[0]?.message
        ? " - " + b.errors[0].message
        : "")
    );
  }

  return b;
}

function ema(a, n) {
  if (a.length < n) return null;

  const k = 2 / (n + 1);

  let x = a
    .slice(0, n)
    .reduce((s, v) => s + v, 0) / n;

  for (let i = n; i < a.length; i++) {
    x = a[i] * k + x * (1 - k);
  }

  return x;
}

function rsi(a, n = 14) {
  if (a.length <= n) return null;

  let g = 0;
  let l = 0;

  for (let i = 1; i <= n; i++) {
    const d = a[i] - a[i - 1];

    if (d > 0) g += d;
    else l -= d;
  }

  let ag = g / n;
  let al = l / n;

  for (let i = n + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];

    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
  }

  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

async function getIndicators() {
  const url =
    "https://api.upstox.com/v3/historical-candle/intraday/" +
    encodeURIComponent(UNDERLYING) +
    "/minutes/5";

  const raw = (await apiGet(url))?.data?.candles;

  if (!Array.isArray(raw)) {
    throw new Error("Candle data unavailable");
  }

  const now = Date.now();

  const c = raw
    .map(x => ({
      time: new Date(x[0]).getTime(),
      high: +x[2],
      low: +x[3],
      close: +x[4],
      volume: +(x[5] || 0)
    }))
    .filter(
      x =>
        Number.isFinite(x.time) &&
        Number.isFinite(x.close) &&
        x.time + 300000 <= now
    )
    .sort((a, b) => a.time - b.time);

  if (c.length < 22) {
    return {
      status: "waiting",
      message:
        "Need at least 22 completed 5-minute candles",
      completedCandles: c.length
    };
  }

  const closes = c.map(x => x.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const r = rsi(closes, 14);

  let pv = 0;
  let vol = 0;

  for (const x of c) {
    if (x.volume > 0) {
      pv +=
        ((x.high + x.low + x.close) / 3) *
        x.volume;

      vol += x.volume;
    }
  }

  const vwap = vol ? pv / vol : null;
  const last = c[c.length - 1];

  let signal = "WAIT";

  if (
    vwap !== null &&
    last.close > e9 &&
    e9 > e21 &&
    last.close > vwap &&
    r >= 55 &&
    r <= 70
  ) {
    signal = "CE";
  } else if (
    vwap !== null &&
    last.close < e9 &&
    e9 < e21 &&
    last.close < vwap &&
    r >= 30 &&
    r <= 45
  ) {
    signal = "PE";
  }

  return {
    status: "ok",
    close: last.close,
    ema9: +e9.toFixed(2),
    ema21: +e21.toFixed(2),
    rsi14: +r.toFixed(2),
    vwap: vwap === null ? null : +vwap.toFixed(2),
    completedCandles: c.length,
    candleTime: new Date(last.time).toISOString(),
    signal
  };
}

function marketOpen() {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const v = Object.fromEntries(
    p.map(x => [x.type, x.value])
  );

  const m = +v.hour * 60 + +v.minute;

  return (
    !["Sat", "Sun"].includes(v.weekday) &&
    m >= 555 &&
    m < 930
  );
}

async function getExpiry() {
  const b = await apiGet(
    "https://api.upstox.com/v2/option/contract?instrument_key=" +
    encodeURIComponent(UNDERLYING)
  );

  const contracts = Array.isArray(b.data) ? b.data : [];
  const today = indiaDate();

  const dates = [
    ...new Set(
      contracts
        .map(x => x.expiry)
        .filter(x => x >= today)
    )
  ].sort();

  if (!dates.length) {
    throw new Error("No active NIFTY expiry found");
  }

  return {
    expiry: dates[0],
    contracts: contracts.filter(
      x => x.expiry === dates[0]
    )
  };
}

async function getChain(expiry) {
  const b = await apiGet(
    "https://api.upstox.com/v2/option/chain?instrument_key=" +
    encodeURIComponent(UNDERLYING) +
    "&expiry_date=" +
    encodeURIComponent(expiry)
  );

  return Array.isArray(b.data) ? b.data : [];
}

async function getAtmOptions() {
  const indicators = await getIndicators();

  if (indicators.status !== "ok") {
    throw new Error(
      indicators.message || "Indicators not ready"
    );
  }

  const e = await getExpiry();
  const rows = await getChain(e.expiry);

  if (!rows.length) {
    throw new Error("Option chain unavailable");
  }

  const spot = Number(
    rows[0].underlying_spot_price || indicators.close
  );

  if (!Number.isFinite(spot)) {
    throw new Error("NIFTY spot unavailable");
  }

  const atm = rows.reduce((a, b) =>
    Math.abs(+b.strike_price - spot) <
    Math.abs(+a.strike_price - spot)
      ? b
      : a
  );

  function option(type) {
    const side =
      type === "CE"
        ? atm.call_options
        : atm.put_options;

    if (!side?.instrument_key) return null;

    const contract = e.contracts.find(
      x => x.instrument_key === side.instrument_key
    );

    const ltp = Number(side.market_data?.ltp);
    const lotSize = Number(contract?.lot_size);

    if (
      !contract ||
      !Number.isFinite(ltp) ||
      ltp <= 0 ||
      !Number.isInteger(lotSize) ||
      lotSize <= 0
    ) {
      return null;
    }

    return {
      type,
      instrumentKey: contract.instrument_key,
      symbol: contract.trading_symbol,
      expiry: contract.expiry,
      strike: +contract.strike_price,
      lotSize,
      ltp
    };
  }

  return {
    indicators,
    spot,
    ce: option("CE"),
    pe: option("PE")
  };
}

function openTrade(o) {
  if (!o || trades.some(t => t.status === "OPEN")) {
    return false;
  }

  const t = {
    id:
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2, 7),

    status: "OPEN",
    type: o.type,
    symbol: o.symbol,
    instrumentKey: o.instrumentKey,
    expiry: o.expiry,
    strike: o.strike,
    lotSize: o.lotSize,
    quantity: o.lotSize,
    entryPrice: o.ltp,

    targetPrice: +(
      o.ltp * (1 + TARGET_PERCENT / 100)
    ).toFixed(2),

    stopPrice: +(
      o.ltp * (1 - STOP_PERCENT / 100)
    ).toFixed(2),

    exitPrice: null,
    pnl: 0,
    entryTime: new Date().toISOString(),
    exitTime: null,
    exitReason: null
  };

  trades.push(t);
  saveTrades();

  lastEntryTime = Date.now();

  console.log("PAPER ENTRY", t.symbol, t.entryPrice);

  return true;
}

function checkExit(instrumentKey, ltp) {
  const t = trades.find(
    x =>
      x.status === "OPEN" &&
      x.instrumentKey === instrumentKey
  );

  ltp = Number(ltp);

  if (!t || !Number.isFinite(ltp) || ltp <= 0) {
    return;
  }

  const reason =
    ltp >= t.targetPrice
      ? "TARGET"
      : ltp <= t.stopPrice
        ? "STOP LOSS"
        : null;

  if (!reason) return;

  t.status = "CLOSED";
  t.exitPrice = ltp;
  t.exitTime = new Date().toISOString();
  t.exitReason = reason;

  t.pnl = +(
    (ltp - t.entryPrice) * t.quantity
  ).toFixed(2);

  saveTrades();

  console.log(
    "PAPER EXIT",
    reason,
    "P/L",
    t.pnl
  );
}

async function tradingCycle() {
  const today = indiaDate();

  if (riskPauseDate && riskPauseDate !== today) {
    pausedForRisk = false;
    riskPauseDate = null;
  }

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

    if (
      feedStatus !== "Connected" ||
      !lastUpdateTime ||
      !latestNiftyLtp ||
      Date.now() -
        new Date(lastUpdateTime).getTime() >
        MAX_FEED_AGE_MS
    ) {
      throw new Error(
        "NIFTY feed stale/disconnected; paper trading paused"
      );
    }

    if (pausedForRisk) {
      cycleStatus = "Paused: daily risk limit";
      return;
    }

    const d = await getAtmOptions();
    indicatorsCache = d.indicators;

    const open = trades.find(t => t.status === "OPEN");

    if (open) {
      const rows = await getChain(open.expiry);

      const row = rows.find(
        x => Number(x.strike_price) === Number(open.strike)
      );

      const side =
        open.type === "CE"
          ? row?.call_options
          : row?.put_options;

      const ltp = Number(side?.market_data?.ltp);

      if (Number.isFinite(ltp) && ltp > 0) {
        checkExit(open.instrumentKey, ltp);
      } else {
        throw new Error(
          "Open option quote unavailable; exit not checked"
        );
      }
    } else {
      if (todayPnl() <= -MAX_DAILY_LOSS) {
        pausedForRisk = true;
        riskPauseDate = today;
        cycleStatus = "Paused: daily loss limit";
        return;
      }

      if (
        lossStreak() >=
        MAX_CONSECUTIVE_LOSSES
      ) {
        cycleStatus = "Paused: consecutive loss limit";
        return;
      }

      if (Date.now() - lastEntryTime < COOLDOWN_MS) {
        cycleStatus = "Cooldown";
        return;
      }

      if (d.indicators.signal === "CE" && d.ce) {
        openTrade(d.ce);
      } else if (
        d.indicators.signal === "PE" &&
        d.pe
      ) {
        openTrade(d.pe);
      }
    }

    cycleStatus = "Running";
    cycleError = null;
  } catch (e) {
    cycleStatus = "Error";
    cycleError = e.message;

    console.error("Trading cycle:", e.message);
  } finally {
    busy = false;
  }
}

app.get("/", (req, res) =>
  res.sendFile(DASHBOARD_FILE, e => {
    if (e && !res.headersSent) {
      res.status(500).send(
        "Dashboard HTML file missing from project root."
      );
    }
  })
);

app.get("/status", (req, res) =>
  res.json({
    app: "NIFTY Demo Paper Trading",
    status: "Running",
    feed: feedStatus,
    demoTrading: cycleStatus,
    realOrders: false
  })
);

app.get("/health", (req, res) =>
  res.json({
    status: "OK",
    feed: feedStatus,
    lastUpdateTime,
    demoTrading: cycleStatus,
    lastCycleTime,
    cycleError,
    realOrders: false
  })
);

app.get("/config", (req, res) =>
  res.json({
    tokenConfigured: !!TOKEN,
    demoTrading: true,
    realOrders: false,
    targetPercent: TARGET_PERCENT,
    stopPercent: STOP_PERCENT,
    pollMilliseconds: POLL_MS,
    maxDailyLoss: MAX_DAILY_LOSS,
    maxConsecutiveLosses: MAX_CONSECUTIVE_LOSSES,
    cooldownMinutes: COOLDOWN_MS / 60000
  })
);

app.get("/nifty", (req, res) =>
  res.json({
    status: feedStatus,
    lastUpdateTime,
    ltp: latestNiftyLtp,
    data: latestNiftyData
  })
);

app.get("/indicators", async (req, res) => {
  try {
    res.json(await getIndicators());
  } catch (e) {
    res.status(502).json({
      status: "waiting",
      message: e.message
    });
  }
});

app.get("/demo-trades", (req, res) =>
  res.json({
    trades,
    openTrades: trades.filter(t => t.status === "OPEN"),
    closedTrades: trades.filter(t => t.status === "CLOSED"),

    totalPnl: +trades
      .filter(t => t.status === "CLOSED")
      .reduce((s, t) => s + Number(t.pnl || 0), 0)
      .toFixed(2),

    todayPnl: +todayPnl().toFixed(2)
  })
);

app.get("/demo-status", (req, res) =>
  res.json({
    status: cycleStatus,
    lastCycleTime,
    cycleError,
    indicators: indicatorsCache,
    openTrades: trades.filter(t => t.status === "OPEN"),
    todayPnl: +todayPnl().toFixed(2),
    pausedForRisk,
    consecutiveLosses: lossStreak()
  })
);

app.listen(PORT, () => {
  console.log(
    "NIFTY paper backend listening on",
    PORT
  );

  if (!TOKEN) {
    feedStatus = "Error";
    cycleStatus = "Stopped: missing token";

    console.error("UPSTOX_ACCESS_TOKEN missing");
    return;
  }

  try {
    Upstox.ApiClient.instance.authentications[
      "OAUTH2"
    ].accessToken = TOKEN;

    streamer = new Upstox.MarketDataStreamerV3();

    const scheduleReconnect = reason => {
      feedStatus = "Reconnecting";

      if (reason) {
        console.error(
          "Upstox feed reconnect:",
          reason.message || reason
        );
      }

      if (reconnectTimer) return;

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        try {
          streamer.connect();
        } catch (e) {
          scheduleReconnect(e);
        }
      }, reconnectDelayMs);
    };

    streamer.on("open", () => {
      feedStatus = "Connected";
      reconnectDelayMs = 15000;

      try {
        streamer.subscribe(
          [UNDERLYING],
          "ltpc"
        );
      } catch (e) {
        feedStatus = "Error";
        scheduleReconnect(e);
      }
    });

    streamer.on("message", data => {
      try {
        const m = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : data;

        latestNiftyData =
          typeof m === "string"
            ? JSON.parse(m)
            : m;

        const findLtp = x => {
          if (!x || typeof x !== "object") {
            return null;
          }

          if (
            x.ltpc &&
            Number.isFinite(Number(x.ltpc.ltp))
          ) {
            return Number(x.ltpc.ltp);
          }

          if (
            x.ltp !== undefined &&
            Number.isFinite(Number(x.ltp))
          ) {
            return Number(x.ltp);
          }

          for (const v of Object.values(x)) {
            const found = findLtp(v);

            if (found !== null) return found;
          }

          return null;
        };

        const ltp = findLtp(latestNiftyData);

        if (ltp !== null && ltp > 0) {
          latestNiftyLtp = ltp;
          lastUpdateTime = new Date().toISOString();
        }
      } catch (e) {
        console.error("Feed parse:", e.message);
      }
    });

    streamer.on("reconnecting", () => {
      feedStatus = "Reconnecting";
    });

    streamer.on("error", e => {
      feedStatus = "Error";
      scheduleReconnect(e);
    });

    streamer.on("close", () => {
      feedStatus = "Disconnected";
      scheduleReconnect("socket closed");
    });

    streamer.connect();

    tradingCycle();
    setInterval(tradingCycle, POLL_MS);
  } catch (e) {
    feedStatus = "Error";
    cycleStatus = "Startup error";
    cycleError = e.message;

    console.error(e);
  }
});

// PAPER TRADING ONLY.
// Real order placement is not implemented.
