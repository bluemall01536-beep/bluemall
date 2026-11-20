
require("dotenv").config();

const {
  scanAllNetworks,
} = require("../services/usdtBlockchainScanner");

// ============================================
// CONFIGURATION
// ============================================

const INTERVAL_MS = Math.max(
  10000,
  Number(process.env.USDT_SCANNER_INTERVAL_MS || 30000)
);

let isRunning = false;
let isStopped = false;
let timer = null;

// ============================================
// SCANNER EXECUTION
// ============================================

async function runScanner() {
  if (isStopped || isRunning) {
    return;
  }

  isRunning = true;

  try {
    await scanAllNetworks();
  } catch (error) {
    console.error("[USDT Scanner] Scan error:", error.message);
  } finally {
    isRunning = false;

    if (!isStopped) {
      timer = setTimeout(runScanner, INTERVAL_MS);
    }
  }
}

// ============================================
// START JOB
// ============================================

function startUSDTDepositScanner() {
  if (!isStopped && (isRunning || timer)) {
    console.log("[USDT Scanner] Already running.");
    return;
  }

  isStopped = false;

  console.log(
    `[USDT Scanner] Job started. Interval: ${INTERVAL_MS}ms`
  );

  // Run immediately after startup.
  runScanner();
}

// ============================================
// STOP JOB
// ============================================

function stopUSDTDepositScanner() {
  isStopped = true;

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  console.log("[USDT Scanner] Job stopped.");
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  startUSDTDepositScanner,
  stopUSDTDepositScanner,
};