// backend/controllers/orderController.js

const mongoose = require("mongoose");
const Order = require("../models/Order");
const User = require("../models/User");

// ======================================================
// HELPER: BUILD IMAGE URL
// ======================================================
const buildFileUrl = (req, filename) => {
  if (!filename) return "";

  if (filename.startsWith("http")) {
    return filename;
  }

  return `${req.protocol}://${req.get("host")}/uploads/orders/${filename}`;
};

// ======================================================
// HELPER: ROUND MONEY TO 4 DECIMALS
// Floating-point errors (418.51279999999997 vs 418.5128)
// se galat "insufficient balance" na aaye.
// ======================================================
const roundMoney = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 10000) / 10000;

// ======================================================
// HELPER: FORMAT ORDER IMAGES
// ======================================================
const formatOrderImages = (req, order) => {
  const result = { ...order };

  if (result.image) {
    result.image = buildFileUrl(req, result.image);
  }

  if (result.images && result.images.length > 0) {
    result.images = result.images.map(img =>
      buildFileUrl(req, img)
    );
  }

  return result;
};

// ======================================================
// ADMIN: CREATE ORDER (SINGLE / COMBINE)
// Admin sends: nickname
// Backend resolves: userId
// ======================================================
exports.createOrder = async (req, res) => {
  try {
    const {
      platform,
      title,
      amount,
      commission,
      totalProfit,
      orderType,
      nickname
    } = req.body;

    // Validate required fields
    if (!platform || !title || amount === undefined || !nickname) {
      return res.status(400).json({
        success: false,
        message: "platform, title, amount and nickname are required"
      });
    }

    // Validate platform
    const allowedPlatforms = [
      "amazon",
      "alibaba",
      "aliexpress"
    ];

    if (!allowedPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message: "Invalid platform"
      });
    }

    // Validate order type
    const finalOrderType = orderType || "single";

    if (!["single", "combine"].includes(finalOrderType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order type"
      });
    }

    const numericAmount = Number(amount);
    const numericCommission = Number(commission || 0);
    const numericTotalProfit = Number(
      totalProfit !== undefined ? totalProfit : numericCommission
    );

    if (
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0 ||
      !Number.isFinite(numericCommission) ||
      numericCommission < 0 ||
      !Number.isFinite(numericTotalProfit) ||
      numericTotalProfit < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid order amount or commission"
      });
    }

    // Find user by nickname
    const user = await User.findOne({
      nickname: nickname.trim()
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const assignedTo = user._id;

    let image = "";
    let images = [];

    // SINGLE ORDER
    if (finalOrderType === "single") {
      if (req.file) {
        image = req.file.filename;
      } else {
        image = req.body.image || "";
      }
    }

    // COMBINE ORDER
    if (finalOrderType === "combine") {
      if (req.files && req.files.length > 0) {
        images = req.files.map(file => file.filename);
      } else if (req.body.images) {
        images = Array.isArray(req.body.images)
          ? req.body.images
          : [];
      }
    }

    // ORDER INDEX PER USER + PLATFORM
    const lastOrder = await Order.findOne({
      platform,
      assignedTo
    }).sort({ orderIndex: -1 });

    const nextIndex = lastOrder
      ? lastOrder.orderIndex + 1
      : 1;

    // CREATE ORDER
    const order = await Order.create({
      platform,
      title,
      orderType: finalOrderType,

      amount: numericAmount,
      commission: numericCommission,
      totalProfit: numericTotalProfit,

      assignedTo,

      image,
      images,

      orderIndex: nextIndex,

      // Existing availability status
      status: "active",

      // New history status
      recordStatus: "available",
      incompleteReason: "",
      availableBalanceAtAttempt: 0,
      balanceGap: 0,
      lastAttemptAt: null,
      incompleteAt: null,
      completedAt: null,
      submissionCount: 0
    });

    const result = formatOrderImages(
      req,
      order.toObject()
    );

    return res.json({
      success: true,
      message: "Order created successfully",
      order: result
    });

  } catch (err) {
    console.error("createOrder error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

// ======================================================
// USER: GET ORDERS BY PLATFORM
// Amazon / Alibaba / AliExpress
// ======================================================
exports.getOrdersByPlatform = async (req, res) => {
  try {
    const platform = req.params.platform;

    const allowedPlatforms = [
      "amazon",
      "alibaba",
      "aliexpress"
    ];

    if (!allowedPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message: "Invalid platform"
      });
    }

    const userId = req.user.id;

    // Incomplete orders remain active and can be retried.
    // Completed orders are archived and won't appear here.
    const orders = await Order.find({
      platform,
      status: "active",
      assignedTo: userId,
      recordStatus: { $nin: ["completed", "failed"] }
    })
      .sort({ orderIndex: 1 })
      .lean();

    const mapped = orders.map(order =>
      formatOrderImages(req, order)
    );

    return res.json({
      success: true,
      orders: mapped
    });

  } catch (err) {
    console.error("getOrdersByPlatform error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

// ======================================================
// USER: GET COMBINED ORDER RECORDS
// GET /api/orders/records
// GET /api/orders/records?status=incomplete
// GET /api/orders/records?status=completed
// ======================================================
exports.getOrderRecords = async (req, res) => {
  try {
    const userId = req.user.id;
    const requestedStatus = req.query.status;

    const allowedStatuses = [
      "incomplete",
      "pending",
      "completed",
      "failed"
    ];

    if (
      requestedStatus &&
      !allowedStatuses.includes(requestedStatus)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid record status"
      });
    }

    const filter = {
      assignedTo: userId,
      recordStatus: {
        $in: allowedStatuses
      }
    };

    if (requestedStatus) {
      filter.recordStatus = requestedStatus;
    }

    const records = await Order.find(filter)
      .sort({ updatedAt: -1 })
      .lean();

    const mappedRecords = records.map(order =>
      formatOrderImages(req, order)
    );

    const stats = {
      total: mappedRecords.length,
      incomplete: mappedRecords.filter(
        order => order.recordStatus === "incomplete"
      ).length,
      pending: mappedRecords.filter(
        order => order.recordStatus === "pending"
      ).length,
      completed: mappedRecords.filter(
        order => order.recordStatus === "completed"
      ).length,
      failed: mappedRecords.filter(
        order => order.recordStatus === "failed"
      ).length
    };

    return res.json({
      success: true,
      records: mappedRecords,
      stats
    });

  } catch (err) {
    console.error("getOrderRecords error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch order records"
    });
  }
};

// ======================================================
// USER: SUBMIT ORDER
// Handles:
// 1. Insufficient balance -> INCOMPLETE
// 2. Sufficient balance -> COMPLETED
// 3. Completed order cannot be submitted again
// 4. No completed order deletion
// ======================================================
exports.submitOrder = async (req, res) => {
  let session;

  try {
    const { orderId } = req.body;

    const userId = req.user.id;

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Valid order ID is required"
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Verify order exists and belongs to this user
    const existingOrder = await Order.findById(orderId);

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    if (
      String(existingOrder.assignedTo) !==
      String(user._id)
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden"
      });
    }

    // Already completed orders cannot be submitted again
    if (
      existingOrder.recordStatus === "completed" ||
      existingOrder.status === "archived"
    ) {
      return res.status(409).json({
        success: false,
        message: "This order has already been completed"
      });
    }

    if (existingOrder.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "This order is not available"
      });
    }

    // Use database transaction so order and wallet updates
    // succeed or fail together.
    session = await mongoose.startSession();

    let outcome = null;

    await session.withTransaction(async () => {
      // Re-read order and user inside transaction
      const order = await Order.findOne({
        _id: orderId,
        assignedTo: user._id,
        status: "active",
        recordStatus: {
          $nin: ["completed", "failed"]
        }
      }).session(session);

      if (!order) {
        outcome = {
          type: "unavailable"
        };
        return;
      }

      const currentUser = await User.findById(
        user._id
      ).session(session);

      if (!currentUser) {
        outcome = {
          type: "user_not_found"
        };
        return;
      }

      // Always calculate using database values.
      // Never trust amount or commission sent by frontend.
      const requiredAmount = roundMoney(order.amount);
      // Available balance = totalBalance + rewardBalance
      // (frontend bhi dono jodkar dikhata hai, isliye mismatch nahi hoga)
      const availableBalance = roundMoney(
        Number(currentUser.totalBalance || 0) +
        Number(currentUser.rewardBalance || 0)
      );

      const commission = Number(
        order.commission || 0
      );

      // ==============================
      // INSUFFICIENT BALANCE
      // ==============================
      if (availableBalance < requiredAmount) {
        const balanceGap = roundMoney(
          requiredAmount - availableBalance
        );

        order.recordStatus = "incomplete";
        order.incompleteReason = "insufficient_balance";

        order.availableBalanceAtAttempt =
          availableBalance;

        order.balanceGap = balanceGap;

        order.lastAttemptAt = new Date();

        if (!order.incompleteAt) {
          order.incompleteAt = new Date();
        }

        order.submissionCount =
          Number(order.submissionCount || 0) + 1;

        // Keep status active so user can retry later.
        order.status = "active";

        await order.save({ session });

        outcome = {
          type: "insufficient_balance",
          requiredAmount,
          availableBalance,
          balanceGap,
          order: formatOrderImages(
            req,
            order.toObject()
          )
        };

        return;
      }

      // ==============================
      // SUCCESSFUL COMPLETION
      // ==============================

      // Claim this order as completed.
      // Transaction prevents duplicate commission credit.
      order.status = "archived";
      order.recordStatus = "completed";
      order.incompleteReason = "";

      order.user = currentUser._id;

      order.balanceGap = 0;
      order.availableBalanceAtAttempt =
        availableBalance;

      order.lastAttemptAt = new Date();
      order.completedAt = new Date();

      order.submissionCount =
        Number(order.submissionCount || 0) + 1;

      await order.save({ session });

      // Credit commission exactly once.
      const updatedUser = await User.findByIdAndUpdate(
        currentUser._id,
        {
          $inc: {
            totalBalance: commission,
            todayProfit: commission,
            totalOrders: 1
          },
          $set: {
            currentOrders: 0
          }
        },
        {
          new: true,
          session,
          runValidators: true
        }
      );

      if (!updatedUser) {
        throw new Error("Failed to update user balance");
      }

      outcome = {
        type: "completed",
        balance: updatedUser.totalBalance,
        todayProfit: updatedUser.todayProfit,
        totalOrders: updatedUser.totalOrders,
        commission,
        order: formatOrderImages(
          req,
          order.toObject()
        )
      };
    });

    if (outcome?.type === "insufficient_balance") {
      return res.status(200).json({
        success: false,
        status: "incomplete",
        reason: "insufficient_balance",
        message: "Insufficient balance",
        requiredAmount: outcome.requiredAmount,
        availableBalance: outcome.availableBalance,
        balanceGap: outcome.balanceGap,
        order: outcome.order
      });
    }

    if (outcome?.type === "unavailable") {
      return res.status(409).json({
        success: false,
        message: "Order is already completed or unavailable"
      });
    }

    if (outcome?.type === "user_not_found") {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (outcome?.type !== "completed") {
      return res.status(500).json({
        success: false,
        message: "Order submission could not be completed"
      });
    }

    return res.json({
      success: true,
      status: "completed",
      message: "Order completed successfully",
      balance: outcome.balance,
      todayProfit: outcome.todayProfit,
      totalOrders: outcome.totalOrders,
      commission: outcome.commission,
      order: outcome.order
    });

  } catch (err) {
    console.error("submitOrder error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error while submitting order"
    });

  } finally {
    if (session) {
      await session.endSession();
    }
  }
};