const express = require('express');
const multer = require('multer');
const path = require('path');
const imageDetectionController = require('../controllers/imageDetectionController');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

// 配置 multer 临时存储
const upload = multer({
  dest: path.join(__dirname, '../../storage/tmp'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|bmp|gif|webp|tiff|tif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = /image\/(jpeg|png|bmp|gif|webp|tiff)/.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed (jpg, jpeg, png, bmp, gif, webp, tiff)'));
  }
});

// 健康检查
router.get('/health', imageDetectionController.checkServiceHealth);

// 单张图片检测
router.post('/detect', authMiddleware, upload.single('file'), imageDetectionController.detectSingleImage);

// 批量图片检测
router.post('/detect/batch', authMiddleware, upload.array('files', 20), imageDetectionController.detectMultipleImages);

module.exports = router;
