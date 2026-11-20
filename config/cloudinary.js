
const cloudinary = require('cloudinary').v2;

// =====================================================
// CLOUDINARY CONFIGURATION
// =====================================================

const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME;
const cloudinaryApiKey = process.env.CLOUDINARY_API_KEY;
const cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET;

if (
    !cloudinaryCloudName ||
    !cloudinaryApiKey ||
    !cloudinaryApiSecret
) {
    throw new Error(
        'Cloudinary configuration missing. Please check your .env file.'
    );
}

cloudinary.config({
    cloud_name: cloudinaryCloudName,
    api_key: cloudinaryApiKey,
    api_secret: cloudinaryApiSecret,
    secure: true,
});

module.exports = cloudinary;