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

let latestNiftyData = null;
let feedStatus = "Disconnected";
let lastUpdateTime = null;

const INSTRUMENT = "NSE_INDEX|Nifty 50";

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
    tokenConfigured: Boolean(
      process.env.UPSTOX_ACCESS_TOKEN
    )
  });
});

app.get("/nifty", (req, res) => {
  res.json({
    status: feedStatus,
    lastUpdateTime,
    data: latestNiftyData
  });
});

app.listen(PORT, () => {
  console.log("NIFTY backend running on port " + PORT);

  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    feedStatus = "Error";
    console.error("UPSTOX_ACCESS_TOKEN is missing");
    return;
  }

  const auth =
    Upstox.ApiClient.instance.authentications["OAUTH2"];

  auth.accessToken = token;

  const streamer = new Upstox.MarketDataStreamerV3();

  // Automatic reconnect: 10-second interval, 3 attempts
  streamer.autoReconnect(true, 10, 3);

  streamer.on("open", () => {
    feedStatus = "Connected";

    console.log("Upstox market feed connected");

    // Subscribe again whenever connection opens
    try {
      streamer.subscribe([INSTRUMENT], "ltpc");
      console.log("NIFTY subscription requested");
    } catch (error) {
      console.error(
        "NIFTY subscription error:",
        error.message
      );
    }
  });

  streamer.on("message", (data) => {
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
      console.error(
        "Market data parse error:",
        error.message
      );
    }
  });

  streamer.on("reconnecting", (data) => {
    feedStatus = "Reconnecting";

    console.log("Upstox reconnecting:", data);
  });

  streamer.on("error", (error) => {
    feedStatus = "Error";

    console.error(
      "Upstox feed error:",
      error.message || error
    );
  });

  streamer.on("close", () => {
    feedStatus = "Disconnected";

    console.log("Upstox feed disconnected");
  });

  streamer.on("autoReconnectStopped", (data) => {
    feedStatus = "Disconnected";

    console.error(
      "Upstox automatic reconnect stopped:",
      data
    );
  });

  streamer.connect();
});
