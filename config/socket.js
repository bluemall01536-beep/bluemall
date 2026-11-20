
'use strict';

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const User = require('../models/User');
const SupportConversation = require('../models/SupportConversation');

let io = null;

// =====================================================
// ROOM HELPERS
// =====================================================

const getUserRoom = (userId) => `support:user:${userId}`;

const getAdminRoom = () => 'support:admins';

const getConversationRoom = (conversationId) =>
    `support:conversation:${conversationId}`;


// =====================================================
// SOCKET AUTHENTICATION
// Uses the same JWT_SECRET and decoded.id as authMiddleware.
// =====================================================

async function authenticateSocket(socket, next) {
    try {
        const token =
            socket.handshake.auth?.token ||
            socket.handshake.headers?.authorization
                ?.replace(/^Bearer\s+/i, '');

        if (!token) {
            return next(new Error('Authentication required.'));
        }

        const jwtSecret = process.env.JWT_SECRET;

        if (!jwtSecret) {
            console.error('JWT_SECRET is missing.');
            return next(new Error('Authentication configuration error.'));
        }

        let decoded;

        try {
            decoded = jwt.verify(token, jwtSecret, {
                algorithms: ['HS256'],
            });
        } catch (error) {
            return next(
                new Error(
                    error.name === 'TokenExpiredError'
                        ? 'Session expired. Please login again.'
                        : 'Invalid or expired token.'
                )
            );
        }

        if (!decoded?.id || !mongoose.Types.ObjectId.isValid(decoded.id)) {
            return next(new Error('Invalid authentication token.'));
        }

        const user = await User.findById(decoded.id).select(
            '_id nickname email invitationCode isAdmin role'
        );

        if (!user) {
            return next(new Error('User account not found.'));
        }

        const isAdmin =
            user.isAdmin === true ||
            String(user.role || '').toLowerCase() === 'admin';

        socket.data.user = {
            id: user._id.toString(),
            username: user.nickname || 'User',
            email: user.email || '',
            invitationCode: user.invitationCode || '',
            isAdmin,
        };

        return next();

    } catch (error) {
        console.error('Socket authentication error:', error);
        return next(new Error('Authentication failed.'));
    }
}


// =====================================================
// INITIALIZE SOCKET.IO
// Call this once from server.js.
// =====================================================

function initializeSocket(server) {
    if (io) {
        return io;
    }

    const allowedOrigins = (
        process.env.FRONTEND_URL || ''
    )
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    io = new Server(server, {
        cors: {
            origin: allowedOrigins.length
                ? allowedOrigins
                : false,
            methods: ['GET', 'POST'],
            credentials: true,
        },

        transports: ['websocket', 'polling'],

        pingInterval: 25000,
        pingTimeout: 20000,

        maxHttpBufferSize: 1e6,
    });

    // Authenticate every socket connection.
    io.use(authenticateSocket);


    // =================================================
    // CONNECTION HANDLER
    // =================================================

    io.on('connection', async (socket) => {
        const currentUser = socket.data.user;

        if (!currentUser) {
            socket.disconnect(true);
            return;
        }

        const userId = currentUser.id;

        console.log(
            `Support socket connected: ${currentUser.username} (${userId})`
        );

        // Every user automatically joins their own private room.
        socket.join(getUserRoom(userId));

        // Only verified admins can join the admin room.
        if (currentUser.isAdmin) {
            socket.join(getAdminRoom());
        }


        // =============================================
        // JOIN CONVERSATION
        // =============================================

        socket.on('support:join-conversation', async (payload = {}, callback) => {
            try {
                const conversationId = String(
                    payload.conversationId || ''
                );

                if (!mongoose.Types.ObjectId.isValid(conversationId)) {
                    return callback?.({
                        success: false,
                        message: 'Invalid conversation ID.',
                    });
                }

                const conversation =
                    await SupportConversation.findById(conversationId)
                        .select('_id userId');

                if (!conversation) {
                    return callback?.({
                        success: false,
                        message: 'Conversation not found.',
                    });
                }

                // A normal user can only join their own conversation.
                if (
                    !currentUser.isAdmin &&
                    String(conversation.userId || '') !== userId
                ) {
                    return callback?.({
                        success: false,
                        message: 'Access denied.',
                    });
                }

                // Admin access is granted only after server-side
                // authentication and admin role verification.
                socket.join(getConversationRoom(conversationId));

                return callback?.({
                    success: true,
                    conversationId,
                });

            } catch (error) {
                console.error('Join conversation error:', error);

                return callback?.({
                    success: false,
                    message: 'Unable to join conversation.',
                });
            }
        });


        // =============================================
        // LEAVE CONVERSATION
        // =============================================

        socket.on('support:leave-conversation', (payload = {}, callback) => {
            const conversationId = String(
                payload.conversationId || ''
            );

            if (!mongoose.Types.ObjectId.isValid(conversationId)) {
                return callback?.({
                    success: false,
                    message: 'Invalid conversation ID.',
                });
            }

            socket.leave(getConversationRoom(conversationId));

            return callback?.({
                success: true,
            });
        });


        // =============================================
        // DISCONNECT
        // =============================================

        socket.on('disconnect', (reason) => {
            console.log(
                `Support socket disconnected: ${userId} (${reason})`
            );
        });
    });

    console.log('Support Socket.IO initialized.');

    return io;
}


// =====================================================
// GET SOCKET INSTANCE
// =====================================================

function getIO() {
    if (!io) {
        throw new Error(
            'Socket.IO is not initialized. Call initializeSocket(server) first.'
        );
    }

    return io;
}


// =====================================================
// EMIT TO A PARTICULAR USER
// =====================================================

function emitToUser(userId, event, data) {
    if (!userId) return;

    getIO()
        .to(getUserRoom(userId.toString()))
        .emit(event, data);
}


// =====================================================
// EMIT TO ALL VERIFIED ADMINS
// =====================================================

function emitToAdmins(event, data) {
    getIO()
        .to(getAdminRoom())
        .emit(event, data);
}


// =====================================================
// EMIT TO A PARTICULAR CONVERSATION
// =====================================================

function emitToConversation(conversationId, event, data) {
    if (!conversationId) return;

    getIO()
        .to(getConversationRoom(conversationId.toString()))
        .emit(event, data);
}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {
    initializeSocket,
    getIO,

    getUserRoom,
    getAdminRoom,
    getConversationRoom,

    emitToUser,
    emitToAdmins,
    emitToConversation,
};