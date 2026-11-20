'use strict';

const mongoose = require('mongoose');

const supportMessageSchema = new mongoose.Schema(
    {
        // Conversation this message belongs to.
        conversationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'SupportConversation',
            required: true,
            index: true,
        },

        // Username displayed in the admin support panel.
        username: {
            type: String,
            required: true,
            trim: true,
            maxlength: 100,
        },

        // Normalized username for case-insensitive lookup.
        usernameKey: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
            index: true,
        },

        // Existing invitation code.
        invitationCode: {
            type: String,
            trim: true,
            default: '',
            index: true,
        },

        // Actual message content.
        message: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 5000,
        },

        // Message sender.
        sender: {
            type: String,
            enum: ['user', 'admin', 'system'],
            required: true,
            default: 'user',
            index: true,
        },

        // Message delivery/read status.
        status: {
            type: String,
            enum: [
                'sent',
                'delivered',
                'read',
                'replied',
            ],
            default: 'sent',
            index: true,
        },

        // Legacy session support.
        // Kept for compatibility with the existing frontend.
        sessionId: {
            type: String,
            default: '',
            trim: true,
        },

        // Optional admin who sent the reply.
        adminId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        // Optional metadata for future attachments.
        attachments: {
            type: [
                {
                    url: {
                        type: String,
                        required: true,
                        trim: true,
                    },
                    publicId: {
                        type: String,
                        default: '',
                        trim: true,
                    },
                    resourceType: {
                        type: String,
                        default: 'image',
                        trim: true,
                    },
                    fileName: {
                        type: String,
                        trim: true,
                    },
                    mimeType: {
                        type: String,
                        trim: true,
                    },
                    size: {
                        type: Number,
                        min: 0,
                    },
                },
            ],
            default: [],
        },

        // Optional message edit timestamp.
        editedAt: {
            type: Date,
            default: null,
        },

        // Optional soft-delete timestamp.
        deletedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);


// ======================================================
// NORMALIZE USERNAME BEFORE VALIDATION
// ======================================================

supportMessageSchema.pre('validate', function (next) {
    if (this.username) {
        this.username = this.username.trim();
        this.usernameKey = this.username.toLowerCase();
    }

    next();
});


// ======================================================
// INDEXES
// ======================================================

// Fetch all messages of a conversation in chronological order.
supportMessageSchema.index({
    conversationId: 1,
    createdAt: 1,
});

// Admin inbox message lookup.
supportMessageSchema.index({
    usernameKey: 1,
    createdAt: -1,
});

// Filter messages by sender.
supportMessageSchema.index({
    conversationId: 1,
    sender: 1,
    createdAt: 1,
});

// Invitation code lookup for legacy compatibility.
supportMessageSchema.index({
    invitationCode: 1,
    createdAt: 1,
});


// ======================================================
// MODEL
// ======================================================

const SupportMessage = mongoose.model(
    'SupportMessage',
    supportMessageSchema
);

module.exports = SupportMessage;