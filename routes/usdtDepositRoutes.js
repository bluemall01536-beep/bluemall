const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');

const authMiddleware = require('../middleware/authMiddleware');

const {
    USDTDeposit,
    USDTWalletSettings,
    NETWORKS,
    MIN_DEPOSIT,
} = require('../models/usdtDeposit');

const router = express.Router();

const ACTIVE_STATUSES = ['pending', 'confirming'];

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
        requestedAmount: deposit.requestedAmount,
        assignedAmount: deposit.assignedAmount,
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
                    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
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
            message: 'Deposit request created. Send the exact amount shown below.',
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
        const isAdmin =
            req.user?.isAdmin === true ||
            req.user?.role === 'admin';

        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Admin access required.',
            });
        }

        const deposits = await USDTDeposit.find({})
            .sort({ createdAt: -1 })
            .limit(200)
            .lean();

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

module.exports = router;