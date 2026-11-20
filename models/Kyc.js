
const mongoose = require('mongoose');

// =====================================================
// KYC DOCUMENT SCHEMA
// =====================================================

const kycDocumentSchema = new mongoose.Schema(
    {
        url: {
            type: String,
            default: null,
            trim: true,
        },

        publicId: {
            type: String,
            default: null,
            trim: true,
        },

        resourceType: {
            type: String,
            enum: ['image', 'raw', null],
            default: null,
        },

        format: {
            type: String,
            default: null,
            trim: true,
            lowercase: true,
        },
    },
    {
        _id: false,
        id: false,
    }
);

// =====================================================
// KYC MAIN SCHEMA
// =====================================================

const kycSchema = new mongoose.Schema(
    {
        // One KYC application per registered user.
        // Rejected applications can be resubmitted
        // by updating the existing record.

        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
        },

        // =============================================
        // PERSONAL INFORMATION
        // =============================================

        fullName: {
            type: String,
            required: true,
            trim: true,
            minlength: 3,
            maxlength: 100,
        },

        // Separate KYC email.
        // Does not overwrite User.email.

        kycEmail: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
            maxlength: 254,
        },

        // Sensitive information.
        // Excluded from normal queries by default.

        idNumber: {
            type: String,
            required: true,
            trim: true,
            minlength: 4,
            maxlength: 100,
            select: false,
        },

        dateOfBirth: {
            type: Date,
            required: true,
        },

        address: {
            type: String,
            required: true,
            trim: true,
            minlength: 5,
            maxlength: 500,
        },

        country: {
            type: String,
            required: true,
            trim: true,
            minlength: 2,
            maxlength: 100,
        },

        // =============================================
        // DOCUMENT INFORMATION
        // =============================================

        documentType: {
            type: String,
            required: true,
            enum: [
                'national_id',
                'passport',
                'drivers_license',
            ],
        },

        documents: {
            frontImage: {
                type: kycDocumentSchema,
                required: true,
            },

            backImage: {
                type: kycDocumentSchema,
                default: null,
            },

            selfieImage: {
                type: kycDocumentSchema,
                required: true,
            },
        },

        // =============================================
        // REVIEW STATUS
        // =============================================

        status: {
            type: String,
            enum: [
                'pending',
                'approved',
                'rejected',
            ],
            default: 'pending',
            required: true,
        },

        rejectionReason: {
            type: String,
            default: '',
            trim: true,
            maxlength: 1000,
        },

        // =============================================
        // ADMIN REVIEW INFORMATION
        // =============================================

        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        reviewedAt: {
            type: Date,
            default: null,
        },

        submittedAt: {
            type: Date,
            default: Date.now,
            required: true,
        },
    },
    {
        timestamps: true,

        // Avoid unnecessary empty objects.
        minimize: true,
    }
);

// =====================================================
// INDEXES
// =====================================================

// One KYC record per user.
// The unique constraint on user creates its index.

// Admin status filtering and newest-first sorting.
kycSchema.index({
    status: 1,
    submittedAt: -1,
});

// User's KYC history lookup.
kycSchema.index({
    user: 1,
    status: 1,
});

// =====================================================
// MODEL EXPORT
// =====================================================

module.exports =
    mongoose.models.Kyc ||
    mongoose.model('Kyc', kycSchema);