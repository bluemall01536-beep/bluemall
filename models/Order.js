
// backend/models/Order.js
const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema(
  {
    // ================= PLATFORM =================
    platform: {
      type: String,
      enum: ["amazon", "alibaba", "aliexpress"],
      required: true
    },

    // ================= ORDER TYPE =================
    // single -> use image
    // combine -> use images
    orderType: {
      type: String,
      enum: ["single", "combine"],
      default: "single"
    },

    // ================= PRODUCT DETAILS =================
    title: {
      type: String,
      required: true
    },

    // Required payment amount
    amount: {
      type: Number,
      required: true
    },

    // Commission paid to user
    commission: {
      type: Number,
      default: 0
    },

    // Convenience total profit
    totalProfit: {
      type: Number,
      default: 0
    },

    // Order number per user/platform
    orderIndex: {
      type: Number,
      required: true
    },

    // ================= USER ASSIGNMENT =================
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    // Single image filename
    image: {
      type: String,
      default: ""
    },

    // Multiple images
    images: [
      {
        type: String
      }
    ],

    // Old system kept for compatibility
    invitationCode: {
      type: String,
      default: null
    },

    // ================= ORDER AVAILABILITY =================
    // Existing system: active / archived
    // Do not use this field for incomplete/completed history.
    status: {
      type: String,
      enum: ["active", "archived"],
      default: "active"
    },

    // ================= ORDER RECORD HISTORY =================
    // Tracks the actual user order progress.
    recordStatus: {
      type: String,
      enum: [
        "available",
        "incomplete",
        "pending",
        "completed",
        "failed"
      ],
      default: "available",
      index: true
    },

    // Why an order became incomplete or failed
    incompleteReason: {
      type: String,
      enum: [
        "",
        "insufficient_balance",
        "submission_failed",
        "other"
      ],
      default: ""
    },

    // User balance when an incomplete attempt happened
    availableBalanceAtAttempt: {
      type: Number,
      default: 0,
      min: 0
    },

    // Additional balance required to submit the order
    balanceGap: {
      type: Number,
      default: 0,
      min: 0
    },

    // First/most recent submission attempt time
    lastAttemptAt: {
      type: Date,
      default: null
    },

    // When order first became incomplete
    incompleteAt: {
      type: Date,
      default: null
    },

    // When order was successfully completed
    completedAt: {
      type: Date,
      default: null
    },

    // Number of submission attempts
    submissionCount: {
      type: Number,
      default: 0,
      min: 0
    },

    // ================= COMPLETED BY USER =================
    // Who completed the order
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  {
    timestamps: true
  }
);

// ================= INDEXES =================

// Efficient user order history queries
OrderSchema.index({
  assignedTo: 1,
  recordStatus: 1,
  createdAt: -1
});

// Efficient platform-wise active order fetching
OrderSchema.index({
  assignedTo: 1,
  platform: 1,
  status: 1,
  orderIndex: 1
});

// ================= EXPORT =================
module.exports = mongoose.model("Order", OrderSchema);