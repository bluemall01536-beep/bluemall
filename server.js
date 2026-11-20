
// ================================
//              IMPORTS
// ================================
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

require("dotenv").config();

// ================================
//       ENVIRONMENT VALIDATION
// ================================
if (!process.env.MONGO_URL) {
  console.error("❌ MONGO_URL is missing in .env");
  process.exit(1);
}

// ================================
//       ENSURE UPLOAD DIRECTORIES
// ================================
const baseUploadDir = path.join(__dirname, "uploads");
const ordersDir = path.join(baseUploadDir, "orders");
const depositsDir = path.join(baseUploadDir, "deposits");

[baseUploadDir, ordersDir, depositsDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ================================
//           ROUTES IMPORT
// ================================
const authRoutes = require("./routes/authRoutes");
const depositRoutes = require("./routes/depositRoutes");
const withdrawRoutes = require("./routes/withdrawRoutes");
const referralRoutes = require("./routes/referralRoutes");
const serviceRoutes = require("./routes/serviceRoutes");
const transactionRoutes = require("./routes/transactionRoutes");
const adminRoutes = require("./routes/admin");
const orderRoutes = require("./routes/orderRoutes");
const notificationRoutes = require("./routes/notificationRoutes");

// Support Routes
const supportRoutes = require("./routes/supportRoutes");

// Support Socket.IO
const { initializeSocket } = require("./config/socket");

// Lucky Spin Routes
const { router: luckySpinRoutes } = require("./routes/luckySpinRoutes");

// KYC Routes
const kycRoutes = require("./routes/kycRoutes");

// Agent Dashboard Routes
const agentRoutes = require("./routes/agentRoutes");

// USDT Deposit Routes
const usdtDepositRoutes = require("./routes/usdtDepositRoutes");

// ================================
//           INITIALIZE APP
// ================================
const app = express();

// Create shared HTTP server for Express + Socket.IO
const httpServer = http.createServer(app);

// ================================
//       SOCKET CORS CONFIGURATION
// ================================
process.env.FRONTEND_URL =
  process.env.FRONTEND_URL ||
  process.env.CLIENT_URL ||
  "http://localhost:5173";

// ================================
//                CORS
// ================================
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  })
);

// ================================
//             BODY PARSER
// ================================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// ================================
//          SERVE UPLOADS
// ================================
app.use(
  "/uploads",
  (req, res, next) => {
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  }
);

app.use(
  "/uploads",
  express.static(baseUploadDir, {
    setHeaders: (res, filePath) => {
      const lower = filePath.toLowerCase();

      if (lower.endsWith(".png")) {
        res.setHeader("Content-Type", "image/png");
      }

      if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
        res.setHeader("Content-Type", "image/jpeg");
      }

      if (lower.endsWith(".webp")) {
        res.setHeader("Content-Type", "image/webp");
      }

      if (lower.endsWith(".gif")) {
        res.setHeader("Content-Type", "image/gif");
      }

      res.setHeader("Content-Disposition", "inline");
    },
  })
);

// ================================
//             API ROUTES
// ================================
app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/deposit", depositRoutes);
app.use("/api/withdraw", withdrawRoutes);
app.use("/api/referrals", referralRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes);

// Support API
app.use("/api/support", supportRoutes);

// Lucky Spin API
app.use("/api/lucky-spin", luckySpinRoutes);

// KYC API
app.use("/api/kyc", kycRoutes);

// Agent Dashboard API
app.use("/api/agent", agentRoutes);

// USDT Deposit API
app.use("/api/usdt-deposit", usdtDepositRoutes);

// ================================
//             HEALTH CHECK
// ================================
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Backend API Working 🚀",
  });
});

// ================================
//          404 API HANDLER
// ================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found",
  });
});

// ================================
//        GLOBAL ERROR HANDLER
// ================================
app.use((err, req, res, next) => {
  console.error("🔥 Server Error:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    success: false,
    message:
      err.status && err.status < 500
        ? err.message
        : "Internal Server Error",
  });
});

// ================================
//          DATABASE + SERVER
// ================================
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    // Connect MongoDB first
    await mongoose.connect(process.env.MONGO_URL, {
      dbName: "GrabWebsite",
    });

    console.log("🔥 MongoDB connected successfully");

    // Start existing cleanup job
    require("./jobs/cleanupHistory");

    // Start USDT deposit scanner job
    const {
      startUSDTDepositScanner,
    } = require("./jobs/usdtDepositScanner");

    startUSDTDepositScanner();

    console.log("✅ USDT Deposit Scanner initialized");

    // Initialize Socket.IO
    initializeSocket(httpServer);

    // Start HTTP + WebSocket server
    httpServer.listen(PORT, () => {
      console.log(`🚀 Backend running on port ${PORT}`);
      console.log("✅ KYC API: /api/kyc");
      console.log("✅ Agent API: /api/agent");
      console.log("✅ Support API: /api/support");
      console.log("✅ USDT Deposit API: /api/usdt-deposit");
      console.log("✅ USDT Scanner: Running");
      console.log("✅ Support Socket.IO: initialized");
    });

  } catch (err) {
    console.error("❌ Server startup error:", err);
    process.exit(1);
  }
};

startServer();

// ================================
//             EXPORT APP
// ================================
module.exports = app;
module.exports.httpServer = httpServer;