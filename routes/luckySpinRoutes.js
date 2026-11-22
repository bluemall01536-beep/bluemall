// =====================================================================
// LUCKY SPIN ROUTES  (backend/routes/luckySpinRoutes.js)
// Model + helpers + controller + routes ek hi file me.
//
//   GET  /api/lucky-spin        -> status, wheel segments, total won, records
//   POST /api/lucky-spin/spin   -> last spin ke exact 24 hours baad next spin
//
// VIP unlock rules (Profile.tsx jaisa):
//   * VIP 1 -> KYC Verification Approved
//   * VIP 2 -> Est. Total Value (totalBalance + rewardBalance) >= 500 USDT
//   * VIP 3 -> Est. Total Value (totalBalance + rewardBalance) >= 10,000 USDT
//   * Total Deposits >= 500 / 10,000 se bhi VIP 2 / VIP 3 milta rehta hai (pehle jaisa)
//
// Spin rules:
//   * Har spin ke baad exact 24 hours cooldown
//   * VIP 1 -> 1 USDT se niche
//   * VIP 2 -> 2 USDT se upar, 5 USDT se niche
//   * VIP 3 -> 5 USDT se upar
//   * Regular (VIP 0) spin nahi kar sakta
//   * Winner backend decide karta hai
// =====================================================================

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const DepositRequest = require("../models/DepositRequest");
const authMiddleware = require("../middleware/authMiddleware");

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------

const DAY_OFFSET_MIN = Number(process.env.SPIN_DAY_OFFSET_MIN ?? 330);

const REGULAR_CAN_SPIN = false;

const VIP2_MIN_DEPOSIT = 500;
const VIP3_MIN_DEPOSIT = 10000;

const REQUIRE_KYC_FOR_HIGHER_VIP = false;

const DEPOSIT_OK_STATUS =
  /^(approved|completed|success|successful|confirmed|credited)$/i;

// ---------------------------------------------------------------------
// REWARD TABLES
// ---------------------------------------------------------------------

const REWARD_TABLES = {
  1: [
    { amount: 0.30, w: 18 },
    { amount: 0.10, w: 24 },
    { amount: 0.50, w: 10 },
    { amount: 0.20, w: 22 },
    { amount: 0.70, w: 4 },
    { amount: 0.40, w: 14 },
    { amount: 0.80, w: 2 },
    { amount: 0.60, w: 6 },
  ],

  2: [
    { amount: 2.50, w: 18 },
    { amount: 2.10, w: 26 },
    { amount: 3.50, w: 6 },
    { amount: 2.30, w: 22 },
    { amount: 4.50, w: 2 },
    { amount: 2.80, w: 13 },
    { amount: 4.00, w: 4 },
    { amount: 3.00, w: 9 },
  ],

  3: [
    { amount: 5.30, w: 17 },
    { amount: 5.10, w: 28 },
    { amount: 6.00, w: 6 },
    { amount: 5.20, w: 22 },
    { amount: 8.00, w: 2 },
    { amount: 5.50, w: 12 },
    { amount: 7.00, w: 4 },
    { amount: 5.75, w: 9 },
  ],
};

// ---------------------------------------------------------------------
// MODEL
// ---------------------------------------------------------------------

const luckySpinRecordSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    day: {
      type: String,
      required: true,
    },

    amount: {
      type: Number,
      required: true,
    },

    vipLevel: {
      type: Number,
      required: true,
    },

    segmentIndex: {
      type: Number,
      required: true,
    },

    status: {
      type: String,
      default: "credited",
    },
  },
  { timestamps: true }
);

// Existing unique index retained
luckySpinRecordSchema.index(
  { user: 1, day: 1 },
  { unique: true }
);

const LuckySpinRecord =
  mongoose.models.LuckySpinRecord ||
  mongoose.model("LuckySpinRecord", luckySpinRecordSchema);

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------

const round2 = (n) =>
  Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const dayKey = (date = new Date()) =>
  new Date(
    date.getTime() + DAY_OFFSET_MIN * 60000
  )
    .toISOString()
    .slice(0, 10);

// ---------------------------------------------------------------------
// DEPOSIT CACHE
// ---------------------------------------------------------------------

const depositCache = new Map();

const DEPOSIT_CACHE_MS = 5000;

const sumApprovedDeposits = async (userId) => {
  try {
    const ids = [
      new mongoose.Types.ObjectId(String(userId)),
      String(userId),
    ];

    const agg = await DepositRequest.aggregate([
      {
        $match: {
          $and: [
            {
              $or: [
                { user: { $in: ids } },
                { userId: { $in: ids } },
              ],
            },
            {
              status: DEPOSIT_OK_STATUS,
            },
          ],
        },
      },

      {
        $group: {
          _id: null,

          total: {
            $sum: {
              $convert: {
                input: "$amount",
                to: "double",
                onError: 0,
                onNull: 0,
              },
            },
          },
        },
      },
    ]);

    return round2(agg[0]?.total ?? 0);
  } catch (err) {
    console.error("sumApprovedDeposits error:", err);
    return 0;
  }
};

const getTotalDeposits = async (
  user,
  { fresh = false } = {}
) => {
  const key = String(user._id);

  const hit = depositCache.get(key);

  let fromDeposits;

  if (
    !fresh &&
    hit &&
    Date.now() - hit.at < DEPOSIT_CACHE_MS
  ) {
    fromDeposits = hit.value;
  } else {
    fromDeposits = await sumApprovedDeposits(user._id);

    depositCache.set(key, {
      value: fromDeposits,
      at: Date.now(),
    });
  }

  return round2(
    Math.max(
      Number(user.totalDeposits) || 0,
      fromDeposits
    )
  );
};

// ---------------------------------------------------------------------
// VIP INFO
// ---------------------------------------------------------------------

// Est. Total Value se VIP level nikalta hai (Profile.tsx jaisa):
// KYC/deposit se VIP 1+ mil chuka ho => VIP 2 >= 500, VIP 3 >= 10,000
const calcVipLevel = (baseVip, totalValue) => {
  let lvl = Math.min(Math.max(baseVip, 0), 3);

  if (lvl >= 1) {
    if (totalValue >= VIP3_MIN_DEPOSIT) lvl = 3;
    else if (totalValue >= VIP2_MIN_DEPOSIT) lvl = Math.max(lvl, 2);
  }

  return lvl;
};

const getVipInfo = async (userDoc, opts) => {
  // ✅ DEMO ACCOUNT: direct VIP 3 (KYC / deposit / balance check skip)
  if (String(userDoc.role || "").toLowerCase() === "demo") {
    return {
      vipLevel: 3,
      totalDeposits: Number(userDoc.totalDeposits) || 0,
      totalValue: round2(
        (Number(userDoc.totalBalance) || 0) +
          (Number(userDoc.rewardBalance) || 0)
      ),
      kycApproved: true,
      kycStatus: "approved",
    };
  }

  const totalDeposits = await getTotalDeposits(
    userDoc,
    opts
  );

  const kycStatus = String(
    userDoc.kycStatus || "none"
  ).toLowerCase();

  const kycApproved =
    kycStatus === "approved" ||
    userDoc.kycVerified === true;

  let vipLevel = 0;

  if (totalDeposits >= VIP3_MIN_DEPOSIT) {
    vipLevel = 3;
  } else if (totalDeposits >= VIP2_MIN_DEPOSIT) {
    vipLevel = 2;
  } else if (kycApproved) {
    vipLevel = 1;
  }

  if (
    REQUIRE_KYC_FOR_HIGHER_VIP &&
    vipLevel > 1 &&
    !kycApproved
  ) {
    vipLevel = 0;
  }

  // Est. Total Value = Earning + Reward (Profile / wallet overview jaisa)
  const totalValue = round2(
    (Number(userDoc.totalBalance) || 0) +
      (Number(userDoc.rewardBalance) || 0)
  );

  vipLevel = calcVipLevel(vipLevel, totalValue);

  return {
    vipLevel,
    totalDeposits,
    totalValue,
    kycApproved,
    kycStatus,
  };
};

const canVipSpin = (vip) =>
  vip >= 1 || REGULAR_CAN_SPIN;

const tableFor = (vip) =>
  REWARD_TABLES[
    Math.min(Math.max(vip, 1), 3)
  ];

// ---------------------------------------------------------------------
// RANDOM REWARD
// ---------------------------------------------------------------------

const pickIndex = (table) => {
  const total = table.reduce(
    (s, r) => s + r.w,
    0
  );

  let roll = crypto.randomInt(total);

  for (let i = 0; i < table.length; i += 1) {
    if (roll < table[i].w) {
      return i;
    }

    roll -= table[i].w;
  }

  return 0;
};

// ---------------------------------------------------------------------
// GET SPIN SUMMARY
// Used by authController (/auth/me)
// ---------------------------------------------------------------------

const getSpinSummary = async (userId) => {
  const empty = {
    vipLevel: 0,
    totalDeposits: 0,
    kycStatus: "none",
    availableSpins: 0,
    nextSpinAt: null,
  };

  try {
    const user = await User.findById(userId).lean();

    if (!user) return empty;

    const info = await getVipInfo(user);

    const lastSpin = await LuckySpinRecord.findOne({
      user: user._id,
    })
      .sort({ createdAt: -1 })
      .select("createdAt")
      .lean();

    const nextSpinAt = lastSpin
      ? new Date(
          new Date(lastSpin.createdAt).getTime() +
            24 * 60 * 60 * 1000
        )
      : null;

    const availableSpins =
      canVipSpin(info.vipLevel) &&
      (!nextSpinAt ||
        Date.now() >= nextSpinAt.getTime())
        ? 1
        : 0;

    return {
      vipLevel: info.vipLevel,
      totalDeposits: info.totalDeposits,
      kycStatus: info.kycStatus,
      availableSpins,
      nextSpinAt: nextSpinAt
        ? nextSpinAt.toISOString()
        : null,
    };
  } catch (err) {
    console.error("getSpinSummary error:", err);
    return empty;
  }
};

// ---------------------------------------------------------------------
// GET STATUS
// GET /api/lucky-spin
// ---------------------------------------------------------------------

const getStatus = async (req, res) => {
  try {
    const user = await User.findById(
      req.user.id
    ).lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const { vipLevel, totalDeposits } =
      await getVipInfo(user);

    const canSpin = canVipSpin(vipLevel);

    const [
      lastSpin,
      history,
      totalAgg,
    ] = await Promise.all([
      LuckySpinRecord.findOne({
        user: user._id,
      })
        .sort({ createdAt: -1 })
        .select("createdAt")
        .lean(),

      LuckySpinRecord.find({
        user: user._id,
      })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean(),

      LuckySpinRecord.aggregate([
        {
          $match: {
            user: new mongoose.Types.ObjectId(
              String(user._id)
            ),
          },
        },

        {
          $group: {
            _id: null,
            total: {
              $sum: "$amount",
            },
          },
        },
      ]),
    ]);

    const nextSpinAt = lastSpin
      ? new Date(
          new Date(lastSpin.createdAt).getTime() +
            24 * 60 * 60 * 1000
        )
      : null;

    const availableSpins =
      canSpin &&
      (!nextSpinAt ||
        Date.now() >= nextSpinAt.getTime())
        ? 1
        : 0;

    return res.json({
      success: true,

      vipLevel,
      canSpin,
      totalDeposits,

      segments: tableFor(vipLevel).map(
        (r) => r.amount
      ),

      availableSpins,

      totalWon: round2(
        totalAgg[0]?.total ?? 0
      ),

      nextSpinAt: nextSpinAt
        ? nextSpinAt.toISOString()
        : null,

      serverTime: new Date().toISOString(),

      history: history.map((h) => ({
        id: String(h._id),
        amount: h.amount,
        createdAt: h.createdAt,
        status: h.status,
      })),
    });
  } catch (err) {
    console.error(
      "Lucky spin status error:",
      err
    );

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// ---------------------------------------------------------------------
// SPIN
// POST /api/lucky-spin/spin
// ---------------------------------------------------------------------

const spin = async (req, res) => {
  try {
    const user = await User.findById(
      req.user.id
    ).lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Fresh VIP check
    const { vipLevel } = await getVipInfo(
      user,
      { fresh: true }
    );

    if (!canVipSpin(vipLevel)) {
      return res.status(403).json({
        success: false,
        message:
          "Complete KYC verification to reach VIP 1 and unlock Lucky Spin.",
      });
    }

    const now = new Date();

    const cooldownCutoff = new Date(
      now.getTime() - 24 * 60 * 60 * 1000
    );

    // Check last spin
    const lastSpin = await LuckySpinRecord.findOne({
      user: user._id,
    })
      .sort({ createdAt: -1 })
      .select("createdAt")
      .lean();

    if (
      lastSpin &&
      new Date(lastSpin.createdAt).getTime() >
        cooldownCutoff.getTime()
    ) {
      const nextSpinAt = new Date(
        new Date(lastSpin.createdAt).getTime() +
          24 * 60 * 60 * 1000
      );

      return res.status(409).json({
        success: false,

        message:
          "Your next spin will be available after 24 hours from your last spin.",

        nextSpinAt: nextSpinAt.toISOString(),

        serverTime: now.toISOString(),
      });
    }

    // Atomic per-user lock to prevent simultaneous spins
    const lock = await User.updateOne(
      {
        _id: user._id,

        $or: [
          {
            luckySpinLastAt: {
              $exists: false,
            },
          },

          {
            luckySpinLastAt: null,
          },

          {
            luckySpinLastAt: {
              $lte: cooldownCutoff,
            },
          },
        ],
      },

      {
        $set: {
          luckySpinLastAt: now,
        },
      },

      {
        strict: false,
      }
    );

    if (!lock.modifiedCount) {
      const lockedUntil = new Date(
        now.getTime() + 24 * 60 * 60 * 1000
      );

      return res.status(409).json({
        success: false,

        message:
          "Your next spin will be available after 24 hours from your last spin.",

        nextSpinAt: lockedUntil.toISOString(),

        serverTime: now.toISOString(),
      });
    }

    // Select reward
    const table = tableFor(vipLevel);

    const segmentIndex = pickIndex(table);

    const amount = round2(
      table[segmentIndex].amount
    );

    // Save spin record
    let record;

    try {
      record = await LuckySpinRecord.create({
        user: user._id,
        day: dayKey(now),
        amount,
        vipLevel,
        segmentIndex,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      // Rollback lock if record creation fails
      await User.updateOne(
        {
          _id: user._id,
          luckySpinLastAt: now,
        },
        {
          $unset: {
            luckySpinLastAt: 1,
          },
        },
        {
          strict: false,
        }
      );

      if (err && err.code === 11000) {
        return res.status(409).json({
          success: false,
          message:
            "Your next spin will be available after 24 hours from your last spin.",
        });
      }

      throw err;
    }

    // Credit reward
    try {
      await User.updateOne(
        {
          _id: user._id,
        },
        {
          $inc: {
            rewardBalance: amount,
          },
        }
      );
    } catch (err) {
      // Rollback record and lock if credit fails
      await LuckySpinRecord.deleteOne({
        _id: record._id,
      });

      await User.updateOne(
        {
          _id: user._id,
          luckySpinLastAt: now,
        },
        {
          $unset: {
            luckySpinLastAt: 1,
          },
        },
        {
          strict: false,
        }
      );

      throw err;
    }

    const fresh = await User.findById(
      user._id
    )
      .select("rewardBalance")
      .lean();

    return res.json({
      success: true,

      reward: amount,

      segmentIndex,

      vipLevel,

      rewardBalance: round2(
        fresh?.rewardBalance ?? amount
      ),

      nextSpinAt: new Date(
        now.getTime() + 24 * 60 * 60 * 1000
      ).toISOString(),

      serverTime: new Date().toISOString(),

      message: `You won ${amount.toFixed(2)} USDT`,
    });
  } catch (err) {
    console.error("Lucky spin error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// ---------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------

const router = express.Router();

router.get("/", authMiddleware, getStatus);

router.post("/spin", authMiddleware, spin);

module.exports = {
  router,
  LuckySpinRecord,
  getSpinSummary,
  getVipInfo,
  dayKey,
};