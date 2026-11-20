
const mongoose = require("mongoose");

const User = require("../models/User");
const DepositRequest = require("../models/DepositRequest");
const WithdrawRequest = require("../models/WithdrawRequest");

// =====================================================
// AGENT DASHBOARD
// GET /api/agent/dashboard
// =====================================================

exports.getAgentDashboard = async (req, res) => {
  try {
    // -----------------------------------------------
    // 1. Validate logged-in user
    // -----------------------------------------------

    const agentId = req.user?.id || req.user?._id;

    if (!agentId || !mongoose.Types.ObjectId.isValid(agentId)) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    // Always fetch the Agent from database.
    // Never trust a role sent by the frontend.
    const agent = await User.findById(agentId).select(
      "_id nickname email agentCode role"
    );

    if (!agent) {
      return res.status(404).json({
        success: false,
        message: "Agent account not found"
      });
    }

    if (agent.role !== "Agent") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Agent account required."
      });
    }

    // -----------------------------------------------
    // 2. Get pagination parameters
    // -----------------------------------------------

    const page = Math.max(
      1,
      parseInt(req.query.page, 10) || 1
    );

    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 20)
    );

    const skip = (page - 1) * limit;

    // -----------------------------------------------
    // 3. Find ONLY direct referred users
    // -----------------------------------------------

    const referralFilter = {
      referredBy: agent._id,
      role: { $nin: ["Agent", "admin"] }
    };

    const [totalUsers, referredUsers] = await Promise.all([
      User.countDocuments(referralFilter),

      User.find(referralFilter)
        .select(
          "_id nickname email phone role kycStatus usedInvitationCode invitationCode createdAt"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    // -----------------------------------------------
    // 4. Get ALL direct referral IDs
    // Used for accurate lifetime totals.
    // -----------------------------------------------

    const referralIds = await User.find(referralFilter)
      .distinct("_id");

    // -----------------------------------------------
    // 5. Calculate approved deposits and withdrawals
    // -----------------------------------------------

    let totalDeposits = 0;
    let totalWithdrawals = 0;

    let depositsByUser = {};
    let withdrawalsByUser = {};

    if (referralIds.length > 0) {
      const [depositStats, withdrawStats] = await Promise.all([

        DepositRequest.aggregate([
          {
            $match: {
              user: { $in: referralIds },
              status: "approved"
            }
          },
          {
            $group: {
              _id: "$user",
              total: { $sum: "$amount" }
            }
          }
        ]),

        WithdrawRequest.aggregate([
          {
            $match: {
              user: { $in: referralIds },
              status: "approved"
            }
          },
          {
            $group: {
              _id: "$user",
              total: { $sum: "$amount" }
            }
          }
        ])

      ]);

      // ---------------------------------------------
      // 6. Create user-wise amount maps
      // ---------------------------------------------

      depositStats.forEach((item) => {
        const id = item._id.toString();

        depositsByUser[id] = Number(item.total) || 0;
        totalDeposits += Number(item.total) || 0;
      });

      withdrawStats.forEach((item) => {
        const id = item._id.toString();

        withdrawalsByUser[id] = Number(item.total) || 0;
        totalWithdrawals += Number(item.total) || 0;
      });
    }

    // -----------------------------------------------
    // 7. Format referred users for frontend
    // -----------------------------------------------

    const users = referredUsers.map((user) => {
      const userId = user._id.toString();

      const userDeposits = depositsByUser[userId] || 0;

      // VIP level follows the existing profile logic:
      // KYC approved = VIP 1
      // Approved deposits >= 500 = VIP 2
      // Approved deposits >= 10,000 = VIP 3

      let level = "—";

      if (userDeposits >= 10000) {
        level = "VIP 3";
      } else if (userDeposits >= 500) {
        level = "VIP 2";
      } else if (user.kycStatus === "approved") {
        level = "VIP 1";
      }

      return {
        id: userId,

        username: user.nickname || "Unknown",

        email: user.email || "",

        phone: user.phone || "",

        level,

        // Code used by this user to register.
        referredBy:
          user.usedInvitationCode ||
          agent.agentCode ||
          "",

        registeredAt: user.createdAt || null,

        // User schema does not currently contain
        // an active/inactive account status field.
        status: "Registered",

        kycStatus: user.kycStatus || "none",

        totalDeposits: userDeposits,

        totalWithdrawals:
          withdrawalsByUser[userId] || 0
      };
    });

    // -----------------------------------------------
    // 8. Send dashboard response
    // -----------------------------------------------

    return res.status(200).json({
      success: true,

      message: "Agent dashboard data fetched successfully",

      agent: {
        id: agent._id,
        username: agent.nickname,
        email: agent.email || "",
        agentCode: agent.agentCode || ""
      },

      summary: {
        totalUsers,

        totalDeposits: Number(totalDeposits.toFixed(2)),

        totalWithdrawals: Number(totalWithdrawals.toFixed(2))
      },

      pagination: {
        currentPage: page,
        limit,
        totalUsers,
        totalPages: Math.ceil(totalUsers / limit)
      },

      users
    });

  } catch (error) {
    console.error("Agent Dashboard Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load Agent dashboard",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined
    });
  }
};