const FormData = require('form-data');
const fs = require('fs');
const fetch = require('node-fetch');

class ImageDetectionService {
  constructor() {
    this.detectorUrl = process.env.IMAGE_DETECTOR_URL || 'http://127.0.0.1:5001';
  }

  async detectImage(filePath) {
    try {
      // 验证文件存在
      if (!fs.existsSync(filePath)) {
        throw new Error('File not found: ' + filePath);
      }

      const formData = new FormData();
      formData.append('file', fs.createReadStream(filePath));

      console.log(`Sending request to ${this.detectorUrl}/detect`);
      
      const response = await fetch(`${this.detectorUrl}/detect`, {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders()
      });

      const responseText = await response.text();
      console.log(`Response status: ${response.status}`);
      console.log(`Response body: ${responseText}`);

      if (!response.ok) {
        throw new Error(`Detection service error: ${responseText}`);
      }

      return JSON.parse(responseText);
    } catch (error) {
      console.error('Image detection error:', error.message);
      throw error;
    }
  }

  async checkHealth() {
    try {
      const response = await fetch(`${this.detectorUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

module.exports = new ImageDetectionService();
