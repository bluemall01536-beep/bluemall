
const jwt = require("jsonwebtoken");
const User = require("../models/User");

module.exports = async function adminMiddleware(req, res, next) {
  try {
    // ================================
    //       JWT SECRET VALIDATION
    // ================================
    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      console.error("❌ JWT_SECRET is missing");

      return res.status(500).json({
        success: false,
        message: "Authentication configuration error",
      });
    }

    // ================================
    //       GET AUTHENTICATED USER ID
    // ================================
    let userId = req.user?.id || req.user?._id;

    // ================================
    //       FALLBACK TOKEN CHECK
    // ================================
    if (!userId) {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/i);

      if (!bearerMatch) {
        return res.status(401).json({
          success: false,
          message: "Invalid authorization format",
        });
      }

      let decoded;

      try {
        decoded = jwt.verify(bearerMatch[1], jwtSecret, {
          algorithms: ["HS256"],
        });
      } catch (err) {
        return res.status(401).json({
          success: false,
          message: "Invalid or expired token",
        });
      }

      if (!decoded?.id) {
        return res.status(401).json({
          success: false,
          message: "Invalid authentication token",
        });
      }

      userId = decoded.id;
    }

    // ================================
    //       VERIFY ADMIN FROM DATABASE
    // ================================
    const user = await User.findById(userId).select(
      "_id nickname email phone role isAdmin"
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User account not found",
      });
    }

    // Strict role check
    if (user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin access only",
      });
    }

    // ================================
    //       UPDATE REQUEST USER
    // ================================
    req.user = {
      ...(req.user?.toObject ? req.user.toObject() : req.user || {}),

      id: user._id,
      _id: user._id,

      username: user.nickname,
      nickname: user.nickname,

      email: user.email,
      phone: user.phone,
      phoneNumber: user.phone,

      role: user.role,
      isAdmin: user.isAdmin,
    };

    return next();

  } catch (err) {
    console.error("🔥 Admin Middleware Error:", err);

    return res.status(500).json({
      success: false,
      message: "Admin authorization service unavailable",
    });
  }
};