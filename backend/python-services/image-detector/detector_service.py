from flask import Flask, request, jsonify
from ultralytics import YOLO
from PIL import Image
import numpy as np
import os
import traceback

app = Flask(__name__)
app.config['JSON_AS_ASCII'] = False

try:
    model = YOLO('model/best.pt')
    print('Model loaded successfully')
except Exception as e:
    print(f'Failed to load model: {e}')
    model = None

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'model_loaded': model is not None})

@app.route('/detect', methods=['POST'])
def detect():
    if model is None:
        return jsonify({'error': 'Model not loaded'}), 500
        
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Empty filename'}), 400
    
    try:
        image = Image.open(file.stream)
        
        # 转换为RGB模式
        if image.mode != 'RGB':
            image = image.convert('RGB')
            
        img_array = np.array(image)
        
        # 执行预测
        results = model(img_array, verbose=False)
        result = results[0]
        
        # 获取预测结果
        max_idx = result.probs.top1
        predicted_class = result.names[max_idx]
        confidence = float(result.probs.top1conf.item())
        
        print(f'Detected: {predicted_class} with confidence {confidence:.4f}')
        
        return jsonify({
            'predicted_class': predicted_class,
            'confidence': confidence,
            'is_normal': predicted_class == 'normal'
        })
    except Exception as e:
        error_msg = str(e)
        print(f'Detection error: {error_msg}')
        print(traceback.format_exc())
        return jsonify({'error': error_msg}), 500

if __name__ == '__main__':
    print('Starting Image Detection Service on port 5001...')
    app.run(host='0.0.0.0', port=5001, debug=False)
