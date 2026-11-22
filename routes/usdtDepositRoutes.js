const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');

const authMiddleware = require('../middleware/authMiddleware');
const User = require('../models/User');

const {
    USDTDeposit,
    USDTWalletSettings,
    NETWORKS,
    MIN_DEPOSIT,
} = require('../models/usdtDeposit');

const router = express.Router();

const ACTIVE_STATUSES = ['pending', 'confirming'];

// Statuses an admin may still approve / reject / edit.
// 'expired' is included so an Auto deposit that was paid after the
// 1-hour window can still be credited manually.
const REVIEWABLE_STATUSES = ['pending', 'confirming', 'review', 'expired'];

const isDemoUser = (req) => String(req.user?.role || '').toLowerCase() === 'demo';

// Auto (Customer / Agent) deposits expire after their window.
// Manual (Demo) deposits never expire.
async function expireStaleDeposits() {
    try {
        await USDTDeposit.updateMany(
            {
                mode: { $ne: 'manual' },
                status: 'pending',
                expiresAt: { $lte: new Date() },
            },
            { $set: { status: 'expired' } }
        );
    } catch (error) {
        console.error('USDT expire stale deposits error:', error);
    }
}

const getUserId = (req) => req.user?._id || req.user?.id;

// Address format per network (TRC20 = Tron base58, BEP20/ERC20 = EVM hex).
const WALLET_ADDRESS_PATTERNS = {
    TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    BEP20: /^0x[a-fA-F0-9]{40}$/,
    ERC20: /^0x[a-fA-F0-9]{40}$/,
};

// Convert USDT amount to integer micro-USDT.
function toMicroUnits(value) {
    const amount = String(value ?? '').trim();

    if (!/^\d{1,10}(\.\d{1,6})?$/.test(amount)) {
        throw new Error('Invalid amount. Maximum 6 decimal places allowed.');
    }

    const [whole, fraction = ''] = amount.split('.');

    return (
        BigInt(whole) * 1000000n +
        BigInt(fraction.padEnd(6, '0'))
    );
}

function fromMicroUnits(value) {
    const whole = value / 1000000n;
    const fraction = String(value % 1000000n).padStart(6, '0');

    return `${whole}.${fraction}`;
}

// Assigned amount format: <whole>.0<suffix>, suffix = 1..9 (e.g. 250.07).
// Built from integers/strings only; no floating-point math.
function formatAssignedAmount(wholeUnits, suffix) {
    return `${wholeUnits}.0${suffix}`;
}

// Returns the suffixes 1..9 in a cryptographically random order, so the
// first free suffix found is randomly selected.
function shuffledSuffixes() {
    const suffixes = [1, 2, 3, 4, 5, 6, 7, 8, 9];

    for (let i = suffixes.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [suffixes[i], suffixes[j]] = [suffixes[j], suffixes[i]];
    }

    return suffixes;
}

function sanitizeDeposit(deposit) {
    return {
        id: deposit._id,
        network: deposit.network,
        username: deposit.username,
        mode: deposit.mode || 'auto',
        requestedAmount: deposit.requestedAmount,
        assignedAmount: deposit.assignedAmount,
        adminAmount: deposit.adminAmount || null,
        adminNote: deposit.adminNote || '',
        reviewedAt: deposit.reviewedAt || null,
        walletAddress: deposit.walletAddress,
        status: deposit.status,
        confirmations: deposit.confirmations || 0,
        expiresAt: deposit.expiresAt,
        creditedAt: deposit.creditedAt,
        createdAt: deposit.createdAt,
        creditedAmount: deposit.creditedAmount,
        blockNumber: deposit.blockNumber,
        blockchainEventId: deposit.blockchainEventId,
    };
}

// =====================================================
// USER: CREATE DEPOSIT REQUEST
// POST /api/usdt-deposit/create
// =====================================================

router.post('/create', authMiddleware, async (req, res) => {
    try {
        const userId = getUserId(req);

        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(401).json({
                success: false,
                message: 'Please login again.',
            });
        }

        const network = String(req.body?.network || '').toUpperCase();
        const rawAmount = req.body?.amount;

        if (!NETWORKS.includes(network)) {
            return res.status(400).json({
                success: false,
                message: 'Select a valid network: TRC20, BEP20 or ERC20.',
            });
        }

        let requestedUnits;

        try {
            requestedUnits = toMicroUnits(rawAmount);
        } catch (error) {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }

        if (requestedUnits < BigInt(MIN_DEPOSIT) * 1000000n) {
            return res.status(400).json({
                success: false,
                message: `Minimum deposit is ${MIN_DEPOSIT} USDT.`,
            });
        }

        await expireStaleDeposits();

        const mode = isDemoUser(req) ? 'manual' : 'auto';

        const wallet = await USDTWalletSettings.findOne({
            network,
            isActive: true,
        }).lean();

        if (!wallet?.walletAddress) {
            return res.status(503).json({
                success: false,
                message: `Deposits on ${network} are currently unavailable.`,
            });
        }

        // Original validated amount, stored in a consistent 6-decimal format.
        const requestedAmount = fromMicroUnits(requestedUnits);

        // Explicit whole-number base: the decimal part of the user's input is
        // discarded (BigInt division) and never included in the assigned amount.
        const wholeUnits = requestedUnits / 1000000n;

        let deposit = null;

        // Try suffixes .01 - .09 in random order until a free one is found.
        for (const suffix of shuffledSuffixes()) {
            const assignedAmount = formatAssignedAmount(wholeUnits, suffix);

            const alreadyUsed = await USDTDeposit.exists({
                network,
                assignedAmount,
                status: { $in: ACTIVE_STATUSES },
            });

            if (alreadyUsed) continue;

            try {
                deposit = await USDTDeposit.create({
                    userId,
                    username: req.user?.username || req.user?.nickname || '',
                    network,
                    requestedAmount,
                    assignedAmount,
                    walletAddress: wallet.walletAddress,
                    status: 'pending',
                    mode,
                    // Demo (manual) deposits never expire.
                    expiresAt: mode === 'manual' ? null : new Date(Date.now() + 60 * 60 * 1000),
                });

                break;
            } catch (error) {
                if (error?.code === 11000) continue;
                throw error;
            }
        }

        if (!deposit) {
            return res.status(503).json({
                success: false,
                message: 'Unable to generate a unique deposit amount. Please try again.',
            });
        }

        return res.status(201).json({
            success: true,
            message: mode === 'manual'
                ? 'Deposit request created. Send the exact amount shown below.'
                : 'Deposit request created. Send the exact amount shown below. Balance is added automatically after payment.',
            deposit: sanitizeDeposit(deposit),
            instructions: {
                currency: 'USDT',
                network,
                amountToSend: deposit.assignedAmount,
                walletAddress: deposit.walletAddress,
                expiresAt: deposit.expiresAt,
                warning: 'Send only USDT on the selected network. Sending on another network may result in permanent loss.',
            },
        });

    } catch (error) {
        console.error('USDT create deposit error:', error);

        return res.status(500).json({
            success: false,
            message: 'Unable to create deposit request.',
        });
    }
});

// =====================================================
// USER: GET MY DEPOSIT HISTORY
// GET /api/usdt-deposit/my
// =====================================================

router.get('/my', authMiddleware, async (req, res) => {
    try {
        const userId = getUserId(req);

        await expireStaleDeposits();

        const deposits = await USDTDeposit.find({ userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        return res.json({
            success: true,
            deposits: deposits.map(sanitizeDeposit),
        });

    } catch (error) {
        console.error('USDT deposit history error:', error);

        return res.status(500).json({
            success: false,
            message: 'Unable to load deposit history.',
        });
    }
});

// =====================================================
// ADMIN: LIST ALL NETWORK WALLETS
// GET /api/usdt-deposit/admin/wallets
// Requires an authenticated (logged-in) session. No role check.
// =====================================================

router.get(
    '/admin/wallets',
    authMiddleware,
    async (req, res) => {
        try {
            const saved = await USDTWalletSettings.find({
                network: { $in: NETWORKS },
            })
                .select('network walletAddress isActive')
                .lean();

            // Always return every network in canonical order
            // (TRC20, BEP20, ERC20). Networks with no saved record yet
            // come back with an empty address and isActive: false.
            const wallets = NETWORKS.map((network) => {
                const record = saved.find((item) => item.network === network);

                return {
                    network,
                    walletAddress: record?.walletAddress || '',
                    isActive: Boolean(record?.walletAddress) && record?.isActive === true,
                };
            });

            // Wallet addresses must always be read fresh from MongoDB.
            res.set('Cache-Control', 'no-store');

            return res.json({
                success: true,
                wallets,
            });

        } catch (error) {
            console.error('USDT wallet list error:', error);

            return res.status(500).json({
                success: false,
                message: 'Unable to load deposit wallets.',
            });
        }
    }
);

// =====================================================
// ADMIN: SET / UPDATE NETWORK WALLET
// PUT /api/usdt-deposit/admin/wallet/:network
// Requires an authenticated (logged-in) session. No role check.
// =====================================================

router.put(
    '/admin/wallet/:network',
    authMiddleware,
    async (req, res) => {
        try {
            const network = String(req.params.network || '').toUpperCase();
            const walletAddress = String(req.body?.walletAddress || '').trim();

            if (!NETWORKS.includes(network)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid network.',
                });
            }

            if (!walletAddress || walletAddress.length > 150) {
                return res.status(400).json({
                    success: false,
                    message: 'Enter a valid wallet address.',
                });
            }

            const pattern = WALLET_ADDRESS_PATTERNS[network];

            if (pattern && !pattern.test(walletAddress)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid ${network} wallet address format.`,
                });
            }

            const settings = await USDTWalletSettings.findOneAndUpdate(
                { network },
                {
                    $set: {
                        walletAddress,
                        isActive: true,
                        updatedBy: getUserId(req),
                    },
                },
                {
                    new: true,
                    upsert: true,
                    runValidators: true,
                    setDefaultsOnInsert: true,
                }
            );

            return res.json({
                success: true,
                message: `${network} deposit wallet updated.`,
                wallet: {
                    network: settings.network,
                    walletAddress: settings.walletAddress,
                    isActive: settings.isActive,
                },
            });

        } catch (error) {
            console.error('USDT wallet update error:', error);

            if (error?.name === 'ValidationError') {
                return res.status(400).json({
                    success: false,
                    message: error.message || 'Invalid wallet data.',
                });
            }

            return res.status(500).json({
                success: false,
                message: 'Unable to update deposit wallet.',
            });
        }
    }
);

// =====================================================
// ADMIN: VIEW ALL DEPOSITS
// GET /api/usdt-deposit/admin/all
// =====================================================

router.get('/admin/all', authMiddleware, async (req, res) => {
    try {
        await expireStaleDeposits();

        const filter = {};

        const status = String(req.query?.status || '').toLowerCase();
        const mode = String(req.query?.mode || '').toLowerCase();

        if (status === 'active') {
            filter.status = { $in: ['pending', 'confirming', 'review', 'expired'] };
        } else if (status === 'history') {
            filter.status = { $in: ['completed', 'rejected'] };
        } else if (status) {
            filter.status = status;
        }

        if (mode === 'auto') filter.mode = { $ne: 'manual' };
        if (mode === 'manual') filter.mode = 'manual';

        const deposits = await USDTDeposit.find(filter)
            .sort({ createdAt: -1 })
            .limit(200)
            .lean();

        res.set('Cache-Control', 'no-store');

        return res.json({
            success: true,
            deposits: deposits.map(sanitizeDeposit),
        });

    } catch (error) {
        console.error('USDT admin deposits error:', error);

        return res.status(500).json({
            success: false,
            message: 'Unable to load deposits.',
        });
    }
});

// =====================================================
// ADMIN: DASHBOARD STATS
// GET /api/usdt-deposit/admin/stats
// totalDeposits   = sum of credited amounts of all completed (approved) deposits
// pendingDeposits = deposits still waiting (pending / confirming / review)
// =====================================================

router.get('/admin/stats', authMiddleware, async (req, res) => {
    try {
        await expireStaleDeposits();

        const [completed] = await USDTDeposit.aggregate([
            { $match: { status: 'completed' } },
            {
                $group: {
                    _id: null,
                    total: {
                        $sum: { $toDouble: { $ifNull: ['$creditedAmount', '0'] } },
                    },
                },
            },
        ]);

        const pendingDeposits = await USDTDeposit.countDocuments({
            status: { $in: ['pending', 'confirming', 'review'] },
        });

        res.set('Cache-Control', 'no-store');

        return res.json({
            success: true,
            stats: {
                totalDeposits: Math.round((completed?.total || 0) * 100) / 100,
                pendingDeposits,
            },
        });

    } catch (error) {
        console.error('USDT admin stats error:', error);

        return res.status(500).json({
            success: false,
            message: 'Unable to load deposit stats.',
        });
    }
});

// =====================================================
// ADMIN: EDIT DEPOSIT AMOUNT
// PATCH /api/usdt-deposit/admin/:id/amount
// Body: { amount: "150.5", note?: "..." }
// The edited amount is what gets credited when the deposit is approved.
// =====================================================

router.patch('/admin/:id/amount', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid deposit id.' });
        }

        let units;

        try {
            units = toMicroUnits(req.body?.amount);
        } catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }

        if (units <= 0n) {
            return res.status(400).json({ success: false, message: 'Amount must be greater than 0.' });
        }

        const update = { adminAmount: fromMicroUnits(units) };

        if (typeof req.body?.note === 'string') {
            update.adminNote = req.body.note.trim().slice(0, 300);
        }

        const deposit = await USDTDeposit.findOneAndUpdate(
            { _id: id, status: { $in: REVIEWABLE_STATUSES } },
            { $set: update },
            { new: true }
        ).lean();

        if (!deposit) {
            return res.status(409).json({
                success: false,
                message: 'Deposit not found or already processed.',
            });
        }

        return res.json({
            success: true,
            message: 'Deposit amount updated.',
            deposit: sanitizeDeposit(deposit),
        });

    } catch (error) {
        console.error('USDT edit amount error:', error);

        return res.status(500).json({ success: false, message: 'Unable to update amount.' });
    }
});

// =====================================================
// ADMIN: APPROVE DEPOSIT (credits user balance)
// POST /api/usdt-deposit/admin/:id/approve
// Body (optional): { amount: "150.5", note?: "..." }
// Amount credited = body.amount, else admin-edited amount, else requested amount.
// Deposit status change and balance credit happen in one transaction, and
// the status guard makes sure the balance is credited only once even if the
// scanner and admin act at the same time.
// =====================================================

router.post('/admin/:id/approve', authMiddleware, async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: 'Invalid deposit id.' });
    }

    const session = await mongoose.startSession();

    try {
        let result = null;
        let failure = null;

        await session.withTransaction(async () => {
            result = null;
            failure = null;

            const current = await USDTDeposit.findOne({
                _id: id,
                status: { $in: REVIEWABLE_STATUSES },
            }).session(session);

            if (!current) {
                failure = { code: 409, message: 'Deposit not found or already processed.' };
                return;
            }

            let units;

            try {
                units = toMicroUnits(
                    req.body?.amount ?? current.adminAmount ?? current.requestedAmount
                );
            } catch (error) {
                failure = { code: 400, message: error.message };
                return;
            }

            if (units <= 0n) {
                failure = { code: 400, message: 'Amount must be greater than 0.' };
                return;
            }

            const creditedAmount = fromMicroUnits(units);
            const numericAmount = Number(creditedAmount);

            const set = {
                status: 'completed',
                creditedAmount,
                adminAmount: creditedAmount,
                creditedAt: new Date(),
                reviewedBy: getUserId(req),
                reviewedAt: new Date(),
            };

            if (typeof req.body?.note === 'string') {
                set.adminNote = req.body.note.trim().slice(0, 300);
            }

            const claimed = await USDTDeposit.findOneAndUpdate(
                { _id: id, status: { $in: REVIEWABLE_STATUSES } },
                { $set: set },
                { new: true, session }
            );

            if (!claimed) {
                failure = { code: 409, message: 'Deposit already processed.' };
                return;
            }

            const updatedUser = await User.updateOne(
                { _id: claimed.userId },
                { $inc: { balance: numericAmount, totalBalance: numericAmount } },
                { session }
            );

            if (updatedUser.modifiedCount !== 1) {
                throw new Error('User balance update failed');
            }

            result = claimed.toObject();
        });

        if (failure) {
            return res.status(failure.code).json({ success: false, message: failure.message });
        }

        return res.json({
            success: true,
            message: 'Deposit approved and balance credited.',
            deposit: sanitizeDeposit(result),
        });

    } catch (error) {
        console.error('USDT approve deposit error:', error);

        return res.status(500).json({ success: false, message: 'Unable to approve deposit.' });
    } finally {
        await session.endSession();
    }
});

// =====================================================
// ADMIN: REJECT DEPOSIT
// POST /api/usdt-deposit/admin/:id/reject
// Body (optional): { note?: "..." }
// =====================================================

router.post('/admin/:id/reject', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid deposit id.' });
        }

        const set = {
            status: 'rejected',
            reviewedBy: getUserId(req),
            reviewedAt: new Date(),
        };

        if (typeof req.body?.note === 'string') {
            set.adminNote = req.body.note.trim().slice(0, 300);
        }

        const deposit = await USDTDeposit.findOneAndUpdate(
            { _id: id, status: { $in: REVIEWABLE_STATUSES } },
            { $set: set },
            { new: true }
        ).lean();

        if (!deposit) {
            return res.status(409).json({
                success: false,
                message: 'Deposit not found or already processed.',
            });
        }

        return res.json({
            success: true,
            message: 'Deposit rejected.',
            deposit: sanitizeDeposit(deposit),
        });

    } catch (error) {
        console.error('USDT reject deposit error:', error);

        return res.status(500).json({ success: false, message: 'Unable to reject deposit.' });
    }
});

module.exports = router;