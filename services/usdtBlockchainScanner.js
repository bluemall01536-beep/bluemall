const mongoose = require("mongoose");
const User = require("../models/User");

const {
  USDTDeposit,
  USDTWalletSettings,
} = require("../models/usdtDeposit");

// =====================================================
// NETWORK CONFIGURATION
// =====================================================

const NETWORK_CONFIG = {
  TRC20: {
    decimals: 6,
    contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    confirmations: Number(process.env.USDT_TRC20_CONFIRMATIONS || 20),
  },

  BEP20: {
    decimals: 18,
    contract: "0x55d398326f99059fF775485246999027B3197955",
    confirmations: Number(process.env.USDT_BEP20_CONFIRMATIONS || 15),
  },

  ERC20: {
    decimals: 6,
    contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    confirmations: Number(process.env.USDT_ERC20_CONFIRMATIONS || 12),
  },
};

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const SCAN_LOCK = {
  running: false,
};

// =====================================================
// HELPERS
// =====================================================

// 500 basis points = 5% tolerance.
// Example: request 10 USDT => matching range 9.50 to 10.50.
const USDT_AMOUNT_TOLERANCE_BPS = 500;

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} missing in .env`);
  }

  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(address) {
  return String(address || "").trim().toLowerCase();
}

function toTokenUnits(amount, decimals) {
  const value = String(amount).trim();

  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error("Invalid token amount");
  }

  const [whole, fraction = ""] = value.split(".");

  if (fraction.length > decimals) {
    throw new Error("Invalid token precision");
  }

  const base = 10n ** BigInt(decimals);

  return (
    BigInt(whole) * base +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0")
  );
}

function fromTokenUnits(value, decimals) {
  const amount = BigInt(value);
  const base = 10n ** BigInt(decimals);

  const whole = amount / base;

  const fraction = (amount % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole.toString();
}

// Compare actual received amount with requested amount using integer math.
function isWithinDepositTolerance(receivedUnits, requestedAmount, decimals) {
  const requestedUnits = toTokenUnits(requestedAmount, decimals);

  if (requestedUnits <= 0n) return false;

  const difference =
    receivedUnits >= requestedUnits
      ? receivedUnits - requestedUnits
      : requestedUnits - receivedUnits;

  return (
    difference * 10000n <=
    requestedUnits * BigInt(USDT_AMOUNT_TOLERANCE_BPS)
  );
}

function evmTopicAddress(address) {
  return (
    "0x" +
    normalizeAddress(address)
      .replace(/^0x/, "")
      .padStart(64, "0")
  );
}

// =====================================================
// HTTP / RPC
// =====================================================

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function evmRpc(url, method, params = []) {
  const result = await postJson(url, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  if (result.error) {
    throw new Error(result.error.message || "Blockchain RPC error");
  }

  return result.result;
}

// =====================================================
// SCANNER CURSOR MODEL
// =====================================================

function getCursorModel() {
  const schema = new mongoose.Schema(
    {
      network: {
        type: String,
        required: true,
        unique: true,
      },

      lastBlock: {
        type: Number,
        default: 0,
      },

      lastTimestamp: {
        type: Number,
        default: 0,
      },
    },
    {
      timestamps: true,
      collection: "usdt_scanner_cursors",
    }
  );

  return (
    mongoose.models.USDTScannerCursor ||
    mongoose.model("USDTScannerCursor", schema)
  );
}

// =====================================================
// DEPOSIT CREDITING
// =====================================================

async function creditDeposit(network, event) {
  const config = NETWORK_CONFIG[network];

  if (!config) {
    throw new Error("Unsupported network");
  }

  const receivedUnits = BigInt(event.value);
  const amount = fromTokenUnits(receivedUnits, config.decimals);

  const wallet = await USDTWalletSettings.findOne({
    network,
    isActive: true,
  }).lean();

  if (!wallet) return;

  if (
    normalizeAddress(wallet.walletAddress) !==
    normalizeAddress(event.to)
  ) {
    return;
  }

  // A pending request must not be expired.
  // A confirming request can only be matched again to its own event.
  // Demo (manual) deposits are never auto-credited: only admin approves them.
  const deposits = await USDTDeposit.find({
    network,
    mode: { $ne: "manual" },
    walletAddress: wallet.walletAddress,
    $or: [
      {
        status: "pending",
        expiresAt: { $gt: new Date() },
      },
      {
        status: "confirming",
        blockchainEventId: event.eventId,
      },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(100)
    .lean();

  // Match against the customer's requested amount, not assignedAmount.
  const matchingDeposits = deposits.filter((deposit) => {
    try {
      return isWithinDepositTolerance(
        receivedUnits,
        deposit.requestedAmount,
        config.decimals
      );
    } catch (error) {
      return false;
    }
  });

  // Never guess which customer should receive an ambiguous payment.
  if (matchingDeposits.length !== 1) {
    if (matchingDeposits.length > 1) {
      await USDTDeposit.updateMany(
        {
          _id: {
            $in: matchingDeposits.map((item) => item._id),
          },
          status: {
            $in: ["pending", "confirming"],
          },
        },
        {
          $set: {
            status: "review",
          },
        }
      );

      console.warn(
        `[USDT] ${network}: ambiguous payment ${amount}; sent for manual review`
      );
    }

    return;
  }

  const deposit = matchingDeposits[0];

  // Wait until the required network confirmations are reached.
  if (event.confirmations < config.confirmations) {
    await USDTDeposit.updateOne(
      {
        _id: deposit._id,
        status: {
          $in: ["pending", "confirming"],
        },
      },
      {
        $set: {
          status: "confirming",
          blockchainEventId: event.eventId,
          blockNumber: event.blockNumber,
          confirmations: event.confirmations,
        },
      }
    );

    return;
  }

  // Actual blockchain-received amount is the amount to credit.
  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount <= 0
  ) {
    await USDTDeposit.updateOne(
      { _id: deposit._id },
      { $set: { status: "review" } }
    );

    return;
  }

  // Deposit completion and user balance credit happen atomically.
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const existingEvent = await USDTDeposit.findOne({
        network,
        blockchainEventId: event.eventId,
      }).session(session);

      // Same event may already be attached to this confirming deposit.
      // Another deposit must never receive the same event.
      if (
        existingEvent &&
        existingEvent._id.toString() !== deposit._id.toString()
      ) {
        return;
      }

      const claimedDeposit = await USDTDeposit.findOneAndUpdate(
        {
          _id: deposit._id,
          status: {
            $in: ["pending", "confirming"],
          },
          mode: { $ne: "manual" },
          network,
        },
        {
          $set: {
            status: "completed",
            blockchainEventId: event.eventId,
            blockNumber: event.blockNumber,
            confirmations: event.confirmations,
            creditedAmount: amount,
            creditedAt: new Date(),
          },
        },
        {
          new: true,
          session,
        }
      );

      if (!claimedDeposit) return;

      const updatedUser = await User.updateOne(
        {
          _id: claimedDeposit.userId,
        },
        {
          $inc: {
            balance: numericAmount,
            totalBalance: numericAmount,
          },
        },
        { session }
      );

      if (updatedUser.modifiedCount !== 1) {
        throw new Error("User balance update failed");
      }

      console.log(
        `[USDT] ${network}: actual received amount ${amount} credited to user ${claimedDeposit.userId}`
      );
    });
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }
  } finally {
    await session.endSession();
  }
}

// =====================================================
// EVM SCANNER - BEP20 / ERC20
// =====================================================

async function scanEvmNetwork(network, Cursor) {
  const config = NETWORK_CONFIG[network];

  const rpcUrl = requiredEnv(
    network === "BEP20" ? "BSC_RPC_URL" : "ETH_RPC_URL"
  );

  const wallet = await USDTWalletSettings.findOne({
    network,
    isActive: true,
  }).lean();

  if (!wallet) return;

  const latestBlock = parseInt(
    await evmRpc(rpcUrl, "eth_blockNumber"),
    16
  );

  const safeHead =
    latestBlock - config.confirmations + 1;

  if (safeHead <= 0) return;

  let cursor = await Cursor.findOne({ network });

  const initialBlocks = Number(
    process.env.USDT_INITIAL_SCAN_BLOCKS || 5000
  );

  // Re-scan a small overlap so recently unmatched events can be checked again.
  const overlapBlocks = Number(
    process.env.USDT_EVM_OVERLAP_BLOCKS || 5000
  );

  let fromBlock = cursor
    ? Math.max(0, cursor.lastBlock - overlapBlocks + 1)
    : Math.max(0, safeHead - initialBlocks);

  const chunkSize = Number(
    process.env.USDT_EVM_BLOCK_CHUNK || 300
  );

  while (fromBlock <= safeHead) {
    const toBlock = Math.min(
      fromBlock + chunkSize - 1,
      safeHead
    );

    const logs = await evmRpc(
      rpcUrl,
      "eth_getLogs",
      [
        {
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          address: config.contract,
          topics: [
            TRANSFER_TOPIC,
            null,
            evmTopicAddress(wallet.walletAddress),
          ],
        },
      ]
    );

    for (const log of logs || []) {
      if (!log.topics || log.topics.length < 3) {
        continue;
      }

      const recipient =
        "0x" + log.topics[2].slice(-40);

      const blockNumber = parseInt(
        log.blockNumber,
        16
      );

      const eventId =
        `${log.transactionHash.toLowerCase()}:` +
        parseInt(log.logIndex, 16);

      await creditDeposit(network, {
        to: recipient,
        value: BigInt(log.data).toString(),
        blockNumber,
        confirmations:
          latestBlock - blockNumber + 1,
        eventId,
      });
    }

    await Cursor.updateOne(
      { network },
      {
        $set: {
          lastBlock: Math.max(
            toBlock,
            cursor?.lastBlock || 0
          ),
        },
      },
      { upsert: true }
    );

    cursor = cursor || { lastBlock: toBlock };
    fromBlock = toBlock + 1;
  }
}

// =====================================================
// TRC20 SCANNER
// =====================================================

async function scanTrc20Network(Cursor) {
  const config = NETWORK_CONFIG.TRC20;

  const wallet = await USDTWalletSettings.findOne({
    network: "TRC20",
    isActive: true,
  }).lean();

  if (!wallet) return;

  const baseUrl =
    process.env.TRONGRID_API_URL ||
    "https://api.trongrid.io";

  const cursor = await Cursor.findOne({
    network: "TRC20",
  });

  const initialHours = Number(
    process.env.USDT_INITIAL_SCAN_HOURS || 24
  );

  const overlapMs = Number(
    process.env.USDT_TRON_OVERLAP_MS || 60 * 60 * 1000
  );

  const minTimestamp = cursor?.lastTimestamp
    ? Math.max(0, cursor.lastTimestamp - overlapMs)
    : Date.now() - initialHours * 60 * 60 * 1000;

  const headers = {};

  if (process.env.TRONGRID_API_KEY) {
    headers["TRON-PRO-API-KEY"] =
      process.env.TRONGRID_API_KEY;
  }

  let nextUrl =
    `${baseUrl}/v1/contracts/${config.contract}/events` +
    `?event_name=Transfer` +
    `&only_confirmed=true` +
    `&limit=200` +
    `&order_by=block_timestamp,asc` +
    `&min_timestamp=${minTimestamp}`;

  const blockResponse = await postJson(
    `${baseUrl}/wallet/getnowblock`,
    {},
    headers
  );

  const currentBlock = Number(
    blockResponse?.block_header?.raw_data?.number || 0
  );

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers,
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      throw new Error(`TronGrid HTTP ${response.status}`);
    }

    const data = await response.json();

    for (const item of data.data || []) {
      const recipient = item.result?.to;

      if (
        normalizeAddress(recipient) !==
        normalizeAddress(wallet.walletAddress)
      ) {
        continue;
      }

      const rawValue = String(item.result?.value || "");

      if (!/^\d+$/.test(rawValue)) continue;

      const blockNumber = Number(
        item.block_number || 0
      );

      const eventId =
        `${String(item.transaction_id).toLowerCase()}:` +
        `${item.event_index ?? 0}`;

      await creditDeposit("TRC20", {
        to: recipient,
        value: rawValue,
        blockNumber,
        confirmations: Math.max(
          0,
          currentBlock - blockNumber + 1
        ),
        eventId,
      });

      await Cursor.updateOne(
        { network: "TRC20" },
        {
          $max: {
            lastTimestamp: Number(
              item.block_timestamp || 0
            ),
          },
        },
        { upsert: true }
      );
    }

    nextUrl = data.meta?.links?.next || null;
  }
}

// =====================================================
// MAIN SCANNER
// =====================================================

async function scanAllNetworks() {
  if (SCAN_LOCK.running) {
    return;
  }

  SCAN_LOCK.running = true;

  try {
    const Cursor = getCursorModel();

    await scanTrc20Network(Cursor);
    await scanEvmNetwork("BEP20", Cursor);
    await scanEvmNetwork("ERC20", Cursor);
  } finally {
    SCAN_LOCK.running = false;
  }
}

module.exports = {
  scanAllNetworks,
};