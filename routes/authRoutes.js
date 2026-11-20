const router = require('express').Router();

// CONTROLLERS
const {
  signup,
  login,
  getAllUsers,
  getMyProfile,
  saveWallet,
  updateWalletName,
  changePassword,
  updatePhone
} = require('../controllers/authController');

// MIDDLEWARES
const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");
const resetTodayProfit = require("../middleware/resetTodayProfit");

// MODEL (FOR PROFILE PHOTO)
const User = require("../models/User");

/* =========================
   AUTH
========================= */

router.post('/signup', signup);
router.post('/login', login);

/* =========================
   WALLET
========================= */

// First-time wallet save
// Network + Address ek baar hi save honge
router.post("/wallet", authMiddleware, saveWallet);

// Wallet name update
// User jitni baar chahe update kar sakta hai
router.put("/wallet", authMiddleware, updateWalletName);

/* =========================
   PROFILE (EXISTING)
========================= */

router.get(
  '/me',
  authMiddleware,
  resetTodayProfit,
  getMyProfile
);

/* =========================
   CHANGE LOGIN PASSWORD
   (Settings > Security)
========================= */

router.put("/change-password", authMiddleware, changePassword);

/* =========================
   ADD PHONE NUMBER
   (Account Information)
========================= */

router.put("/update-phone", authMiddleware, updatePhone);

/* =========================
   UPDATE PROFILE
   (PHOTO + NICKNAME)
========================= */

router.put("/profile", authMiddleware, async (req, res) => {
  try {
    const { nickname, profilePhoto } = req.body;

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (nickname !== undefined) {
      user.nickname = nickname;
    }

    if (profilePhoto !== undefined) {
      user.profilePhoto = profilePhoto;
    }

    await user.save();

    res.json({
      success: true,
      message: "Profile updated successfully",
      user: {
        nickname: user.nickname,
        profilePhoto: user.profilePhoto
      }
    });

  } catch (err) {
    console.error("Profile update error:", err);

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* =========================
   DELETE PROFILE PHOTO
========================= */

router.delete("/profile/photo", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    user.profilePhoto = "";

    await user.save();

    res.json({
      success: true,
      message: "Profile photo deleted successfully"
    });

  } catch (err) {
    console.error("Profile photo delete error:", err);

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* =========================
   ADMIN
========================= */

router.get(
  '/users',
  authMiddleware,
  adminMiddleware,
  getAllUsers
);

module.exports = router;