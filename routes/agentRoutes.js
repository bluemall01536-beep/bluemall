
const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");

const {
  getAgentDashboard
} = require("../controllers/agentController");

// =====================================================
// AGENT DASHBOARD ROUTE
// GET /api/agent/dashboard
// =====================================================

// Verify JWT + verify Agent role
router.get(
  "/dashboard",
  authMiddleware,
  (req, res, next) => {
    if (!req.user || req.user.role !== "Agent") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Agent account required."
      });
    }

    next();
  },
  getAgentDashboard
);

module.exports = router;