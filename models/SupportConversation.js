'use strict';

const mongoose = require('mongoose');

const supportConversationSchema = new mongoose.Schema(
    {
        // Username is the primary identity for chat history.
        username: {
            type: String,
            trim: true,
            required: true,
            minlength: 1,
            maxlength: 100,
        },

        // Normalized username used for unique lookup.
        // Shadow, shadow and SHADOW will be treated as the same username.
        usernameKey: {
            type: String,
            trim: true,
            lowercase: true,
            required: true,
        },

        // Logged-in user reference (optional).
        // Username remains the primary chat identity.
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            index: true,
        },

        // Existing invitation code associated with the user's chat.
        invitationCode: {
            type: String,
            trim: true,
            default: '',
            index: true,
        },

        // Latest message preview for the admin conversation list.
        lastMessage: {
            type: String,
            trim: true,
            default: '',
            maxlength: 5000,
        },

        // Who sent the latest message.
        lastMessageSender: {
            type: String,
            enum: ['user', 'admin', 'system'],
            default: 'system',
        },

        // Timestamp of the latest message.
        lastMessageAt: {
            type: Date,
            default: Date.now,
            index: true,
        },

        // Number of user messages not yet seen by admin.
        unreadByAdmin: {
            type: Number,
            default: 0,
            min: 0,
        },

        // Number of admin messages not yet seen by the user.
        unreadByUser: {
            type: Number,
            default: 0,
            min: 0,
        },

        // Conversation lifecycle.
        status: {
            type: String,
            enum: ['open', 'closed'],
            default: 'open',
            index: true,
        },

        // Optional admin who last handled the conversation.
        assignedAdmin: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        // Last time the conversation was opened by admin.
        adminLastSeenAt: {
            type: Date,
            default: null,
        },

        // Last time the conversation was opened by the user.
        userLastSeenAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

// Automatically generate normalized username before validation.
supportConversationSchema.pre('validate', function (next) {
    if (this.username) {
        this.username = this.username.trim();
        this.usernameKey = this.username.toLowerCase();
    }

    next();
});

// One conversation per username.
supportConversationSchema.index(
    { usernameKey: 1 },
    {
        unique: true,
        name: 'unique_support_username',
    }
);

// Efficient admin inbox sorting.
supportConversationSchema.index({
    status: 1,
    lastMessageAt: -1,
});

// Efficient lookup using invitation code.
supportConversationSchema.index({
    invitationCode: 1,
    lastMessageAt: -1,
});

// Efficient lookup using username.
supportConversationSchema.index({
    usernameKey: 1,
    lastMessageAt: -1,
});

const SupportConversation = mongoose.model(
    'SupportConversation',
    supportConversationSchema
);

module.exports = SupportConversation;