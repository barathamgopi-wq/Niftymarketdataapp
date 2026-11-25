// ===============================
// SAFE UPSTOX WEBSOCKET CONNECTION
// ===============================

let streamer = null;
let reconnectTimer = null;
let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 60000;
let shuttingDown = false;

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;

  feedStatus = "Reconnecting";

  console.log(
    `Reconnect scheduled in ${reconnectDelay / 1000} seconds`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startStreamer();
  }, reconnectDelay);

  reconnectDelay = Math.min(
    reconnectDelay * 2,
    MAX_RECONNECT_DELAY
  );
}

function startStreamer() {
  if (shuttingDown) return;

  try {
    // పాత streamer ను సురక్షితంగా మూసివేయడం
    if (streamer) {
      try {
        streamer.disconnect();
      } catch (e) {
        console.log("Old streamer cleanup:", e.message);
      }
    }

    // కొత్త streamer సృష్టించడం
    streamer = new Upstox.MarketDataStreamerV3();

    streamer.on("open", () => {
      console.log("Upstox WebSocket connected");

      feedStatus = "Connected";
      reconnectDelay = 5000;

      try {
        streamer.subscribe([UNDERLYING], "ltpc");
        console.log("NIFTY subscription successful");
      } catch (error) {
        console.error("Subscription error:", error.message);
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
        console.error("Message parsing error:", error.message);
      }
    });

    streamer.on("error", error => {
      console.error(
        "Upstox WebSocket error:",
        error.message || error
      );

      feedStatus = "Error";
    });

    streamer.on("close", () => {
      console.log("WebSocket closed");

      feedStatus = "Disconnected";

      scheduleReconnect();
    });

    streamer.connect();

  } catch (error) {
    console.error("Streamer startup error:", error.message);

    feedStatus = "Error";

    scheduleReconnect();
  }
}

// ===============================
// SERVER START
// ===============================

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

  startStreamer();

  // Demo trading cycle
  tradingCycle();

  setInterval(tradingCycle, POLL_MS);
});

// ===============================
// SHUTDOWN
// ===============================

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down...");

  shuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (streamer) {
    try {
      streamer.disconnect();
    } catch (error) {
      console.log("Disconnect:", error.message);
    }
  }

  process.exit(0);
});
