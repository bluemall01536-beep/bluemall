
const multer = require('multer');

// =====================================================
// CONFIGURATION
// =====================================================

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB per file
const MAX_FILES = 3;

const ALLOWED_MIME_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
    'application/pdf',
];

const ALLOWED_IMAGE_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
];

const ALLOWED_FIELDS = [
    'frontImage',
    'backImage',
    'selfieImage',
];

// =====================================================
// MEMORY STORAGE
// =====================================================

const storage = multer.memoryStorage();

// =====================================================
// MIME TYPE VALIDATION
// =====================================================

const fileFilter = (req, file, cb) => {
    const mimeType = String(file.mimetype || '').toLowerCase();

    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        return cb(
            new Error(
                'Unsupported file format. Upload JPG, PNG, HEIC, HEIF or PDF.'
            )
        );
    }

    // Selfie must always be an image.
    if (
        file.fieldname === 'selfieImage' &&
        !ALLOWED_IMAGE_TYPES.includes(mimeType)
    ) {
        return cb(
            new Error('Selfie must be an image. PDF is not allowed.')
        );
    }

    return cb(null, true);
};

// =====================================================
// FILE SIGNATURE / MAGIC BYTE VALIDATION
// =====================================================

const detectFileType = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
        return null;
    }

    // JPEG: FF D8 FF
    if (
        buffer[0] === 0xFF &&
        buffer[1] === 0xD8 &&
        buffer[2] === 0xFF
    ) {
        return 'jpeg';
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(
            Buffer.from([
                0x89, 0x50, 0x4E, 0x47,
                0x0D, 0x0A, 0x1A, 0x0A,
            ])
        )
    ) {
        return 'png';
    }

    // PDF: %PDF-
    if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
        return 'pdf';
    }

    // HEIC / HEIF: ISO Base Media File Format
    if (buffer.toString('ascii', 4, 8) === 'ftyp') {
        const brands = [];

        // Major brand
        brands.push(buffer.toString('ascii', 8, 12));

        // Compatible brands
        for (let offset = 16; offset + 4 <= Math.min(buffer.length, 128); offset += 4) {
            brands.push(buffer.toString('ascii', offset, offset + 4));
        }

        const heicBrands = [
            'heic',
            'heix',
            'hevc',
            'hevx',
        ];

        const heifBrands = [
            'mif1',
            'msf1',
            'heic',
            'heix',
            'hevc',
            'hevx',
        ];

        if (brands.some((brand) => heicBrands.includes(brand))) {
            return 'heic';
        }

        if (brands.some((brand) => heifBrands.includes(brand))) {
            return 'heif';
        }
    }

    return null;
};

// =====================================================
// MIME + SIGNATURE MATCHING
// =====================================================

const isMimeMatchingSignature = (mimeType, detectedType) => {
    const mime = String(mimeType || '').toLowerCase();

    const mimeMap = {
        'image/jpeg': ['jpeg'],
        'image/jpg': ['jpeg'],
        'image/png': ['png'],
        'image/heic': ['heic'],
        'image/heif': ['heif', 'heic'],
        'image/heic-sequence': ['heic'],
        'image/heif-sequence': ['heif', 'heic'],
        'application/pdf': ['pdf'],
    };

    return mimeMap[mime]?.includes(detectedType) || false;
};

const validateFileSignature = (file) => {
    if (!file || !Buffer.isBuffer(file.buffer)) {
        return {
            valid: false,
            message: 'Unable to read uploaded file.',
        };
    }

    const detectedType = detectFileType(file.buffer);

    if (!detectedType) {
        return {
            valid: false,
            message: 'Invalid or unsupported file content.',
        };
    }

    const mimeType = String(file.mimetype || '').toLowerCase();

    if (!isMimeMatchingSignature(mimeType, detectedType)) {
        return {
            valid: false,
            message: 'File content does not match its declared file type.',
        };
    }

    if (
        file.fieldname === 'selfieImage' &&
        detectedType === 'pdf'
    ) {
        return {
            valid: false,
            message: 'Selfie must be an image. PDF is not allowed.',
        };
    }

    return {
        valid: true,
        detectedType,
    };
};

// =====================================================
// MULTER INSTANCE
// =====================================================

const upload = multer({
    storage,
    fileFilter,

    limits: {
        fileSize: MAX_FILE_SIZE,
        files: MAX_FILES,
        fields: 10,
        fieldNameSize: 100,
        fieldSize: 100 * 1024,
        parts: 15,
    },
});

// =====================================================
// ERROR RESPONSE HELPER
// =====================================================

const sendUploadError = (res, error) => {
    if (error instanceof multer.MulterError) {
        const errorMessages = {
            LIMIT_FILE_SIZE: 'Each file must be smaller than 5 MB.',
            LIMIT_FILE_COUNT: 'Maximum 3 documents are allowed.',
            LIMIT_UNEXPECTED_FILE: 'Unexpected upload field or too many files.',
            LIMIT_FIELD_COUNT: 'Too many form fields.',
            LIMIT_FIELD_KEY: 'Form field name is too long.',
            LIMIT_FIELD_VALUE: 'Form field value is too large.',
            LIMIT_PART_COUNT: 'Too many multipart form parts.',
        };

        return res.status(400).json({
            success: false,
            message:
                errorMessages[error.code] ||
                'File upload failed.',
        });
    }

    return res.status(400).json({
        success: false,
        message: error.message || 'Invalid document file.',
    });
};

// =====================================================
// KYC UPLOAD MIDDLEWARE
// =====================================================

const uploadKyc = (req, res, next) => {
    const uploadFields = upload.fields([
        {
            name: 'frontImage',
            maxCount: 1,
        },
        {
            name: 'backImage',
            maxCount: 1,
        },
        {
            name: 'selfieImage',
            maxCount: 1,
        },
    ]);

    uploadFields(req, res, (error) => {
        if (error) {
            return sendUploadError(res, error);
        }

        try {
            const files = req.files || {};

            // Check unexpected fields defensively.
            for (const fieldName of Object.keys(files)) {
                if (!ALLOWED_FIELDS.includes(fieldName)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Unexpected upload field.',
                    });
                }
            }

            // Validate actual file content.
            for (const fieldName of ALLOWED_FIELDS) {
                const fieldFiles = files[fieldName] || [];

                for (const file of fieldFiles) {
                    const result = validateFileSignature(file);

                    if (!result.valid) {
                        return res.status(400).json({
                            success: false,
                            message: result.message,
                            field: fieldName,
                        });
                    }

                    // Attach detected type for downstream use.
                    file.detectedFileType = result.detectedType;
                }
            }

            return next();

        } catch (validationError) {
            console.error(
                'KYC file validation error:',
                validationError
            );

            return res.status(400).json({
                success: false,
                message: 'Unable to validate uploaded documents.',
            });
        }
    });
};

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
    uploadKyc,
};