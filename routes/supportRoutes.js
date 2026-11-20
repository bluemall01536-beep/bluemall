'use strict';

const express = require('express');
const multer = require('multer');

const router = express.Router();

const {
    // Support settings
    getSupportSettings,
    updateSupportSettings,

    // User chat
    sendMessage,
    getUserMessages,

    // Admin chat
    getAllMessages,
    getConversationMessages,
    replyMessage,
    closeConversation,
    reopenConversation,
} = require('../controllers/supportController');

// Store files in memory temporarily; supportController uploads them to
// Cloudinary and stores only the Cloudinary metadata/URL in MongoDB.
const chatImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5 MB per image
        files: 5,
    },
    fileFilter: (req, file, callback) => {
        if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/.test(file.mimetype)) {
            const error = new Error('Only JPG, PNG, WEBP, GIF and HEIC images are allowed');
            error.status = 400;
            return callback(error);
        }
        callback(null, true);
    },
});

// ======================================
// SUPPORT SETTINGS
// ======================================

router.get('/', getSupportSettings);
router.put('/update', updateSupportSettings);

// ======================================
// USER SUPPORT CHAT
// ======================================

// Send text, images, or both.
// FormData fields: username, message, invitationCode, sessionId, images[]
router.post('/send-message', chatImageUpload.array('images', 5), sendMessage);

router.get('/user-messages/:username', getUserMessages);

// ======================================
// ADMIN LIVE CHAT
// ======================================

router.get('/all-messages', getAllMessages);
router.get('/conversation/:username', getConversationMessages);

// Admin can send text, images, or both using the same "images" field.
router.post('/reply-message', chatImageUpload.array('images', 5), replyMessage);

router.patch('/conversation/:conversationId/close', closeConversation);
router.patch('/conversation/:conversationId/reopen', reopenConversation);

// Multer/file validation errors for these routes.
router.use((error, req, res, next) => {
    if (error instanceof multer.MulterError || error.status === 400) {
        return res.status(error.status || 400).json({
            success: false,
            message: error.message || 'Image upload failed',
        });
    }
    return next(error);
});

module.exports = router;