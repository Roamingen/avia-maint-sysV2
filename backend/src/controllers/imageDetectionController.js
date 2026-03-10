const imageDetectionService = require('../services/imageDetectionService');
const path = require('path');
const fs = require('fs');

class ImageDetectionController {
  async detectSingleImage(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const result = await imageDetectionService.detectImage(req.file.path);
      
      // 清理临时文件
      fs.unlinkSync(req.file.path);

      res.json(result);
    } catch (error) {
      console.error('Detection error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async detectMultipleImages(req, res) {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const results = await Promise.all(
        req.files.map(async (file) => {
          try {
            const detection = await imageDetectionService.detectImage(file.path);
            // 安全删除临时文件
            try {
              if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
              }
            } catch (unlinkError) {
              console.error('Failed to delete temp file:', unlinkError);
            }
            return {
              filename: Buffer.from(file.originalname, 'latin1').toString('utf8'),
              ...detection
            };
          } catch (error) {
            // 安全删除临时文件
            try {
              if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
              }
            } catch (unlinkError) {
              console.error('Failed to delete temp file:', unlinkError);
            }
            return {
              filename: Buffer.from(file.originalname, 'latin1').toString('utf8'),
              error: error.message
            };
          }
        })
      );

      res.json({ results });
    } catch (error) {
      console.error('Batch detection error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async checkServiceHealth(req, res) {
    try {
      const isHealthy = await imageDetectionService.checkHealth();
      res.json({ 
        status: isHealthy ? 'ok' : 'unavailable',
        service: 'image-detector'
      });
    } catch (error) {
      res.status(503).json({ 
        status: 'error',
        error: error.message 
      });
    }
  }
}

module.exports = new ImageDetectionController();
