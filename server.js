

const express = require("express");
const Upstox = require("upstox-js-sdk");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 3000;

let latestNiftyData = null;
let feedStatus = "Disconnected";

app.get("/", (req, res) => {
  res.json({
    app: "NIFTY Live Market Backend",
    status: "Running",
    feed: feedStatus,
    marketData: "Read-only"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "OK", feed: feedStatus });
});

app.get("/config", (req, res) => {
  res.json({
    tokenConfigured: Boolean(process.env.UPSTOX_ACCESS_TOKEN)
  });
});

app.get("/nifty", (req, res) => {
  res.json({
    status: feedStatus,
    data: latestNiftyData
  });
});

app.listen(PORT, () => {
  console.log("NIFTY backend running on port " + PORT);

  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token) {
    console.error("UPSTOX_ACCESS_TOKEN is missing");
    return;
  }

  const auth =
    Upstox.ApiClient.instance.authentications["OAUTH2"];

  auth.accessToken = token;

  const streamer = new Upstox.MarketDataStreamerV3();

  streamer.autoReconnect(false);

  streamer.on("open", () => {
    feedStatus = "Connected";
    console.log("Upstox market feed connected");

    streamer.subscribe(
      ["NSE_INDEX|Nifty 50"],
      "ltpc"
    );
  });

  streamer.on("message", (data) => {
  
  try {
        const message = Buffer.isBuffer(data)
            ? data.toString("utf8")
            : data;

        latestNiftyData = typeof message === "string"
            ? JSON.parse(message)
            : message;

        console.log("NIFTY market update received");
    } catch (error) {
        console.error("Market data parse error:", error.message);
    }
});

  });

  streamer.on("error", (error) => {
    feedStatus = "Error";
    console.error("Upstox feed error:", error);
  });

  streamer.on("close", () => {
    feedStatus = "Disconnected";
    console.log("Upstox feed disconnected");
  });

  streamer.connect();
});
