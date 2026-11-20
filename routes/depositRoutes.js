const router = require("express").Router();

const auth = require("../middleware/authMiddleware");
const admin = require("../middleware/adminMiddleware");

const User = require("../models/User");
const DepositRequest = require("../models/DepositRequest");

const {
  requestDeposit,
  getAllDeposits,
  approveDeposit,
  rejectDeposit,
  getDepositAddress
} = require("../controllers/depositController");

// =====================================================
// USER → Create deposit request
// =====================================================
router.post("/request", auth, requestDeposit);

// =====================================================
// ADMIN → Get all deposit requests
// =====================================================
router.get("/all", auth, admin, getAllDeposits);

// =====================================================
// USER → Get own deposit address
// =====================================================
router.get("/address", auth, getDepositAddress);

// =====================================================
// ADMIN → Approve deposit
// =====================================================
router.post("/approve/:id", auth, admin, approveDeposit);

// =====================================================
// ADMIN → Reject deposit
// =====================================================
router.post("/reject/:id", auth, admin, rejectDeposit);

// =====================================================
// USER → GET OWN DEPOSIT RECORDS (username se)
// GET /api/deposit/deposit-records/:username
// Records token wale user (req.user.id) se aate hain; URL ka username sirf route match ke liye hai.
// =====================================================
router.get("/deposit-records/:username", auth, async (req, res) => {
  try {
    // 🔍 Token wala user
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // ✅ IMPORTANT: user (NOT userId)
    const records = await DepositRequest.find({ user: user._id })
      .sort({ createdAt: -1 });

    const totalDeposits = records
      .filter(r => r.status === "approved")
      .reduce((sum, r) => sum + r.amount, 0);

    const todayDeposits = records
      .filter(
        r =>
          r.status === "approved" &&
          new Date(r.createdAt).toDateString() ===
            new Date().toDateString()
      )
      .reduce((sum, r) => sum + r.amount, 0);

    res.json({
      success: true,
      records,
      userInfo: {
        nickname: user.nickname,
        phone: user.phone,
        invitationCode: user.invitationCode,
        totalDeposits,
        todayDeposits
      }
    });
  } catch (err) {
    console.error("Deposit records error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

module.exports = router;