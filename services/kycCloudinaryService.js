'use strict';

const cloudinary = require('../config/cloudinary');
const { Readable } = require('stream');
const crypto = require('crypto');

const KYC_FOLDER = 'kyc';
const IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
]);
const PDF_MIME_TYPE = 'application/pdf';

const getSingleFile = (value) => {
    // Supports both Multer upload.fields() arrays and normalized file objects.
    if (Array.isArray(value)) return value[0] || null;
    return value || null;
};

const validateFileSignature = (file, { allowPdf = true } = {}) => {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
        throw new Error('Invalid or empty upload received.');
    }

    const mime = String(file.mimetype || '').toLowerCase();
    const buffer = file.buffer;

    const isJpeg =
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff;

    const isPng =
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        );

    const isPdf = buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';

    const brand = buffer.length >= 12
        ? buffer.subarray(8, 12).toString('ascii').toLowerCase()
        : '';

    const isHeic =
        buffer.length >= 12 &&
        buffer.subarray(4, 8).toString('ascii') === 'ftyp' &&
        ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heis', 'hevm'].includes(brand);

    if ((mime === 'image/jpeg' || mime === 'image/jpg') && isJpeg) return 'image';
    if (mime === 'image/png' && isPng) return 'image';

    if (IMAGE_MIME_TYPES.has(mime) && isHeic) return 'image';

    if (allowPdf && mime === PDF_MIME_TYPE && isPdf) return 'raw';

    throw new Error(
        `Uploaded file content does not match an accepted file type: ${file.originalname || 'document'}`
    );
};

const uploadBuffer = (file, folder, { allowPdf = true } = {}) => {
    return new Promise((resolve, reject) => {
        let resourceType;

        try {
            resourceType = validateFileSignature(file, { allowPdf });
        } catch (error) {
            reject(error);
            return;
        }

        const publicId = crypto.randomUUID();
        const options = {
            folder,
            public_id: resourceType === 'raw' ? `${publicId}.pdf` : publicId,
            resource_type: resourceType,
            type: 'authenticated',
            overwrite: false,
            unique_filename: false,
        };

        const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
            if (error) return reject(error);
            if (!result || !result.public_id) {
                return reject(new Error('Cloudinary did not return an uploaded asset.'));
            }

            resolve({
                // Kept for internal compatibility. Do not expose this raw URL to users.
                url: result.secure_url || null,
                publicId: result.public_id,
                resourceType: result.resource_type,
                format: result.format || null,
            });
        });

        Readable.from(file.buffer).pipe(stream);
        stream.on('error', reject);
    });
};

const uploadKycDocuments = async (files, userId = 'unassigned') => {
    const uploaded = {};
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '');

    if (!files || typeof files !== 'object') {
        throw new Error('No KYC documents were provided.');
    }

    const frontFile = getSingleFile(files.frontImage);
    const backFile = getSingleFile(files.backImage);
    const selfieFile = getSingleFile(files.selfieImage);

    if (!frontFile || !selfieFile) {
        throw new Error('Front document and selfie are required.');
    }

    const folder = `${KYC_FOLDER}/${safeUserId || 'unassigned'}`;

    try {
        uploaded.frontImage = await uploadBuffer(frontFile, folder, { allowPdf: true });

        if (backFile) {
            uploaded.backImage = await uploadBuffer(backFile, folder, { allowPdf: true });
        }

        // Selfies must always be image files, never PDFs.
        uploaded.selfieImage = await uploadBuffer(selfieFile, folder, { allowPdf: false });

        return uploaded;
    } catch (error) {
        await deleteKycDocuments(uploaded);
        throw error;
    }
};

const getDocumentEntries = (documents) => {
    if (!documents || typeof documents !== 'object') return [];

    // Accept either {frontImage, ...} or the full Kyc model's {documents: {...}}.
    const source = documents.documents && typeof documents.documents === 'object'
        ? documents.documents
        : documents;

    return ['frontImage', 'backImage', 'selfieImage']
        .map((key) => source[key])
        .filter((document) => document && document.publicId);
};

const deleteKycDocuments = async (documents) => {
    const entries = getDocumentEntries(documents);

    const results = await Promise.allSettled(
        entries.map((document) => cloudinary.uploader.destroy(document.publicId, {
            resource_type: document.resourceType || 'image',
            type: 'authenticated',
            invalidate: true,
        }))
    );

    results.forEach((result) => {
        if (result.status === 'rejected') {
            // Cleanup failure should be logged and handled by an operational alert in production.
            console.error('KYC Cloudinary cleanup failed:', result.reason?.message || result.reason);
        } else if (result.value?.result === 'not found') {
            console.warn('KYC Cloudinary asset was already missing.');
        }
    });

    return results;
};

const getKycSignedUrl = (document) => {
    if (!document || !document.publicId) return null;

    return cloudinary.url(document.publicId, {
        secure: true,
        sign_url: true,
        type: 'authenticated',
        resource_type: document.resourceType || 'image',
    });
};

module.exports = {
    uploadKycDocuments,
    deleteKycDocuments,
    getKycSignedUrl,
    validateFileSignature,
};