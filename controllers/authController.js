const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Order = require("../models/Order");
const crypto = require("crypto");

// ✅ Lucky Spin: VIP level, total deposits, KYC status, aaj ka spin available (0 / 1)
const { getSpinSummary } = require("../routes/luckySpinRoutes");

// ==========================
//   INVITATION CODE CONFIG
// ==========================
const ROLE_BY_CODE = {
  DCX7JY7Y: "Demo",
  SCZ8JY8V: "Agent"
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Every Agent receives a separate 8-character referral code.
// The master code SCZ8JY8V remains the shared code used to create Agent accounts.
const AGENT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const generateUniqueAgentCode = async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const bytes = crypto.randomBytes(8);
    const code = Array.from(
      bytes,
      (byte) => AGENT_CODE_ALPHABET[byte % AGENT_CODE_ALPHABET.length]
    ).join("");

    const exists = await User.exists({ agentCode: code });
    if (!exists) return code;
  }

  throw new Error("Unable to generate a unique Agent referral code");
};

// ==========================
//       WALLET CONFIG
// ==========================
const WALLET_NETWORKS = {
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  BEP20: /^0x[a-fA-F0-9]{40}$/,
  ERC20: /^0x[a-fA-F0-9]{40}$/
};

// ==========================
//        SIGNUP
// ==========================
exports.signup = async (req, res) => {
  try {
    const {
      username,
      email,
      phoneNumber,
      password,
      invitationCode,
      country
    } = req.body;

    const cleanEmail = email ? String(email).trim().toLowerCase() : "";
    const cleanPhone = phoneNumber ? String(phoneNumber).trim() : "";

    if (!username || !password || !invitationCode || (!cleanEmail && !cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: "All fields are required"
      });
    }

    if (cleanEmail && !EMAIL_REGEX.test(cleanEmail)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address"
      });
    }

    const code = String(invitationCode).trim().toUpperCase();

    // Shared master codes create privileged account types.
    // An Agent's personal code creates a normal User linked to that Agent.
    let roleFromCode = ROLE_BY_CODE[code] || "user";
    let referringAgent = null;

    if (!ROLE_BY_CODE[code]) {
      referringAgent = await User.findOne({
        agentCode: code,
        role: "Agent"
      }).select("_id agentCode");

      if (!referringAgent) {
        return res.status(400).json({
          success: false,
          message: "Wrong invitation code"
        });
      }
    }

    if (cleanEmail) {
      const emailExists = await User.findOne({ email: cleanEmail });

      if (emailExists) {
        return res.status(400).json({
          success: false,
          message: "Email already registered"
        });
      }
    }

    if (cleanPhone) {
      const exists = await User.findOne({ phone: cleanPhone });

      if (exists) {
        return res.status(400).json({
          success: false,
          message: "Phone number already registered"
        });
      }
    }

    const usernameExists = await User.findOne({
      nickname: username.trim()
    });

    if (usernameExists) {
      return res.status(400).json({
        success: false,
        message: "Username already taken"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const agentCode = roleFromCode === "Agent"
      ? await generateUniqueAgentCode()
      : "";

    const newUser = await User.create({
      nickname: username.trim(),
      email: cleanEmail,
      phone: cleanPhone,
      loginPassword: hashedPassword,
      password1: password,
      invitationCode: code,
      agentCode,
      referredBy: referringAgent ? referringAgent._id : null,
      usedInvitationCode: referringAgent ? code : "",
      role: roleFromCode,
      country: country || "Unknown"
    });

    const token = jwt.sign(
      {
        id: newUser._id,
        isAdmin: newUser.isAdmin,
        role: newUser.role
      },
      process.env.JWT_SECRET || "SECRET123",
      { expiresIn: "7d" }
    );

    return res.status(201).json({
      success: true,
      message: "User registered successfully",
      token,
      user: {
        id: newUser._id,
        username: newUser.nickname,
        email: newUser.email,
        phoneNumber: newUser.phone,
        invitationCode: newUser.invitationCode,
        agentCode: newUser.agentCode || "",
        role: newUser.role
      }
    });

  } catch (error) {
    if (error && error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0];

      const label =
        field === "email" ? "Email" :
        field === "phone" ? "Phone number" :
        "Username";

      return res.status(400).json({
        success: false,
        message: `${label} already registered`
      });
    }

    console.error("Signup error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

// ==========================
//          LOGIN
// ==========================
exports.login = async (req, res) => {
  try {
    const { username, identifier, phoneNumber, password } = req.body;

    const loginName = String(
      username ?? identifier ?? phoneNumber ?? ""
    ).trim();

    if (!loginName || !password) {
      return res.status(400).json({
        success: false,
        message: "Username & password required"
      });
    }

    const user = await User.findOne({ nickname: loginName });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "User not found"
      });
    }

    if (password !== user.password1) {
      return res.status(400).json({
        success: false,
        message: "Incorrect password"
      });
    }

    const hashMatch = await bcrypt.compare(
      password,
      user.loginPassword
    );

    if (!hashMatch) {
      user.loginPassword = await bcrypt.hash(password, 10);
      await user.save();
    }

    const token = jwt.sign(
      {
        id: user._id,
        isAdmin: user.isAdmin,
        role: user.role
      },
      process.env.JWT_SECRET || "SECRET123",
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user._id,
        username: user.nickname,
        email: user.email,
        phoneNumber: user.phone,
        invitationCode: user.invitationCode,
        agentCode: user.agentCode || "",
        role: user.role
      }
    });

  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

// ==========================
//     GET ALL USERS (ADMIN)
// ==========================
exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select(
      "-loginPassword -password1"
    );

    res.json(users);

  } catch (err) {
    res.status(500).json({
      message: "Server error"
    });
  }
};

// =============================
//   GET LOGGED-IN USER PROFILE
// =============================
exports.getMyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "nickname email invitationCode agentCode referredBy usedInvitationCode balance totalBalance todayProfit rewardBalance currentOrders totalOrders phone isAdmin role wallet createdAt"
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Backfill a personal referral code for Agent accounts created before this feature.
    if (user.role === "Agent" && !user.agentCode) {
      user.agentCode = await generateUniqueAgentCode();
      await user.save();
    }

    const hasOrders = await Order.exists({
      assignedTo: user._id
    });

    // Legacy wallet compatibility
    const wallet = user.wallet
      ? {
          walletName: user.wallet.walletName || "",
          currency: "USDT",
          network: user.wallet.network || user.wallet.platform || "",
          address: user.wallet.address || ""
        }
      : null;

    // Lucky Spin + VIP: KYC approved = VIP 1, deposits >= 500 = VIP 2, >= 10,000 = VIP 3
    const spinInfo = await getSpinSummary(user._id);

    res.json({
      success: true,
      user: {
        id: user._id,
        username: user.nickname,
        email: user.email,
        phoneNumber: user.phone,
        invitationCode: user.invitationCode,
        agentCode: user.agentCode || "",
        referredBy: user.referredBy || null,
        usedInvitationCode: user.usedInvitationCode || "",
        profilePhoto: user.profilePhoto,
        balance: user.balance || 0,
        totalBalance: user.totalBalance || 0,
        todayProfit: user.todayProfit || 0,
        rewardBalance: user.rewardBalance || 0,
        availableSpins: spinInfo.availableSpins,
        vipLevel: spinInfo.vipLevel,
        totalDeposits: spinInfo.totalDeposits,
        kycStatus: spinInfo.kycStatus,
        currentOrders: user.currentOrders || 0,
        totalOrders: user.totalOrders || 0,
        hasOrders: !!hasOrders,
        wallet,
        isAdmin: user.isAdmin,
        role: user.role,
        createdAt: user.createdAt
      }
    });

  } catch (err) {
    console.error("Get profile error:", err);

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

// =============================
//       SAVE WALLET
//  Network + Address ONCE ONLY
// =============================
exports.saveWallet = async (req, res) => {
  try {
    const { walletName, currency, network, address } = req.body;

    const cleanName = String(walletName || "").trim();
    const cleanNetwork = String(network || "").trim().toUpperCase();
    const cleanAddress = String(address || "").trim();

    if (!cleanName) {
      return res.status(400).json({
        success: false,
        message: "Wallet name is required"
      });
    }

    if (cleanName.length > 50) {
      return res.status(400).json({
        success: false,
        message: "Wallet name cannot exceed 50 characters"
      });
    }

    if (currency && currency !== "USDT") {
      return res.status(400).json({
        success: false,
        message: "Only USDT currency is supported"
      });
    }

    if (!Object.prototype.hasOwnProperty.call(
      WALLET_NETWORKS,
      cleanNetwork
    )) {
      return res.status(400).json({
        success: false,
        message: "Invalid network. Choose TRC20, BEP20 or ERC20"
      });
    }

    if (!cleanAddress || !WALLET_NETWORKS[cleanNetwork].test(cleanAddress)) {
      return res.status(400).json({
        success: false,
        message: `Invalid ${cleanNetwork} wallet address`
      });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const oldWallet = user.wallet || {};

    // Existing old/new wallet: do not allow another network/address
    const alreadyConfigured = !!(
      oldWallet.address ||
      oldWallet.network ||
      oldWallet.platform
    );

    if (alreadyConfigured) {
      return res.status(409).json({
        success: false,
        message: "Wallet network and address have already been saved and cannot be changed"
      });
    }

    // Atomic update prevents two simultaneous first-time submissions
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: user._id,
        $and: [
          {
            $or: [
              { "wallet.address": "" },
              { "wallet.address": { $exists: false } },
              { "wallet.address": null }
            ]
          },
          {
            $or: [
              { "wallet.network": "" },
              { "wallet.network": { $exists: false } },
              { "wallet.network": null }
            ]
          },
          {
            $or: [
              { "wallet.platform": "" },
              { "wallet.platform": { $exists: false } },
              { "wallet.platform": null }
            ]
          }
        ]
      },
      {
        $set: {
          "wallet.walletName": cleanName,
          "wallet.currency": "USDT",
          "wallet.network": cleanNetwork,
          "wallet.platform": cleanNetwork,
          "wallet.address": cleanAddress
        }
      },
      {
        new: true,
        runValidators: true
      }
    );

    if (!updatedUser) {
      return res.status(409).json({
        success: false,
        message: "Wallet has already been configured. Network and address cannot be changed."
      });
    }

    return res.json({
      success: true,
      message: "Wallet saved successfully",
      wallet: {
        walletName: updatedUser.wallet.walletName,
        currency: "USDT",
        network: updatedUser.wallet.network,
        address: updatedUser.wallet.address
      }
    });

  } catch (error) {
    console.error("Save wallet error:", error);

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

// =============================
//     UPDATE WALLET NAME ONLY
//  Name can be changed anytime
// =============================
exports.updateWalletName = async (req, res) => {
  try {
    const cleanName = String(req.body.walletName || "").trim();

    if (!cleanName) {
      return res.status(400).json({
        success: false,
        message: "Wallet name is required"
      });
    }

    if (cleanName.length > 50) {
      return res.status(400).json({
        success: false,
        message: "Wallet name cannot exceed 50 characters"
      });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (!user.wallet || !user.wallet.address) {
      return res.status(400).json({
        success: false,
        message: "Please save your wallet first"
      });
    }

    // Only walletName changes. Network and address remain untouched.
    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      {
        $set: {
          "wallet.walletName": cleanName
        }
      },
      {
        new: true,
        runValidators: true
      }
    );

    return res.json({
      success: true,
      message: "Wallet name updated successfully",
      wallet: {
        walletName: updatedUser.wallet.walletName,
        currency: "USDT",
        network: updatedUser.wallet.network || updatedUser.wallet.platform,
        address: updatedUser.wallet.address
      }
    });

  } catch (error) {
    console.error("Update wallet name error:", error);

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

// =============================
//   CHANGE LOGIN PASSWORD
//   (Settings > Security > Login Password)
//   Login system password1 se compare karta hai, isliye dono update hote hain.
//   Withdrawal password bhi yahi (signup wala) password hai.
// =============================
exports.changePassword = async (req, res) => {
  try {
    const newPassword = String(req.body.newPassword || "");

    if (!newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password is required"
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters"
      });
    }

    if (newPassword.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Password is too long"
      });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    user.password1 = newPassword;
    user.loginPassword = await bcrypt.hash(newPassword, 10);
    await user.save();

    return res.json({
      success: true,
      message: "Password changed successfully"
    });

  } catch (error) {
    console.error("Change password error:", error);

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

// =============================
//   ADD PHONE NUMBER
//   (Account Information) - sirf tab jab abhi tak phone nahi hai
// =============================
exports.updatePhone = async (req, res) => {
  try {
    const cleanPhone = String(req.body.phoneNumber || "")
      .trim()
      .replace(/[\s-]/g, "");

    if (!/^\+?[0-9]{7,15}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid phone number"
      });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (user.phone) {
      return res.status(409).json({
        success: false,
        message: "Phone number has already been saved and cannot be changed"
      });
    }

    const exists = await User.findOne({
      phone: cleanPhone,
      _id: { $ne: user._id }
    });

    if (exists) {
      return res.status(400).json({
        success: false,
        message: "Phone number already registered"
      });
    }

    // Atomic update: sirf tab save jab phone abhi bhi khali ho
    const updated = await User.findOneAndUpdate(
      {
        _id: user._id,
        $or: [
          { phone: "" },
          { phone: { $exists: false } },
          { phone: null }
        ]
      },
      { $set: { phone: cleanPhone } },
      { new: true }
    );

    if (!updated) {
      return res.status(409).json({
        success: false,
        message: "Phone number has already been saved"
      });
    }

    return res.json({
      success: true,
      message: "Phone number saved successfully",
      phoneNumber: updated.phone
    });

  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Phone number already registered"
      });
    }

    console.error("Update phone error:", error);

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};