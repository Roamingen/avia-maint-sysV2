const FormData = require('form-data');
const fs = require('fs');
const fetch = require('node-fetch');

class ImageDetectionService {
  constructor() {
    this.detectorUrl = process.env.IMAGE_DETECTOR_URL || 'http://127.0.0.1:5001';
  }

  async detectImage(filePath) {
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(filePath));

      const response = await fetch(`${this.detectorUrl}/detect`, {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders()
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Detection failed: ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Image detection error:', error);
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
