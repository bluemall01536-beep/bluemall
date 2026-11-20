'use strict';

const express = require('express');
const router = express.Router();

const {
    submitKyc,
    getKycStatus,
    getAllKyc,
    getKycDetails,
    approveKyc,
    rejectKyc,
} = require('../controllers/kycController');

const userAuth = require('../middleware/authMiddleware');
const { uploadKyc } = require('../middleware/uploadKyc');

// User KYC endpoints retain normal user authentication.
router.post('/submit', userAuth, uploadKyc, submitKyc);
router.get('/status', userAuth, getKycStatus);

// Admin endpoints follow the same routing pattern as the existing /api/admin
// dashboard endpoints in routes/admin.js (which currently do not apply auth).
router.get('/admin', getAllKyc);
router.get('/admin/:id', getKycDetails);
router.patch('/admin/:id/approve', approveKyc);
router.patch('/admin/:id/reject', rejectKyc);

module.exports = router;