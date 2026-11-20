const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    /* ================= BASIC INFO ================= */
    nickname: {
      type: String,
      required: true,
      trim: true
    },

    // email: optional. Field hamesha rahegi (na ho to ""), unique sirf tab jab bhara ho
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: ""
    },

    // phone: optional
    phone: {
      type: String,
      trim: true,
      default: ""
    },

    loginPassword: {
      type: String,
      required: true
    },

    password1: {
      type: String
    },

    invitationCode: {
      type: String,
      required: true,
    },

    // Personal referral code issued to each Agent (8 uppercase letters/numbers).
    // The shared SCZ8JY8V master code is stored in invitationCode, not here.
    agentCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: ""
    },

    // Agent who referred this account, if signup used an Agent's personal code.
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    // Exact personal Agent code entered during signup, when applicable.
    usedInvitationCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: ""
    },

    country: {
      type: String,
      default: "Unknown"
    },

    // PROFILE PHOTO (BASE64)
    profilePhoto: {
      type: String,
      default: ""
    },

    /* ================= BALANCE ================= */
    balance: { type: Number, default: 0 },
    totalBalance: { type: Number, default: 0 },
    todayProfit: { type: Number, default: 0 },

    // Lucky Spin rewards yahan add hote hain (WalletManagement ka Reward account)
    rewardBalance: { type: Number, default: 0 },

    // Total approved deposits (optional cache). Agar deposit approve hone par yahan $inc karoge
    // to bhi theek, nahi karoge to Lucky Spin DepositRequest se khud total nikal leta hai.
    totalDeposits: { type: Number, default: 0 },

    /* ================= KYC (VIP 1 unlock) ================= */
    // KYC approve hone par "approved" set karna -> user VIP 1 ban jayega
    kycStatus: {
      type: String,
      enum: ["none", "pending", "approved", "rejected"],
      default: "none"
    },

    /* ================= ORDERS ================= */
    currentOrders: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },

    /* ================= USER WALLET ================= */
    wallet: {
      // User apna wallet name kabhi bhi update kar sakta hai
      walletName: {
        type: String,
        default: "",
        trim: true,
        maxlength: 50
      },

      // Currency fixed: USDT
      currency: {
        type: String,
        enum: ["USDT"],
        default: "USDT"
      },

      // User sirf ek network select kar sakta hai
      network: {
        type: String,
        enum: ["", "TRC20", "BEP20", "ERC20"],
        default: ""
      },

      // Selected network ka single wallet address
      address: {
        type: String,
        default: "",
        trim: true
      },

      // Legacy field: existing data / old code compatibility
      platform: {
        type: String,
        default: ""
      }
    },

    /* ================= ADMIN FLAGS ================= */
    isAdmin: {
      type: Boolean,
      default: false
    },

    // Demo aur Agent roles
    role: {
      type: String,
      enum: ["user", "admin", "Demo", "Agent"],
      default: "user"
    },

    /* ================= DEPOSIT WALLET (ADMIN CONTROL) ================= */
    depositWallet: {
      address: {
        type: String,
        default: ""
      },
      network: {
        type: String,
        default: "TRC20"
      }
    }
  },
  { timestamps: true }
);

/* ==================================================
   UNIQUE INDEX
   Sirf filled phone/email values unique hongi.
================================================== */

UserSchema.index(
  { phone: 1 },
  {
    name: "phone_unique_when_filled",
    unique: true,
    partialFilterExpression: {
      phone: { $gt: "" }
    }
  }
);

UserSchema.index(
  { email: 1 },
  {
    name: "email_unique_when_filled",
    unique: true,
    partialFilterExpression: {
      email: { $gt: "" }
    }
  }
);

// Agent referral codes must be unique; empty values are ignored for non-Agent accounts.
UserSchema.index(
  { agentCode: 1 },
  {
    name: "agent_code_unique_when_filled",
    unique: true,
    partialFilterExpression: {
      agentCode: { $gt: "" }
    }
  }
);

/* ==================================================
   AUTO SYNC: isAdmin ↔ role
   Existing functionality preserved.
================================================== */

UserSchema.pre("save", function (next) {
  if (this.isAdmin === true) {
    this.role = "admin";
  }

  next();
});

module.exports = mongoose.model("User", UserSchema);