'use strict';

const mongoose = require('mongoose');

const SupportMessage = require('../models/SupportMessage');
const SupportConversation = require('../models/SupportConversation');
const SupportSettings = require('../models/SupportSettings');
const cloudinary = require('../config/cloudinary');

const {
    emitToAdmins,
    emitToUser,
    emitToConversation,
} = require('../config/socket');


// ======================================================
// HELPERS
// ======================================================

const normalizeUsername = (username) =>
    String(username || '').trim().toLowerCase();

const getUsername = (username) =>
    String(username || '').trim();

const getAdminId = (req) =>
    req.user?._id || req.user?.id || null;

const escapeRegex = (value) =>
    String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');



// Upload validated image buffers to Cloudinary. The returned URLs are saved
// in MongoDB, so both sides load the same persistent attachments.
const uploadChatImages = async (files = []) => {
    if (!files.length) return [];

    return Promise.all(files.map((file) => new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: 'support-chat',
                resource_type: 'image',
                transformation: [{ quality: 'auto', fetch_format: 'auto' }],
            },
            (error, result) => {
                if (error) return reject(error);
                resolve({
                    url: result.secure_url,
                    publicId: result.public_id,
                    resourceType: result.resource_type || 'image',
                    fileName: file.originalname,
                    mimeType: file.mimetype,
                    size: file.size,
                });
            }
        );

        stream.end(file.buffer);
    })));
};

const getChatPreview = (message, attachments = []) =>
    message || (attachments.length ? '📷 Photo' : '');

// Find conversations by normalized username.
// The second condition supports older records without usernameKey.
const findConversationsByUsername = async (username) => {
    const cleanUsername = getUsername(username);
    const usernameKey = normalizeUsername(cleanUsername);

    if (!usernameKey) return [];

    return SupportConversation.find({
        $or: [
            { usernameKey },
            {
                username: {
                    $regex: `^${escapeRegex(cleanUsername)}$`,
                    $options: 'i',
                },
            },
        ],
    }).sort({ lastMessageAt: -1, createdAt: -1 });
};


// Fetch messages from all matching conversations, including legacy messages
// which were saved before conversationId was introduced.
const findMessagesForUsername = async (username, conversations = []) => {
    const cleanUsername = getUsername(username);
    const usernameKey = normalizeUsername(cleanUsername);

    const conversationIds = conversations
        .map((conversation) => conversation._id)
        .filter(Boolean);

    const conditions = [];

    if (conversationIds.length) {
        conditions.push({
            conversationId: { $in: conversationIds },
        });
    }

    // Legacy records may not contain conversationId or usernameKey.
    conditions.push({
        conversationId: { $exists: false },
        $or: [
            { usernameKey },
            {
                username: {
                    $regex: `^${escapeRegex(cleanUsername)}$`,
                    $options: 'i',
                },
            },
            ...(conversations
                .map((conversation) => conversation.invitationCode)
                .filter(Boolean)
                .map((invitationCode) => ({ invitationCode }))),
        ],
    });

    return SupportMessage.find({
        $or: conditions,
    }).sort({ createdAt: 1, _id: 1 });
};


// Find or create a conversation using username.
const findOrCreateConversation = async ({
    username,
    invitationCode = '',
    userId = null,
}) => {
    const cleanUsername = getUsername(username);
    const usernameKey = normalizeUsername(cleanUsername);

    if (!usernameKey) {
        throw new Error('Username is required');
    }

    let conversation = await SupportConversation.findOne({
        usernameKey,
    });

    if (!conversation) {
        try {
            conversation = await SupportConversation.create({
                username: cleanUsername,
                usernameKey,
                userId,
                invitationCode,
                status: 'open',
                lastMessage: '',
                lastMessageSender: 'system',
                lastMessageAt: new Date(),
            });
        } catch (error) {
            if (error.code === 11000) {
                conversation = await SupportConversation.findOne({
                    usernameKey,
                });
            } else {
                throw error;
            }
        }
    }

    if (!conversation) {
        throw new Error('Unable to create support conversation');
    }

    const updates = {};

    if (invitationCode && !conversation.invitationCode) {
        updates.invitationCode = invitationCode;
    }

    if (userId && !conversation.userId) {
        updates.userId = userId;
    }

    if (Object.keys(updates).length) {
        conversation = await SupportConversation.findByIdAndUpdate(
            conversation._id,
            { $set: updates },
            { new: true }
        );
    }

    return conversation;
};


// Update conversation preview and unread counters.
const updateConversationAfterMessage = async (
    conversation,
    message,
    sender
) => {
    const update = {
        lastMessage: message,
        lastMessageSender: sender,
        lastMessageAt: new Date(),
        status: 'open',
    };

    if (sender === 'user') {
        update.$inc = { unreadByAdmin: 1 };
    } else if (sender === 'admin') {
        update.$inc = { unreadByUser: 1 };
    }

    return SupportConversation.findByIdAndUpdate(
        conversation._id,
        update,
        { new: true }
    );
};


// ======================================================
// SUPPORT SETTINGS
// Existing functionality preserved.
// ======================================================

// GET SUPPORT SETTINGS
exports.getSupportSettings = async (req, res) => {
    try {
        let settings = await SupportSettings.findOne();

        if (!settings) {
            settings = await SupportSettings.create({});
        }

        return res.json({
            success: true,
            settings,
        });
    } catch (error) {
        console.error('getSupportSettings error:', error);

        return res.status(500).json({
            success: false,
            message: 'Server error',
        });
    }
};


// UPDATE SUPPORT SETTINGS
exports.updateSupportSettings = async (req, res) => {
    try {
        const { telegramLink, telegramUsername } = req.body;

        let settings = await SupportSettings.findOne();

        if (!settings) {
            settings = await SupportSettings.create({});
        }

        settings.telegramLink =
            telegramLink !== undefined
                ? telegramLink
                : settings.telegramLink;

        settings.telegramUsername =
            telegramUsername !== undefined
                ? telegramUsername
                : settings.telegramUsername;

        await settings.save();

        return res.json({
            success: true,
            message: 'Support settings updated successfully',
            settings,
        });
    } catch (error) {
        console.error('updateSupportSettings error:', error);

        return res.status(500).json({
            success: false,
            message: 'Server error',
        });
    }
};


// ======================================================
// USER SEND MESSAGE
// ======================================================

exports.sendMessage = async (req, res) => {
    try {
        const {
            username,
            inviteCode,
            invitationCode,
            message,
            sessionId,
        } = req.body;

        const cleanUsername = getUsername(username);
        const cleanMessage = String(message || '').trim();
        const code = invitationCode || inviteCode || '';

        if (!cleanUsername) {
            return res.status(400).json({
                success: false,
                message: 'Username is required',
            });
        }

        if (!cleanMessage && !(req.files || []).length) {
            return res.status(400).json({
                success: false,
                message: 'Write a message or attach at least one image',
            });
        }

        if (cleanMessage.length > 5000) {
            return res.status(400).json({
                success: false,
                message: 'Message is too long',
            });
        }

        const conversation = await findOrCreateConversation({
            username: cleanUsername,
            invitationCode: code,
            userId: req.user?._id || req.user?.id || null,
        });

        const attachments = await uploadChatImages(req.files || []);

        const newMessage = await SupportMessage.create({
            conversationId: conversation._id,
            username: conversation.username,
            usernameKey: conversation.usernameKey,
            invitationCode: conversation.invitationCode || code,
            message: cleanMessage,
            attachments,
            sender: 'user',
            status: 'sent',
            sessionId: sessionId || '',
        });

        const updatedConversation =
            await updateConversationAfterMessage(
                conversation,
                getChatPreview(cleanMessage, attachments),
                'user'
            );

        emitToAdmins('support:new-message', {
            message: newMessage,
            conversation: updatedConversation,
        });

        emitToConversation(
            conversation._id.toString(),
            'support:new-message',
            newMessage
        );

        return res.status(201).json({
            success: true,
            message: 'Message sent successfully',
            data: newMessage,
            conversation: updatedConversation,
        });

    } catch (error) {
        console.error('sendMessage error:', error);

        return res.status(500).json({
            success: false,
            message: 'Failed to send message',
        });
    }
};


// ======================================================
// USER FETCH CHAT BY USERNAME
// Includes old messages and new messages.
// ======================================================

exports.getUserMessages = async (req, res) => {
    try {
        const username =
            req.params.username || req.params.invitationCode;

        const usernameKey = normalizeUsername(username);

        if (!usernameKey) {
            return res.status(400).json({
                success: false,
                message: 'Username is required',
            });
        }

        const conversations = await findConversationsByUsername(username);

        if (!conversations.length) {
            return res.json({
                success: true,
                conversation: null,
                conversations: [],
                messages: [],
            });
        }

        const messages = await findMessagesForUsername(
            username,
            conversations
        );

        const conversation = conversations[0];

        await SupportConversation.updateMany(
            { _id: { $in: conversations.map((item) => item._id) } },
            {
                $set: {
                    unreadByUser: 0,
                    userLastSeenAt: new Date(),
                },
            }
        );

        return res.json({
            success: true,
            conversation,
            conversations,
            messages,
        });

    } catch (error) {
        console.error('getUserMessages error:', error);

        return res.status(500).json({
            success: false,
            message: 'Failed to load messages',
        });
    }
};


// ======================================================
// ADMIN GET ALL CONVERSATIONS
// One inbox entry per username.
// ======================================================

exports.getAllMessages = async (req, res) => {
    try {
        const allConversations = await SupportConversation.find()
            .sort({ lastMessageAt: -1, createdAt: -1 })
            .lean();

        // Deduplicate by usernameKey.
        // Keep the latest conversation for each username.
        const uniqueConversations = new Map();

        for (const conversation of allConversations) {
            const usernameKey =
                normalizeUsername(conversation.usernameKey || conversation.username);

            if (!usernameKey) continue;

            if (!uniqueConversations.has(usernameKey)) {
                uniqueConversations.set(usernameKey, conversation);
            }
        }

        const conversations = Array.from(uniqueConversations.values());

        return res.json({
            success: true,
            conversations,
        });

    } catch (error) {
        console.error('getAllMessages error:', error);

        return res.status(500).json({
            success: false,
            message: 'Failed to fetch conversations',
        });
    }
};


// ======================================================
// ADMIN FETCH ONE CONVERSATION
// Fetches BOTH user and admin messages.
// Also includes legacy messages.
// ======================================================

exports.getConversationMessages = async (req, res) => {
    try {
        const username = req.params.username;
        const usernameKey = normalizeUsername(username);

        if (!usernameKey) {
            return res.status(400).json({
                success: false,
                message: 'Username is required',
            });
        }

        const conversations = await findConversationsByUsername(username);

        if (!conversations.length) {
            return res.status(404).json({
                success: false,
                message: 'Conversation not found',
            });
        }

        const messages = await findMessagesForUsername(
            username,
            conversations
        );

        await SupportConversation.updateMany(
            { _id: { $in: conversations.map((item) => item._id) } },
            {
                $set: {
                    unreadByAdmin: 0,
                    adminLastSeenAt: new Date(),
                },
            }
        );

        return res.json({
            success: true,
            conversation: conversations[0],
            conversations,
            messages,
        });

    } catch (error) {
        console.error('getConversationMessages error:', error);

        return res.status(500).json({
            success: false,
            message: 'Failed to fetch conversation',
        });
    }
};


// ======================================================
// ADMIN REPLY
// Saves admin reply in the SAME conversation.
// ======================================================

exports.replyMessage = async (req, res) => {
    try {
        const {
            username,
            message,
            conversationId,
            invitationCode,
        } = req.body;

        const cleanMessage = String(message || '').trim();

        if (!cleanMessage && !(req.files || []).length) {
            return res.status(400).json({
                success: false,
                message: 'Write a reply or attach at least one image',
            });
        }

        if (cleanMessage.length > 5000) {
            return res.status(400).json({
                success: false,
                message: 'Reply is too long',
            });
        }

        let conversation = null;

        if (
            conversationId &&
            mongoose.isValidObjectId(conversationId)
        ) {
            conversation = await SupportConversation.findById(
                conversationId
            );
        }

        if (!conversation && username) {
            conversation = await SupportConversation.findOne({
                usernameKey: normalizeUsername(username),
            });
        }

        if (!conversation) {
            return res.status(404).json({
                success: false,
                message: 'Conversation not found',
            });
        }

        const adminId = getAdminId(req);
        const attachments = await uploadChatImages(req.files || []);

        const reply = await SupportMessage.create({
            conversationId: conversation._id,
            username: conversation.username,
            usernameKey: conversation.usernameKey ||
                normalizeUsername(conversation.username),
            invitationCode:
                conversation.invitationCode || invitationCode || '',
            message: cleanMessage,
            attachments,
            sender: 'admin',
            status: 'delivered',
            sessionId: '',
            adminId: adminId || null,
        });

        const updatedConversation =
            await updateConversationAfterMessage(
                conversation,
                getChatPreview(cleanMessage, attachments),
                'admin'
            );

        if (adminId) {
            await SupportConversation.findByIdAndUpdate(
                conversation._id,
                {
                    $set: {
                        assignedAdmin: adminId,
                    },
                }
            );
        }

        emitToConversation(
            conversation._id.toString(),
            'support:new-message',
            reply
        );

        if (conversation.userId) {
            emitToUser(
                conversation.userId.toString(),
                'support:new-message',
                reply
            );
        }

        emitToAdmins('support:conversation-updated', {
            conversation: updatedConversation,
            message: reply,
        });

        return res.json({
            success: true,
            message: 'Reply sent successfully',
            data: reply,
            conversation: updatedConversation,
        });

    } catch (error) {
        console.error('replyMessage error:', error);

        return res.status(500).json({
            success: false,
            message: 'Failed to send reply',
        });
    }
};


// ======================================================
// ADMIN CLOSE CONVERSATION
// ======================================================

exports.closeConversation = async (req, res) => {
    try {
        const { conversationId } = req.params;

        if (!mongoose.isValidObjectId(conversationId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid conversation ID',
            });
        }

        const conversation = await SupportConversation.findByIdAndUpdate(
            conversationId,
            {
                $set: {
                    status: 'closed',
                },
            },
            { new: true }
        );

        if (!conversation) {
            return res.status(404).json({
                success: false,
                message: 'Conversation not found',
            });
        }

        emitToAdmins('support:conversation-updated', {
            conversation,
        });

        emitToConversation(
            conversation._id.toString(),
            'support:conversation-closed',
            conversation
        );

        return res.json({
            success: true,
            message: 'Conversation closed successfully',
            conversation,
        });

    } catch (error) {
        console.error('closeConversation error:', error);

        return res.status(500).json({
            success: false,
            message: 'Failed to close conversation',
        });
    }
};


// ======================================================
// ADMIN REOPEN CONVERSATION
// ======================================================

exports.reopenConversation = async (req, res) => {
    try {
        const { conversationId } = req.params;

        if (!mongoose.isValidObjectId(conversationId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid conversation ID',
            });
        }

        const conversation = await SupportConversation.findByIdAndUpdate(
            conversationId,
            {
                $set: {
                    status: 'open',
                },
            },
            { new: true }
        );

        if (!conversation) {
            return res.status(404).json({
                success: false,
                message: 'Conversation not found',
            });
        }

        emitToAdmins('support:conversation-updated', {
            conversation,
        });

        emitToConversation(
            conversation._id.toString(),
            'support:conversation-reopened',
            conversation
        );

        return res.json({
            success: true,
            message: 'Conversation reopened successfully',
            conversation,
        });

    } catch (error) {
        console.error('reopenConversation error:', error);

        return res.status(500).json({
            success: false,
            message: 'Failed to reopen conversation',
        });
    }
};