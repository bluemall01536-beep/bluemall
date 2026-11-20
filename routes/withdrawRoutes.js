const router = require("express").Router();
const auth = require("../middleware/authMiddleware");
const admin = require("../middleware/adminMiddleware");

const {
  requestWithdraw,
  approveWithdraw,
  rejectWithdraw,
} = require("../controllers/withdrawController");

const User = require("../models/User");
const WithdrawRequest = require("../models/WithdrawRequest");

/**
 * USER → Create withdraw request
 * POST /api/withdraw/request
 */
router.post("/request", auth, requestWithdraw);

/**
 * ADMIN → Get all withdraw requests
 * GET /api/withdraw/all
 * Returns pure array (for admin panel table)
 */
router.get("/all", auth, admin, async (req, res) => {
  try {
    const list = await WithdrawRequest.find()
      .populate("user", "name nickname email invitationCode")
      .sort({ createdAt: -1 });

    return res.json(list);
  } catch (err) {
    console.error("withdraw/all error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * ADMIN → Approve withdraw
 * POST /api/withdraw/approve/:id
 */
router.post("/approve/:id", auth, admin, approveWithdraw);

/**
 * ADMIN → Reject withdraw
 * POST /api/withdraw/reject/:id
 */
router.post("/reject/:id", auth, admin, rejectWithdraw);

/**
 * USER → Own withdraw records (username se)
 * GET /api/withdraw/withdraw-records/:username
 * Records token wale user (req.user.id) se aate hain; URL ka username sirf route match ke liye hai.
 */
router.get("/withdraw-records/:username", auth, async (req, res) => {
  try {
    // Token wala user
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const records = await WithdrawRequest.find({ user: user._id })
      .sort({ createdAt: -1 });

    const totalWithdrawals = records
      .filter(r => r.status === "approved")
      .reduce((sum, r) => sum + r.amount, 0);

    const todayWithdrawals = records
      .filter(
        r =>
          r.status === "approved" &&
          new Date(r.createdAt).toDateString() === new Date().toDateString()
      )
      .reduce((sum, r) => sum + r.amount, 0);

    const pendingWithdrawals = records.filter(
      r => r.status === "pending"
    ).length;

    res.json({
      success: true,
      records,
      userInfo: {
        nickname: user.nickname,
        phone: user.phone,
        invitationCode: user.invitationCode,
        totalWithdrawals,
        todayWithdrawals,
        pendingWithdrawals,
        withdrawalFeeRate: 5
      }
    });
  } catch (error) {
    console.error("Error fetching withdrawal records:", error);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

module.exports = router;