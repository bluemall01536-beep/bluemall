
const mongoose = require("mongoose");

/*
|--------------------------------------------------------------------------
| USDT DEPOSIT MODEL
|--------------------------------------------------------------------------
| Networks: TRC20, BEP20, ERC20
| Minimum deposit: 10 USDT
| User enters amount; backend assigns a unique matching amount.
| Blockchain transaction identity is stored internally for deduplication.
|--------------------------------------------------------------------------
*/

const NETWORKS = ["TRC20", "BEP20", "ERC20"];

const depositSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    username: {
      type: String,
      trim: true,
      default: "",
    },

    network: {
      type: String,
      enum: NETWORKS,
      required: true,
      uppercase: true,
    },

    requestedAmount: {
      type: String,
      required: true,
    },

    assignedAmount: {
      type: String,
      required: true,
    },

    walletAddress: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: [
        "pending",
        "confirming",
        "completed",
        "expired",
        "review",
      ],
      default: "pending",
      index: true,
    },

    // Internal blockchain event identity.
    // Never required from the user.
    blockchainEventId: {
      type: String,
      default: null,
    },

    blockNumber: {
      type: Number,
      default: null,
    },

    confirmations: {
      type: Number,
      default: 0,
    },

    creditedAmount: {
      type: String,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    creditedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/*
|--------------------------------------------------------------------------
| INDEXES
|--------------------------------------------------------------------------
*/

// Prevent two active requests from receiving the same amount
// on the same network.
// Both pending and confirming requests reserve their amount.
depositSchema.index(
  { network: 1, assignedAmount: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["pending", "confirming"] },
    },
  }
);

// Prevent the same blockchain event from being credited twice.
depositSchema.index(
  { network: 1, blockchainEventId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      blockchainEventId: { $type: "string" },
    },
  }
);

// User deposit history.
depositSchema.index({
  userId: 1,
  createdAt: -1,
});

// Expiry scanning.
depositSchema.index({
  status: 1,
  expiresAt: 1,
});

const walletSettingsSchema = new mongoose.Schema(
  {
    network: {
      type: String,
      enum: NETWORKS,
      required: true,
      unique: true,
      uppercase: true,
    },

    walletAddress: {
      type: String,
      required: true,
      trim: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const USDTDeposit =
  mongoose.models.USDTDeposit ||
  mongoose.model("USDTDeposit", depositSchema);

const USDTWalletSettings =
  mongoose.models.USDTWalletSettings ||
  mongoose.model("USDTWalletSettings", walletSettingsSchema);

module.exports = {
  USDTDeposit,
  USDTWalletSettings,
  NETWORKS,
  MIN_DEPOSIT: 10,
};