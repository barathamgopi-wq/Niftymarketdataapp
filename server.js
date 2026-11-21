
const express = require("express");
const Upstox = require("upstox-js-sdk");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const PORT = process.env.PORT || 3000;
const INSTRUMENT = "NSE_INDEX|Nifty 50";

let latestNiftyData = null;
let feedStatus = "Disconnected";
let lastUpdateTime = null;

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let value =
    values.slice(0, period).reduce((a, b) => a + b, 0) / period;

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
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

app.get("/", (req, res) => {
  res.json({
    app: "NIFTY Live Market Backend",
    status: "Running",
    feed: feedStatus,
    marketData: "Read-only"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    feed: feedStatus,
    lastUpdateTime
  });
});

app.get("/config", (req, res) => {
  res.json({
    tokenConfigured: Boolean(process.env.UPSTOX_ACCESS_TOKEN)
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
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    return res.status(503).json({
      status: "waiting",
      message: "Upstox token is not configured"
    });
  }

  try {
    const url =
      "https://api.upstox.com/v3/historical-candle/intraday/" +
      encodeURIComponent(INSTRUMENT) +
      "/minutes/5";

    const response = await fetch(url, {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(
        "Upstox candle API returned HTTP " + response.status
      );
    }

    const payload = await response.json();
    const raw = payload && payload.data && payload.data.candles;

    if (!Array.isArray(raw)) {
      throw new Error(
        "Candle data is not available in the expected format"
      );
    }

    const now = Date.now();

    const candles = raw
      .map(c => ({
        time: new Date(c[0]).getTime(),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5] || 0)
      }))
      .filter(c =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.close) &&
        c.time + 5 * 60 * 1000 <= now
      )
      .sort((a, b) => a.time - b.time);

    if (candles.length < 22) {
      return res.json({
        status: "waiting",
        message:
          "At least 22 completed 5-minute candles are needed for EMA 21 and RSI 14",
        completedCandles: candles.length
      });
    }

    const closes = candles.map(c => c.close);

    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const rsi14 = rsi(closes, 14);

    const volumeAvailable = candles.some(
      c => Number.isFinite(c.volume) && c.volume > 0
    );

    let vwap = null;

    if (volumeAvailable) {
      let pv = 0;
      let totalVolume = 0;

      for (const c of candles) {
        if (c.volume > 0) {
          pv += ((c.high + c.low + c.close) / 3) * c.volume;
          totalVolume += c.volume;
        }
      }

      if (totalVolume > 0) {
        vwap = pv / totalVolume;
      }
    }

    const latest = candles[candles.length - 1];

    res.json({
      status: "ok",
      instrument: INSTRUMENT,
      interval: "5 minutes",
      completedCandles: candles.length,
      candleTime: new Date(latest.time).toISOString(),
      close: latest.close,
      ema9: Number(ema9.toFixed(2)),
      ema21: Number(ema21.toFixed(2)),
      rsi14: Number(rsi14.toFixed(2)),
      vwap: vwap === null ? null : Number(vwap.toFixed(2)),
      vwapAvailable: vwap !== null,
      volumeAvailable,
      volume: latest.volume
    });
  } catch (error) {
    console.error("Indicator fetch error:", error.message);

    res.status(502).json({
      status: "waiting",
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log("NIFTY backend running on port " + PORT);

  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    feedStatus = "Error";
    console.error("UPSTOX_ACCESS_TOKEN is missing");
    return;
  }

  Upstox.ApiClient.instance.authentications["OAUTH2"].accessToken =
    token;

  const streamer = new Upstox.MarketDataStreamerV3();

  streamer.autoReconnect(true, 10, 3);

  streamer.on("open", () => {
    feedStatus = "Connected";
    console.log("Upstox market feed connected");

    try {
      streamer.subscribe([INSTRUMENT], "ltpc");
      console.log("NIFTY subscription requested");
    } catch (error) {
      console.error("NIFTY subscription error:", error.message);
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

      console.log("NIFTY market update received");
    } catch (error) {
      console.error("Market data parse error:", error.message);
    }
  });

  streamer.on("reconnecting", data => {
    feedStatus = "Reconnecting";
    console.log("Upstox reconnecting:", data);
  });

  streamer.on("error", error => {
    feedStatus = "Error";
    console.error("Upstox feed error:", error.message || error);
  });

  streamer.on("close", () => {
    feedStatus = "Disconnected";
    console.log("Upstox feed disconnected");
  });

  streamer.on("autoReconnectStopped", data => {
    feedStatus = "Disconnected";
    console.error(
      "Upstox automatic reconnect stopped:",
      data
    );
  });

  streamer.connect();
});
        
