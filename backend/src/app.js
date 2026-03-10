const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/authRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');
const imageDetectionRoutes = require('./routes/imageDetectionRoutes');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/image-detection', imageDetectionRoutes);

app.use((req, res) => {
    res.status(404).json({ message: '接口不存在' });
});

app.use((error, req, res, next) => {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
        message: error.message || '服务器内部错误',
    });
});

module.exports = app;
