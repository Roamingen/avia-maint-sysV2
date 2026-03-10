# 图片质量检测服务

## 功能说明

基于 YOLOv8 的图片质量自动检测服务，用于识别检修照片是否符合标准。

- **检测类别**: normal（正常）/ bad（异常）
- **支持格式**: jpg, jpeg, png
- **服务端口**: 5001

## 安装依赖

### 1. 安装 Python 环境

确保已安装 Python 3.8+

### 2. 安装依赖包

```bash
cd backend/python-services/image-detector
pip install -r requirements.txt
```

## 启动服务

### 一键启动（推荐）

```bash
# Windows
startall.bat
```

这将自动启动所有服务：
- 区块链节点
- 图片检测服务（Python）
- 后端 API
- 前端界面

### 手动启动

如需单独启动图片检测服务：

```bash
cd backend/python-services/image-detector
python detector_service.py
```

## API 接口

### 健康检查

```
GET http://127.0.0.1:5001/health
```

### 单张图片检测

```
POST http://127.0.0.1:5001/detect
Content-Type: multipart/form-data

file: <image_file>
```

响应示例：
```json
{
  "predicted_class": "normal",
  "confidence": 0.9876,
  "is_normal": true
}
```

## 集成说明

图片检测服务已集成到主系统：

1. **后端 API**: `/api/image-detection/detect` 和 `/api/image-detection/detect/batch`
2. **前端页面**: 工作台 -> 图片检测
3. **权限要求**: record.view

## 模型文件

模型文件位于 `backend/python-services/image-detector/model/best.pt`

如需更新模型，替换此文件即可。
