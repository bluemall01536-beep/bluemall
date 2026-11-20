'use strict';

const mongoose = require('mongoose');
const Kyc = require('../models/Kyc');
const User = require('../models/User');

const {
    uploadKycDocuments,
    deleteKycDocuments,
    getKycSignedUrl,
} = require('../services/kycCloudinaryService');

const { validateKycFields } = require('../utils/kycValidation');

const getUserId = (req) => req.user?._id || req.user?.id;

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const getUploadedFiles = (files) => ({
    frontImage: files?.frontImage?.[0] || null,
    backImage: files?.backImage?.[0] || null,
    selfieImage: files?.selfieImage?.[0] || null,
});

const hasRequiredFiles = (documentType, files) => {
    if (!files.frontImage || !files.selfieImage) return false;

    if (
        ['national_id', 'drivers_license'].includes(documentType) &&
        !files.backImage
    ) {
        return false;
    }

    return true;
};

const escapeRegex = (value) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getPublicDocument = (document) => {
    if (!document) return null;

    const item = typeof document.toObject === 'function'
        ? document.toObject()
        : { ...document };

    // Never send the stored raw Cloudinary URL to the browser.
    delete item.url;

    return {
        ...item,
        signedUrl: getKycSignedUrl(item),
    };
};

// =====================================================
// 1. USER: SUBMIT KYC
// POST /api/kyc/submit
// =====================================================

exports.submitKyc = async (req, res) => {
    let uploadedDocuments = null;
    let savedKyc = false;

    try {
        const userId = getUserId(req);

        if (!userId || !isValidObjectId(userId)) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required.',
            });
        }

        const validation = validateKycFields(req.body || {});

        if (!validation.isValid) {
            return res.status(400).json({
                success: false,
                message: validation.errors[0],
                errors: validation.errors,
            });
        }

        const {
            fullName,
            email,
            idNumber,
            dateOfBirth,
            address,
            country,
            documentType,
        } = validation.data;

        const files = getUploadedFiles(req.files);

        if (!hasRequiredFiles(documentType, files)) {
            return res.status(400).json({
                success: false,
                message: 'Please upload all required KYC documents. Front image and selfie are required; back image is required for national ID and driving licence.',
            });
        }

        const [existingKyc, userExists] = await Promise.all([
            Kyc.findOne({ user: userId }),
            User.exists({ _id: userId }),
        ]);

        if (!userExists) {
            return res.status(401).json({
                success: false,
                message: 'User account not found. Please sign in again.',
            });
        }

        if (existingKyc?.status === 'pending') {
            return res.status(409).json({
                success: false,
                message: 'Your KYC application is already under review.',
                status: 'pending',
            });
        }

        if (existingKyc?.status === 'approved') {
            return res.status(409).json({
                success: false,
                message: 'Your KYC is already approved.',
                status: 'approved',
            });
        }

        // Upload documents to Cloudinary.
        uploadedDocuments = await uploadKycDocuments(
            files,
            String(userId)
        );

        const kycData = {
            user: userId,
            fullName: fullName.trim(),
            kycEmail: email.trim().toLowerCase(),
            idNumber: idNumber.trim(),
            dateOfBirth: new Date(`${dateOfBirth}T00:00:00.000Z`),
            address: address.trim(),
            country: country.trim(),
            documentType,

            documents: {
                frontImage: uploadedDocuments.frontImage,
                backImage: uploadedDocuments.backImage || null,
                selfieImage: uploadedDocuments.selfieImage,
            },

            status: 'pending',
            rejectionReason: '',
            reviewedBy: null,
            reviewedAt: null,
            submittedAt: new Date(),
        };

        if (existingKyc) {
            const oldDocuments = existingKyc.documents;

            Object.assign(existingKyc, kycData);

            await existingKyc.save();
            savedKyc = true;

            // Delete old documents only after successful save.
            if (oldDocuments) {
                await deleteKycDocuments(oldDocuments).catch(
                    (cleanupError) => {
                        console.error(
                            'Old KYC document cleanup error:',
                            cleanupError.message
                        );
                    }
                );
            }
        } else {
            await Kyc.create(kycData);
            savedKyc = true;
        }

        // Keep user's KYC state in sync.
        // This does not assign a deposit-based VIP tier.
        await User.updateOne(
            { _id: userId },
            { $set: { kycStatus: 'pending' } }
        );

        return res.status(201).json({
            success: true,
            message: 'KYC submitted successfully. Your application is under review.',
            status: 'pending',
        });

    } catch (error) {
        // Cleanup newly uploaded files if database save failed.
        if (uploadedDocuments && !savedKyc) {
            await deleteKycDocuments(uploadedDocuments).catch(
                (cleanupError) => {
                    console.error(
                        'KYC upload cleanup error:',
                        cleanupError.message
                    );
                }
            );
        }

        console.error('Submit KYC error:', error);

        return res.status(500).json({
            success: false,
            message: 'Unable to submit KYC. Please try again.',
        });
    }
};

// =====================================================
// 2. USER: GET KYC STATUS
// GET /api/kyc/status
// =====================================================

exports.getKycStatus = async (req, res) => {
    try {
        const userId = getUserId(req);

        if (!userId || !isValidObjectId(userId)) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required.',
            });
        }

        const kyc = await Kyc.findOne({ user: userId })
            .select('status rejectionReason submittedAt reviewedAt')
            .lean();

        if (!kyc) {
            return res.status(200).json({
                success: true,
                status: 'none',
                rejectionReason: '',
            });
        }

        return res.status(200).json({
            success: true,
            status: kyc.status,
            rejectionReason: kyc.rejectionReason || '',
            submittedAt: kyc.submittedAt,
            reviewedAt: kyc.reviewedAt,
        });

    } catch (error) {
        console.error('Get KYC status error:', error);

        return res.status(500).json({
            success: false,
            message: 'Unable to fetch KYC status.',
        });
    }
};

// =====================================================
// 3. ADMIN: GET ALL KYC APPLICATIONS
// GET /api/kyc/admin
// =====================================================

exports.getAllKyc = async (req, res) => {
    try {
        const {
            status,
            page = 1,
            limit = 20,
            search,
        } = req.query;

        const filter = {};

        if (status && ['pending', 'approved', 'rejected'].includes(status)) {
            filter.status = status;
        }

        if (typeof search === 'string' && search.trim()) {
            const searchRegex = new RegExp(
                escapeRegex(search.trim()),
                'i'
            );

            filter.$or = [
                { fullName: searchRegex },
                { kycEmail: searchRegex },
                { country: searchRegex },
            ];
        }

        const currentPage = Math.max(
            1,
            Number.parseInt(page, 10) || 1
        );

        const pageLimit = Math.min(
            100,
            Math.max(1, Number.parseInt(limit, 10) || 20)
        );

        const [applications, total] = await Promise.all([
            Kyc.find(filter)
                .select('-idNumber -documents')
                .populate('user', 'email nickname phone')
                .populate('reviewedBy', 'email nickname')
                .sort({ submittedAt: -1 })
                .skip((currentPage - 1) * pageLimit)
                .limit(pageLimit)
                .lean(),

            Kyc.countDocuments(filter),
        ]);

        return res.status(200).json({
            success: true,
            applications,
            pagination: {
                total,
                page: currentPage,
                limit: pageLimit,
                totalPages: Math.ceil(total / pageLimit),
            },
        });

    } catch (error) {
        console.error('Get all KYC error:', error);

        return res.status(500).json({
            success: false,
            message: 'Unable to fetch KYC applications.',
        });
    }
};

// =====================================================
// 4. ADMIN: GET SINGLE KYC DETAILS
// GET /api/kyc/admin/:id
// =====================================================

exports.getKycDetails = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid KYC application ID.',
            });
        }

        const kyc = await Kyc.findById(id)
            .select('+idNumber')
            .populate('user', 'email nickname phone')
            .populate('reviewedBy', 'email nickname');

        if (!kyc) {
            return res.status(404).json({
                success: false,
                message: 'KYC application not found.',
            });
        }

        const application = kyc.toObject();

        if (application.documents) {
            application.documents = {
                frontImage: getPublicDocument(
                    application.documents.frontImage
                ),

                backImage: getPublicDocument(
                    application.documents.backImage
                ),

                selfieImage: getPublicDocument(
                    application.documents.selfieImage
                ),
            };
        }

        return res.status(200).json({
            success: true,
            application,
        });

    } catch (error) {
        console.error('Get KYC details error:', error);

        return res.status(500).json({
            success: false,
            message: 'Unable to fetch KYC details.',
        });
    }
};

// =====================================================
// 5. ADMIN: APPROVE KYC
// PATCH /api/kyc/admin/:id/approve
// =====================================================

exports.approveKyc = async (req, res) => {
    try {
        const { id } = req.params;
        const adminId = getUserId(req);

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid KYC application ID.',
            });
        }

        // Existing admin dashboard uses its own frontend login and its
        // /api/admin endpoints do not attach a MongoDB admin user to req.user.
        // Keep reviewedBy empty when review is performed from that panel.


        // Conditional update prevents duplicate concurrent approvals.
        const kyc = await Kyc.findOneAndUpdate(
            {
                _id: id,
                status: 'pending',
            },
            {
                $set: {
                    status: 'approved',
                    rejectionReason: '',
                    reviewedBy: (adminId && isValidObjectId(adminId)) ? adminId : null,
                    reviewedAt: new Date(),
                },
            },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!kyc) {
            const existing = await Kyc.findById(id).select('status');

            if (!existing) {
                return res.status(404).json({
                    success: false,
                    message: 'KYC application not found.',
                });
            }

            return res.status(409).json({
                success: false,
                message: `This application is already ${existing.status}.`,
                status: existing.status,
            });
        }

        try {
            const userUpdate = await User.updateOne(
                { _id: kyc.user },
                { $set: { kycStatus: 'approved' } }
            );

            if (!userUpdate.matchedCount && !userUpdate.n) {
                throw new Error(
                    'The user associated with this KYC application was not found.'
                );
            }

        } catch (userError) {
            // Roll back KYC status if user update fails.
            await Kyc.updateOne(
                {
                    _id: kyc._id,
                    status: 'approved',
                },
                {
                    $set: {
                        status: 'pending',
                        reviewedBy: null,
                        reviewedAt: null,
                    },
                }
            ).catch((rollbackError) => {
                console.error(
                    'CRITICAL: KYC approval rollback failed:',
                    rollbackError
                );
            });

            throw userError;
        }

        return res.status(200).json({
            success: true,
            message: 'KYC approved successfully. VIP 1 eligibility is now unlocked.',
            status: 'approved',
            kycApproved: true,
            vipAccessUnlocked: true,
        });

    } catch (error) {
        console.error('Approve KYC error:', error);

        return res.status(500).json({
            success: false,
            message: 'Unable to approve KYC application.',
        });
    }
};

// =====================================================
// 6. ADMIN: REJECT KYC
// PATCH /api/kyc/admin/:id/reject
// =====================================================

exports.rejectKyc = async (req, res) => {
    try {
        const { id } = req.params;
        const adminId = getUserId(req);
        const { rejectionReason } = req.body || {};

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid KYC application ID.',
            });
        }

        // Existing admin dashboard uses its own frontend login and its
        // /api/admin endpoints do not attach a MongoDB admin user to req.user.
        // Keep reviewedBy empty when review is performed from that panel.


        if (
            typeof rejectionReason !== 'string' ||
            rejectionReason.trim().length < 3 ||
            rejectionReason.trim().length > 1000
        ) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a rejection reason between 3 and 1000 characters.',
            });
        }

        const kyc = await Kyc.findOneAndUpdate(
            {
                _id: id,
                status: 'pending',
            },
            {
                $set: {
                    status: 'rejected',
                    rejectionReason: rejectionReason.trim(),
                    reviewedBy: (adminId && isValidObjectId(adminId)) ? adminId : null,
                    reviewedAt: new Date(),
                },
            },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!kyc) {
            const existing = await Kyc.findById(id).select('status');

            if (!existing) {
                return res.status(404).json({
                    success: false,
                    message: 'KYC application not found.',
                });
            }

            return res.status(409).json({
                success: false,
                message: `This application is already ${existing.status}.`,
                status: existing.status,
            });
        }

        try {
            const userUpdate = await User.updateOne(
                { _id: kyc.user },
                { $set: { kycStatus: 'rejected' } }
            );

            if (!userUpdate.matchedCount && !userUpdate.n) {
                throw new Error(
                    'The user associated with this KYC application was not found.'
                );
            }

        } catch (userError) {
            await Kyc.updateOne(
                {
                    _id: kyc._id,
                    status: 'rejected',
                },
                {
                    $set: {
                        status: 'pending',
                        rejectionReason: '',
                        reviewedBy: null,
                        reviewedAt: null,
                    },
                }
            ).catch((rollbackError) => {
                console.error(
                    'CRITICAL: KYC rejection rollback failed:',
                    rollbackError
                );
            });

            throw userError;
        }

        return res.status(200).json({
            success: true,
            message: 'KYC application rejected.',
            status: 'rejected',
            rejectionReason: kyc.rejectionReason,
        });

    } catch (error) {
        console.error('Reject KYC error:', error);

        return res.status(500).json({
            success: false,
            message: 'Unable to reject KYC application.',
        });
    }
};