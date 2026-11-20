
// backend/routes/orderRoutes.js

const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");

const auth = require("../middleware/authMiddleware");

const {
    createOrder,
    getOrdersByPlatform,
    getOrderRecords,
    submitOrder
} = require("../controllers/orderController");

const {
    uploadCsvController
} = require("../controllers/orderCsvController");


// ============================================
// MULTER STORAGE CONFIGURATION
// ============================================

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, "../uploads/orders"));
    },

    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname);

        const name =
            Date.now() +
            "-" +
            Math.random().toString(36).slice(2, 7) +
            ext;

        cb(null, name);
    }
});

const upload = multer({ storage });


// ============================================
// ADMIN → CREATE SINGLE ORDER
// Field name: image
// ============================================

router.post(
    "/create-single",
    upload.single("image"),
    createOrder
);


// ============================================
// ADMIN → CREATE COMBINE ORDER
// Field name: images
// Maximum images: 5
// ============================================

router.post(
    "/create-combine",
    upload.array("images", 5),
    createOrder
);


// ============================================
// ADMIN → CSV ORDER UPLOAD
// Field name: csvFile
// ============================================

router.post(
    "/upload-csv",
    upload.single("csvFile"),
    uploadCsvController
);


// ============================================
// USER → GET PLATFORM-WISE ACTIVE ORDERS
// Amazon / Alibaba / AliExpress
//
// Example:
// GET /api/orders/platform/amazon
// GET /api/orders/platform/alibaba
// GET /api/orders/platform/aliexpress
// ============================================

router.get(
    "/platform/:platform",
    auth,
    getOrdersByPlatform
);


// ============================================
// USER → GET COMBINED ORDER RECORDS
//
// Fetches records from all platforms.
//
// Example:
// GET /api/orders/records
//
// Optional filters:
// GET /api/orders/records?status=incomplete
// GET /api/orders/records?status=completed
// GET /api/orders/records?status=pending
// GET /api/orders/records?platform=amazon
// ============================================

router.get(
    "/records",
    auth,
    getOrderRecords
);


// ============================================
// USER → SUBMIT / RETRY ORDER
//
// Insufficient balance:
// Saves order as incomplete.
//
// Sufficient balance:
// Completes the same order record.
// Updates commission only once.
// Does NOT delete the order.
// ============================================

router.post(
    "/submit",
    auth,
    submitOrder
);


module.exports = router;