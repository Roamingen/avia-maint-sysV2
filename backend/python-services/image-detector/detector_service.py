from flask import Flask, request, jsonify
from ultralytics import YOLO
from PIL import Image
import numpy as np
import os

app = Flask(__name__)
model = YOLO('model/best.pt')

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})

@app.route('/detect', methods=['POST'])
def detect():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Empty filename'}), 400
    
    try:
        image = Image.open(file.stream)
        img_array = np.array(image)
        results = model(img_array)
        result = results[0]
        
        max_idx = result.probs.top1
        predicted_class = result.names[max_idx]
        confidence = float(result.probs.top1conf.item())
        
        return jsonify({
            'predicted_class': predicted_class,
            'confidence': confidence,
            'is_normal': predicted_class == 'normal'
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001, debug=False)
