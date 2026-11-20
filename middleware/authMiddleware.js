
const jwt = require("jsonwebtoken");
const User = require("../models/User");

module.exports = async function authMiddleware(req, res, next) {
  try {
    // ================================
    //       JWT SECRET VALIDATION
    // ================================
    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      console.error("❌ JWT_SECRET is missing in environment variables");

      return res.status(500).json({
        success: false,
        message: "Authentication configuration error",
      });
    }

    // ================================
    //       AUTHORIZATION HEADER
    // ================================
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: "Authentication required. Please login.",
      });
    }

    const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/i);

    if (!bearerMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid authorization format. Use Bearer token.",
      });
    }

    const token = bearerMatch[1];

    // ================================
    //          VERIFY JWT
    // ================================
    let decoded;

    try {
      decoded = jwt.verify(token, jwtSecret, {
        algorithms: ["HS256"],
      });
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({
          success: false,
          message: "Session expired. Please login again.",
        });
      }

      return res.status(401).json({
        success: false,
        message: "Invalid or expired token. Please login again.",
      });
    }

    if (!decoded || !decoded.id) {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token.",
      });
    }

    // ================================
    //          FETCH USER
    // ================================
    const user = await User.findById(decoded.id).select(
      "_id nickname phone email invitationCode balance wallet isAdmin role kycStatus"
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User account not found.",
      });
    }

    // ================================
    //          SET REQ.USER
    // ================================
    req.user = {
      id: user._id,
      _id: user._id,

      username: user.nickname,
      nickname: user.nickname,

      phoneNumber: user.phone,
      phone: user.phone,

      email: user.email,
      invitationCode: user.invitationCode,

      balance: user.balance,
      wallet: user.wallet,

      isAdmin: user.isAdmin,
      role: user.role,

      kycStatus: user.kycStatus,
    };

    // ================================
    //          CONTINUE REQUEST
    // ================================
    return next();

  } catch (err) {
    console.error("🔥 Auth Middleware Error:", err);

    return res.status(500).json({
      success: false,
      message: "Authentication service temporarily unavailable.",
    });
  }
};