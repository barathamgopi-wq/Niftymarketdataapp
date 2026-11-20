
const express = require("express");
const Upstox = require("upstox-js-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    app: "NIFTY Live Market Backend",
    status: "Running",
    marketData: "Read-only"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

app.get("/config", (req, res) => {
  res.json({
    tokenConfigured: Boolean(process.env.UPSTOX_ACCESS_TOKEN)
  });
});

app.listen(PORT, () => {
  console.log("NIFTY backend running on port " + PORT);

  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) {
    console.error("UPSTOX_ACCESS_TOKEN is missing");
    return;
  }

  const auth = Upstox.ApiClient.instance.authentications["OAUTH2"];
  auth.accessToken = token;

  const streamer = new Upstox.MarketDataStreamerV3(
    ["NSE_INDEX|Nifty 50"],
    "ltpc"
  );

  streamer.on("open", () => {
    console.log("Upstox market feed connected");
  });

  streamer.on("message", (data) => {
    console.log("NIFTY market update received");
  });

  streamer.on("error", (error) => {
    console.error("Upstox feed error:", error.message || error);
  });

  streamer.on("close", () => {
    console.log("Upstox feed disconnected");
  });

  streamer.connect();
});
